import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  DEFAULT_ENVIRONMENT_TYPE,
  assessSecurityPolicy,
  type EnvironmentType,
  type SecurityDecision,
  type SecurityPolicy
} from "../contracts/security.js";
import type { SessionDB } from "../contracts/session.js";
import type { ToolApprovalHandler, ToolDefinition, ToolExecutionContext, ToolResult, ToolRiskClass, ToolSecurityResolution, ToolsetName } from "../contracts/tool.js";
import type { RuntimeEventSink } from "../contracts/runtime-event.js";
import type { ProviderUsageLineage } from "../contracts/provider-usage.js";
import type { VisionDispatchPhase, VisionInputProvenanceContext } from "../contracts/vision.js";
import type { SecureInputKind, SecureInputRequestHandler } from "../contracts/secure-input.js";
import { assessCommandSafety } from "../security/command-safety.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { DelegateCallBudget } from "../delegation/delegate-call-budget.js";
import { buildToolSecurityTargetSummary } from "./tool-target-summary.js";

const MAX_STORED_TOOL_RESULT_CHARS = 12_000;
const MAX_CONTEXT_SUMMARY_CHARS = 500;
const SENSITIVE_KEY_RE = /apiKey|api[_-]?key|password|passwd|token|secret|credential|authorization|(?:^|[_-])auth(?:$|[_-])/i;
const REDACTED_SECRET_VALUE = "[REDACTED]";
const REDACTED_CDP_EXPRESSION = "[REDACTED_CDP_EXPRESSION]";
const REDACTED_PROVIDER_ARGUMENTS = "[REDACTED_PROVIDER_ARGUMENTS]";
const SENSITIVE_QUERY_PARAM_VALUE_RE = /(^|[?&;\s])((?:token|access_token|refresh_token|id_token|api_key|key|password|passwd|secret|client_secret|auth|authorization)=)([^&;\s"'<>)[\][]+)/giu;
const SENSITIVE_FIELD_VALUE_RE = /(^|["'{,\s])([A-Za-z0-9_-]*(?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|secret|client[_-]?secret|credential)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)([^"',\s}\]\[]+)/giu;
const AUTH_FIELD_VALUE_RE = /(^|["'{,\s])(auth["']?\s*[:=]\s*["']?)([^"',\s}\]\[]+)/giu;
const AUTHORIZATION_FIELD_VALUE_RE = /(^|["'{,\s])(authorization["']?\s*[:=]\s*["']?)(?!(?:bearer|basic)\s)([^"',\s}\]\[]+)/giu;
const AUTH_VALUE_RE = /\b((?:authorization\s*:\s*)?(?:bearer|basic)\s+)([\w.\-~+/]+=*)/giu;
const TOKEN_PREFIX_RE = /\b(?:sk-ant-|sk-proj-|sk-|ghp_|github_pat_)[A-Za-z0-9_\-]+/gu;
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/giu;

export type ToolExecutionRequest = {
  toolset: ToolsetName;
  input: Record<string, unknown>;
  trustedWorkspace: boolean;
  sessionId: string;
  environmentType?: EnvironmentType;
  excludedTools?: string[];
  providerUsageLineage?: ProviderUsageLineage;
  visionInputProvenance?: VisionInputProvenanceContext;
  visionDispatchPhase?: VisionDispatchPhase;
  signal?: AbortSignal;
  onApprovalRequest?: ToolApprovalHandler;
  onSecureInputRequest?: SecureInputRequestHandler;
};

export type NamedToolExecutionRequest = {
  tool: string;
  input: Record<string, unknown>;
  trustedWorkspace: boolean;
  sessionId: string;
  environmentType?: EnvironmentType;
  toolCallId?: string;
  visibleTurnId?: string;
  providerUsageLineage?: ProviderUsageLineage;
  visionInputProvenance?: VisionInputProvenanceContext;
  visionDispatchPhase?: VisionDispatchPhase;
  toolCallName?: string;
  providerNativeToolCall?: unknown;
  signal?: AbortSignal;
  onEvent?: RuntimeEventSink;
  onApprovalRequest?: ToolApprovalHandler;
  onSecureInputRequest?: SecureInputRequestHandler;
  delegateCallBudget?: DelegateCallBudget;
  readLedger?: ToolReadLedger;
  readLedgerScope?: ToolReadLedgerScope;
};

export type ToolReadLedgerScope = {
  profileId: string;
  sessionId: string;
};

export type ToolReadLedger = {
  reuse(input: {
    scope: ToolReadLedgerScope;
    tool: ToolDefinition;
    input: Record<string, unknown>;
    toolCallId?: string;
  }): ToolResult | undefined;
  observe(input: {
    scope: ToolReadLedgerScope;
    execution: ToolExecutionRecord;
  }): void;
};

export type ToolExecutionRecord = {
  tool: ToolDefinition;
  input?: Record<string, unknown>;
  decision: SecurityDecision;
  riskClass: ToolRiskClass;
  targetKey?: string;
  targetSummary?: string;
  result?: ToolResult;
  toolCallId?: string;
  toolCallName?: string;
  providerNativeToolCall?: unknown;
};

export type ToolExecutorOptions = {
  registry: ToolRegistry;
  securityPolicy: SecurityPolicy;
  sessionDb: SessionDB;
  trajectoryRecorder: TrajectoryRecorder;
  workspaceRoot?: string;
};

export class ToolExecutor {
  readonly #registry: ToolRegistry;
  readonly #securityPolicy: SecurityPolicy;
  readonly #sessionDb: SessionDB;
  readonly #trajectoryRecorder: TrajectoryRecorder;
  readonly #workspaceRoot: string;

  constructor(options: ToolExecutorOptions) {
    this.#registry = options.registry;
    this.#securityPolicy = options.securityPolicy;
    this.#sessionDb = options.sessionDb;
    this.#trajectoryRecorder = options.trajectoryRecorder;
    this.#workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  }

  resetPerTurnBudgets(): void {
    // Kept as a no-op compatibility hook. Provider-turn budgets are owned by ToolPlanRunner.
  }

  async executeFirstAvailable(request: ToolExecutionRequest): Promise<ToolExecutionRecord | undefined> {
    const tools = await this.#availableToolsFor(request.toolset);
    const excludedTools = new Set(request.excludedTools ?? []);
    const tool = tools.find((candidate) => !excludedTools.has(candidate.name));

    if (tool === undefined) {
      return undefined;
    }

    return this.executeTool({
      tool: tool.name,
      input: request.input,
      trustedWorkspace: request.trustedWorkspace,
      sessionId: request.sessionId,
      environmentType: request.environmentType,
      providerUsageLineage: request.providerUsageLineage,
      visionInputProvenance: request.visionInputProvenance,
      visionDispatchPhase: request.visionDispatchPhase,
      signal: request.signal,
      onApprovalRequest: request.onApprovalRequest,
      onSecureInputRequest: request.onSecureInputRequest
    });
  }

  async executeTool(request: NamedToolExecutionRequest): Promise<ToolExecutionRecord | undefined> {
    const tool = this.#registry.get(request.tool);

    if (tool === undefined || !(await tool.isAvailable())) {
      return undefined;
    }

    const environmentType = request.environmentType ?? DEFAULT_ENVIRONMENT_TYPE;
    const baseRiskClass = classifyEffectiveRisk(tool, request.input, environmentType);
    const persistedCall = redactToolCallForPersistence(tool.name, request.input, request.providerNativeToolCall);
    const validationError = validateToolInput(tool, request.input);
    if (validationError !== undefined) {
      const result: ToolResult = {
        ok: false,
        content: `Invalid tool input: ${validationError}`
      };
      const storedResult = redactToolResultForPersistence(truncateToolResultForStorage(result));
      await this.#sessionDb.appendEvent(request.sessionId, {
        kind: "tool-result",
        tool: tool.name,
        result: storedResult,
        toolCallId: request.toolCallId,
        toolCallName: request.toolCallName,
        providerNativeToolCall: persistedCall.providerNativeToolCall
      });

      return {
        tool: toDefinition(tool),
        input: request.input,
        decision: "deny",
        riskClass: baseRiskClass,
        result,
        toolCallId: request.toolCallId,
        toolCallName: request.toolCallName,
        providerNativeToolCall: request.providerNativeToolCall
      };
    }

    let securityResolution: ToolSecurityResolution | undefined;
    try {
      securityResolution = await tool.resolveSecurity?.(request.input, {
        toolCallId: request.toolCallId,
        visibleTurnId: request.visibleTurnId,
        providerUsageLineage: request.providerUsageLineage,
        visionInputProvenance: request.visionInputProvenance,
        visionDispatchPhase: request.visionDispatchPhase,
        signal: request.signal,
        environmentType,
        onEvent: request.onEvent,
        trustedWorkspace: request.trustedWorkspace,
        sessionId: request.sessionId
      });
    } catch {
      return await this.#blockedSecurityResolution(request, tool, baseRiskClass);
    }
    const riskClass = moreRestrictiveRiskClass(baseRiskClass, securityResolution?.riskClass);
    if (tool.name === "delegate_task" && request.delegateCallBudget !== undefined) {
      const budget = request.delegateCallBudget.tryConsume();
      if (budget.allowed === false) {
        return await this.#blockedDelegateCallLimit(request, tool, riskClass, budget);
      }
    }

    const targetKey = securityResolution?.targetKey ?? await this.#buildSecurityTargetKey(tool.name, request.input);
    const targetSummary = securityResolution?.targetSummary ?? summarizeSecurityTarget(tool.name, request.input);
    const persistedTargetKey = redactPersistedString(targetKey);
    const persistedTargetSummary = redactPersistedString(targetSummary);
    const securityRequest = {
      riskClass,
      toolName: tool.name,
      targetKey: persistedTargetKey,
      targetSummary: persistedTargetSummary,
      command: typeof request.input.command === "string" ? request.input.command : undefined,
      environmentType,
      description: `run tool ${tool.name}`,
      context: {
        trustedWorkspace: request.trustedWorkspace,
        targetConversationIsActive: true,
        ...(securityResolution?.dataEgress === undefined
          ? {}
          : { dataEgress: securityResolution.dataEgress })
      }
    };
    let assessment = await assessSecurityPolicy(this.#securityPolicy, securityRequest);
    await this.#recordSecurityAssessment(request.sessionId, tool.name, riskClass, persistedTargetKey, persistedTargetSummary, assessment);

    if (assessment.decision === "ask" && request.onApprovalRequest !== undefined && !isAbortSignalAborted(request.signal)) {
      let operatorDecision: Awaited<ReturnType<ToolApprovalHandler>> = "denied";
      try {
        operatorDecision = await request.onApprovalRequest({
          tool: toDefinition(tool),
          input: structuredClone(request.input),
          riskClass,
          targetKey: persistedTargetKey,
          targetSummary: persistedTargetSummary,
          toolCallId: request.toolCallId,
          toolCallName: request.toolCallName
        });
      } catch {
        operatorDecision = "denied";
      }

      if (operatorDecision === "approved" && !isAbortSignalAborted(request.signal)) {
        assessment = await assessSecurityPolicy(this.#securityPolicy, securityRequest);
        await this.#recordSecurityAssessment(request.sessionId, tool.name, riskClass, persistedTargetKey, persistedTargetSummary, assessment);
        if (assessment.decision === "ask") {
          assessment = {
            ...assessment,
            decision: "deny",
            reason: "The approval did not authorize this exact tool call."
          };
        }
      } else {
        assessment = {
          ...assessment,
          decision: "deny",
          reason: isAbortSignalAborted(request.signal)
            ? "Tool approval was cancelled before execution."
            : "Tool approval was denied by the operator."
        };
      }
    }

    const decision = assessment.decision;

    if (decision !== "allow") {
      await this.#sessionDb.appendEvent(request.sessionId, {
        kind: "tool-gated",
        tool: tool.name,
        decision,
        riskClass
      });
      this.#trajectoryRecorder.record("tool-gated", {
        tool: tool.name,
        decision,
        riskClass
      });

      return {
        tool: toDefinition(tool),
        input: request.input,
        decision,
        riskClass,
        targetKey,
        targetSummary,
        toolCallId: request.toolCallId,
        toolCallName: request.toolCallName,
        providerNativeToolCall: request.providerNativeToolCall
      };
    }

    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "tool-called",
      tool: tool.name,
      input: persistedCall.input,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: persistedCall.providerNativeToolCall
    });
    this.#trajectoryRecorder.record("tool-call", {
      tool: tool.name,
      input: persistedCall.input
    });

    let result: ToolResult;
    const definition = toDefinition(tool);
    const reusableResult = request.readLedger === undefined || request.readLedgerScope === undefined
      ? undefined
      : request.readLedger.reuse({
          scope: request.readLedgerScope,
          tool: definition,
          input: request.input,
          toolCallId: request.toolCallId
        });

    if (request.signal?.aborted === true) {
      result = {
        ok: false,
        content: "Tool execution cancelled.",
        metadata: { reason: "cancelled" }
      };
    } else if (reusableResult !== undefined) {
      result = reusableResult;
    } else {
      try {
        const executionContext = {
          toolCallId: request.toolCallId,
          visibleTurnId: request.visibleTurnId,
          providerUsageLineage: request.providerUsageLineage,
          visionInputProvenance: request.visionInputProvenance,
          visionDispatchPhase: request.visionDispatchPhase,
          securityResolution,
          signal: request.signal,
          environmentType,
          onEvent: request.onEvent,
          onApprovalRequest: tool.name === "execute_code" ? request.onApprovalRequest : undefined,
          onSecureInputRequest: request.onSecureInputRequest
        };
        result = await runToolWithProtectedArguments(tool, request.input, executionContext);
      } catch (error) {
        if (request.signal?.aborted) {
          result = {
            ok: false,
            content: "Tool execution cancelled.",
            metadata: { reason: "cancelled" }
          };
        } else {
          const message = error instanceof Error ? error.message : "Unknown error";
          result = {
            ok: false,
            content: `Tool execution failed: ${message}`,
            metadata: { reason: "error" }
          };
        }
      }
    }

    const storedResult = redactToolResultForPersistence(truncateToolResultForStorage(result));
    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "tool-result",
      tool: tool.name,
      result: storedResult,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: persistedCall.providerNativeToolCall
    });
    await this.#sessionDb.appendMessage({
      sessionId: request.sessionId,
      role: "tool",
      content: storedResult.content,
      metadata: {
        tool: tool.name,
        tool_call_id: request.toolCallId,
        tool_call_name: request.toolCallName,
        provider_native_tool_call: persistedCall.providerNativeToolCall,
        ok: result.ok,
        truncated: storedResult.metadata?.truncatedForStorage,
        ...contextSummaryMetadata(storedResult.metadata)
      }
    });
    this.#trajectoryRecorder.record("tool-result", {
      tool: tool.name,
      result: storedResult
    });

    const execution: ToolExecutionRecord = {
      tool: definition,
      input: request.input,
      decision,
      riskClass,
      targetKey,
      targetSummary,
      result,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: request.providerNativeToolCall
    };
    if (request.readLedger !== undefined && request.readLedgerScope !== undefined) {
      request.readLedger.observe({
        scope: request.readLedgerScope,
        execution
      });
    }
    return execution;
  }

  getToolDefinition(name: string): ToolDefinition | undefined {
    const tool = this.#registry.get(name);

    return tool === undefined ? undefined : toDefinition(tool);
  }

  async #recordSecurityAssessment(
    sessionId: string,
    toolName: string,
    riskClass: ToolRiskClass,
    targetKey: string | undefined,
    targetSummary: string | undefined,
    assessment: Awaited<ReturnType<typeof assessSecurityPolicy>>
  ): Promise<void> {
    await this.#sessionDb.appendEvent(sessionId, {
      kind: "security-assessed",
      tool: toolName,
      riskClass,
      targetKey,
      targetSummary,
      assessment
    });
    this.#trajectoryRecorder.record("progress", {
      message: `security assessed for ${toolName}`,
      tool: toolName,
      decision: assessment.decision,
      mode: assessment.mode,
      reason: assessment.reason,
      riskClass
    });
  }

  async #availableToolsFor(toolset: ToolsetName) {
    const tools = this.#registry.getRegisteredByToolset(toolset);
    const available = [];

    for (const tool of tools) {
      if (await tool.isAvailable()) {
        available.push(tool);
      }
    }

    return available;
  }

  async #buildSecurityTargetKey(toolName: string, input: Record<string, unknown>): Promise<string | undefined> {
    const canonicalRoot = await realpath(this.#workspaceRoot).catch(() => this.#workspaceRoot);

    if (toolName === "terminal.run" || toolName === "process.start") {
      if (typeof input.command !== "string") {
        return undefined;
      }

      const command = normalizeCommandKey(input.command);
      const executable = extractExecutable(command);
      return `${toolName}:cwd=${normalizePathKey(canonicalRoot)}:exec=${executable}:cmd=${command}`;
    }

    if (toolName.startsWith("file.")) {
      const rawPath = typeof input.path === "string"
        ? input.path
        : typeof input.file_path === "string"
          ? input.file_path
          : undefined;
      if (rawPath === undefined) {
        return undefined;
      }

      const allowMissingLeaf = toolName === "file.write";
      const canonicalTarget = await canonicalWorkspaceTarget(this.#workspaceRoot, canonicalRoot, rawPath, { allowMissingLeaf });
      return canonicalTarget === undefined
        ? `${toolName}:path:${normalizePathKey(rawPath)}`
        : `${toolName}:path:${normalizePathKey(canonicalTarget)}`;
    }

    if (typeof input.url === "string") {
      return `${toolName}:url:${normalizeUrlKey(input.url)}`;
    }

    if (typeof input.path === "string") {
      return `${toolName}:path:${normalizePathKey(input.path)}`;
    }

    if (typeof input.file_path === "string") {
      return `${toolName}:path:${normalizePathKey(input.file_path)}`;
    }

    return undefined;
  }

  async #blockedDelegateCallLimit(
    request: NamedToolExecutionRequest,
    tool: import("../contracts/tool.js").RegisteredTool,
    riskClass: ToolRiskClass,
    budget: { limit: number; skippedCount: number; used: number }
  ): Promise<ToolExecutionRecord> {
    const result: ToolResult = {
      ok: false,
      content: `delegate_task call skipped because this provider turn reached maxDelegateCallsPerTurn (${budget.limit}).`,
      metadata: {
        reason: "delegate-call-limit",
        status: "skipped",
        limit: budget.limit,
        skippedCount: budget.skippedCount,
        used: budget.used
      }
    };
    const persistedCall = redactToolCallForPersistence(tool.name, request.input, request.providerNativeToolCall);
    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "tool-result",
      tool: tool.name,
      result,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: persistedCall.providerNativeToolCall
    });
    await this.#sessionDb.appendMessage({
      sessionId: request.sessionId,
      role: "tool",
      content: result.content,
      metadata: {
        tool: tool.name,
        tool_call_id: request.toolCallId,
        tool_call_name: request.toolCallName,
        provider_native_tool_call: persistedCall.providerNativeToolCall,
        ok: false,
        reason: "delegate-call-limit",
        skippedCount: budget.skippedCount,
        limit: budget.limit
      }
    });

    return {
      tool: toDefinition(tool),
      input: request.input,
      decision: "deny",
      riskClass,
      result,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: request.providerNativeToolCall
    };
  }

  async #blockedSecurityResolution(
    request: NamedToolExecutionRequest,
    tool: import("../contracts/tool.js").RegisteredTool,
    riskClass: ToolRiskClass
  ): Promise<ToolExecutionRecord> {
    const targetSummary = "dynamic tool security preflight failed";
    const assessment = {
      decision: "deny" as const,
      mode: "strict" as const,
      reason: "Tool security preflight failed closed before execution.",
      risk: "high" as const,
      deterministicRule: "tool-security-preflight-failed",
      assessor: { used: false as const, status: "disabled" as const }
    };
    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "security-assessed",
      tool: tool.name,
      riskClass,
      targetSummary,
      assessment
    });
    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "tool-gated",
      tool: tool.name,
      decision: "deny",
      riskClass
    });
    this.#trajectoryRecorder.record("tool-gated", {
      tool: tool.name,
      decision: "deny",
      riskClass
    });
    return {
      tool: toDefinition(tool),
      input: request.input,
      decision: "deny",
      riskClass,
      targetSummary,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: request.providerNativeToolCall
    };
  }
}

