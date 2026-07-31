import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureGlobalStateDirectories } from "./state-bootstrap.js";

describe("ensureGlobalStateDirectories", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "estacoda-state-bootstrap-test-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("creates the non-authorizing global state layout", async () => {
    const paths = await ensureGlobalStateDirectories({ homeDir: tempHome });

    expect(existsSync(paths.sharedMemoryPath)).toBe(true);
    expect(existsSync(paths.packsPath)).toBe(true);
    expect(existsSync(join(paths.stateRoot, ".backups"))).toBe(true);
    expect(existsSync(paths.trustJsonPath)).toBe(false);
    expect(existsSync(paths.workspaceApprovalsPath)).toBe(false);
    expect(existsSync(paths.sessionsSqlitePath)).toBe(false);
    expect(existsSync(paths.profilesRoot)).toBe(false);
  });

  it("is safe under concurrent calls", async () => {
    const paths = await Promise.all(
      Array.from({ length: 16 }, () => ensureGlobalStateDirectories({ homeDir: tempHome }))
    );

    expect(new Set(paths.map((entry) => entry.stateRoot))).toEqual(new Set([join(tempHome, ".estacoda")]));
    expect(existsSync(paths[0].trustJsonPath)).toBe(false);
  });

  it("can repair global directories without creating trust state", async () => {
    const paths = await ensureGlobalStateDirectories({ homeDir: tempHome });

    expect(existsSync(paths.sharedMemoryPath)).toBe(true);
    expect(existsSync(paths.packsPath)).toBe(true);
    expect(existsSync(join(paths.stateRoot, ".backups"))).toBe(true);
    expect(existsSync(paths.trustJsonPath)).toBe(false);
  });

  it("rejects an empty home without creating relative state", async () => {
    await expect(ensureGlobalStateDirectories({ homeDir: "" })).rejects.toThrow("HOME is not set");
  });
});
