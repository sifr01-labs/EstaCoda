import { describe, expect, it } from "vitest";
import { runUpdateCommand } from "./update-command.js";
import type { InstallMethod, InstallMethodInfo } from "../lifecycle/install-method.js";
import type { GitUpdateResolverResult } from "../lifecycle/version-resolver.js";

function installInfo(method: InstallMethod, overrides: Partial<InstallMethodInfo> = {}): InstallMethodInfo {
  const commandByMethod: Record<InstallMethod, string> = {
    "managed-source": "estacoda update",
    "manual-source": "git fetch origin && git status",
    homebrew: "brew upgrade kemetresearch/tap/estacoda",
    docker: "docker pull ghcr.io/kemetresearch/estacoda:latest",
    "npm-global": "npm install -g estacoda@latest",
    "pnpm-global": "pnpm add -g estacoda@latest",
    unknown: "reinstall using documented install path"
  };

  return {
    method,
    source: "path",
    recommendedUpdateCommand: commandByMethod[method],
    canSelfUpdate: method === "managed-source",
    reason: `${method} test install`,
    ...overrides
  };
}

describe("runUpdateCommand install-method routing", () => {
  it.each([
    ["manual-source", "git fetch origin && git status"],
    ["homebrew", "brew upgrade kemetresearch/tap/estacoda"],
    ["docker", "docker pull ghcr.io/kemetresearch/estacoda:latest"],
    ["npm-global", "npm install -g estacoda@latest"],
    ["pnpm-global", "pnpm add -g estacoda@latest"],
    ["unknown", "reinstall using documented install path"]
  ] as const)("prints safe dry-run guidance for %s installs", async (method, command) => {
    let checked = false;
    const result = await runUpdateCommand({
      dryRun: true,
      apply: false,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo(method),
      checkForUpdate: async () => {
        checked = true;
        return { kind: "error", message: "should not check" };
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Update routing (dry run)");
    expect(result.output).toContain(`Detected install method: ${method}`);
    expect(result.output).toContain(command);
    expect(result.output).toContain("This was a dry run. No files were modified.");
    expect(checked).toBe(false);
  });

  it.each([
    ["homebrew", "Homebrew install detected. Run: brew upgrade kemetresearch/tap/estacoda"],
    ["docker", "Docker/container install detected. Run: docker pull ghcr.io/kemetresearch/estacoda:latest"],
    ["npm-global", "npm global install detected. Run: npm install -g estacoda@latest"],
    ["pnpm-global", "pnpm global install detected. Run: pnpm add -g estacoda@latest"],
    ["unknown", "Unknown install method. Run: reinstall using documented install path"]
  ] as const)("prints check guidance for %s installs", async (method, message) => {
    const result = await runUpdateCommand({
      check: true,
      dryRun: true,
      apply: false,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo(method)
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Update check");
    expect(result.output).toContain(message);
    expect(result.output).toContain("This was a check. No files were modified.");
  });

  it("refuses to self-mutate manual-source installs on apply", async () => {
    const result = await runUpdateCommand({
      dryRun: false,
      apply: true,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo("manual-source")
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Detected install method: manual-source");
    expect(result.output).toContain("Manual source checkouts are not self-mutated");
    expect(result.output).toContain("No files were modified.");
  });

  it("reports that managed-source apply is reserved for PR-I5", async () => {
    let checkedArtifact = false;
    let appliedArtifact = false;
    const result = await runUpdateCommand({
      dryRun: false,
      apply: true,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo("managed-source"),
      canApplyUpdate: () => {
        checkedArtifact = true;
        return { testable: true, reason: "test artifact" };
      },
      applyUpdate: async () => {
        appliedArtifact = true;
        return { kind: "success", message: "should not apply" };
      }
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Detected install method: managed-source");
    expect(result.output).toContain("PR-I5");
    expect(result.output).toContain("No files were modified.");
    expect(checkedArtifact).toBe(false);
    expect(appliedArtifact).toBe(false);
  });

  it("reports managed-source update availability through git without applying", async () => {
    const result = await runUpdateCommand({
      check: true,
      dryRun: true,
      apply: false,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo("managed-source", {
        installDir: "/repo",
        sourceUrl: "https://github.com/KemetResearch/EstaCoda.git",
        expectedBranch: "main"
      }),
      checkGitUpdate: async (info, options): Promise<GitUpdateResolverResult> => {
        expect(info.installDir).toBe("/repo");
        expect(options.mutateRemoteRefs).toBe(true);
        return {
          ok: true,
          kind: "available",
          info: {
            current: "local",
            latest: "remote",
            branch: "main",
            remote: "origin",
            repoDir: "/repo",
            commitsBehind: 3
          }
        };
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Update available: 3 commits behind origin/main.");
    expect(result.output).toContain("Run: estacoda update");
    expect(result.output).toContain("No files were modified.");
  });

  it("reports managed-source up-to-date through git", async () => {
    const result = await runUpdateCommand({
      check: true,
      dryRun: true,
      apply: false,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo("managed-source", { installDir: "/repo", expectedBranch: "main" }),
      checkGitUpdate: async (): Promise<GitUpdateResolverResult> => ({
        ok: true,
        kind: "up-to-date",
        info: {
          current: "same",
          latest: "same",
          branch: "main",
          remote: "origin",
          repoDir: "/repo",
          commitsBehind: 0
        }
      })
    });

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("Already up to date.");
  });

  it("returns exit 1 when managed-source check fails", async () => {
    const result = await runUpdateCommand({
      check: true,
      dryRun: true,
      apply: false,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo("managed-source", { installDir: "/repo", expectedBranch: "main" }),
      checkGitUpdate: async (): Promise<GitUpdateResolverResult> => ({
        ok: false,
        error: "Git update check failed during fetch origin/main: auth failed"
      })
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Update check failed");
  });

  it("prints manual-source check advice without mutating refs", async () => {
    const result = await runUpdateCommand({
      check: true,
      dryRun: true,
      apply: false,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo("manual-source", { installDir: "/repo", expectedBranch: "main" }),
      checkGitUpdate: async (_info, options): Promise<GitUpdateResolverResult> => {
        expect(options.mutateRemoteRefs).toBe(false);
        return {
          ok: true,
          kind: "available",
          info: {
            current: "local",
            latest: "remote",
            branch: "main",
            remote: "origin",
            repoDir: "/repo"
          }
        };
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Update may be available on origin/main.");
    expect(result.output).toContain("Manual source checkout detected. Run: git fetch origin && git status");
    expect(result.output).toContain("EstaCoda will not mutate this checkout automatically.");
  });

  it("keeps existing manual-source dry-run advisory without git probing", async () => {
    let checked = false;
    const result = await runUpdateCommand({
      dryRun: true,
      apply: false,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo("manual-source", { installDir: "/repo", expectedBranch: "main" }),
      checkGitUpdate: async (): Promise<GitUpdateResolverResult> => {
        checked = true;
        return { ok: false, error: "should not check" };
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Update routing (dry run)");
    expect(result.output).toContain("Manual source checkout detected");
    expect(checked).toBe(false);
  });

  it("does not invoke git checks for non-source methods", async () => {
    let checked = false;
    const result = await runUpdateCommand({
      check: true,
      dryRun: true,
      apply: false,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo("homebrew"),
      checkGitUpdate: async (): Promise<GitUpdateResolverResult> => {
        checked = true;
        return { ok: false, error: "should not check" };
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("brew upgrade");
    expect(checked).toBe(false);
  });

  it("keeps managed-source dry-run on the existing update check path", async () => {
    const result = await runUpdateCommand({
      dryRun: true,
      apply: false,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo("managed-source"),
      checkGitUpdate: async (): Promise<GitUpdateResolverResult> => ({
        ok: true,
        kind: "up-to-date",
        info: {
          current: "same",
          latest: "same",
          branch: "main",
          remote: "origin",
          repoDir: "/repo",
          commitsBehind: 0
        }
      })
    });

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("Already up to date.");
  });
});