async function runToolWithProtectedArguments(
  tool: import("../contracts/tool.js").RegisteredTool,
  input: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const declarations = tool.protectedArguments ?? [];
  const protectedArguments = declarations.flatMap((declaration) => {
    const envelope = getAtPath(input, declaration.path);
    return isProtectedInputEnvelope(envelope) ? [{ declaration, envelope }] : [];
  });
  if (protectedArguments.length === 0) return await tool.run(input, context);
  if (protectedArguments.length > 1) {
    return protectedArgumentFailure("Only one protected argument may be supplied per tool call.");
  }
  if (context.onSecureInputRequest === undefined) {
    return protectedArgumentFailure("Protected tool arguments are unavailable on this runtime.");
  }

  const [{ declaration, envelope }] = protectedArguments;
  const descriptor = parseProtectedArgumentDescriptor(envelope.protectedInput, tool.name, declaration.path);
  if (descriptor === undefined) {
    return protectedArgumentFailure("Protected tool argument metadata is invalid.");
  }
  let dispatchedResult: ToolResult | undefined;
  const destination = declaration.destination === undefined
    ? { type: "tool-argument" as const, toolName: tool.name, argumentPath: declaration.path }
    : {
        type: "mcp-argument" as const,
        serverId: declaration.destination.serverId,
        toolName: declaration.destination.toolName,
        argumentPath: declaration.path
      };
  const receipt = await context.onSecureInputRequest({
    kind: descriptor.kind,
    purpose: descriptor.purpose,
    retention: "use-once",
    destination
  }, async (value) => {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
    const dispatchedInput = structuredClone(input);
    setAtPath(dispatchedInput, declaration.path, decoded);
    try {
      dispatchedResult = redactExactSecret(await tool.run(dispatchedInput, {
        ...context,
        onSecureInputRequest: undefined
      }), decoded);
    } catch {
      throw new Error("Protected tool argument dispatch failed.");
    }
  }).catch(() => undefined);

  if (receipt?.status !== "delivered" || dispatchedResult === undefined) {
    return protectedArgumentFailure(receipt === undefined
      ? "Protected tool argument delivery failed."
      : `Protected tool argument ${receipt.status}: ${receipt.reason ?? "delivery did not complete."}`);
  }
  return dispatchedResult;
}

