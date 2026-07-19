import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExternalMemoryProvider } from "../contracts/memory.js";
import type { TrajectoryEvent, TrajectoryEventKind } from "../contracts/trajectory.js";
import { createFileExternalMemoryProvider } from "./external-memory-provider.js";
import { createMemoryTool } from "../tools/memory-tool.js";
import { MemoryStore } from "./memory-store.js";
import { MemoryPersistenceService } from "./memory-persistence-service.js";
import { MemoryCurationBusyError } from "./memory-curation-coordinator.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("memory.curate", () => {
  it("uses the profile mutation coordinator and returns busy without mutating memory", async () => {
    const store = new MemoryStore();
    const runExclusive = vi.fn(async () => {
      throw new MemoryCurationBusyError();
    });
    const tool = createMemoryTool(store, {
      mutationCoordinator: { runExclusive }
    });

    const result = await tool.run({
      kind: "append",
      file: "USER.md",
      content: "- Prefer focused replies."
    });

    expect(result).toEqual({
      ok: false,
      content: "Memory update is busy while background curation finishes. Try again shortly."
    });
    expect(runExclusive).toHaveBeenCalledTimes(1);
    expect(store.read("USER.md")).toBe("");
  });

  it("does not accept AGENTS.md", async () => {
    const tool = createMemoryTool(new MemoryStore());

    await expect(tool.run({
      kind: "append",
      file: "AGENTS.md",
      content: "workspace instructions do not belong in memory"
    } as never)).rejects.toThrow("memory.curate does not manage AGENTS.md");
  });

  it("returns structured overflow metadata without mutating memory", async () => {
    const store = new MemoryStore({ budgets: [{ kind: "USER.md", maxChars: 10 }] });
    store.write("USER.md", "short");
    const tool = createMemoryTool(store);

    const result = await tool.run({
      kind: "append",
      file: "USER.md",
      content: "too long"
    });

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({
      error: "memory-budget-overflow",
      pressure: {
        kind: "USER.md",
        state: "overflow"
      }
    });
    expect(store.read("USER.md")).toBe("short");
  });

  it("detects external disk edits before writing memory.curate changes", async () => {
    const root = await makeTempDir("estacoda-memory-tool-drift-");
    const path = join(root, "USER.md");
    await writeFile(path, "- original preference", "utf8");
    const persistence = new MemoryPersistenceService();
    const loaded = await persistence.readFile({
      path,
      kind: "USER.md"
    });
    const store = new MemoryStore();
    store.write("USER.md", loaded ?? "");
    const tool = createMemoryTool(store, {
      persistence,
      persistencePaths: {
        "USER.md": path
      }
    });
    await writeFile(path, "- externally edited preference with sentinel-current", "utf8");

    const result = await tool.run({
      kind: "append",
      file: "USER.md",
      content: "- proposed sentinel-new preference"
    });

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({
      error: "memory-disk-drift",
      kind: "USER.md",
      path
    });
    expect(await readFile(path, "utf8")).toBe("- externally edited preference with sentinel-current");
    expect(store.read("USER.md")).toBe("- original preference");
    const diagnostic = JSON.stringify(result);
    expect(diagnostic).not.toContain("sentinel-current");
    expect(diagnostic).not.toContain("sentinel-new");
  });

  it("keeps duplicate rejection behavior unchanged", async () => {
    const store = new MemoryStore();
    store.write("USER.md", "- Prefer concise replies.");
    const tool = createMemoryTool(store);

    await expect(tool.run({
      kind: "append",
      file: "USER.md",
      content: "- Prefer concise replies."
    })).rejects.toThrow("Duplicate memory entry rejected in USER.md");

    expect(store.read("USER.md")).toBe("- Prefer concise replies.");
  });

  it("does not fail local memory writes when external mirror writes fail", async () => {
    const store = new MemoryStore();
    const provider: ExternalMemoryProvider = {
      id: "fake",
      mirrorMemoryWrite: vi.fn(async () => {
        throw new Error("api_key=secretsecretsecretsecretsecret");
      })
    };
    const tool = createMemoryTool(store, {
      profileId: "default",
      sessionId: "session-1",
      workspaceRoot: "/workspace/a",
      externalMemoryProviders: [provider],
      externalMemory: {
        enabled: true,
        timeoutMs: 750,
        maxResults: 3,
        maxChars: 2500,
        mirrorWrites: true
      }
    });

    const result = await tool.run({
      kind: "append",
      file: "USER.md",
      content: "- Likes structured summaries"
    });

    expect(result.ok).toBe(true);
    expect(store.read("USER.md")).toContain("Likes structured summaries");
    expect(provider.mirrorMemoryWrite).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "default",
      sessionId: "session-1",
      workspaceRoot: "/workspace/a",
      source: "memory.curate",
      operation: expect.objectContaining({
        kind: "append",
        file: "USER.md"
      })
    }));
    expect(result.metadata?.warnings).toEqual([
      "external memory provider fake mirror write failed: api_key=[REDACTED]"
    ]);
  });

  it("mirrors memory writes to the file-backed external provider when explicitly enabled", async () => {
    const profileRoot = await makeTempDir("estacoda-memory-tool-file-provider-");
    const store = new MemoryStore();
    const provider = createFileExternalMemoryProvider({
      profileRoot,
      path: "memory.jsonl"
    });
    const tool = createMemoryTool(store, {
      profileId: "default",
      sessionId: "session-1",
      workspaceRoot: "/workspace/a",
      externalMemoryProviders: [provider],
      externalMemory: {
        enabled: true,
        timeoutMs: 750,
        maxResults: 3,
        maxChars: 2500,
        mirrorWrites: true
      }
    });

    const result = await tool.run({
      kind: "append",
      file: "USER.md",
      content: "- Likes external-memory tests"
    });

    expect(result.ok).toBe(true);
    expect(result.metadata).toBeUndefined();
    expect(store.read("USER.md")).toContain("Likes external-memory tests");
    const mirrored = await readFile(join(profileRoot, "external-memory", "memory.jsonl"), "utf8");
    expect(mirrored).toContain("Likes external-memory tests");
    expect(mirrored).toContain("\"workspaceRoot\":\"/workspace/a\"");
  });

  it("records mirror-write audit data without raw memory content", async () => {
    const store = new MemoryStore();
    const events: unknown[] = [];
    const trajectories: Array<{ kind: string; data: unknown }> = [];
    const provider: ExternalMemoryProvider = {
      id: "fake",
      mirrorMemoryWrite: vi.fn(async () => undefined)
    };
    const tool = createMemoryTool(store, {
      profileId: "default",
      sessionId: "session-1",
      workspaceRoot: "/workspace/a",
      sessionDb: {
        appendEvent: vi.fn(async (_sessionId, event) => {
          events.push(event);
        })
      },
      trajectoryRecorder: {
        record: vi.fn((kind: TrajectoryEventKind, data: Record<string, unknown>): TrajectoryEvent => {
          trajectories.push({ kind, data });
          return {
            id: `trajectory-${trajectories.length}`,
            kind,
            timestamp: "2026-05-20T00:00:00.000Z",
            data
          };
        })
      },
      externalMemoryProviders: [provider],
      externalMemory: {
        enabled: true,
        timeoutMs: 750,
        maxResults: 3,
        maxChars: 2500,
        mirrorWrites: true
      }
    });

    const result = await tool.run({
      kind: "append",
      file: "USER.md",
      content: "- Audit-sensitive preference should stay out of audit"
    });

    expect(result.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "external-memory-mirror-write",
      providerIds: ["fake"],
      enabled: true,
      mirrorEnabled: true,
      localWriteSucceeded: true,
      mirrorAttempted: true,
      mirrorSucceeded: true,
      memoryFile: "USER.md",
      operationKind: "append",
      profileId: "default",
      workspaceScoped: true,
      warningCount: 0,
      failureCount: 0
    });
    expect(JSON.stringify(events[0])).not.toContain("Audit-sensitive preference");
    expect(JSON.stringify(events[0])).not.toContain("should stay out of audit");
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0]?.kind).toBe("external-memory-mirror-write");
  });

  it("records redacted mirror-write failures without failing local memory writes", async () => {
    const store = new MemoryStore();
    const events: unknown[] = [];
    const provider: ExternalMemoryProvider = {
      id: "fake",
      mirrorMemoryWrite: vi.fn(async () => {
        throw new Error("TOKEN=secretsecretsecretsecretsecret " + "x".repeat(500));
      })
    };
    const tool = createMemoryTool(store, {
      profileId: "default",
      sessionId: "session-1",
      workspaceRoot: "/workspace/a",
      sessionDb: {
        appendEvent: vi.fn(async (_sessionId, event) => {
          events.push(event);
        })
      },
      externalMemoryProviders: [provider],
      externalMemory: {
        enabled: true,
        timeoutMs: 750,
        maxResults: 3,
        maxChars: 2500,
        mirrorWrites: true
      }
    });

    const result = await tool.run({
      kind: "append",
      file: "MEMORY.md",
      content: "- Local memory still wins"
    });

    expect(result.ok).toBe(true);
    expect(store.read("MEMORY.md")).toContain("Local memory still wins");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "external-memory-mirror-write",
      mirrorSucceeded: false,
      warningCount: 1,
      failureCount: 1,
      failures: [
        expect.objectContaining({
          providerId: "fake"
        })
      ]
    });
    const eventJson = JSON.stringify(events[0]);
    expect(eventJson).toContain("TOKEN=[REDACTED]");
    expect(eventJson).not.toContain("secretsecret");
    expect(eventJson.length).toBeLessThan(1_200);
  });

  it("keeps mirror-write audit failures non-fatal and redacted", async () => {
    const store = new MemoryStore();
    const provider: ExternalMemoryProvider = {
      id: "fake",
      mirrorMemoryWrite: vi.fn(async () => undefined)
    };
    const tool = createMemoryTool(store, {
      profileId: "default",
      sessionId: "session-1",
      workspaceRoot: "/workspace/a",
      sessionDb: {
        appendEvent: vi.fn(async () => {
          throw new Error("db token=secretsecretsecretsecretsecret");
        })
      },
      trajectoryRecorder: {
        record: vi.fn(() => {
          throw new Error("trajectory token=secretsecretsecretsecretsecret");
        })
      },
      externalMemoryProviders: [provider],
      externalMemory: {
        enabled: true,
        timeoutMs: 750,
        maxResults: 3,
        maxChars: 2500,
        mirrorWrites: true
      }
    });

    const result = await tool.run({
      kind: "append",
      file: "USER.md",
      content: "- Event failure should not block local writes"
    });

    expect(result.ok).toBe(true);
    expect(store.read("USER.md")).toContain("Event failure should not block local writes");
    const warnings = result.metadata?.warnings as string[] | undefined;
    expect(warnings?.join("\n")).toContain("external memory mirror write session event failed");
    expect(warnings?.join("\n")).toContain("external memory mirror write trajectory event failed");
    expect(warnings?.join("\n")).not.toContain("secretsecret");
  });

  it("does not audit or run mirror writes when external memory is disabled", async () => {
    const store = new MemoryStore();
    const appendEvent = vi.fn(async () => undefined);
    const provider: ExternalMemoryProvider = {
      id: "fake",
      mirrorMemoryWrite: vi.fn(async () => undefined)
    };
    const tool = createMemoryTool(store, {
      profileId: "default",
      sessionId: "session-1",
      sessionDb: { appendEvent },
      externalMemoryProviders: [provider],
      externalMemory: {
        enabled: false,
        timeoutMs: 750,
        maxResults: 3,
        maxChars: 2500,
        mirrorWrites: true
      }
    });

    const result = await tool.run({
      kind: "append",
      file: "USER.md",
      content: "- Disabled external memory stays quiet"
    });

    expect(result.ok).toBe(true);
    expect(provider.mirrorMemoryWrite).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
  });
});
