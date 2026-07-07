import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryCurationStore,
  memoryCurationStorePath,
  summarizeMemoryOperation
} from "./memory-curation-store.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-memory-curation-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("MemoryCurationStore", () => {
  it("appends and reads recent curation records", async () => {
    const root = await makeTempDir();
    const store = new MemoryCurationStore({
      path: memoryCurationStorePath(root),
      now: () => new Date("2026-05-20T10:00:00.000Z"),
      id: () => "record-1"
    });

    await store.append({
      profileId: "default",
      sessionId: "session-1",
      trigger: "turn-count",
      status: "auto-applied",
      extractedFactIds: ["fact-1"],
      operations: [summarizeMemoryOperation({
        kind: "append",
        file: "USER.md",
        content: "- User prefers pnpm."
      })],
      reason: "explicit low-risk fact passed curation policy"
    });

    await store.append({
      profileId: "default",
      sessionId: "session-2",
      trigger: "manual",
      status: "pending-review",
      extractedFactIds: [],
      operations: [],
      reason: "manual review requested"
    });

    expect(await store.latestForSession("session-1")).toMatchObject({
      id: "record-1",
      sessionId: "session-1",
      createdAt: "2026-05-20T10:00:00.000Z"
    });
    expect(await store.list({ limit: 1 })).toMatchObject([
      {
        sessionId: "session-2",
        status: "pending-review"
      }
    ]);
  });

  it("does not summarize unsupported memory file operations", () => {
    expect(() => summarizeMemoryOperation({
      kind: "append",
      file: "SOUL.md",
      content: "identity"
    })).toThrow("memory curation records do not support SOUL.md");
  });
});