function getAtPath(input: Record<string, unknown>, path: string): unknown {
  if (!isSafeProtectedArgumentPath(path)) return undefined;
  let current: unknown = input;
  for (const segment of path.split(".")) {
    if (!isObjectRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function setAtPath(input: Record<string, unknown>, path: string, value: string): void {
  if (!isSafeProtectedArgumentPath(path)) throw new Error("Protected argument path is invalid.");
  const segments = path.split(".");
  let current = input;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!isObjectRecord(next)) throw new Error("Protected argument path changed before dispatch.");
    current = next;
  }
  current[segments.at(-1) as string] = value;
}

function isSafeProtectedArgumentPath(path: string): boolean {
  return path.split(".").every((segment) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/u.test(segment) &&
    segment !== "__proto__" && segment !== "prototype" && segment !== "constructor"
  );
}

function parseProtectedArgumentDescriptor(
  value: Record<string, unknown>,
  toolName: string,
  argumentPath: string
): { kind: SecureInputKind; purpose: string } | undefined {
  if (!SECURE_INPUT_KINDS.has(value.kind as SecureInputKind)) return undefined;
  if (value.retention !== undefined && value.retention !== "use-once") return undefined;
  const purpose = typeof value.purpose === "string" && value.purpose.trim().length > 0 && value.purpose.length <= 500
    ? value.purpose.trim()
    : `Provide protected argument ${argumentPath} to ${toolName}`;
  return { kind: value.kind as SecureInputKind, purpose };
}

function redactExactSecret(result: ToolResult, secret: string): ToolResult {
  if (secret.length === 0) return result;
  return replaceExactSecret(result, secret) as ToolResult;
}

function replaceExactSecret(value: unknown, secret: string): unknown {
  if (typeof value === "string") return value.split(secret).join("[PROTECTED_INPUT]");
  if (Array.isArray(value)) return value.map((entry) => replaceExactSecret(entry, secret));
  if (!isObjectRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceExactSecret(entry, secret)]));
}

