import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import type { TaskOperatorService } from "../workflow/task-operator-service.js";

export const TASK_STATUS_MAX_RESULT_CHARS = 12_000;

export function createTaskTools(options: {
  service?: TaskOperatorService;
  currentSessionId: () => string;
}): readonly RegisteredTool[] {
  if (options.service === undefined) return [];
  return [{
    name: "task.status",
    description:
      "Inspect bounded lifecycle status, execution ownership/readiness, Step progress, usage completeness, and result handles for a durable Task linked to this session. Does not expose workspace paths, host identities, prompts, tool inputs, credentials, or full result bodies.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: { type: "string", minLength: 1, description: "Durable Task ID." }
      },
      required: ["task_id"]
    },
    riskClass: "read-only-local",
    toolsets: ["core"],
    progressLabel: "checking task status",
    maxResultSizeChars: TASK_STATUS_MAX_RESULT_CHARS,
    isAvailable: () => true,
    run: async (input: unknown): Promise<ToolResult> => {
      if (!validInput(input)) {
        return error("invalid-input", "task.status requires one non-empty task_id string.");
      }
      try {
        const status = options.service!.status(input.task_id, options.currentSessionId());
        return {
          ok: true,
          content: [
            `Task ${status.taskId}`,
            `Status: ${status.status}`,
            `Execution: ${["completed", "partial", "failed", "cancelled"].includes(status.status) ? "settled" : status.execution}`,
            `Execution preference: ${status.executionPreference}`,
            `Foreground owner: ${status.foregroundOwnerActive ? "active" : "inactive"}`,
            `Background continuation: ${status.backgroundContinuation}`,
            ...(status.executionWaitingReason === undefined ? [] : [`Execution waiting reason: ${status.executionWaitingReason}`]),
            `Progress: ${status.progress.completed}/${status.progress.total} Steps completed`,
            `Running: ${status.progress.running}`,
            `Waiting: ${status.progress.waiting_for_input + status.progress.waiting_for_approval}`,
            `Results: ${status.results.length}`,
            `Usage: ${status.usage.totalTokens} tokens${status.usage.usageComplete ? "" : " (incomplete)"}`,
            `Estimated cost: $${status.usage.estimatedCostUsd.toFixed(4)}${status.usage.pricingComplete ? "" : " (incomplete)"}`
          ].join("\n"),
          metadata: status
        };
      } catch {
        return error("task-not-found", "Task status is unavailable for this session.");
      }
    }
  }];
}

export const taskToolProvider: SessionToolProvider = {
  name: "task",
  kind: "session",
  createTools(ctx) {
    return createTaskTools({
      service: ctx.taskOperatorService,
      currentSessionId: ctx.currentSessionId
    });
  }
};

function validInput(input: unknown): input is { task_id: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const candidate = input as Record<string, unknown>;
  return Object.keys(candidate).length === 1 &&
    typeof candidate.task_id === "string" && candidate.task_id.trim().length > 0;
}

function error(code: string, content: string): ToolResult {
  return { ok: false, content, metadata: { error: code } };
}
