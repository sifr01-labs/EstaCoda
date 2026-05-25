import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile, rm } from "node:fs/promises";
import {
  applyManagedSourceUpdate,
  checkForUpdate,
  canApplyUpdate,
  prepareUpdateInfo,
  readCachedUpdateStatus,
  UPDATE_CACHE_TTL_MS,
  type SourceUpdateCommandRunner
} from "./update-engine.js";
import type { InstallMethodInfo } from "./install-method.js";
import type { GitCommandResult } from "./version-resolver.js";

describe("checkForUpdate", () => {
  it("reports up-to-date when versions match", async () => {
    const mockFetch = () =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            tag_name: "v0.0.5",
            html_url: "https://example.com"
          })
      } as Response);

    const result = await checkForUpdate(mockFetch);
    expect(result.kind).toBe("up-to-date");
  });

  it("handles network errors gracefully", async () => {
    const mockFetch = () => Promise.reject(new Error("timeout"));
    const result = await checkForUpdate(mockFetch);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("timeout");
    }
  });

  it("treats cache write failures as non-fatal", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-write-test-"));
    const homeFile = join(tempDir, "home-file");
    await writeFile(homeFile, "not a directory");
    const mockFetch = () =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            tag_name: "v0.0.5",
            html_url: "https://example.com"
          })
      } as Response);

    const result = await checkForUpdate({ fetchFn: mockFetch, homeDir: homeFile });

    expect(result.kind).toBe("up-to-date");
  });
});

describe("canApplyUpdate", () => {
  it("rejects when ESTACODA_UPDATE_ARTIFACT is not set", () => {
    delete process.env.ESTACODA_UPDATE_ARTIFACT;
    const result = canApplyUpdate();
    expect(result.testable).toBe(false);
    expect(result.reason).toContain("not set");
  });

  it("rejects when artifact path does not exist", () => {
    process.env.ESTACODA_UPDATE_ARTIFACT = "/nonexistent/path/estacoda";
    const result = canApplyUpdate();
    expect(result.testable).toBe(false);
    expect(result.reason).toContain("does not exist");
  });

  it("accepts when artifact path exists", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-update-test-"));
    const artifact = join(tempDir, "estacoda");
    writeFileSync(artifact, "binary", "utf8");

    process.env.ESTACODA_UPDATE_ARTIFACT = artifact;
    const result = canApplyUpdate();
    expect(result.testable).toBe(true);
  });
});

describe("prepareUpdateInfo", () => {
  it("includes current, latest, and protected paths", () => {
    const text = prepareUpdateInfo({
      current: "0.1.0",
      latest: "0.2.0",
      releaseNotesUrl: "https://example.com",
      breakingChanges: false
    });
    expect(text).toContain("0.1.0");
    expect(text).toContain("0.2.0");
    expect(text).toContain("Protected state paths");
  });

  it("warns about breaking changes", () => {
    const text = prepareUpdateInfo({
      current: "0.1.0",
      latest: "0.2.0",
      releaseNotesUrl: "https://example.com",
      breakingChanges: true
    });
    expect(text).toContain("breaking changes");
  });
});