function protectedArgumentFailure(content: string): ToolResult {
  return { ok: false, content, metadata: { reason: "protected-tool-argument-unavailable" } };
}

const SECURE_INPUT_KINDS = new Set<SecureInputKind>([
  "account-identifier", "password", "one-time-code", "api-key", "client-secret", "access-token",
  "private-key", "recovery-code", "generic-secret"
]);

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function classifyEffectiveRisk(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  environmentType: EnvironmentType = DEFAULT_ENVIRONMENT_TYPE
): ToolRiskClass {
  if ((tool.name === "terminal.run" || tool.name === "process.start") && typeof input.command === "string") {
    const assessment = assessCommandSafety(input.command, { environmentType });
    if (assessment.riskClass !== undefined) {
      return assessment.riskClass;
    }
  }

  return tool.riskClass;
}

function moreRestrictiveRiskClass(
  base: ToolRiskClass,
  dynamic: ToolRiskClass | undefined
): ToolRiskClass {
  if (dynamic === undefined) return base;
  return toolRiskRank(dynamic) > toolRiskRank(base) ? dynamic : base;
}

function toolRiskRank(value: ToolRiskClass): number {
  switch (value) {
    case "read-only-local": return 0;
    case "read-only-network": return 1;
    case "workspace-write": return 2;
    case "shared-state-mutation": return 3;
    case "external-side-effect": return 4;
    case "credential-access": return 5;
    case "destructive-local": return 6;
    case "spend-money": return 7;
    case "sandbox-escape": return 8;
  }
}

