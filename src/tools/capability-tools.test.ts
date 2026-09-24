import { describe, expect, it } from "vitest";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import type { LoadedSkill } from "../contracts/skill.js";
import { createSkillTools } from "./skill-tools.js";
import { SKILL_READ_MAX_CHARS } from "../skills/skill-limits.js";
import { CHARS_PER_TOKEN } from "../prompt/token-estimator.js";
import type { ToolExecutionRecord } from "./tool-executor.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { ToolRegistry } from "./tool-registry.js";
import { buildProviderToolSchemaCatalog, MAX_PROVIDER_SCHEMA_TOKENS } from "./tool-schema.js";
import { createCapabilityTools, SessionCapabilityRecovery } from "./capability-tools.js";

const scope = { sessionId: "session", profileId: "profile", visibleTurnId: "turn", toolCallId: "call" };
function tool(name: string): RegisteredTool {
  return { name, description: "test capability", toolsets: ["test"], inputSchema: { type: "object" }, riskClass: "read-only-local", maxResultSizeChars: 1000, progressLabel: "test", isAvailable: () => true, run: async () => ({ ok: true, content: "done" }) };
}
function harness() {
  const registry = new ToolRegistry();
  const recovery = new SessionCapabilityRecovery({ registry, skills: new SkillRegistry() });
  for (const definition of [...Array.from({ length: 12 }, (_, i) => tool(`test.${i}`)), ...createCapabilityTools(recovery)]) registry.register(definition);
  const catalog = buildProviderToolSchemaCatalog({ tools: registry.list() });
  recovery.bindCatalog(catalog);
  recovery.beginTurn({ ...scope, tools: catalog.entries.filter((entry) => entry.tool.name.startsWith("capability.")).map((entry) => entry.schema) });
  return { registry, recovery, catalog };
}
function execution(result: ToolResult, overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return { tool: tool("capability.request"), input: {}, decision: "allow", riskClass: "read-only-local", result, toolCallId: scope.toolCallId, ...overrides };
}

describe("session capability recovery requests", () => {
  it("bounds discovery without exposing schemas, paths, or excluded entries", () => {
    const { recovery } = harness();
    const result = recovery.discover({ kind: "tool", query: "test" }, scope);
    expect(result.metadata?.matches).toHaveLength(8);
    expect(result.metadata?.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("inputSchema");
    expect(recovery.discover({ ids: ["tool:hidden"] }, scope).metadata?.matches).toEqual([]);
    expect(recovery.request({ ids: ["tool:hidden", "tool:unknown"], reason: "needed" }, scope).metadata?.requests).toEqual([
      { id: "tool:hidden", status: "not_in_session" }, { id: "tool:unknown", status: "not_in_session" }
    ]);
  });

  it("accepts only authentic successful receipts, not copied/spoofed metadata", () => {
    const { recovery } = harness();
    const result = recovery.request({ ids: ["tool:test.0"], reason: "needed" }, scope);
    expect(recovery.takeRequests([execution({ ...result }), execution(result, { tool: tool("web.extract") }), execution(result, { decision: "deny" }), execution(result, { toolCallId: "spoof" })])).toEqual([]);
    expect(recovery.takeRequests([execution(result)])).toEqual([{ id: "tool:test.0", callId: "call" }]);
    expect(recovery.takeRequests([execution(result)])).toEqual([]);
  });

  it("bounds and deduplicates parallel requests and resets across turns", async () => {
    const { recovery } = harness();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.resolve(recovery.request({ ids: [`tool:test.${i}`], reason: "needed" }, { ...scope, toolCallId: `call${i}` }))));
    expect(results[8]?.metadata?.requests).toEqual([{ id: "tool:test.8", status: "round_size_limit" }]);
    expect(recovery.request({ ids: ["tool:test.0"], reason: "again" }, scope).metadata?.requests).toEqual([{ id: "tool:test.0", status: "already_pending" }]);
    recovery.endTurn();
    recovery.beginTurn({ ...scope, visibleTurnId: "new", tools: [] });
    expect(recovery.takeRequests(results.map((result, i) => execution(result, { toolCallId: `call${i}` })))).toEqual([]);
  });

  it("rejects malformed, cross-profile and stale-scope requests", () => {
    const { recovery } = harness();
    for (const input of [null, { ids: ["tool:test.0"], reason: "" }, { ids: ["tool:test.0"], reason: "ok", approved: true }, { ids: ["tool:/private/path"], reason: "ok" }]) expect(recovery.request(input, scope).ok).toBe(false);
    expect(recovery.request({ ids: ["tool:test.0"], reason: "needed" }, { ...scope, profileId: "other" }).ok).toBe(false);
    expect(recovery.request({ ids: ["tool:test.0"], reason: "needed" }, { ...scope, visibleTurnId: "old" }).ok).toBe(false);
  });

  it("rechecks availability, schema changes, and registration identity", async () => {
    const { recovery, registry } = harness();
    expect(await recovery.toolSchema("tool:test.0")).toBeDefined();
    registry.get("test.0")!.inputSchema = { type: "object", properties: { injected: { type: "string" } } };
    expect(await recovery.toolSchema("tool:test.0")).toBeUndefined();
    registry.get("test.1")!.isAvailable = () => false;
    expect(await recovery.toolSchema("tool:test.1")).toBeUndefined();
    registry.unregister("test.2"); registry.register(tool("test.2"));
    expect(await recovery.toolSchema("tool:test.2")).toBeUndefined();
    registry.get("test.3")!.run = async () => ({ ok: true, content: "changed handler" });
    expect(await recovery.toolSchema("tool:test.3")).toBeUndefined();
    registry.get("test.4")!.isAvailable = async () => {
      registry.get("test.4")!.riskClass = "workspace-write";
      return true;
    };
    expect(await recovery.toolSchema("tool:test.4")).toBeUndefined();
  });

  it("enforces two rounds and does not charge duplicates", () => {
    const { recovery } = harness();
    recovery.completeRound(false);
    expect(recovery.roundsRemaining).toBe(2);
    recovery.completeRound(true); recovery.completeRound(true);
    expect(recovery.request({ ids: ["tool:test.0"], reason: "needed" }, scope).metadata?.requests).toEqual([{ id: "tool:test.0", status: "round_limit" }]);
  });
});


