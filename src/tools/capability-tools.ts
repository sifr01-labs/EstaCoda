import { routingStatus } from "../runtime/jev/routing-status.js";
import { evaluateCapabilities } from "../runtime/jev/capability-decisions.js";
import { jevRoutingContext, type LiveJevRouting } from "../runtime/jev/live-routing.js";
import { createHash } from "node:crypto";
import type { LoadedSkill, SkillDefinition } from "../contracts/skill.js";
import type { RecoveredSkillReceipt } from "../contracts/runtime-event.js";
import type { RegisteredTool, SessionToolProvider, ToolExecutionContext, ToolResult } from "../contracts/tool.js";
import { buildSkillReadinessMetadata, resolveSkillSetupContext } from "../skills/skill-readiness.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { ToolExecutionRecord } from "./tool-executor.js";
import type { ToolRegistry } from "./tool-registry.js";
import { budgetProviderTools, type OpenAICompatibleToolSchema, type ProviderToolSchemaCatalog } from "./tool-schema.js";

export const CAPABILITY_RECOVERY_TOOLS = ["capability.discover", "capability.request"] as const;
export const MAX_CAPABILITY_RESULTS = 8;
export const MAX_CAPABILITY_ADDITIONS = 8;
export const MAX_CAPABILITY_ROUNDS = 2;

type RequestReceipt = { ids: string[]; callId: string; turn: object };
export type CapabilityProposal = { id: string; callId: string };

/** Session-owned state. Provider text/metadata cannot manufacture request receipts. */
export class SessionCapabilityRecovery {
  readonly #registry: ToolRegistry;
  readonly #skills: SkillRegistry;
  readonly #skillConfig: Record<string, Record<string, unknown>>;
  #catalog?: ProviderToolSchemaCatalog;
  #routing?: LiveJevRouting;
  #reportRouting?: (status: import("../contracts/routing.js").RoutingStatus, context?: ToolExecutionContext) => Promise<void>;
  #stagedTools = new Set<string>();
  #identity = new WeakMap<object, number>();
  #nextIdentity = 0;

  #definitions = new Map<string, { instance: RegisteredTool; run: RegisteredTool["run"]; signature: string }>();
  #turn?: { token: object; sessionId: string; profileId: string; visibleTurnId?: string; objective?: string; continuity?: string; signal?: AbortSignal };
  #active = new Set<string>();
  #receipts = new WeakMap<ToolResult, RequestReceipt>();
  #pending = new Set<string>();
  #rounds = 0;
  #skillDefinitions = new Map<string, { instance: LoadedSkill | SkillDefinition; signature: string }>();
  #requestedSkills = new Map<string, { instance: LoadedSkill | SkillDefinition; signature: string }>();
  #skillReceipts = new WeakMap<ToolResult, { receipt: Omit<RecoveredSkillReceipt, "appliedIteration">; content: string; turn: object }>();
  #loadedSkills = new Set<string>();

  constructor(options: { registry: ToolRegistry; skills: SkillRegistry; skillConfig?: Record<string, Record<string, unknown>> }) {
    this.#registry = options.registry;
    this.#skills = options.skills;
    this.#skillConfig = options.skillConfig ?? {};
  }