function validateToolInput(tool: ToolDefinition, input: Record<string, unknown>): string | undefined {
  if (containsProtectedInputPlaintextConflict(input)) {
    return "protected input cannot include a plaintext 'text' value";
  }
  const schema = tool.inputSchema;
  if (!isObjectRecord(schema)) {
    return undefined;
  }

  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  for (const key of required) {
    if (!(key in input)) {
      return `missing required field '${key}'`;
    }
  }

  const properties = isObjectRecord(schema.properties) ? schema.properties : {};
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!isObjectRecord(property) || !("type" in property)) {
      continue;
    }

    const expected = property.type;
    if (typeof expected !== "string") {
      continue;
    }

    if (!matchesJsonSchemaPrimitive(value, expected)) {
      return `field '${key}' must be ${expected}`;
    }
  }

  return undefined;
}

function matchesJsonSchemaPrimitive(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isObjectRecord(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateToolResultForStorage(result: ToolResult): ToolResult {
  if (result.content.length <= MAX_STORED_TOOL_RESULT_CHARS) {
    return result;
  }

  return {
    ...result,
    content: `${result.content.slice(0, MAX_STORED_TOOL_RESULT_CHARS)}\n[truncated ${result.content.length - MAX_STORED_TOOL_RESULT_CHARS} chars before session storage]`,
    metadata: {
      ...result.metadata,
      truncatedForStorage: true,
      originalChars: result.content.length
    }
  };
}

function toDefinition(tool: ToolDefinition): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    riskClass: tool.riskClass,
    toolsets: [...tool.toolsets],
    progressLabel: tool.progressLabel,
    maxResultSizeChars: tool.maxResultSizeChars,
    requiredConfig: tool.requiredConfig === undefined ? undefined : [...tool.requiredConfig]
  };
}