it("applies at most eight additions per round, preserving active tools and budget", async () => {
  const { recovery, catalog } = harness();
  const active = catalog.entries.filter((entry) => entry.tool.name.startsWith("capability.")).map((entry) => entry.schema);
  const result = recovery.request({ ids: Array.from({ length: 8 }, (_, i) => `tool:test.${i}`), reason: "needed" }, scope);
  const first = await recovery.applyRequests(recovery.takeRequests([execution(result)]), active);
  expect(first.applied).toHaveLength(8);
  expect(first.tools).toHaveLength(10);
  const second = recovery.request({ ids: ["tool:test.8"], reason: "needed" }, scope);
  const expanded = await recovery.applyRequests(recovery.takeRequests([execution(second)]), first.tools);
  expect(expanded.applied).toEqual(["tool:test.8"]);
  expect(recovery.roundsRemaining).toBe(0);
  expect(recovery.request({ ids: ["tool:test.0"], reason: "repeat" }, scope).metadata?.requests).toEqual([{ id: "tool:test.0", status: "already_exposed" }]);
});

it("reports schema budget rejection without evicting active schemas or consuming a round", async () => {
  const { recovery, catalog } = harness();
  const active = Array.from({ length: 100 }, (_, i) => ({ ...catalog.tools[0]!, function: { ...catalog.tools[0]!.function, name: `active_${i}` } }));
  const result = recovery.request({ ids: ["tool:test.0"], reason: "needed" }, scope);
  const expansion = await recovery.applyRequests(recovery.takeRequests([execution(result)]), active);
  expect(expansion.tools).toEqual(active);
  expect(expansion.rejected).toEqual([{ id: "tool:test.0", reason: "schema_budget" }]);
  expect(recovery.roundsRemaining).toBe(2);
});

it("enforces the serialized schema token ceiling even below the tool count limit", async () => {
  const { recovery, catalog } = harness();
  const active = [{ ...catalog.tools[0]!, function: { ...catalog.tools[0]!.function, name: "active", description: "" } }];
  active[0]!.function.description = "x".repeat(MAX_PROVIDER_SCHEMA_TOKENS * CHARS_PER_TOKEN - JSON.stringify(active).length - 5);
  const result = recovery.request({ ids: ["tool:test.1"], reason: "needed" }, scope);
  const expansion = await recovery.applyRequests(recovery.takeRequests([execution(result)]), active);
  expect(expansion.tools).toEqual(active);
  expect(expansion.rejected).toEqual([{ id: "tool:test.1", reason: "schema_budget" }]);
  expect(recovery.roundsRemaining).toBe(2);
});

function skillHarness(overrides: Partial<LoadedSkill> = {}) {
  const skill: LoadedSkill = {
    name: "research", description: "Research workflow", version: "1", whenToUse: [],
    requiredToolsets: ["files"], optionalToolsets: ["terminal"], playbook: [],
    permissionExpectations: [], examples: [], evaluations: [],
    sourcePath: "/unused/research/SKILL.md", sourceKind: "local", sourceRoot: "/unused",
    instructions: "Read primary sources and synthesize findings.", ...overrides
  };
  const skills = new SkillRegistry();
  skills.register(skill);
  const registry = new ToolRegistry();
  const recovery = new SessionCapabilityRecovery({ registry, skills });
  const read = createSkillTools({ registry: skills, localSkillsRoot: "/unused", capabilityRecovery: recovery }).find((entry) => entry.name === "skill.read")!;
  for (const entry of [read, ...createCapabilityTools(recovery)]) registry.register(entry);
  const catalog = buildProviderToolSchemaCatalog({ tools: registry.list() });
  recovery.bindCatalog(catalog);
  recovery.beginTurn({ ...scope, tools: [] });
  return { recovery, skill, read, request: async () => {
    const result = recovery.request({ ids: ["skill:research"], reason: "Use research instructions" }, scope);
    return recovery.applyRequests(recovery.takeRequests([execution(result)]), []);
  }, readRecord: async (input = { name: "research" }): Promise<ToolExecutionRecord> =>
    execution(await read.run(input, scope), { tool: read }) };
}

