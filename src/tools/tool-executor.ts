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
import type { ToolDefinition, ToolResult, ToolRiskClass, ToolsetName } from "../contracts/tool.js";
import type { RuntimeEventSink } from "../contracts/runtime-event.js";
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
  signal?: AbortSignal;
};

export type NamedToolExecutionRequest = {
  tool: string;
  input: Record<string, unknown>;
  trustedWorkspace: boolean;
  sessionId: string;
  environmentType?: EnvironmentType;
  toolCallId?: string;
  visibleTurnId?: string;
  toolCallName?: string;
  providerNativeToolCall?: unknown;
  signal?: AbortSignal;
  onEvent?: RuntimeEventSink;
  delegateCallBudget?: DelegateCallBudget;
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
      signal: request.signal
    });
  }

  async executeTool(request: NamedToolExecutionRequest): Promise<ToolExecutionRecord | undefined> {
    const tool = this.#registry.get(request.tool);

    if (tool === undefined || !(await tool.isAvailable())) {
      return undefined;
    }

    const environmentType = request.environmentType ?? DEFAULT_ENVIRONMENT_TYPE;
    const riskClass = classifyEffectiveRisk(tool, request.input, environmentType);
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
        riskClass,
        result,
        toolCallId: request.toolCallId,
        toolCallName: request.toolCallName,
        providerNativeToolCall: request.providerNativeToolCall
      };
    }
    if (tool.name === "delegate_task" && request.delegateCallBudget !== undefined) {
      const budget = request.delegateCallBudget.tryConsume();
      if (budget.allowed === false) {
        return await this.#blockedDelegateCallLimit(request, tool, riskClass, budget);
      }
    }

    const targetKey = await this.#buildSecurityTargetKey(tool.name, request.input);
    const targetSummary = summarizeSecurityTarget(tool.name, request.input);
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
        targetConversationIsActive: true
      }
    };
    const assessment = await assessSecurityPolicy(this.#securityPolicy, securityRequest);
    const decision = assessment.decision;

    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "security-assessed",
      tool: tool.name,
      riskClass,
      targetKey: persistedTargetKey,
      targetSummary: persistedTargetSummary,
      assessment
    });
    this.#trajectoryRecorder.record("progress", {
      message: `security assessed for ${tool.name}`,
      tool: tool.name,
      decision: assessment.decision,
      mode: assessment.mode,
      reason: assessment.reason,
      riskClass
    });

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

    if (request.signal?.aborted === true) {
      result = {
        ok: false,
        content: "Tool execution cancelled.",
        metadata: { reason: "cancelled" }
      };
    } else {
      try {
        result = await tool.run(request.input, {
          toolCallId: request.toolCallId,
          visibleTurnId: request.visibleTurnId,
          signal: request.signal,
          environmentType,
          onEvent: request.onEvent
        });
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

    return {
      tool: toDefinition(tool),
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
  }

  getToolDefinition(name: string): ToolDefinition | undefined {
    const tool = this.#registry.get(name);

    return tool === undefined ? undefined : toDefinition(tool);
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

function validateToolInput(tool: ToolDefinition, input: Record<string, unknown>): string | undefined {
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
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) {
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