export const summarizeSecurityTarget = buildToolSecurityTargetSummary;

function redactToolCallForPersistence(
  toolName: string,
  input: Record<string, unknown>,
  providerNativeToolCall: unknown
): {
  input: Record<string, unknown>;
  providerNativeToolCall: unknown;
} {
  return {
    input: redactToolInputForPersistence(toolName, input),
    providerNativeToolCall: redactProviderNativeToolCallForPersistence(toolName, providerNativeToolCall)
  };
}

function redactToolInputForPersistence(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactValue(input) as Record<string, unknown>;
  return redactCdpInputForPersistence(toolName, redacted);
}

function redactToolResultForPersistence(result: ToolResult): ToolResult {
  return {
    ...result,
    content: redactPersistedText(result.content),
    metadata: result.metadata === undefined ? undefined : redactValue(result.metadata) as ToolResult["metadata"]
  };
}

function contextSummaryMetadata(metadata: ToolResult["metadata"] | undefined): {
  _estacoda_context_summary?: string;
} {
  const summary = metadata?._estacoda_context_summary;
  if (typeof summary !== "string") {
    return {};
  }
  const trimmed = summary.trim();
  if (trimmed.length === 0) {
    return {};
  }
  return {
    _estacoda_context_summary: truncate(trimmed, MAX_CONTEXT_SUMMARY_CHARS)
  };
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactPersistedText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (isProtectedInputEnvelope(value)) {
    return redactProtectedInputEnvelope(value);
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (isProtectedInputEnvelope(val)) {
      result[key] = redactProtectedInputEnvelope(val);
    } else if (SENSITIVE_KEY_RE.test(key)) {
      result[key] = REDACTED_SECRET_VALUE;
    } else if (typeof val === "object" && val !== null) {
      result[key] = redactValue(val);
    } else if (typeof val === "string") {
      result[key] = redactPersistedText(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function containsProtectedInputPlaintextConflict(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsProtectedInputPlaintextConflict);
  if (!isObjectRecord(value)) return false;
  if (isObjectRecord(value.protectedInput) && typeof value.text === "string") return true;
  return Object.values(value).some(containsProtectedInputPlaintextConflict);
}

function isProtectedInputEnvelope(value: unknown): value is Record<string, unknown> & {
  protectedInput: Record<string, unknown>;
} {
  return isObjectRecord(value) && isObjectRecord(value.protectedInput);
}

function redactProtectedInputEnvelope(value: Record<string, unknown> & {
  protectedInput: Record<string, unknown>;
}): Record<string, unknown> {
  const metadata = value.protectedInput;
  return {
    ...(typeof value.ref === "string" ? { ref: redactPersistedText(value.ref) } : {}),
    protectedInput: {
      ...(typeof metadata.kind === "string" ? { kind: redactPersistedText(metadata.kind) } : {}),
      ...(typeof metadata.purpose === "string" ? { purpose: redactPersistedText(metadata.purpose) } : {}),
      ...(typeof metadata.retention === "string" ? { retention: redactPersistedText(metadata.retention) } : {})
    }
  };
}

function redactProviderNativeToolCallForPersistence(toolName: string, value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  return redactProviderNativeValue(toolName, value);
}

function redactProviderNativeValue(toolName: string, value: unknown): unknown {
  if (typeof value === "string") {
    return redactPersistedText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactProviderNativeValue(toolName, entry));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isProviderArgumentKey(key)) {
      result[key] = redactProviderArgumentPayload(toolName, entry);
    } else if (SENSITIVE_KEY_RE.test(key)) {
      result[key] = REDACTED_SECRET_VALUE;
    } else {
      result[key] = redactProviderNativeValue(toolName, entry);
    }
  }
  return result;
}

function isProviderArgumentKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === "arguments" || normalized === "args";
}

