import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import {
  TASK_RESULT_PAGE_MAX_CHARS,
  TaskResultAccessError,
  TaskResultContentError,
  type TaskResultService
} from "../tasks/task-result-service.js";

export const TASK_RESULT_READ_MAX_RESULT_CHARS = TASK_RESULT_PAGE_MAX_CHARS + 2_000;

export type TaskResultReadInput = {
  task_id: string;
  result_id: string;
  offset?: number;
  max_chars?: number;
};

export type TaskResultExportInput = {
  task_id: string;
  result_id: string;
  filename?: string;
};

export function createTaskResultTools(options: {
  service?: TaskResultService;
  artifactStore?: ArtifactStore;
  exportRoot?: string;
  currentSessionId: () => string;
}): readonly RegisteredTool[] {
  if (options.service === undefined) return [];

  const tools: RegisteredTool[] = [{
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
            disposition: page.result.disposition,
            diagnosticWarning: page.result.disposition === "diagnostic"
              ? "The Attempt failed. This output may be incomplete and was not accepted as the successful Step result."
              : undefined,
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

  if (options.artifactStore !== undefined && options.exportRoot !== undefined) {
    tools.push({
      name: "task.result.export",
      description:
        "Export one authorized durable text Task result as an exact Markdown document artifact for delivery on the current surface. Requires explicit Task and Result IDs. Does not regenerate or summarize the result.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string", minLength: 1, description: "Durable Task ID." },
          result_id: { type: "string", minLength: 1, description: "Durable Result ID." },
          filename: {
            type: "string",
            minLength: 1,
            maxLength: 120,
            description: "Optional safe filename. The .md extension is added when omitted."
          }
        },
        required: ["task_id", "result_id"]
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core"],
      progressLabel: "exporting task result",
      maxResultSizeChars: 4_000,
      isAvailable: () => true,
      run: async (input: TaskResultExportInput): Promise<ToolResult> => {
        if (!validExportInput(input)) {
          return errorResult(
            "invalid-input",
            "task.result.export requires non-empty task_id and result_id strings and an optional safe filename."
          );
        }
        let exportDir: string | undefined;
        try {
          const exported = await options.service!.readText({
            taskId: input.task_id,
            resultId: input.result_id,
            sessionId: options.currentSessionId()
          });
          const filename = exportFilename(input.filename, exported.result.id);
          const root = join(options.exportRoot!, "task-results");
          await mkdir(root, { recursive: true, mode: 0o700 });
          exportDir = await mkdtemp(join(root, "export-"));
          const localPath = join(exportDir, filename);
          await writeFile(localPath, exported.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
          const artifact = options.artifactStore!.record({
            path: localPath,
            displayPath: filename,
            localPath,
            kind: "document",
            bytes: Buffer.byteLength(exported.content, "utf8"),
            mimeType: "text/markdown; charset=utf-8",
            summary: `Exact export of durable Task result ${exported.result.id}.`,
            metadata: {
              source: "task-result-export",
              taskId: exported.result.taskId,
              resultId: exported.result.id,
              resultHandle: exported.result.handle,
              disposition: exported.result.disposition
            }
          });
          return {
            ok: true,
            content: [
              `Task result exported: ${filename}`,
              `Result ID: ${exported.result.id}`,
              `Size: ${artifact.bytes} bytes`,
              "The artifact is ready for delivery on the current surface."
            ].join("\n"),
            metadata: { artifact }
          };
        } catch (error) {
          if (exportDir !== undefined) {
            await rm(exportDir, { recursive: true, force: true }).catch(() => undefined);
          }
          if (error instanceof TaskResultAccessError) {
            return errorResult(error.code, error.message);
          }
          if (error instanceof TaskResultContentError) {
            return errorResult(error.code, error.message);
          }
          return errorResult("task-result-export-failed", "Task result could not be exported as a document.");
        }
      }
    });
  }

  return tools;
}

export const taskResultToolProvider: SessionToolProvider = {
  name: "taskResult",
  kind: "session",
  createTools(ctx) {
    return createTaskResultTools({
      service: ctx.taskResultService,
      artifactStore: ctx.artifactStore,
      exportRoot: ctx.channelMediaRoot,
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

function validExportInput(input: unknown): input is TaskResultExportInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const candidate = input as Record<string, unknown>;
  const allowed = new Set(["task_id", "result_id", "filename"]);
  return Object.keys(candidate).every((key) => allowed.has(key)) &&
    typeof candidate.task_id === "string" && candidate.task_id.trim().length > 0 &&
    typeof candidate.result_id === "string" && candidate.result_id.trim().length > 0 &&
    (candidate.filename === undefined || (
      typeof candidate.filename === "string" && isSafeExportFilename(candidate.filename)
    ));
}

function exportFilename(requested: string | undefined, resultId: string): string {
  const base = requested?.trim() ?? `task-result-${safeFilenameToken(resultId)}`;
  return base.toLowerCase().endsWith(".md") ? base : `${base}.md`;
}

function isSafeExportFilename(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9._ -]*$/u.test(trimmed) && trimmed !== "." && trimmed !== "..";
}

function safeFilenameToken(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64);
  return safe.length === 0 ? "result" : safe;
}

function errorResult(code: string, content: string): ToolResult {
  return { ok: false, content, metadata: { error: code } };
}