describe("readCachedUpdateStatus", () => {
  it("returns unknown when cache file is missing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-test-"));
    const result = await readCachedUpdateStatus(tempDir);
    expect(result).toBe("unknown");
  });

  it("returns cached up-to-date when cache is fresh", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-test-"));
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    await writeFile(
      join(tempDir, ".estacoda", "update-cache.json"),
      JSON.stringify({ checkedAt: new Date().toISOString(), versionStatus: "up-to-date" })
    );
    const result = await readCachedUpdateStatus(tempDir);
    expect(result).toBe("up-to-date");
  });

  it("returns cached update-available when cache is fresh", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-test-"));
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    await writeFile(
      join(tempDir, ".estacoda", "update-cache.json"),
      JSON.stringify({ checkedAt: new Date().toISOString(), versionStatus: "update-available" })
    );
    const result = await readCachedUpdateStatus(tempDir);
    expect(result).toBe("update-available");
  });

  it("uses a 6 hour cache TTL", () => {
    expect(UPDATE_CACHE_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("returns cached status within the 6 hour cache TTL", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-test-"));
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    const freshDate = new Date(Date.now() - UPDATE_CACHE_TTL_MS + 60 * 1000).toISOString();
    await writeFile(
      join(tempDir, ".estacoda", "update-cache.json"),
      JSON.stringify({ checkedAt: freshDate, versionStatus: "up-to-date" })
    );
    const result = await readCachedUpdateStatus(tempDir);
    expect(result).toBe("up-to-date");
  });

  it("returns unknown when cache is stale after the 6 hour cache TTL", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-test-"));
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    const oldDate = new Date(Date.now() - UPDATE_CACHE_TTL_MS - 60 * 1000).toISOString();
    await writeFile(
      join(tempDir, ".estacoda", "update-cache.json"),
      JSON.stringify({ checkedAt: oldDate, versionStatus: "up-to-date" })
    );
    const result = await readCachedUpdateStatus(tempDir);
    expect(result).toBe("unknown");
  });

  it("returns unknown when cache contains invalid JSON", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-test-"));
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    await writeFile(join(tempDir, ".estacoda", "update-cache.json"), "not json");
    const result = await readCachedUpdateStatus(tempDir);
    expect(result).toBe("unknown");
  });

  it("treats cache read failures as non-fatal", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-test-"));
    await writeFile(join(tempDir, ".estacoda"), "not a directory");

    const result = await readCachedUpdateStatus(tempDir);

    expect(result).toBe("unknown");
  });

  it("returns unknown when cache has invalid versionStatus", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-test-"));
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    await writeFile(
      join(tempDir, ".estacoda", "update-cache.json"),
      JSON.stringify({ checkedAt: new Date().toISOString(), versionStatus: "bogus" })
    );
    const result = await readCachedUpdateStatus(tempDir);
    expect(result).toBe("unknown");
  });
});