describe("recovered skill instruction receipts", () => {
  it("respects confirmation requirements without exposing tools or consuming a round", async () => {
    const h = skillHarness({ routing: { labels: [], triggerPatterns: [], confirmation: "ask" } });
    expect(await h.request()).toMatchObject({ tools: [], applied: [], rejected: [{ id: "skill:research", reason: "confirmation_required" }] });
    expect(h.recovery.roundsRemaining).toBe(2);
    expect(h.recovery.takeSkillLoads([await h.readRecord()])).toEqual([]);
  });

  it("reports missing setup while loading instructions, without activating toolsets", async () => {
    const h = skillHarness({ configFields: [{ key: "endpoint", required: true }] });
    expect(h.recovery.discover({ kind: "skill" }, scope).metadata?.matches).toEqual([
      { id: "skill:research", kind: "skill", name: "research", state: "missing-setup" }
    ]);
    const expansion = await h.request();
    expect(expansion.tools.map((entry) => entry.function.name)).toEqual(["skill_read"]);
    const loads = h.recovery.takeSkillLoads([await h.readRecord()]);
    expect(loads).toHaveLength(1);
    expect(loads[0]?.receipt).toMatchObject({ name: "research", readiness: "missing-setup", contentMode: "complete" });
    expect(loads[0]?.content).toContain(h.skill.instructions);
    expect(h.recovery.discover({ kind: "skill" }, scope).metadata?.matches).not.toContainEqual(expect.objectContaining({ state: "loaded" }));
    h.recovery.markSkillDelivered("research");
    expect(h.recovery.request({ ids: ["skill:research"], reason: "again" }, scope).metadata?.requests).toEqual([{ id: "skill:research", status: "already_loaded" }]);
  });

  it("rejects forged, denied, stale, duplicate, and unrequested read receipts", async () => {
    const h = skillHarness();
    expect(h.recovery.takeSkillLoads([await h.readRecord()])).toEqual([]);
    await h.request();
    const record = await h.readRecord();
    expect(h.recovery.takeSkillLoads([
      { ...record, result: { ...record.result! } }, { ...record, decision: "deny" },
      { ...record, toolCallId: "spoof" }, { ...record, tool: tool("web.extract") }
    ])).toEqual([]);
    expect(h.recovery.takeSkillLoads([record, record])).toHaveLength(1);
    const stale = await h.readRecord();
    h.recovery.endTurn();
    h.recovery.beginTurn({ ...scope, visibleTurnId: "new", tools: [] });
    expect(h.recovery.takeSkillLoads([stale])).toEqual([]);
  });

  it("rejects changed definitions at expansion and after instruction read", async () => {
    const h = skillHarness();
    h.skill.instructions += "changed";
    expect((await h.request()).rejected).toEqual([{ id: "skill:research", reason: "unavailable_or_changed" }]);
    const stable = skillHarness();
    await stable.request();
    const record = await stable.readRecord();
    stable.skill.instructions += "changed";
    expect(stable.recovery.takeSkillLoads([record])).toEqual([]);
  });

  it("does not count metadata, resource reads, failed reads, or truncated full instructions", async () => {
    const h = skillHarness({ instructions: "x".repeat(SKILL_READ_MAX_CHARS + 100) });
    await h.request();
    const full = await h.read.run({ name: "research", mode: "full" }, scope);
    expect(full.metadata?.truncated).toBe(true);
    expect(h.recovery.takeSkillLoads([execution(full, { tool: h.read })])).toEqual([]);
    for (const mode of ["metadata-only", "reference"]) {
      const result = { ok: true, content: "metadata", metadata: { mode } };
      h.recovery.observeSkillRead(h.skill, result, {}, scope);
      expect(h.recovery.takeSkillLoads([execution(result, { tool: h.read })])).toEqual([]);
    }
    const resource = { ok: true, content: "resource", metadata: { mode: "complete" } };
    h.recovery.observeSkillRead(h.skill, resource, { path: "references/guide.md" }, scope);
    expect(h.recovery.takeSkillLoads([execution(resource, { tool: h.read })])).toEqual([]);
    expect(h.recovery.takeSkillLoads([await h.readRecord({ name: "hidden" })])).toEqual([]);
    expect(h.recovery.request({ ids: ["skill:hidden", "skill:unknown"], reason: "needed" }, scope).metadata?.requests).toEqual([
      { id: "skill:hidden", status: "not_in_session" }, { id: "skill:unknown", status: "not_in_session" }
    ]);
  });
});