function redactProviderArgumentPayload(toolName: string, value: unknown): unknown {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isObjectRecord(parsed)) {
        return JSON.stringify(redactToolInputForPersistence(toolName, parsed));
      }
      return JSON.stringify(redactValue(parsed));
    } catch {
      return REDACTED_PROVIDER_ARGUMENTS;
    }
  }

  if (isObjectRecord(value)) {
    return redactToolInputForPersistence(toolName, value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }

  return redactValue(value);
}

function redactCdpInputForPersistence(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (toolName !== "browser.cdp" || !isObjectRecord(input.params) || typeof input.method !== "string") {
    return input;
  }

  if (input.method === "Runtime.evaluate") {
    return {
      ...input,
      params: redactRuntimeExpressionFields(input.params, ["expression"])
    };
  }

  if (input.method === "Runtime.callFunctionOn") {
    return {
      ...input,
      params: redactRuntimeExpressionFields(input.params, ["functionDeclaration", "expression"])
    };
  }

  return input;
}

function redactRuntimeExpressionFields(params: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result = { ...params };
  for (const key of keys) {
    if (typeof result[key] === "string") {
      result[key] = REDACTED_CDP_EXPRESSION;
    }
  }
  return result;
}

function redactPersistedString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return redactPersistedText(value);
}

