import type { SecurityDecision, SecurityPolicy } from "../contracts/security.js";
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
  result?: ToolResult;
};

export type ToolExecutorOptions = {
  registry: ToolRegistry;
  securityPolicy: SecurityPolicy;
  sessionDb: SessionDB;
  trajectoryRecorder: TrajectoryRecorder;
};

export class ToolExecutor {
  readonly #registry: ToolRegistry;
  readonly #securityPolicy: SecurityPolicy;
  readonly #sessionDb: SessionDB;
  readonly #trajectoryRecorder: TrajectoryRecorder;

  constructor(options: ToolExecutorOptions) {
    this.#registry = options.registry;
    this.#securityPolicy = options.securityPolicy;
    this.#sessionDb = options.sessionDb;
    this.#trajectoryRecorder = options.trajectoryRecorder;
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
    const decision = this.#securityPolicy.decide({
      riskClass,
      description: `run tool ${tool.name}`,
      context: {
        trustedWorkspace: request.trustedWorkspace,
        targetConversationIsActive: true
      }
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
        riskClass
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
