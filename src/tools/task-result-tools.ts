import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import {
  TASK_RESULT_PAGE_MAX_CHARS,
  TaskResultAccessError,
  TaskResultContentError,
  type TaskResultService
} from "../workflow/task-result-service.js";

export const TASK_RESULT_READ_MAX_RESULT_CHARS = TASK_RESULT_PAGE_MAX_CHARS + 2_000;

export type TaskResultReadInput = {
  task_id: string;
  result_id: string;
  offset?: number;
  max_chars?: number;
};

export function createTaskResultTools(options: {
  service?: TaskResultService;
  currentSessionId: () => string;
}): readonly RegisteredTool[] {
  if (options.service === undefined) return [];

  return [{
    name: "task.result.read",
    description:
      "Read one authorized durable Task result as a bounded page. Requires the Task and Result IDs. Continue with next_offset when has_more is true. Binary artifacts are not returned as text.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: { type: "string", minLength: 1, description: "Durable Task ID." },
        result_id: { type: "string", minLength: 1, description: "Durable Result ID." },
        offset: { type: "integer", minimum: 0, description: "Unicode character offset. Defaults to 0." },
        max_chars: {
          type: "integer",
          minimum: 1,
          maximum: TASK_RESULT_PAGE_MAX_CHARS,
          description: "Maximum Unicode characters to return."
        }
      },
      required: ["task_id", "result_id"]
    },
    riskClass: "read-only-local",
    toolsets: ["core"],
    progressLabel: "reading task result",
    maxResultSizeChars: TASK_RESULT_READ_MAX_RESULT_CHARS,
    isAvailable: () => true,
    run: async (input: TaskResultReadInput): Promise<ToolResult> => {
      if (!validInput(input)) {
        return errorResult("invalid-input", "task.result.read requires non-empty task_id and result_id strings.");
      }
      try {
        const page = await options.service!.readPage({
          taskId: input.task_id,
          resultId: input.result_id,
          sessionId: options.currentSessionId(),
          offset: input.offset,
          maxChars: input.max_chars
        });
        return {
          ok: true,
          content: page.content,
          metadata: {
            taskId: page.result.taskId,
            resultId: page.result.id,
            resultHandle: page.result.handle,
            kind: page.result.kind,
            mimeType: page.result.mimeType,
            contentHash: page.result.contentHash,
            byteLength: page.result.byteLength,
            offset: page.offset,
            nextOffset: page.nextOffset,
            totalChars: page.totalChars,
            hasMore: page.hasMore
          }
        };
      } catch (error) {
        if (error instanceof TaskResultAccessError) {
          return errorResult(error.code, error.message);
        }
        if (error instanceof TaskResultContentError) {
          return errorResult(error.code, error.message);
        }
        return errorResult("task-result-read-failed", "Task result could not be read.");
      }
    }
  }];
}

export const taskResultToolProvider: SessionToolProvider = {
  name: "taskResult",
  kind: "session",
  createTools(ctx) {
    return createTaskResultTools({
      service: ctx.taskResultService,
      currentSessionId: ctx.currentSessionId
    });
  }
};

function validInput(input: unknown): input is TaskResultReadInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const candidate = input as Record<string, unknown>;
  const allowed = new Set(["task_id", "result_id", "offset", "max_chars"]);
  return Object.keys(candidate).every((key) => allowed.has(key)) &&
    typeof candidate.task_id === "string" && candidate.task_id.trim().length > 0 &&
    typeof candidate.result_id === "string" && candidate.result_id.trim().length > 0 &&
    (candidate.offset === undefined || (Number.isSafeInteger(candidate.offset) && Number(candidate.offset) >= 0)) &&
    (candidate.max_chars === undefined || (
      Number.isSafeInteger(candidate.max_chars) &&
      Number(candidate.max_chars) >= 1 &&
      Number(candidate.max_chars) <= TASK_RESULT_PAGE_MAX_CHARS
    ));
}

function errorResult(code: string, content: string): ToolResult {
  return { ok: false, content, metadata: { error: code } };
}