function redactPersistedText(value: string): string {
  return value
    .replace(URL_USERINFO_RE, (_match, protocol: string) => `${protocol}${REDACTED_SECRET_VALUE}:${REDACTED_SECRET_VALUE}@`)
    .replace(AUTH_VALUE_RE, (_match, prefix: string) => `${prefix}${REDACTED_SECRET_VALUE}`)
    .replace(SENSITIVE_QUERY_PARAM_VALUE_RE, (_match, boundary: string, prefix: string) => `${boundary}${prefix}${REDACTED_SECRET_VALUE}`)
    .replace(SENSITIVE_FIELD_VALUE_RE, (_match, boundary: string, prefix: string) => `${boundary}${prefix}${REDACTED_SECRET_VALUE}`)
    .replace(AUTH_FIELD_VALUE_RE, (_match, boundary: string, prefix: string) => `${boundary}${prefix}${REDACTED_SECRET_VALUE}`)
    .replace(AUTHORIZATION_FIELD_VALUE_RE, (_match, boundary: string, prefix: string) => `${boundary}${prefix}${REDACTED_SECRET_VALUE}`)
    .replace(TOKEN_PREFIX_RE, REDACTED_SECRET_VALUE);
}

function normalizeCommandKey(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function normalizePathKey(value: string): string {
  const normalized = value.trim().replace(/\/+/gu, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeUrlKey(value: string): string {
  return value.trim();
}

function extractExecutable(command: string): string {
  const [head = "unknown"] = command.split(/\s+/u);
  return head;
}

async function canonicalWorkspaceTarget(
  configuredRoot: string,
  canonicalRoot: string,
  rawPath: string,
  options: { allowMissingLeaf?: boolean } = {}
): Promise<string | undefined> {
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(configuredRoot, rawPath);
  if (!isWithinAnyRoot([configuredRoot, canonicalRoot], candidate)) {
    return undefined;
  }

  try {
    const resolved = await realpath(candidate);
    return isWithinRoot(canonicalRoot, resolved) ? resolved : undefined;
  } catch {
    if (options.allowMissingLeaf !== true) {
      return undefined;
    }

    try {
      const resolvedParent = await realpath(dirname(candidate));
      const finalTarget = resolve(resolvedParent, basename(candidate));
      return isWithinRoot(canonicalRoot, finalTarget) ? finalTarget : undefined;
    } catch {
      return undefined;
    }
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !isAbsolute(diff));
}

function isWithinAnyRoot(roots: string[], candidate: string): boolean {
  return roots.some((root) => isWithinRoot(root, candidate));
}
