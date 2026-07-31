import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureGlobalStateBootstrap, ensureGlobalStateDirectories } from "./state-bootstrap.js";

describe("ensureGlobalStateBootstrap", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "estacoda-state-bootstrap-test-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("creates the complete global state layout", async () => {
    const paths = await ensureGlobalStateBootstrap({ homeDir: tempHome });

    expect(existsSync(paths.sharedMemoryPath)).toBe(true);
    expect(existsSync(paths.packsPath)).toBe(true);
    expect(existsSync(join(paths.stateRoot, ".backups"))).toBe(true);
    expect(readFileSync(paths.trustJsonPath, "utf8")).toBe("{}\n");
    expect(existsSync(paths.workspaceApprovalsPath)).toBe(false);
    expect(existsSync(paths.sessionsSqlitePath)).toBe(false);
    expect(existsSync(paths.profilesRoot)).toBe(false);
  });

  it("is safe under concurrent calls", async () => {
    const paths = await Promise.all(
      Array.from({ length: 16 }, () => ensureGlobalStateBootstrap({ homeDir: tempHome }))
    );

    expect(new Set(paths.map((entry) => entry.stateRoot))).toEqual(new Set([join(tempHome, ".estacoda")]));
    expect(() => JSON.parse(readFileSync(paths[0].trustJsonPath, "utf8"))).not.toThrow();
  });

  it("does not overwrite an existing trust store", async () => {
    const first = await ensureGlobalStateBootstrap({ homeDir: tempHome });
    const existing = `${JSON.stringify({ version: 2, grants: [{ root: "/workspace", grantedAt: "2026-01-01T00:00:00.000Z" }] }, null, 2)}\n`;
    writeFileSync(first.trustJsonPath, existing, "utf8");

    await ensureGlobalStateBootstrap({ homeDir: tempHome });

    expect(readFileSync(first.trustJsonPath, "utf8")).toBe(existing);
  });

  it("can repair global directories without creating trust state", async () => {
    const paths = await ensureGlobalStateDirectories({ homeDir: tempHome });

    expect(existsSync(paths.sharedMemoryPath)).toBe(true);
    expect(existsSync(paths.packsPath)).toBe(true);
    expect(existsSync(join(paths.stateRoot, ".backups"))).toBe(true);
    expect(existsSync(paths.trustJsonPath)).toBe(false);
  });

  it("rejects an empty home without creating relative state", async () => {
    await expect(ensureGlobalStateBootstrap({ homeDir: "" })).rejects.toThrow("HOME is not set");
  });
});
