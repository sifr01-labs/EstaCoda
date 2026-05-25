import { describe, it, expect } from "vitest";
import {
  getLocalVersion,
  resolveLatestVersion,
  compareVersions,
  resolveGitUpdateInfo,
  type GitCommandRunner
} from "./version-resolver.js";

describe("getLocalVersion", () => {
  it("returns a semver string", async () => {
    const version = await getLocalVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("falls back to git describe when package metadata is unavailable", async () => {
    const gitRunner: GitCommandRunner = async (args) => {
      expect(args).toEqual(["describe", "--tags", "--always", "--dirty"]);
      return { exitCode: 0, stdout: "v0.1.0-2-gabc123\n", stderr: "" };
    };

    const version = await getLocalVersion({
      packagePath: "/missing/package.json",
      cwd: "/repo",
      gitRunner
    });

    expect(version).toBe("0.1.0-2-gabc123");
  });

  it("falls back to 0.0.0 when git describe fails", async () => {
    const gitRunner: GitCommandRunner = async () => ({ exitCode: 1, stdout: "", stderr: "fatal: no names found" });

    const version = await getLocalVersion({
      packagePath: "/missing/package.json",
      cwd: "/repo",
      gitRunner
    });

    expect(version).toBe("0.0.0");
  });
});

describe("resolveLatestVersion", () => {
  it("handles network failure gracefully", async () => {
    const badFetch = () => Promise.reject(new Error("network down"));
    const result = await resolveLatestVersion(badFetch as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("network down");
    }
  });

  it("handles non-ok HTTP response", async () => {
    const mockFetch = () =>
      Promise.resolve({
        ok: false,
        status: 404
      } as Response);

    const result = await resolveLatestVersion(mockFetch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("404");
    }
  });
});

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("returns negative when left < right", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("0.1.0", "0.1.1")).toBeLessThan(0);
  });

  it("returns positive when left > right", () => {
    expect(compareVersions("0.2.0", "0.1.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });
});

describe("resolveGitUpdateInfo", () => {
  it("reports managed source check available with commits behind after fetch", async () => {
    const calls: readonly string[][] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      (calls as string[][]).push([...args]);
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { exitCode: 0, stdout: "1111111\n", stderr: "" };
      }
      if (args[0] === "fetch") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "FETCH_HEAD") {
        return { exitCode: 0, stdout: "2222222\n", stderr: "" };
      }
      if (args[0] === "rev-list") {
        return { exitCode: 0, stdout: "3\n", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };

    const result = await resolveGitUpdateInfo({
      repoDir: "/repo",
      branch: "main",
      remote: "origin",
      gitRunner
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("available");
      expect(result.info.commitsBehind).toBe(3);
    }
    expect(calls).toEqual([
      ["rev-parse", "HEAD"],
      ["fetch", "--quiet", "--no-tags", "origin", "main"],
      ["rev-parse", "FETCH_HEAD"],
      ["rev-list", "--count", "HEAD..FETCH_HEAD"]
    ]);
  });

  it("reports up-to-date when HEAD matches FETCH_HEAD", async () => {
    const gitRunner: GitCommandRunner = async (args) => {
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: "1111111\n", stderr: "" };
      }
      if (args[0] === "fetch") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-list") {
        return { exitCode: 0, stdout: "0\n", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };

    const result = await resolveGitUpdateInfo({
      repoDir: "/repo",
      branch: "main",
      remote: "origin",
      gitRunner
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("up-to-date");
      expect(result.info.commitsBehind).toBe(0);
    }
  });

  it("supports non-mutating manual-source checks with ls-remote", async () => {
    const calls: readonly string[][] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      (calls as string[][]).push([...args]);
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: "1111111\n", stderr: "" };
      }
      if (args[0] === "ls-remote") {
        return { exitCode: 0, stdout: "2222222\trefs/heads/main\n", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };

    const result = await resolveGitUpdateInfo({
      repoDir: "/repo",
      branch: "main",
      remote: "origin",
      mutateRemoteRefs: false,
      gitRunner
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("available");
      expect(result.info.commitsBehind).toBeUndefined();
    }
    expect(calls).toEqual([
      ["rev-parse", "HEAD"],
      ["ls-remote", "origin", "refs/heads/main"]
    ]);
  });

  it("handles malformed ls-remote output safely", async () => {
    const gitRunner: GitCommandRunner = async (args) => {
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: "1111111\n", stderr: "" };
      }
      if (args[0] === "ls-remote") {
        return { exitCode: 0, stdout: "not-a-sha\trefs/heads/main\n", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };

    const result = await resolveGitUpdateInfo({
      repoDir: "/repo",
      branch: "main",
      remote: "origin",
      mutateRemoteRefs: false,
      gitRunner
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("was not found");
    }
  });

  it("redacts sensitive git error output", async () => {
    const gitRunner: GitCommandRunner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "fatal: https://token@example.com/repo.git OPENAI_API_KEY=sk-secret"
    });

    const result = await resolveGitUpdateInfo({
      repoDir: "/repo",
      branch: "main",
      remote: "origin",
      gitRunner
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("token@example.com");
      expect(result.error).not.toContain("sk-secret");
      expect(result.error).toContain("[redacted]");
    }
  });
});
