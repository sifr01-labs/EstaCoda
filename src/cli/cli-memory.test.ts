import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { resolveMemoryIndexStorePath } from "../memory/memory-index-store.js";
import { MemoryCurationStore, memoryCurationStorePath } from "../memory/memory-curation-store.js";
import { writeSharedMemory } from "../memory/shared-memory.js";
import { runCliCommand } from "./cli.js";

const tempDirs: string[] = [];

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-cli-memory-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("CLI memory commands", () => {
  it("memory index path outputs profile-state memory-index.sqlite", async () => {
    const homeDir = await makeTempHome();
    const result = await runMemoryCommand(homeDir, ["memory", "index", "path"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Local memory index path");
    expect(result.output).toContain(resolveMemoryIndexStorePath({ homeDir, profileId: "default" }));
    expect(result.output).toContain("memory-index.sqlite");
    expect(result.output).toContain("rebuildable mirror");
  });

  it("memory index status shows enabled/path/backfill and counts", async () => {
    const homeDir = await makeTempHome();
    await seedProfileMemory(homeDir, {
      "USER.md": "needle user memory",
      "MEMORY.md": "needle project memory",
      "SOUL.md": "needle protected identity"
    });
    await runMemoryCommand(homeDir, ["memory", "index", "rebuild"]);

    const result = await runMemoryCommand(homeDir, ["memory", "index", "status"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("enabled: true");
    expect(result.output).toContain("backfillOnStartup: bounded");
    expect(result.output).toContain("indexedEntries: 3");
    expect(result.output).toContain("indexedProfiles: 1");
    expect(result.output).toContain("staleEntries: 0");
    expect(result.output).toContain("protectedEntries: 1");
    expect(result.output).toContain("ftsHealthy: true");
    expect(result.output).toContain("pendingRebuildReason: none");
  });

  it("memory index rebuild metadata survives a fresh status command", async () => {
    const homeDir = await makeTempHome();
    await seedProfileMemory(homeDir, {
      "USER.md": "rebuild metadata memory"
    });

    const rebuild = await runMemoryCommand(homeDir, ["memory", "index", "rebuild"]);
    const status = await runMemoryCommand(homeDir, ["memory", "index", "status"]);

    expect(rebuild.exitCode).toBe(0);
    expect(rebuild.output).not.toContain("lastRebuildAt: none");
    expect(status.exitCode).toBe(0);
    expect(status.output).not.toContain("lastRebuildAt: none");
    expect(status.output).not.toContain("lastBackfillAt: none");
    expect(status.output).toContain("pendingRebuildReason: none");
  });

  it("memory index status works after deleting index file and reports pending rebuild", async () => {
    const homeDir = await makeTempHome();
    await seedProfileMemory(homeDir, {
      "USER.md": "authoritative user memory"
    });
    await runMemoryCommand(homeDir, ["memory", "index", "rebuild"]);
    const indexPath = resolveMemoryIndexStorePath({ homeDir, profileId: "default" });
    await rm(indexPath, { force: true });

    const result = await runMemoryCommand(homeDir, ["memory", "index", "status"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("missingIndexFile: true");
    expect(result.output).toContain("pendingRebuildReason: missing memory-index.sqlite at startup");
    expect(result.output).toContain("memory-index-missing");
    await expect(readFile(resolveProfileStateHome({ homeDir, profileId: "default" }).userMdPath, "utf8"))
      .resolves.toBe("authoritative user memory");
  });

  it("memory index rebuild recreates and repopulates from authoritative files idempotently", async () => {
    const homeDir = await makeTempHome();
    await seedProfileMemory(homeDir, {
      "USER.md": "user rebuild memory",
      "MEMORY.md": "project rebuild memory",
      "SOUL.md": "protected rebuild memory"
    });
    await writeSharedMemory("team", "shared rebuild memory", { homeDir });
    const indexPath = resolveMemoryIndexStorePath({ homeDir, profileId: "default" });

    const first = await runMemoryCommand(homeDir, ["memory", "index", "rebuild"]);
    await rm(indexPath, { force: true });
    const second = await runMemoryCommand(homeDir, ["memory", "index", "rebuild"]);
    const third = await runMemoryCommand(homeDir, ["memory", "index", "rebuild"]);

    expect(first.output).toContain("indexedEntries: 4");
    expect(second.output).toContain("indexedEntries: 4");
    expect(third.output).toContain("indexedEntries: 4");
    expect(second.output).toContain("protectedEntries: 1");
    expect(second.output).toContain("no authoritative memory files were deleted");
    expect(existsSync(indexPath)).toBe(true);
    await expect(readFile(resolveProfileStateHome({ homeDir, profileId: "default" }).soulMdPath, "utf8"))
      .resolves.toBe("protected rebuild memory");
  });

  it("memory search returns bounded redacted lexical results and excludes protected entries by default", async () => {
    const homeDir = await makeTempHome();
    await seedProfileMemory(homeDir, {
      "USER.md": `needle visible OPENAI_API_KEY=secretsecretsecretsecretsecret ${"x".repeat(200)}`,
      "SOUL.md": "needle protected identity"
    });
    await runMemoryCommand(homeDir, ["memory", "index", "rebuild"]);

    const result = await runMemoryCommand(homeDir, [
      "memory",
      "search",
      "needle",
      "--max-results",
      "20",
      "--max-chars",
      "32"
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Local memory search");
    expect(result.output).toContain("results: 1");
    expect(result.output).toContain("source: USER.md");
    expect(result.output).not.toContain("protected identity");
    expect(result.output).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(result.output).not.toContain("secretsecret");
    expect(result.output).toContain("contextLabel: local-memory-context");
    expect(result.output).toContain("instructionBoundary: context-not-instruction");
    expect(result.output).toContain("redactionApplied: true");
  });

  it("memory search can include protected entries only with explicit flag", async () => {
    const homeDir = await makeTempHome();
    await seedProfileMemory(homeDir, {
      "SOUL.md": "needle protected identity"
    });
    await runMemoryCommand(homeDir, ["memory", "index", "rebuild"]);

    const without = await runMemoryCommand(homeDir, ["memory", "search", "needle"]);
    const withFlag = await runMemoryCommand(homeDir, ["memory", "search", "needle", "--include-protected"]);

    expect(without.output).toContain("results: 0");
    expect(without.output).toContain("memory-protected-filtered");
    expect(withFlag.output).toContain("results: 1");
    expect(withFlag.output).toContain("source: SOUL.md");
    expect(withFlag.output).toContain("protectedClass: identity");
  });

  it("memory read supports USER.md, MEMORY.md, and shared memory", async () => {
    const homeDir = await makeTempHome();
    await seedProfileMemory(homeDir, {
      "USER.md": "user read memory",
      "MEMORY.md": "project read memory"
    });
    await writeSharedMemory("team", "shared read memory", { homeDir });

    const user = await runMemoryCommand(homeDir, ["memory", "read", "USER.md"]);
    const memory = await runMemoryCommand(homeDir, ["memory", "read", "MEMORY.md"]);
    const shared = await runMemoryCommand(homeDir, ["memory", "read", "shared", "team"]);

    expect(user.exitCode).toBe(0);
    expect(user.output).toContain("user read memory");
    expect(memory.exitCode).toBe(0);
    expect(memory.output).toContain("project read memory");
    expect(shared.exitCode).toBe(0);
    expect(shared.output).toContain("shared read memory");
    expect(shared.output).toContain("sourceKey: team");
  });

  it("memory read SOUL.md is denied unless include-protected is explicit", async () => {
    const homeDir = await makeTempHome();
    await seedProfileMemory(homeDir, {
      "SOUL.md": "protected soul memory"
    });

    const denied = await runMemoryCommand(homeDir, ["memory", "read", "SOUL.md"]);
    const allowed = await runMemoryCommand(homeDir, [
      "memory",
      "read",
      "SOUL.md",
      "--include-protected",
      "--max-chars",
      "9"
    ]);

    expect(denied.exitCode).toBe(1);
    expect(denied.output).toContain("ok: false");
    expect(denied.output).toContain("memory-protected-filtered");
    expect(denied.output).not.toContain("protected soul memory");
    expect(allowed.exitCode).toBe(0);
    expect(allowed.output).toContain("protected");
    expect(allowed.output).not.toContain("protected soul memory");
    expect(allowed.output).toContain("protectedClass: identity");
  });

  it("memory read rejects traversal shared keys without reading outside shared memory", async () => {
    const homeDir = await makeTempHome();
    await seedProfileMemory(homeDir, {
      "SOUL.md": "CLI traversal must not expose protected identity."
    });

    const result = await runMemoryCommand(homeDir, [
      "memory",
      "read",
      "shared",
      "../../profiles/default/SOUL.md"
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Shared memory key is invalid.");
    expect(result.output).not.toContain("CLI traversal");
  });

  it("memory retrieval disabled blocks CLI read and search", async () => {
    const homeDir = await makeTempHome();
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
    await seedProfileMemory(homeDir, {
      "USER.md": "CLI disabled retrieval must not expose this."
    });
    await writeFile(paths.configPath, JSON.stringify({
      memory: {
        retrieval: { enabled: false },
        index: { enabled: false }
      }
    }, null, 2), "utf8");

    const read = await runMemoryCommand(homeDir, ["memory", "read", "USER.md"]);
    const search = await runMemoryCommand(homeDir, ["memory", "search", "disabled"]);

    expect(read.exitCode).toBe(1);
    expect(read.output).toContain("memory-retrieval-disabled");
    expect(read.output).not.toContain("CLI disabled retrieval");
    expect(search.exitCode).toBe(0);
    expect(search.output).toContain("memory-retrieval-disabled");
    expect(search.output).not.toContain("CLI disabled retrieval");
  });

  it("memory read missing source returns structured diagnostics", async () => {
    const homeDir = await makeTempHome();

    const result = await runMemoryCommand(homeDir, ["memory", "read", "USER.md"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("ok: false");
    expect(result.output).toContain("Requested local memory source was not found");
    expect(result.output).toContain("diagnostics:");
  });

  it("memory mode shows and updates the profile-local curation mode", async () => {
    const homeDir = await makeTempHome();

    const update = await runMemoryCommand(homeDir, ["memory", "mode", "review"]);
    const status = await runMemoryCommand(homeDir, ["memory", "mode"]);
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
    const rawConfig = JSON.parse(await readFile(paths.configPath, "utf8")) as {
      memory?: { curation?: { mode?: string } };
    };

    expect(update.exitCode).toBe(0);
    expect(update.output).toContain("Memory curation mode updated");
    expect(update.output).toContain("previous: auto");
    expect(update.output).toContain("mode: review");
    expect(status.exitCode).toBe(0);
    expect(status.output).toContain("mode: review");
    expect(rawConfig.memory?.curation?.mode).toBe("review");
  });

  it("memory recent and review render profile-local curation history", async () => {
    const homeDir = await makeTempHome();
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
    const store = new MemoryCurationStore({
      path: memoryCurationStorePath(paths.profileRoot),
      id: () => "record-1",
      now: () => new Date("2026-05-20T00:00:00.000Z")
    });
    await store.append({
      profileId: "default",
      sessionId: "session-1",
      trigger: "manual",
      status: "pending-review",
      sourceMessageCount: 3,
      sourceMessageIds: ["m1", "m2", "m3"],
      extractedFactIds: ["fact-1"],
      operations: [],
      reason: "memory candidates require review"
    });

    const recent = await runMemoryCommand(homeDir, ["memory", "recent"]);
    const review = await runMemoryCommand(homeDir, ["memory", "review"]);

    expect(recent.exitCode).toBe(0);
    expect(recent.output).toContain("Recent memory curation");
    expect(recent.output).toContain("record-1");
    expect(recent.output).toContain("[pending-review]");
    expect(review.exitCode).toBe(0);
    expect(review.output).toContain("Pending memory review");
    expect(review.output).toContain("memory candidates require review");
  });

  it("memory review candidates can be applied and undone through the shared operator path", async () => {
    const homeDir = await makeTempHome();
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
    const store = new MemoryCurationStore({
      path: memoryCurationStorePath(paths.profileRoot),
      id: () => "record-1",
      now: () => new Date("2026-05-20T00:00:00.000Z")
    });
    await store.append({
      profileId: "default",
      sessionId: "session-1",
      trigger: "manual",
      status: "pending-review",
      sourceMessageCount: 1,
      sourceMessageIds: ["m1"],
      extractedFactIds: ["fact-1"],
      operations: [],
      candidates: [{
        id: "candidate-1",
        factId: "fact-1",
        target: "USER.md",
        disposition: "pending-review",
        reviewStatus: "pending",
        reason: "memory curation mode is review",
        risk: "low",
        operation: {
          kind: "append",
          file: "USER.md",
          content: "- User prefers pnpm."
        }
      }],
      reason: "memory candidates require review"
    });

    const review = await runMemoryCommand(homeDir, ["memory", "review"]);
    const apply = await runMemoryCommand(homeDir, ["memory", "apply", "record-1", "candidate-1"]);
    const updatedAfterApply = await store.get("record-1");

    expect(review.exitCode).toBe(0);
    expect(review.output).toContain("candidate:candidate-1");
    expect(review.output).toContain("preview:- User prefers pnpm.");
    expect(apply.exitCode, apply.output).toBe(0);
    expect(apply.output).toContain("Memory review candidates applied");
    await expect(readFile(paths.userMdPath, "utf8")).resolves.toBe("- User prefers pnpm.");
    expect(updatedAfterApply).toMatchObject({
      status: "applied",
      candidates: [expect.objectContaining({ id: "candidate-1", reviewStatus: "applied" })],
      operations: [expect.objectContaining({ file: "USER.md", kind: "append" })]
    });
    const undo = await runMemoryCommand(homeDir, ["memory", "undo", "record-1"]);
    const updatedAfterUndo = await store.get("record-1");

    expect(undo.exitCode).toBe(0);
    expect(undo.output).toContain("Memory curation record undone");
    await expect(readFile(paths.userMdPath, "utf8")).resolves.toBe("");
    expect(updatedAfterUndo).toMatchObject({
      status: "undone"
    });
  });

  it("memory populate dispatches a manual curation checkpoint through the active runtime", async () => {
    const homeDir = await makeTempHome();
    const calls: unknown[] = [];
    const result = await runCliCommand({
      argv: ["memory", "populate"],
      workspaceRoot: homeDir,
      homeDir,
      interactive: false,
      runtime: {
        sessionId: "session-1",
        auditMemoryCuration: async (input: unknown) => {
          calls.push(input);
          return {
            status: "auto-applied",
            trigger: "manual",
            sessionId: "session-1",
            sourceMessageCount: 4,
            reviewedMessageCount: 4,
            extractedFactCount: 1,
            candidateCount: 1,
            autoAppliedCount: 1,
            pendingReviewCount: 0,
            ignoredCount: 0,
            failedCount: 0,
            warnings: []
          };
        }
      } as never
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([{ trigger: "manual", sessionId: "session-1", signal: undefined }]);
    expect(result.output).toContain("Memory populate");
    expect(result.output).toContain("status: auto-applied");
    expect(result.output).toContain("reviewedMessages: 4");
  });

  it("memory clear requires confirmation and never clears SOUL.md", async () => {
    const homeDir = await makeTempHome();
    await seedProfileMemory(homeDir, {
      "USER.md": "user memory",
      "MEMORY.md": "project memory",
      "SOUL.md": "protected identity"
    });
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });

    const refused = await runMemoryCommand(homeDir, ["memory", "clear"]);

    expect(refused.exitCode).toBe(1);
    expect(refused.output).toContain("Refusing to clear durable memory");
    await expect(readFile(paths.userMdPath, "utf8")).resolves.toBe("user memory");
    const cleared = await runMemoryCommand(homeDir, ["memory", "clear", "all", "--yes"]);

    expect(cleared.exitCode).toBe(0);
    expect(cleared.output).toContain("USER.md: cleared");
    expect(cleared.output).toContain("MEMORY.md: cleared");
    await expect(readFile(paths.userMdPath, "utf8")).resolves.toBe("");
    await expect(readFile(paths.memoryMdPath, "utf8")).resolves.toBe("");
    await expect(readFile(paths.soulMdPath, "utf8")).resolves.toBe("protected identity");
  });
});

async function runMemoryCommand(homeDir: string, argv: string[]) {
  return runCliCommand({
    argv,
    workspaceRoot: homeDir,
    homeDir,
    interactive: false
  });
}

async function seedProfileMemory(
  homeDir: string,
  files: Partial<Record<"USER.md" | "MEMORY.md" | "SOUL.md", string>>
): Promise<void> {
  const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
  await mkdir(paths.profileRoot, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const path = file === "USER.md"
      ? paths.userMdPath
      : file === "MEMORY.md"
        ? paths.memoryMdPath
        : paths.soulMdPath;
    await writeFile(path, content, "utf8");
  }
}
