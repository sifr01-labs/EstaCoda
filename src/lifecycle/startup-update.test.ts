import { describe, expect, it, vi } from "vitest";
import {
  buildStartupUpdateHint,
  prefetchStartupUpdateStatus,
  scheduleStartupUpdatePrefetch,
  shouldScheduleStartupUpdatePrefetch
} from "./startup-update.js";
import type { InstallMethodInfo } from "./install-method.js";

function installMethod(overrides: Partial<InstallMethodInfo> = {}): InstallMethodInfo {
  return {
    method: "managed-source",
    source: "stamp",
    installDir: "/repo",
    sourceUrl: "https://github.com/sifr01-labs/EstaCoda.git",
    branch: "main",
    expectedBranch: "main",
    recommendedUpdateCommand: "estacoda update",
    canSelfUpdate: true,
    reason: "test",
    ...overrides
  };
}

describe("scheduleStartupUpdatePrefetch", () => {
  it("gates scheduling to interactive bare startup only", () => {
    expect(shouldScheduleStartupUpdatePrefetch([], true)).toBe(true);
    expect(shouldScheduleStartupUpdatePrefetch([], false)).toBe(false);
    expect(shouldScheduleStartupUpdatePrefetch(["gateway"], true)).toBe(false);
    expect(shouldScheduleStartupUpdatePrefetch(["hello"], true)).toBe(false);
    expect(shouldScheduleStartupUpdatePrefetch(["/status"], true)).toBe(false);
  });

  it("schedules prefetch without running it synchronously", () => {
    const tasks: Array<() => void> = [];
    const readCachedUpdateInfo = vi.fn(async () => ({ versionStatus: "unknown" as const }));

    scheduleStartupUpdatePrefetch({
      homeDir: "/home/test",
      readCachedUpdateInfo
    }, (task) => {
      tasks.push(task);
    });

    expect(tasks).toHaveLength(1);
    expect(readCachedUpdateInfo).not.toHaveBeenCalled();
  });
});