describe("applyManagedSourceUpdate", () => {
  it("refuses managed-source stamps missing installDir before commands", async () => {
    const calls: string[] = [];
    const result = await applyManagedSourceUpdate({
      installMethod: managedSourceInfo({ installDir: undefined }),
      homeDir: "/tmp/home",
      pathExists: async () => true,
      commandRunner: runnerFor(calls, {})
    });

    expect(result.kind).toBe("error");
    expect(result.message).toContain("missing installDir");
    expect(calls).toEqual([]);
  });

  it("exits cleanly when managed-source is already up to date", async () => {
    const calls: string[] = [];
    const writes: string[] = [];
    const result = await applyManagedSourceUpdate({
      installMethod: managedSourceInfo(),
      homeDir: "/tmp/home",
      pathExists: async () => true,
      commandRunner: runnerFor(calls, {
        "git rev-parse --show-toplevel": ok("/repo\n"),
        "git remote get-url origin": ok("https://github.com/KemetResearch/EstaCoda.git\n"),
        "git rev-parse --abbrev-ref HEAD": ok("main\n"),
        "git status --porcelain": ok(""),
        "git rev-parse HEAD": ok("abc1234\n"),
        "git fetch origin": ok(""),
        "git rev-list --count HEAD..origin/main": ok("0\n")
      }),
      writeCache: async (_homeDir, status) => {
        writes.push(status);
      }
    });

    expect(result.kind).toBe("success");
    expect(result.message).toContain("Already up to date.");
    expect(calls).not.toContain("git pull --ff-only origin main");
    expect(calls.some((call) => call.startsWith("pnpm "))).toBe(false);
    expect(writes).toEqual(["up-to-date"]);
  });

  it("pulls ff-only, rebuilds, validates, and updates cache when behind", async () => {
    const calls: string[] = [];
    const writes: string[] = [];
    const result = await applyManagedSourceUpdate({
      installMethod: managedSourceInfo(),
      homeDir: "/tmp/home",
      pathExists: async () => true,
      commandRunner: runnerFor(calls, {
        "git rev-parse --show-toplevel": ok("/repo\n"),
        "git remote get-url origin": ok("https://github.com/KemetResearch/EstaCoda.git\n"),
        "git rev-parse --abbrev-ref HEAD": ok("main\n"),
        "git status --porcelain": ok(""),
        "git rev-parse HEAD": ok("abc1234\n"),
        "git fetch origin": ok(""),
        "git rev-list --count HEAD..origin/main": ok("2\n"),
        "git pull --ff-only origin main": ok("Fast-forward\n"),
        "pnpm install --frozen-lockfile": ok(""),
        "pnpm run build": ok(""),
        "node dist/index.js --version": ok("0.0.5\n"),
        "node dist/index.js --help": ok("Usage\n")
      }),
      writeCache: async (_homeDir, status) => {
        writes.push(status);
      }
    });

    expect(result.kind).toBe("success");
    expect(result.message).toContain("Update applied: fast-forwarded 2 commits");
    expect(result.message).toContain("Bundled skill sync: no-op");
    expect(calls).toEqual([
      "git rev-parse --show-toplevel",
      "git remote get-url origin",
      "git rev-parse --abbrev-ref HEAD",
      "git status --porcelain",
      "git rev-parse HEAD",
      "git fetch origin",
      "git rev-list --count HEAD..origin/main",
      "git pull --ff-only origin main",
      "pnpm install --frozen-lockfile",
      "pnpm run build",
      "node dist/index.js --version",
      "node dist/index.js --help"
    ]);
    expect(writes).toEqual(["up-to-date"]);
  });

  it("refuses dirty managed-source worktrees before mutation", async () => {
    const calls: string[] = [];
    const result = await applyManagedSourceUpdate({
      installMethod: managedSourceInfo(),
      homeDir: "/tmp/home",
      pathExists: async () => true,
      commandRunner: runnerFor(calls, {
        "git rev-parse --show-toplevel": ok("/repo\n"),
        "git remote get-url origin": ok("https://github.com/KemetResearch/EstaCoda.git\n"),
        "git rev-parse --abbrev-ref HEAD": ok("main\n"),
        "git status --porcelain": ok(" M src/index.ts\n")
      })
    });

    expect(result.kind).toBe("error");
    expect(result.message).toContain("uncommitted changes");
    expect(result.message).toContain("Exit code: 3");
    expect(calls).not.toContain("git pull --ff-only origin main");
    expect(calls).not.toContain("git reset --hard abc1234");
  });

  it("refuses wrong branches before mutation", async () => {
    const calls: string[] = [];
    const result = await applyManagedSourceUpdate({
      installMethod: managedSourceInfo(),
      homeDir: "/tmp/home",
      pathExists: async () => true,
      commandRunner: runnerFor(calls, {
        "git rev-parse --show-toplevel": ok("/repo\n"),
        "git remote get-url origin": ok("https://github.com/KemetResearch/EstaCoda.git\n"),
        "git rev-parse --abbrev-ref HEAD": ok("feature\n")
      })
    });

    expect(result.kind).toBe("error");
    expect(result.message).toContain("expected main");
    expect(result.message).toContain("will not switch branches");
    expect(calls).not.toContain("git pull --ff-only origin main");
  });

  it("refuses origin remotes that do not match the managed-source stamp", async () => {
    const calls: string[] = [];
    const result = await applyManagedSourceUpdate({
      installMethod: managedSourceInfo(),
      homeDir: "/tmp/home",
      pathExists: async () => true,
      commandRunner: runnerFor(calls, {
        "git rev-parse --show-toplevel": ok("/repo\n"),
        "git remote get-url origin": ok("https://example.com/fork.git\n")
      })
    });

    expect(result.kind).toBe("error");
    expect(result.message).toContain("origin remote does not match");
    expect(calls).not.toContain("git fetch origin");
    expect(calls).not.toContain("git reset --hard abc1234");
  });

  it.each([
    "https://github.com/KemetResearch/EstaCoda",
    "git@github.com:KemetResearch/EstaCoda.git"
  ])("accepts equivalent GitHub source URL form %s", async (originUrl) => {
    const calls: string[] = [];
    const result = await applyManagedSourceUpdate({
      installMethod: managedSourceInfo({
        sourceUrl: "https://github.com/KemetResearch/EstaCoda.git"
      }),
      homeDir: "/tmp/home",
      pathExists: async () => true,
      commandRunner: runnerFor(calls, {
        "git rev-parse --show-toplevel": ok("/repo\n"),
        "git remote get-url origin": ok(`${originUrl}\n`),
        "git rev-parse --abbrev-ref HEAD": ok("main\n"),
        "git status --porcelain": ok(""),
        "git rev-parse HEAD": ok("abc1234\n"),
        "git fetch origin": ok(""),
        "git rev-list --count HEAD..origin/main": ok("0\n")
      })
    });

    expect(result.kind).toBe("success");
    expect(calls).toContain("git fetch origin");
  });

  it("refuses malformed behind counts before mutation", async () => {
    const calls: string[] = [];
    const result = await applyManagedSourceUpdate({
      installMethod: managedSourceInfo(),
      homeDir: "/tmp/home",
      pathExists: async () => true,
      commandRunner: runnerFor(calls, {
        "git rev-parse --show-toplevel": ok("/repo\n"),
        "git remote get-url origin": ok("https://github.com/KemetResearch/EstaCoda.git\n"),
        "git rev-parse --abbrev-ref HEAD": ok("main\n"),
        "git status --porcelain": ok(""),
        "git rev-parse HEAD": ok("abc1234\n"),
        "git fetch origin": ok(""),
        "git rev-list --count HEAD..origin/main": ok("not-a-number\n")
      })
    });

    expect(result.kind).toBe("error");
    expect(result.message).toContain("could not determine");
    expect(calls).not.toContain("git pull --ff-only origin main");
    expect(calls).not.toContain("git reset --hard abc1234");
  });

  it("refuses manual-source without running git reset or other commands", async () => {
    const calls: string[] = [];
    const result = await applyManagedSourceUpdate({
      installMethod: { ...managedSourceInfo(), method: "manual-source", canSelfUpdate: false },
      homeDir: "/tmp/home",
      pathExists: async () => true,
      commandRunner: runnerFor(calls, {})
    });

    expect(result.kind).toBe("error");
    expect(result.message).toContain("manual-source");
    expect(calls).toEqual([]);
  });

  it("does not run build when pull fails and rolls back to pre-pull SHA", async () => {
    const calls: string[] = [];
    const result = await applyManagedSourceUpdate({
      installMethod: managedSourceInfo(),
      homeDir: "/tmp/home",
      pathExists: async () => true,
      commandRunner: runnerFor(calls, {
        "git rev-parse --show-toplevel": ok("/repo\n"),
        "git remote get-url origin": ok("https://github.com/KemetResearch/EstaCoda.git\n"),
        "git rev-parse --abbrev-ref HEAD": ok("main\n"),
        "git status --porcelain": ok(""),
        "git rev-parse HEAD": ok("abc1234\n"),
        "git fetch origin": ok(""),
        "git rev-list --count HEAD..origin/main": ok("1\n"),
        "git pull --ff-only origin main": fail("not fast-forward"),
        "git reset --hard abc1234": ok("")
      })
    });

    expect(result.kind).toBe("error");
    expect(result.message).toContain("Update failed during pull");
    expect(result.message).toContain("Rolled back managed-source checkout to abc1234");
    expect(calls).toContain("git reset --hard abc1234");
    expect(calls.some((call) => call.startsWith("pnpm "))).toBe(false);
  });

  it("rolls back when dependency install fails after pull and does not write cache", async () => {
    const calls: string[] = [];
    const writes: string[] = [];
    const result = await applyManagedSourceUpdate({
      installMethod: managedSourceInfo(),
      homeDir: "/tmp/home",
      pathExists: async () => true,
      commandRunner: runnerFor(calls, {
        "git rev-parse --show-toplevel": ok("/repo\n"),
        "git remote get-url origin": ok("https://github.com/KemetResearch/EstaCoda.git\n"),
        "git rev-parse --abbrev-ref HEAD": ok("main\n"),
        "git status --porcelain": ok(""),
        "git rev-parse HEAD": ok("abc1234\n"),
        "git fetch origin": ok(""),
        "git rev-list --count HEAD..origin/main": ok("1\n"),
        "git pull --ff-only origin main": ok(""),
        "pnpm install --frozen-lockfile": fail("install failed"),
        "git reset --hard abc1234": ok("")
      }),
      writeCache: async (_homeDir, status) => {
        writes.push(status);
      }
    });

    expect(result.kind).toBe("error");
    expect(result.message).toContain("Update failed during dependency install");
    expect(calls).toContain("git reset --hard abc1234");
    expect(calls).not.toContain("pnpm run build");
    expect(writes).toEqual([]);
  });

  it("rolls back when build fails after pull", async () => {
    const calls: string[] = [];
    const result = await applyManagedSourceUpdate({
      installMethod: managedSourceInfo(),
      homeDir: "/tmp/home",
      pathExists: async () => true,
      commandRunner: runnerFor(calls, {
        "git rev-parse --show-toplevel": ok("/repo\n"),
        "git remote get-url origin": ok("https://github.com/KemetResearch/EstaCoda.git\n"),
        "git rev-parse --abbrev-ref HEAD": ok("main\n"),
        "git status --porcelain": ok(""),
        "git rev-parse HEAD": ok("abc1234\n"),
        "git fetch origin": ok(""),
        "git rev-list --count HEAD..origin/main": ok("1\n"),
        "git pull --ff-only origin main": ok(""),
        "pnpm install --frozen-lockfile": ok(""),
        "pnpm run build": fail("build failed"),
        "git reset --hard abc1234": ok("")
      })
    });

    expect(result.kind).toBe("error");
    expect(result.message).toContain("Update failed during build");
    expect(calls).toContain("git reset --hard abc1234");
  });

  it("rolls back when version validation fails", async () => {
    const calls: string[] = [];
    const result = await applyManagedSourceUpdate({
      installMethod: managedSourceInfo(),
      homeDir: "/tmp/home",
      pathExists: async () => true,
      commandRunner: runnerFor(calls, {
        "git rev-parse --show-toplevel": ok("/repo\n"),
        "git remote get-url origin": ok("https://github.com/KemetResearch/EstaCoda.git\n"),
        "git rev-parse --abbrev-ref HEAD": ok("main\n"),
        "git status --porcelain": ok(""),
        "git rev-parse HEAD": ok("abc1234\n"),
        "git fetch origin": ok(""),
        "git rev-list --count HEAD..origin/main": ok("1\n"),
        "git pull --ff-only origin main": ok(""),
        "pnpm install --frozen-lockfile": ok(""),
        "pnpm run build": ok(""),
        "node dist/index.js --version": fail("missing dist"),
        "git reset --hard abc1234": ok("")
      })
    });

    expect(result.kind).toBe("error");
    expect(result.message).toContain("Update failed during post-update validation");
    expect(calls).toContain("git reset --hard abc1234");
  });

  it("rolls back when help validation fails", async () => {
    const calls: string[] = [];
    const result = await applyManagedSourceUpdate({
      installMethod: managedSourceInfo(),
      homeDir: "/tmp/home",
      pathExists: async () => true,
      commandRunner: runnerFor(calls, {
        "git rev-parse --show-toplevel": ok("/repo\n"),
        "git remote get-url origin": ok("https://github.com/KemetResearch/EstaCoda.git\n"),
        "git rev-parse --abbrev-ref HEAD": ok("main\n"),
        "git status --porcelain": ok(""),
        "git rev-parse HEAD": ok("abc1234\n"),
        "git fetch origin": ok(""),
        "git rev-list --count HEAD..origin/main": ok("1\n"),
        "git pull --ff-only origin main": ok(""),
        "pnpm install --frozen-lockfile": ok(""),
        "pnpm run build": ok(""),
        "node dist/index.js --version": ok("0.0.5\n"),
        "node dist/index.js --help": fail("help failed"),
        "git reset --hard abc1234": ok("")
      })
    });

    expect(result.kind).toBe("error");
    expect(result.message).toContain("Update failed during post-update validation");
    expect(calls).toContain("git reset --hard abc1234");
  });

  it("treats successful cache write failures as non-fatal", async () => {
    const calls: string[] = [];
    const result = await applyManagedSourceUpdate({
      installMethod: managedSourceInfo(),
      homeDir: "/tmp/home",
      pathExists: async () => true,
      commandRunner: runnerFor(calls, {
        "git rev-parse --show-toplevel": ok("/repo\n"),
        "git remote get-url origin": ok("https://github.com/KemetResearch/EstaCoda.git\n"),
        "git rev-parse --abbrev-ref HEAD": ok("main\n"),
        "git status --porcelain": ok(""),
        "git rev-parse HEAD": ok("abc1234\n"),
        "git fetch origin": ok(""),
        "git rev-list --count HEAD..origin/main": ok("1\n"),
        "git pull --ff-only origin main": ok(""),
        "pnpm install --frozen-lockfile": ok(""),
        "pnpm run build": ok(""),
        "node dist/index.js --version": ok("0.0.5\n"),
        "node dist/index.js --help": ok("Usage\n")
      }),
      writeCache: async () => {
        throw new Error("cache denied");
      }
    });

    expect(result.kind).toBe("success");
    expect(result.message).toContain("Update applied");
  });
});

function managedSourceInfo(overrides: Partial<InstallMethodInfo> = {}): InstallMethodInfo {
  return {
    method: "managed-source",
    source: "stamp",
    installDir: "/repo",
    sourceUrl: "https://github.com/KemetResearch/EstaCoda.git",
    branch: "main",
    expectedBranch: "main",
    recommendedUpdateCommand: "estacoda update",
    canSelfUpdate: true,
    reason: "Install method stamp declares managed-source.",
    ...overrides
  };
}

function runnerFor(calls: string[], responses: Record<string, GitCommandResult>): SourceUpdateCommandRunner {
  return async (command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    return responses[key] ?? fail(`unexpected command: ${key}`);
  };
}

function ok(stdout: string): GitCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function fail(stderr: string): GitCommandResult {
  return { exitCode: 1, stdout: "", stderr };
}
