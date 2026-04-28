import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { assessSecurityPolicy, type SecurityDecision, type SecurityPolicy } from "../contracts/security.js";
import type { SessionDB } from "../contracts/session.js";
import type { ToolDefinition, ToolResult, ToolRiskClass, ToolsetName } from "../contracts/tool.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import type { ToolRegistry } from "./tool-registry.js";

export type ToolExecutionRequest = {
  toolset: ToolsetName;
  input: Record<string, unknown>;
  trustedWorkspace: boolean;
  sessionId: string;
  excludedTools?: string[];
  signal?: AbortSignal;
};

export type NamedToolExecutionRequest = {
  tool: string;
  input: Record<string, unknown>;
  trustedWorkspace: boolean;
  sessionId: string;
  signal?: AbortSignal;
};

export type ToolExecutionRecord = {
  tool: ToolDefinition;
  decision: SecurityDecision;
  riskClass: ToolRiskClass;
  targetKey?: string;
  targetSummary?: string;
  result?: ToolResult;
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
      signal: request.signal
    });
  }

  async executeTool(request: NamedToolExecutionRequest): Promise<ToolExecutionRecord | undefined> {
    const tool = this.#registry.get(request.tool);

    if (tool === undefined || !(await tool.isAvailable())) {
      return undefined;
    }

    const riskClass = classifyEffectiveRisk(tool, request.input);
    const targetKey = await this.#buildSecurityTargetKey(tool.name, request.input);
    const targetSummary = summarizeSecurityTarget(tool.name, request.input);
    const securityRequest = {
      riskClass,
      toolName: tool.name,
      targetKey,
      targetSummary,
      command: typeof request.input.command === "string" ? request.input.command : undefined,
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
      targetKey,
      targetSummary,
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
        decision,
        riskClass,
        targetKey,
        targetSummary
      };
    }

    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "tool-called",
      tool: tool.name,
      input: request.input
    });
    this.#trajectoryRecorder.record("tool-call", {
      tool: tool.name,
      input: request.input
    });

    const result = request.signal?.aborted === true
      ? {
          ok: false,
          content: "Tool execution cancelled.",
          metadata: {
            reason: "cancelled"
          }
        }
      : await tool.run(request.input, {
          signal: request.signal
        });

    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "tool-result",
      tool: tool.name,
      result
    });
    await this.#sessionDb.appendMessage({
      sessionId: request.sessionId,
      role: "tool",
      content: result.content,
      metadata: {
        tool: tool.name,
        ok: result.ok
      }
    });
    this.#trajectoryRecorder.record("tool-result", {
      tool: tool.name,
      result
    });

    return {
      tool: toDefinition(tool),
      decision,
      riskClass,
      targetKey,
      targetSummary,
      result
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
}

function classifyEffectiveRisk(tool: ToolDefinition, input: Record<string, unknown>): ToolRiskClass {
  if ((tool.name === "terminal.run" || tool.name === "process.start") && typeof input.command === "string") {
    if (looksCredentialSeeking(input.command)) {
      return "credential-access";
    }

    if (looksDestructive(input.command)) {
      return "destructive-local";
    }
  }

  return tool.riskClass;
}

function looksDestructive(command: string): boolean {
  return /\brm\s+-rf\b|\bsudo\b|\bchmod\s+-R\b|\bchown\s+-R\b|\bmkfs\.|\bdd\b.+\bof=|>\/dev\/sd[a-z]/u.test(command);
}

function looksCredentialSeeking(command: string): boolean {
  return /\b(printenv|env|security\s+find|op\s+read)\b/u.test(command) ||
    /(\.env|\.ssh|\.aws|\.gnupg|id_rsa|id_ed25519|token|secret|api[_-]?key)/iu.test(command);
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

function summarizeSecurityTarget(toolName: string, input: Record<string, unknown>): string | undefined {
  if ((toolName === "terminal.run" || toolName === "process.start") && typeof input.command === "string") {
    return truncateSecuritySummary(input.command);
  }

  if (typeof input.path === "string") {
    return truncateSecuritySummary(input.path);
  }

  if (typeof input.url === "string") {
    return truncateSecuritySummary(input.url);
  }

  if (typeof input.file_path === "string") {
    return truncateSecuritySummary(input.file_path);
  }

  return undefined;
}

function truncateSecuritySummary(value: string): string {
  const trimmed = value.trim().replace(/\s+/gu, " ");
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 117)}...`;
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
