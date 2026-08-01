import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import type { TaskResult } from "../contracts/task.js";
import {
  TaskResultAccessError,
  TaskResultContentError,
  type TaskResultService
} from "../tasks/task-result-service.js";
import { createTaskResultTools } from "./task-result-tools.js";

describe("task.result.read", () => {
  it("is absent when durable Task result storage is unavailable", () => {
    expect(createTaskResultTools({ service: undefined, currentSessionId: () => "session-1" })).toEqual([]);
  });

  it("reads a bounded page for the current session without exposing a path", async () => {
    const readPage = vi.fn(() => ({
      result: result(),
      content: "second page",
      offset: 10,
      nextOffset: 21,
      totalChars: 30,
      hasMore: true
    }));
    const [tool] = createTaskResultTools({
      service: { readPage } as unknown as TaskResultService,
      currentSessionId: () => "authorized-session"
    });

    const response = await tool!.run({
      task_id: "task-1",
      result_id: "result-1",
      offset: 10,
      max_chars: 11
    });

    expect(readPage).toHaveBeenCalledWith({
      taskId: "task-1",
      resultId: "result-1",
      sessionId: "authorized-session",
      offset: 10,
      maxChars: 11
    });
    expect(response).toEqual({
      ok: true,
      content: "second page",
      metadata: expect.objectContaining({
        resultId: "result-1",
        resultHandle: "task-result:opaque",
        nextOffset: 21,
        hasMore: true
      })
    });
    expect(JSON.stringify(response)).not.toContain("/profiles/");
  });

  it("labels inspection-only diagnostic output in result metadata", async () => {
    const [tool] = createTaskResultTools({
      service: {
        readPage: () => ({
          result: { ...result(), disposition: "diagnostic" },
          content: "incomplete",
          offset: 0,
          totalChars: 10,
          hasMore: false
        })
      } as unknown as TaskResultService,
      currentSessionId: () => "authorized-session"
    });

    await expect(tool!.run({ task_id: "task-1", result_id: "result-1" })).resolves.toMatchObject({
      ok: true,
      metadata: {
        disposition: "diagnostic",
        diagnosticWarning: "The Attempt failed. This output may be incomplete and was not accepted as the successful Step result."
      }
    });
  });

  it("fails closed without distinguishing missing from unauthorized results", async () => {
    const [tool] = createTaskResultTools({
      service: {
        readPage: () => { throw new TaskResultAccessError(); }
      } as unknown as TaskResultService,
      currentSessionId: () => "unlinked-session"
    });

    await expect(tool!.run({ task_id: "task-1", result_id: "guessed-result" })).resolves.toEqual({
      ok: false,
      content: "Task result was not found or is not accessible from this session.",
      metadata: { error: "task-result-not-accessible" }
    });
  });

  it("returns structured validation and content errors", async () => {
    const [tool] = createTaskResultTools({
      service: {
        readPage: () => { throw new TaskResultContentError("invalid-maxChars", "Bad page size."); }
      } as unknown as TaskResultService,
      currentSessionId: () => "session-1"
    });

    await expect(tool!.run({ task_id: "", result_id: "result-1" })).resolves.toMatchObject({
      ok: false,
      metadata: { error: "invalid-input" }
    });
    await expect(tool!.run({ task_id: "task-1", result_id: "result-1", max_chars: 50_000 }))
      .resolves.toMatchObject({ ok: false, metadata: { error: "invalid-input" } });
    await expect(tool!.run({ task_id: "task-1", result_id: "result-1", max_chars: 100 }))
      .resolves.toEqual({ ok: false, content: "Bad page size.", metadata: { error: "invalid-maxChars" } });
  });

  it("exports the exact authorized result as a profile-local Markdown artifact", async () => {
    const exportRoot = await mkdtemp(join(tmpdir(), "estacoda-task-result-export-"));
    const artifactStore = new ArtifactStore({ id: () => "artifact-1" });
    const readText = vi.fn(() => ({ result: result(), content: "# Durable answer\n\nExact body.\n" }));
    try {
      const tools = createTaskResultTools({
        service: { readText } as unknown as TaskResultService,
        artifactStore,
        exportRoot,
        currentSessionId: () => "authorized-session"
      });
      const tool = tools.find((candidate) => candidate.name === "task.result.export");
      const response = await tool!.run({
        task_id: "task-1",
        result_id: "result-1",
        filename: "durable-answer"
      });

      expect(readText).toHaveBeenCalledWith({
        taskId: "task-1",
        resultId: "result-1",
        sessionId: "authorized-session"
      });
      expect(response).toMatchObject({
        ok: true,
        metadata: {
          artifact: {
            id: "artifact-1",
            path: "durable-answer.md",
            kind: "document",
            mimeType: "text/markdown; charset=utf-8",
            metadata: { taskId: "task-1", resultId: "result-1" }
          }
        }
      });
      const artifact = response.metadata?.artifact as { localPath: string };
      await expect(readFile(artifact.localPath, "utf8")).resolves.toBe("# Durable answer\n\nExact body.\n");
      expect(response.content).not.toContain(artifact.localPath);
    } finally {
      await rm(exportRoot, { recursive: true, force: true });
    }
  });

  it("keeps export unavailable without an artifact store and rejects unsafe filenames", async () => {
    const readText = vi.fn(() => ({ result: result(), content: "answer" }));
    expect(createTaskResultTools({
      service: { readText } as unknown as TaskResultService,
      currentSessionId: () => "authorized-session"
    }).map((tool) => tool.name)).toEqual(["task.result.read"]);

    const tools = createTaskResultTools({
      service: { readText } as unknown as TaskResultService,
      artifactStore: new ArtifactStore(),
      exportRoot: tmpdir(),
      currentSessionId: () => "authorized-session"
    });
    const tool = tools.find((candidate) => candidate.name === "task.result.export");
    await expect(tool!.run({
      task_id: "task-1",
      result_id: "result-1",
      filename: "../secret.md"
    })).resolves.toMatchObject({ ok: false, metadata: { error: "invalid-input" } });
    expect(readText).not.toHaveBeenCalled();
  });
});

function result(): TaskResult {
  return {
    id: "result-1",
    profileId: "alpha",
    taskId: "task-1",
    kind: "text",
    disposition: "accepted",
    status: "available",
    handle: "task-result:opaque",
    byteLength: 30,
    contentHash: "sha256:hash",
    mimeType: "text/plain",
    createdAt: "2030-01-01T00:00:00.000Z"
  };
}