describe("prefetchStartupUpdateStatus", () => {
  it("respects a fresh six-hour update cache and skips detection", async () => {
    const detectInstallMethod = vi.fn(async () => installMethod());
    const writeCachedUpdateStatus = vi.fn();

    await prefetchStartupUpdateStatus({
      homeDir: "/home/test",
      readCachedUpdateInfo: async () => ({ versionStatus: "update-available" }),
      detectInstallMethod,
      writeCachedUpdateStatus
    });

    expect(detectInstallMethod).not.toHaveBeenCalled();
    expect(writeCachedUpdateStatus).not.toHaveBeenCalled();
  });

  it("treats detection failure as silent and non-fatal", async () => {
    await expect(prefetchStartupUpdateStatus({
      homeDir: "/home/test",
      readCachedUpdateInfo: async () => ({ versionStatus: "unknown" }),
      detectInstallMethod: async () => {
        throw new Error("boom");
      }
    })).resolves.toBeUndefined();
  });

  it("checks managed-source without mutating remote refs and writes an update hint", async () => {
    const writeCachedUpdateStatus = vi.fn(async () => {});
    const checkGitUpdate = vi.fn(async () => ({
      ok: true as const,
      kind: "available" as const,
      info: {
        current: "1111111",
        latest: "2222222",
        branch: "main",
        remote: "origin",
        repoDir: "/repo",
        commitsBehind: 3
      }
    }));

    await prefetchStartupUpdateStatus({
      homeDir: "/home/test",
      readCachedUpdateInfo: async () => ({ versionStatus: "unknown" }),
      detectInstallMethod: async () => installMethod(),
      checkGitUpdate,
      writeCachedUpdateStatus
    });

    expect(checkGitUpdate).toHaveBeenCalledWith(expect.any(Object), { mutateRemoteRefs: false });
    expect(writeCachedUpdateStatus).toHaveBeenCalledWith(
      "/home/test",
      "update-available",
      "Update available: 3 commits behind origin/main. Run: estacoda update"
    );
  });

  it("checks manual-source with ls-remote style non-mutating git check", async () => {
    const writeCachedUpdateStatus = vi.fn(async () => {});
    const checkGitUpdate = vi.fn(async () => ({
      ok: true as const,
      kind: "available" as const,
      info: {
        current: "1111111",
        latest: "2222222",
        branch: "main",
        remote: "origin",
        repoDir: "/repo",
        commitsBehind: 1
      }
    }));

    await prefetchStartupUpdateStatus({
      homeDir: "/home/test",
      readCachedUpdateInfo: async () => ({ versionStatus: "unknown" }),
      detectInstallMethod: async () => installMethod({
        method: "manual-source",
        canSelfUpdate: false,
        recommendedUpdateCommand: "git fetch origin && git status"
      }),
      checkGitUpdate,
      writeCachedUpdateStatus
    });

    expect(checkGitUpdate).toHaveBeenCalledWith(expect.any(Object), { mutateRemoteRefs: false });
    expect(writeCachedUpdateStatus).toHaveBeenCalledWith(
      "/home/test",
      "update-available",
      expect.stringContaining("EstaCoda will not mutate this checkout automatically.")
    );
  });

  it("uses release checks for package-manager methods and writes manager guidance", async () => {
    const writeCachedUpdateStatus = vi.fn(async () => {});

    await prefetchStartupUpdateStatus({
      homeDir: "/home/test",
      readCachedUpdateInfo: async () => ({ versionStatus: "unknown" }),
      detectInstallMethod: async () => installMethod({
        method: "homebrew",
        source: "path",
        canSelfUpdate: false,
        recommendedUpdateCommand: "brew upgrade kemetresearch/tap/estacoda"
      }),
      checkForUpdate: async () => ({
        kind: "available",
        info: {
          current: "0.0.6",
          latest: "0.1.0",
          releaseNotesUrl: "https://example.test",
          breakingChanges: false
        }
      }),
      writeCachedUpdateStatus
    });

    expect(writeCachedUpdateStatus).toHaveBeenCalledWith(
      "/home/test",
      "update-available",
      "Homebrew install detected. Update with: brew upgrade kemetresearch/tap/estacoda"
    );
  });

  it("does not write an update hint for up-to-date checks", async () => {
    const writeCachedUpdateStatus = vi.fn(async () => {});

    await prefetchStartupUpdateStatus({
      homeDir: "/home/test",
      readCachedUpdateInfo: async () => ({ versionStatus: "unknown" }),
      detectInstallMethod: async () => installMethod(),
      checkGitUpdate: async () => ({
        ok: true,
        kind: "up-to-date",
        info: {
          current: "1111111",
          latest: "1111111",
          branch: "main",
          remote: "origin",
          repoDir: "/repo",
          commitsBehind: 0
        }
      }),
      writeCachedUpdateStatus
    });

    expect(writeCachedUpdateStatus).toHaveBeenCalledWith("/home/test", "up-to-date", undefined);
  });

  it("treats cache write failure as non-fatal", async () => {
    await expect(prefetchStartupUpdateStatus({
      homeDir: "/home/test",
      readCachedUpdateInfo: async () => ({ versionStatus: "unknown" }),
      detectInstallMethod: async () => installMethod(),
      checkGitUpdate: async () => ({
        ok: true,
        kind: "available",
        info: {
          current: "1111111",
          latest: "2222222",
          branch: "main",
          remote: "origin",
          repoDir: "/repo"
        }
      }),
      writeCachedUpdateStatus: async () => {
        throw new Error("readonly");
      }
    })).resolves.toBeUndefined();
  });
});

describe("buildStartupUpdateHint", () => {
  it("omits hints when update status is not available", () => {
    expect(buildStartupUpdateHint({
      installMethod: installMethod(),
      versionStatus: "up-to-date"
    })).toBeUndefined();
  });

  it("renders docker guidance without implying self-update", () => {
    expect(buildStartupUpdateHint({
      installMethod: installMethod({
        method: "docker",
        source: "container",
        canSelfUpdate: false,
        recommendedUpdateCommand: "docker pull ghcr.io/sifr01-labs/estacoda:latest"
      }),
      versionStatus: "update-available"
    })).toBe("Docker/container install detected. Update with: docker pull ghcr.io/sifr01-labs/estacoda:latest");
  });
});
