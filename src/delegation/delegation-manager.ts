import type { ChannelKind } from "../contracts/channel.js";
import type { SessionDB } from "../contracts/session.js";
import type { ToolsetName } from "../contracts/tool.js";
import type { ToolExecutor, ToolExecutionRecord } from "../tools/tool-executor.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";

export type DelegationRequest = {
  parentSessionId: string;
  profileId: string;
  task: string;
  context?: string;
  allowedToolsets?: ToolsetName[];
  allowedTools?: string[];
  channel?: ChannelKind;
  trustedWorkspace: boolean;
};

export type DelegationSummary = {
  childSessionId: string;
  status: "completed" | "blocked" | "failed";
  task: string;
  summary: string;
  toolExecutions: Array<{
    tool: string;
    decision: string;
    ok?: boolean;
  }>;
  allowedToolsets: ToolsetName[];
  allowedTools: string[];
};

export type DelegationManagerOptions = {
  sessionDb: SessionDB;
  toolExecutor: ToolExecutor;
  trajectoryRecorder: TrajectoryRecorder;
  id?: () => string;
};

export class DelegationManager {
  readonly #sessionDb: SessionDB;
  readonly #toolExecutor: ToolExecutor;
  readonly #trajectoryRecorder: TrajectoryRecorder;
  readonly #id: () => string;

  constructor(options: DelegationManagerOptions) {
    this.#sessionDb = options.sessionDb;
    this.#toolExecutor = options.toolExecutor;
    this.#trajectoryRecorder = options.trajectoryRecorder;
    this.#id = options.id ?? (() => `child_${crypto.randomUUID()}`);
  }

  async delegate(request: DelegationRequest): Promise<DelegationSummary> {
    const childSession = await this.#sessionDb.createSession({
      id: this.#id(),
      profileId: request.profileId,
      parentSessionId: request.parentSessionId,
      title: `Delegated: ${request.task.slice(0, 60)}`,
      metadata: {
        kind: "delegated-child",
        allowedToolsets: request.allowedToolsets ?? [],
        allowedTools: request.allowedTools ?? [],
        context: request.context ?? ""
      }
    });

    await this.#sessionDb.appendEvent(request.parentSessionId, {
      kind: "delegation-started",
      childSessionId: childSession.id,
      task: request.task,
      allowedToolsets: request.allowedToolsets ?? [],
      allowedTools: request.allowedTools ?? []
    });
    await this.#sessionDb.appendMessage({
      sessionId: childSession.id,
      role: "system",
      channel: request.channel,
      content: [
        "You are an isolated delegated EstaCoda child session.",
        "Use only the explicit task/context below.",
        `Task: ${request.task}`,
        request.context === undefined ? undefined : `Context:\n${request.context}`,
        `Allowed toolsets: ${(request.allowedToolsets ?? []).join(", ") || "none"}`,
        `Allowed tools: ${(request.allowedTools ?? []).join(", ") || "none"}`
      ]
        .filter((line) => line !== undefined)
        .join("\n\n"),
      metadata: {
        parentSessionId: request.parentSessionId
      }
    });
    await this.#sessionDb.appendMessage({
      sessionId: childSession.id,
      role: "user",
      channel: request.channel,
      content: request.task,
      metadata: {
        delegated: true,
        parentSessionId: request.parentSessionId
      }
    });
    this.#trajectoryRecorder.record("delegation-started", {
      parentSessionId: request.parentSessionId,
      childSessionId: childSession.id,
      task: request.task,
      allowedToolsets: request.allowedToolsets ?? [],
      allowedTools: request.allowedTools ?? []
    });

    const toolExecutions = await this.#runInitialDelegatedTools({
      childSessionId: childSession.id,
      task: request.task,
      context: request.context,
      allowedToolsets: request.allowedToolsets ?? [],
      allowedTools: request.allowedTools ?? [],
      trustedWorkspace: request.trustedWorkspace
    });
    const summary = this.#summarize(request.task, toolExecutions);
    const status: DelegationSummary["status"] = toolExecutions.some((execution) => execution.decision !== "allow")
      ? "blocked"
      : "completed";

    await this.#sessionDb.appendMessage({
      sessionId: childSession.id,
      role: "agent",
      channel: request.channel,
      content: summary,
      metadata: {
        toolExecutions: toolExecutions.map((execution) => execution.tool.name)
      }
    });
    await this.#sessionDb.appendEvent(request.parentSessionId, {
      kind: "delegation-finished",
      childSessionId: childSession.id,
      summary,
      status
    });
    this.#trajectoryRecorder.record("delegation-finished", {
      parentSessionId: request.parentSessionId,
      childSessionId: childSession.id,
      status,
      summary
    });

    return {
      childSessionId: childSession.id,
      status,
      task: request.task,
      summary,
      allowedToolsets: request.allowedToolsets ?? [],
      allowedTools: request.allowedTools ?? [],
      toolExecutions: toolExecutions.map((execution) => ({
        tool: execution.tool.name,
        decision: execution.decision,
        ok: execution.result?.ok
      }))
    };
  }

  async #runInitialDelegatedTools(input: {
    childSessionId: string;
    task: string;
    context?: string;
    allowedToolsets: ToolsetName[];
    allowedTools: string[];
    trustedWorkspace: boolean;
  }): Promise<ToolExecutionRecord[]> {
    const records: ToolExecutionRecord[] = [];

    if (
      isToolAllowed("workflow.plan", input.allowedTools) &&
      (input.allowedToolsets.includes("research") || input.allowedToolsets.includes("core"))
    ) {
      const execution = await this.#toolExecutor.executeTool({
        tool: "workflow.plan",
        sessionId: input.childSessionId,
        trustedWorkspace: input.trustedWorkspace,
        input: {
          skill: "delegated-task",
          intent: ["delegation"],
          firstStep: input.task
        }
      });

      if (execution !== undefined) {
        records.push(execution);
      }
    }

    if (
      isToolAllowed("file.search", input.allowedTools) &&
      input.allowedToolsets.includes("files") &&
      input.context !== undefined
    ) {
      const firstSearchTerm = input.context
        .split(/\s+/)
        .find((term) => term.length > 5 && /^[a-zA-Z0-9_.-]+$/.test(term));

      if (firstSearchTerm !== undefined) {
        const execution = await this.#toolExecutor.executeTool({
          tool: "file.search",
          sessionId: input.childSessionId,
          trustedWorkspace: input.trustedWorkspace,
          input: {
            query: firstSearchTerm
          }
        });

        if (execution !== undefined) {
          records.push(execution);
        }
      }
    }

    return records;
  }

  #summarize(task: string, toolExecutions: ToolExecutionRecord[]): string {
    const lines = [
      `Delegated task: ${task}`,
      `Tool steps: ${toolExecutions.length}`,
      ...toolExecutions.map((execution) =>
        `- ${execution.tool.name}: ${execution.decision}${execution.result === undefined ? "" : ` / ${execution.result.ok ? "ok" : "error"}`}`
      )
    ];

    return lines.join("\n");
  }
}

function isToolAllowed(tool: string, allowedTools: string[]): boolean {
  return allowedTools.length === 0 || allowedTools.includes(tool);
}