  bindRouting(routing: LiveJevRouting, report?: (status: import("../contracts/routing.js").RoutingStatus, context?: ToolExecutionContext) => Promise<void>): void { this.#routing = routing; this.#reportRouting = report; }

  /** Handler identity, definitions, visibility and aliases participate in async decision invalidation. */
  catalogRevision(): string {
    const identity = (value: object) => {
      if (!this.#identity.has(value)) this.#identity.set(value, ++this.#nextIdentity);
      return this.#identity.get(value);
    };
    return createHash("sha256").update(JSON.stringify({ catalog: this.#catalog && {
      inventory: this.#catalog.inventory, entries: this.#catalog.entries, aliases: [...this.#catalog.aliases]
    }, tools: this.#registry.list().map(definition => {
      const tool = this.#registry.get(definition.name)!;
      return [definition, identity(tool), identity(tool.run), identity(tool.isAvailable)];
    }), skills: this.#skills.list() })).digest("hex");
  }

  bindCatalog(catalog: ProviderToolSchemaCatalog): void {
    this.#catalog = catalog;
    this.#definitions.clear();
    this.#skillDefinitions = new Map(this.#skills.list().map((skill) => [skill.name, { instance: skill, signature: skillSignature(skill) }]));
    for (const entry of catalog.entries) {
      const instance = this.#registry.get(entry.tool.name);
      if (instance) this.#definitions.set(entry.tool.name, { instance, run: instance.run, signature: definitionSignature(instance) });
    }
  }

  beginTurn(input: { sessionId: string; profileId: string; visibleTurnId?: string; tools: readonly OpenAICompatibleToolSchema[]; stagedTools?: readonly string[]; objective?: string; continuity?: string; signal?: AbortSignal }): void {
    this.endTurn();
    this.#turn = { ...input, token: {} };
    this.setExposure(input.tools);
    this.#stagedTools = new Set(input.stagedTools ?? []);
  }

  endTurn(): void {
    this.#turn = undefined;
    this.#active.clear();
    this.#stagedTools.clear();
    this.#receipts = new WeakMap();
    this.#pending.clear();
    this.#rounds = 0;
    this.#requestedSkills.clear();
    this.#skillReceipts = new WeakMap();
    this.#loadedSkills.clear();
  }

  setExposure(tools: readonly OpenAICompatibleToolSchema[]): void {
    this.#active = new Set(tools.map((tool) => this.#catalog?.aliases.get(tool.function.name) ?? tool.function.name));
  }

  discover(input: unknown, context?: ToolExecutionContext): ToolResult {
    if (!this.#inScope(context)) return failure("inactive_scope");
    if (!isRecord(input) || Object.keys(input).some((key) => !["query", "ids", "kind"].includes(key)) ||
      (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 200)) ||
      (input.kind !== undefined && input.kind !== "tool" && input.kind !== "skill") ||
      (input.ids !== undefined && !validIds(input.ids, true))) return failure("invalid_request");
    const ids = Array.isArray(input.ids) && input.ids.length > 0 ? new Set(input.ids) : undefined;
    // Exact IDs are deterministic lookup, even when a query accompanies them.
    const query = ids ? "" : typeof input.query === "string" ? input.query.toLocaleLowerCase().trim() : "";
    const terms = [...new Set(query.match(/[\p{L}\p{N}_-]+/gu) ?? [])].filter(term => term.length > 2 && !["the", "and", "for", "with", "from", "this", "that", "about", "using", "use"].includes(term));
    const entries = this.#discoveryEntries(input.kind).map(entry => {
      const skill = entry.kind === "skill" ? this.#skills.get(entry.name) : undefined;
      const description = skill?.description ?? this.#catalog?.inventory.find(tool => tool.name === entry.name)?.description ?? entry.description;
      const search = `${entry.name} ${description} ${skill ? JSON.stringify(skill.routing?.triggerPatterns ?? []) : entry.toolsets.join(" ")}`.toLocaleLowerCase();
      const boost = (skill?.routing?.triggerPatterns ?? []).some(pattern => pattern.type === "contains" && query.includes(pattern.value.toLocaleLowerCase())) ? 8 : 0;
      const score = query.length === 0 ? 1 : boost + (entry.name.toLocaleLowerCase() === query ? 100 : 0) + terms.reduce((sum, term) => sum +
        (entry.name.toLocaleLowerCase().includes(term) ? 3 : search.includes(term) ? 1 : 0), 0);
      return { ...entry, score };
    }).filter(entry => (ids === undefined || ids.has(entry.id)) && (query.length === 0 || entry.score > 0))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return discoveryResult(entries.map(({ score: _score, ...entry }) => entry));
  }

