import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersistentCliSessionStore } from "./cli-session-store.js";

describe("PersistentCliSessionStore v2", () => {
  let tempDir: string;
  let path: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-cli-session-store-v2-"));
    path = join(tempDir, ".estacoda", "cli-sessions.json");
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps continuation pointers isolated by profile and workspace", async () => {
    const store = new PersistentCliSessionStore({ path, now: () => new Date("2026-08-04T10:00:00.000Z") });
    await store.setSessionId({ profileId: "default", workspaceRoot: join(tempDir, "one"), sessionId: "default-one" });
    await store.setSessionId({ profileId: "work", workspaceRoot: join(tempDir, "one"), sessionId: "work-one" });
    await store.setSessionId({ profileId: "default", workspaceRoot: join(tempDir, "two"), sessionId: "default-two" });

    await expect(store.getSessionId({ profileId: "default", workspaceRoot: join(tempDir, "one") }))
      .resolves.toBe("default-one");
    await expect(store.getSessionId({ profileId: "work", workspaceRoot: join(tempDir, "one") }))
      .resolves.toBe("work-one");
    await expect(store.getSessionId({ profileId: "default", workspaceRoot: join(tempDir, "two") }))
      .resolves.toBe("default-two");

    const file = JSON.parse(await readFile(path, "utf8")) as { version: number; entries: unknown[] };
    expect(file.version).toBe(2);
    expect(file.entries).toHaveLength(3);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("updates only the matching profile/workspace entry", async () => {
    const store = new PersistentCliSessionStore({ path });
    const workspaceRoot = join(tempDir, "workspace");
    await store.setSessionId({ profileId: "default", workspaceRoot, sessionId: "first" });
    await store.setSessionId({ profileId: "work", workspaceRoot, sessionId: "work" });
    await store.setSessionId({ profileId: "default", workspaceRoot, sessionId: "second" });

    await expect(store.getSessionId({ profileId: "default", workspaceRoot })).resolves.toBe("second");
    await expect(store.getSessionId({ profileId: "work", workspaceRoot })).resolves.toBe("work");
    const file = JSON.parse(await readFile(path, "utf8")) as { entries: unknown[] };
    expect(file.entries).toHaveLength(2);
  });

  it("fails closed for legacy v1 and malformed state", async () => {
    await writeFile(path, JSON.stringify({
      version: 1,
      entries: [{ workspaceRoot: tempDir, sessionId: "legacy" }],
    }), "utf8");
    const store = new PersistentCliSessionStore({ path });
    await expect(store.getSessionId({ profileId: "default", workspaceRoot: tempDir })).resolves.toBeUndefined();

    await writeFile(path, "{not-json", "utf8");
    await expect(store.getSessionId({ profileId: "default", workspaceRoot: tempDir })).resolves.toBeUndefined();

    await writeFile(path, "null", "utf8");
    await expect(store.getSessionId({ profileId: "default", workspaceRoot: tempDir })).resolves.toBeUndefined();
  });

  it("rejects invalid profile and session identifiers", async () => {
    const store = new PersistentCliSessionStore({ path });
    await expect(store.setSessionId({ profileId: "../other", workspaceRoot: tempDir, sessionId: "safe" }))
      .rejects.toThrow("Invalid profile id");
    await expect(store.setSessionId({ profileId: "default", workspaceRoot: tempDir, sessionId: "bad\nvalue" }))
      .rejects.toThrow("Invalid CLI session id");
    await expect(store.setSessionId({ profileId: "default", workspaceRoot: "", sessionId: "safe" }))
      .rejects.toThrow("Invalid CLI session workspace root");
  });
});