  #discoveryEntries(kind: unknown) {
    return [
      ...(kind === "skill" ? [] : (this.#catalog?.inventory ?? []).map(tool => ({
        id: `tool:${tool.name}`, kind: "tool", name: tool.name, description: tool.description.slice(0, 300), toolsets: tool.toolsets,
        ...(tool.availability !== "available" ? { setup_note: "Check capability setup and current availability before requesting exposure." } : {}),
        state: tool.availability !== "available" ? tool.availability : !tool.schemaEligible ? "provider_schema_restricted" : this.#active.has(tool.name) ? "exposed" : "not_selected"
      }))),
      ...(kind === "tool" ? [] : this.#skills.list().map(skill => ({
        id: `skill:${skill.name}`, kind: "skill", name: skill.name, description: skill.description.slice(0, 300), toolsets: skill.requiredToolsets ?? [],
        ...readinessSummary(buildSkillReadinessMetadata(skill, resolveSkillSetupContext(skill, this.#skillConfig[skill.name]))),
        state: this.#loadedSkills.has(skill.name) ? "loaded" : buildSkillReadinessMetadata(skill, resolveSkillSetupContext(skill, this.#skillConfig[skill.name])).readiness_status
      })))
    ].filter(entry => safeId(entry.id));
  }

  async discoverAsync(input: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    const standard = this.discover(input, context);
    if (!standard.ok || !isRecord(input) || (Array.isArray(input.ids) && input.ids.length > 0) || typeof input.query !== "string" || !input.query.trim() || !this.#routing) return standard;
    const token = this.#turn?.token;
    const revision = this.catalogRevision();
    const entries = this.#discoveryEntries(input.kind);
    // Use full registered descriptions for decisions; display metadata remains bounded.
    const candidates = entries.map(entry => ({ id: entry.id, description: `${entry.name}: ${entry.kind === "tool" ? this.#catalog?.inventory.find(tool => tool.name === entry.name)?.description : this.#skills.get(entry.name)?.description}` }));
    const decision = await evaluateCapabilities(this.#routing, candidates, {
      context: jevRoutingContext({ userRequest: this.#turn?.objective ?? input.query, continuity: this.#turn?.continuity, material: this.#turn?.objective ? [{ kind: "retrieved", text: `Agent discovery query (relevance hint only): ${input.query}` }] : [] }), signal: context?.signal,
      usage: { ...context?.providerUsageLineage, executionSessionId: context?.sessionId, visibleTurnId: context?.visibleTurnId, requestKey: `jev-discovery:${context?.toolCallId ?? "query"}` }
    }, "discovery", new Set((standard.metadata?.matches as Array<{ id: string }> | undefined)?.map(entry => entry.id) ?? []));
    if (token !== this.#turn?.token || !this.#inScope(context) || revision !== this.catalogRevision()) return failure("inactive_or_changed_scope");
    await this.#reportRouting?.(routingStatus("discovery", decision), context);
    if (token !== this.#turn?.token || !this.#inScope(context) || revision !== this.catalogRevision()) return failure("inactive_or_changed_scope");
    const summary = { schemaVersion: decision.schemaVersion, configurationRevision: decision.configurationRevision, configuredMode: decision.configuredMode, actualEngine: decision.actualEngine, partialFallback: decision.partialFallback, fallbackReason: decision.fallbackReason, model: decision.model, catalogRevision: decision.catalogRevision };
    if (decision.actualEngine !== "jev") {
      const fallback = this.discover(input, context);
      return { ...fallback, content: JSON.stringify({ ...fallback.metadata, routing: summary }), metadata: { ...fallback.metadata, routing: summary } };
    }
    const selected = new Map(decision.selections.filter(item => item.selected).map(item => [item.id, item.probability ?? 0]));
    const result = discoveryResult(entries.filter(entry => selected.has(entry.id)).sort((a, b) => selected.get(b.id)! - selected.get(a.id)! || a.id.localeCompare(b.id)));
    // Bounded diagnostics: complete decisions are used, only returned IDs are presented to the agent.
    return { ...result, content: JSON.stringify({ ...result.metadata, routing: summary }), metadata: { ...result.metadata, routing: summary } };
  }

  request(input: unknown, context?: ToolExecutionContext): ToolResult {
    if (!this.#inScope(context) || !context?.toolCallId) return failure("inactive_scope");
    if (!isRecord(input) || Object.keys(input).some((key) => !["ids", "reason"].includes(key)) || !validIds(input.ids) ||
      typeof input.reason !== "string" || input.reason.trim().length === 0 || input.reason.length > 300) return failure("invalid_request");
    const accepted: string[] = [];
    const results: Array<{ id: string; status: string }> = [];
    for (const id of new Set(input.ids)) {
      const status = this.#requestStatus(id);
      if (status === "queued") { this.#pending.add(id); accepted.push(id); }
      results.push({ id, status });
    }
    const result: ToolResult = { ok: true, content: JSON.stringify({ requests: results, applies: "next_iteration", grantsAuthority: false }), metadata: { requests: results } };
    if (accepted.length > 0) this.#receipts.set(result, { ids: accepted, callId: context.toolCallId, turn: this.#turn!.token });
    return result;
  }

  /** Only successful executions carrying the handler's exact result object qualify. */
  takeRequests(executions: readonly ToolExecutionRecord[]): CapabilityProposal[] {
    const proposals: CapabilityProposal[] = [];
    for (const execution of executions) {
      if (execution.tool.name !== "capability.request" || execution.decision !== "allow" || execution.result?.ok !== true) continue;
      const receipt = this.#receipts.get(execution.result);
      if (!receipt || receipt.turn !== this.#turn?.token || receipt.callId !== execution.toolCallId) continue;
      this.#receipts.delete(execution.result);
      for (const id of receipt.ids) proposals.push({ id, callId: receipt.callId });
    }
    this.#pending.clear();
    return proposals;
  }

  async toolSchema(id: string): Promise<OpenAICompatibleToolSchema | undefined> {
    if (!id.startsWith("tool:")) return undefined;
    const name = id.slice(5);
    const saved = this.#definitions.get(name);
    const live = this.#registry.get(name);
    if (!saved || live !== saved.instance || live.run !== saved.run || definitionSignature(live) !== saved.signature) return undefined;
    try { if (!await live.isAvailable()) return undefined; } catch { return undefined; }
    if (this.#registry.get(name) !== live || live.run !== saved.run || definitionSignature(live) !== saved.signature) return undefined;
    return this.#catalog?.entries.find((entry) => entry.tool.name === name)?.schema;
  }

  async applyRequests(proposals: readonly CapabilityProposal[], active: readonly OpenAICompatibleToolSchema[]): Promise<{
    tools: OpenAICompatibleToolSchema[]; applied: string[]; rejected: Array<{ id: string; reason: string }>; deferred?: string[];
  }> {
    let tools = [...active];
    const deferred: string[] = [];
    const protectedNames = new Set<string>([...CAPABILITY_RECOVERY_TOOLS, "config.provider.execution_status"]);
    const appliedNames = new Set<string>();
    const stagedTools = new Set(this.#stagedTools);
    const requestedSkills = new Map(this.#requestedSkills);
    const applied: string[] = [];
    const rejected: Array<{ id: string; reason: string }> = [];
    const token = this.#turn?.token;
    const revision = this.catalogRevision();
    const routingRevision = () => { try { const snapshot = this.#routing?.snapshot(); return snapshot ? `${snapshot.configurationRevision}:${snapshot.catalogRevision}` : ""; } catch { return "unavailable"; } };
    const routingAtStart = routingRevision();
    for (const { id } of proposals.slice(0, MAX_CAPABILITY_ADDITIONS)) {
      if (!token || this.#turn?.token !== token || this.roundsRemaining === 0) { rejected.push({ id, reason: "inactive_or_exhausted" }); continue; }
      const skill = id.startsWith("skill:") ? this.#skills.get(id.slice(6)) : undefined;
      const skillDefinition = skill === undefined ? undefined : this.#skillDefinitions.get(skill.name);
      if (skill && (!skillDefinition || skillDefinition.instance !== skill || skillSignature(skill) !== skillDefinition.signature)) { rejected.push({ id, reason: "unavailable_or_changed" }); continue; }
      if (id.startsWith("skill:") && (!skill || !("instructions" in skill))) { rejected.push({ id, reason: "instructions_unavailable" }); continue; }
      if (skill?.routing?.confirmation === "ask") { rejected.push({ id, reason: "confirmation_required" }); continue; }
      const schema = await this.toolSchema(skill ? "tool:skill.read" : id);
      if (this.#turn?.token !== token || this.#turn?.signal?.aborted || revision !== this.catalogRevision() || routingAtStart !== routingRevision()) return { tools: [...active], applied: [], rejected: [{ id, reason: "inactive_scope" }] };
      if (!schema) { rejected.push({ id, reason: "unavailable_or_changed" }); continue; }
      const alreadyExposed = tools.some((tool) => tool.function.name === schema.function.name);
      if (alreadyExposed && !skill) continue;
      const staged = stagedTools.has(id.slice(5));
      const budget = budgetProviderTools({ tools: alreadyExposed ? tools : staged ? [...tools.filter(tool => protectedNames.has(this.#catalog?.aliases.get(tool.function.name) ?? tool.function.name) || appliedNames.has(tool.function.name)), schema, ...tools] : [...tools, schema],
        priorityNames: new Set(staged ? [schema.function.name, ...tools.filter(tool => protectedNames.has(this.#catalog?.aliases.get(tool.function.name) ?? tool.function.name) || appliedNames.has(tool.function.name)).map(tool => tool.function.name)] : tools.map(tool => tool.function.name)) });
      if (!budget.tools.some((tool) => tool.function.name === schema.function.name)) { rejected.push({ id, reason: "schema_budget" }); continue; }
      if (!alreadyExposed) {
        for (const name of budget.omitted) {
          const canonical = this.#catalog?.aliases.get(name) ?? name;
          deferred.push(`tool:${canonical}`);
          stagedTools.add(canonical);
        }
        tools = budget.tools;
        appliedNames.add(schema.function.name);
      }
      if (skill) requestedSkills.set(skill.name, { instance: skill, signature: skillSignature(skill) });
      applied.push(id);
    }
    this.#stagedTools = stagedTools;
    this.#requestedSkills = requestedSkills;
    this.completeRound(applied.length > 0);
    this.setExposure(tools);
    return { tools, applied, rejected, ...(deferred.length ? { deferred } : {}) };
  }

  observeSkillRead(skill: LoadedSkill | SkillDefinition, result: ToolResult, input: { path?: string }, context?: ToolExecutionContext): void {
    const requested = this.#requestedSkills.get(skill.name);
    const mode = result.metadata?.mode;
    if (!this.#inScope(context) || !context?.toolCallId || input.path !== undefined || !result.ok || !requested ||
      this.#skills.get(skill.name) !== skill || requested.instance !== skill || requested.signature !== skillSignature(skill) ||
      !["complete", "contract", "full"].includes(String(mode)) || (mode === "full" && result.metadata?.truncated === true)) return;
    this.#skillReceipts.set(result, { content: result.content, turn: this.#turn!.token, receipt: {
      name: skill.name, origin: "capability-recovery", toolCallId: context.toolCallId,
      contentMode: mode as "complete" | "contract" | "full",
      readiness: result.metadata?.setup_needed === true ? "missing-setup" : "available",
      confirmationRequired: skill.routing?.confirmation === "ask"
    } });
  }

  takeSkillLoads(executions: readonly ToolExecutionRecord[]): Array<{ receipt: Omit<RecoveredSkillReceipt, "appliedIteration">; content: string }> {
    const loads: Array<{ receipt: Omit<RecoveredSkillReceipt, "appliedIteration">; content: string }> = [];
    for (const execution of executions) {
      if (execution.tool.name !== "skill.read" || execution.decision !== "allow" || !execution.result?.ok) continue;
      const saved = this.#skillReceipts.get(execution.result);
      if (!saved || saved.turn !== this.#turn?.token || saved.receipt.toolCallId !== execution.toolCallId || this.#loadedSkills.has(saved.receipt.name)) continue;
      const requested = this.#requestedSkills.get(saved.receipt.name);
      const current = this.#skills.get(saved.receipt.name);
      if (!requested || current !== requested.instance || skillSignature(current) !== requested.signature) continue;
      this.#skillReceipts.delete(execution.result);
      loads.push({ receipt: saved.receipt, content: saved.content });
    }
    return loads;
  }

  markSkillDelivered(name: string): void { this.#loadedSkills.add(name); }

  completeRound(applied: boolean): void { if (applied) this.#rounds++; }
  get roundsRemaining(): number { return Math.max(0, MAX_CAPABILITY_ROUNDS - this.#rounds); }

  #requestStatus(id: string): string {
    if (id.startsWith("tool:")) {
      const name = id.slice(5);
      const tool = this.#catalog?.inventory.find((entry) => entry.name === name);
      if (!tool) return "not_in_session";
      if (tool.availability !== "available") return tool.availability;
      if (!tool.schemaEligible) return "provider_schema_restricted";
      if (this.#active.has(name)) return "already_exposed";
    } else if (id.startsWith("skill:")) {
      const name = id.slice(6);
      if (!this.#skills.get(name)) return "not_in_session";
      if (this.#loadedSkills.has(name)) return "already_loaded";
      if (this.#requestedSkills.has(name)) return "already_requested";
    } else return "not_in_session";
    if (this.#pending.has(id)) return "already_pending";
    if (this.roundsRemaining === 0) return "round_limit";
    if (this.#pending.size >= MAX_CAPABILITY_ADDITIONS) return "round_size_limit";
    return "queued";
  }

  #inScope(context: ToolExecutionContext | undefined): boolean {
    return this.#catalog !== undefined && this.#turn !== undefined && context?.signal?.aborted !== true && this.#turn.signal?.aborted !== true &&
      context?.sessionId === this.#turn.sessionId && context?.profileId === this.#turn.profileId && context?.visibleTurnId === this.#turn.visibleTurnId;
  }
}

export function createCapabilityTools(recovery: SessionCapabilityRecovery): readonly RegisteredTool[] {
  return [
    { name: "capability.discover", description: "Find up to eight session-visible tools or skills. Metadata discovery does not authorize execution.",
      inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 200 }, ids: { type: "array", maxItems: 8, items: { type: "string" } }, kind: { type: "string", enum: ["tool", "skill"] } }, additionalProperties: false },
      run: (input: unknown, context?: ToolExecutionContext) => recovery.discoverAsync(input, context) },
    { name: "capability.request", description: "Request exact tool: or skill: IDs for the next iteration. No same-batch use, installation, or authorization. Use skill.read for instructions once exposed.",
      inputSchema: { type: "object", properties: { ids: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } }, reason: { type: "string", minLength: 1, maxLength: 300 } }, required: ["ids", "reason"], additionalProperties: false },
      run: (input: unknown, context?: ToolExecutionContext) => Promise.resolve(recovery.request(input, context)) }
  ].map((tool) => ({ ...tool, riskClass: "read-only-local", toolsets: ["core"], progressLabel: "checking session capabilities", maxResultSizeChars: 6000, isAvailable: () => true }));
}

export const capabilityToolProvider: SessionToolProvider = {
  name: "capability", kind: "session",
  createTools: (context) => context.capabilityRecovery ? createCapabilityTools(context.capabilityRecovery) : []
};

function isRecord(input: unknown): input is Record<string, unknown> { return input !== null && typeof input === "object" && !Array.isArray(input); }
function safeId(id: string): boolean { return /^(?:tool|skill):[\p{L}\p{N}_.:-]{1,128}$/u.test(id); }
function validIds(ids: unknown, allowEmpty = false): ids is string[] { return Array.isArray(ids) && (allowEmpty || ids.length > 0) && ids.length <= 8 && ids.every((id) => typeof id === "string" && safeId(id)); }
function failure(code: string): ToolResult { return { ok: false, content: `Capability recovery: ${code}`, metadata: { code } }; }
function definitionSignature(tool: RegisteredTool): string { return JSON.stringify([tool.name, tool.description, tool.inputSchema, tool.riskClass, tool.toolsets, tool.connector]); }

function skillSignature(skill: LoadedSkill | SkillDefinition): string { return createHash("sha256").update(JSON.stringify(skill)).digest("hex"); }

function discoveryResult(entries: readonly object[]): ToolResult {
  const matches = entries.slice(0, MAX_CAPABILITY_RESULTS);
  const metadata = { matches, truncated: entries.length > matches.length };
  return { ok: true, content: JSON.stringify(metadata), metadata };
}

function readinessSummary(readiness: ReturnType<typeof buildSkillReadinessMetadata>) {
  return { readiness_status: readiness.readiness_status, setup_needed: readiness.setup_needed, setup_note: readiness.setup_note };
}
