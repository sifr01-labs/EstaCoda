import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runUpdateCommand, type GatewayRestartHandoffOptions } from "./update-command.js";
import { updateLogPath } from "./update-resilience.js";
import type { InstallMethod, InstallMethodInfo } from "../lifecycle/install-method.js";
import type { UpdateApplyResult } from "../lifecycle/update-engine.js";
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
    const homeDir = mkdtempSync(join(tmpdir(), "estacoda-update-command-"));
    try {
      const result = await runUpdateCommand({
        dryRun: false,
        apply: true,
        explicitApply: true,
        homeDir,
        installMethodInfo: installInfo("manual-source")
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Detected install method: manual-source");
      expect(result.output).toContain("Manual source checkouts are not self-mutated");
      expect(result.output).toContain("No files were modified.");
      expect(existsSync(updateLogPath(homeDir))).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("applies managed-source updates through the source updater without artifact update", async () => {
    let checkedArtifact = false;
    let appliedArtifact = false;
    let appliedSource = false;
    const result = await runUpdateCommand({
      dryRun: false,
      apply: true,
      explicitApply: true,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo("managed-source", {
        source: "stamp",
        installDir: "/repo",
        sourceUrl: "https://github.com/KemetResearch/EstaCoda.git",
        expectedBranch: "main"
      }),
      canApplyUpdate: () => {
        checkedArtifact = true;
        return { testable: true, reason: "test artifact" };
      },
      applyUpdate: async () => {
        appliedArtifact = true;
        return { kind: "success", message: "should not apply" };
      },
      applyManagedSourceUpdate: async (input): Promise<UpdateApplyResult> => {
        appliedSource = true;
        expect(input.homeDir).toBe("/tmp/estacoda-home");
        expect(input.installMethod.installDir).toBe("/repo");
        expect(input.backupMode).toBe("default");
        return { kind: "success", message: "Update applied: test" };
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Detected install method: managed-source");
    expect(result.output).toContain("Update applied: test");
    expect(checkedArtifact).toBe(false);
    expect(appliedArtifact).toBe(false);
    expect(appliedSource).toBe(true);
  });

  it("wraps managed-source apply with update logging", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "estacoda-update-command-"));
    try {
      const result = await runUpdateCommand({
        dryRun: false,
        apply: true,
        explicitApply: false,
        homeDir,
        installMethodInfo: installInfo("managed-source", {
          source: "stamp",
          installDir: "/repo",
          sourceUrl: "https://github.com/KemetResearch/EstaCoda.git",
          expectedBranch: "main"
        }),
        applyManagedSourceUpdate: async (): Promise<UpdateApplyResult> => ({
          kind: "success",
          message: "Update applied from TOKEN=secret-value"
        })
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(`Update log: ${updateLogPath(homeDir)}`);
      const log = readFileSync(updateLogPath(homeDir), "utf8");
      expect(log).toContain("update result: success");
      expect(log).toContain("TOKEN=[redacted]");
      expect(log).not.toContain("secret-value");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("reports unavailable update logging without blocking managed-source apply", async () => {
    const result = await runUpdateCommand({
      dryRun: false,
      apply: true,
      explicitApply: false,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo("managed-source", {
        source: "stamp",
        installDir: "/repo",
        sourceUrl: "https://github.com/KemetResearch/EstaCoda.git",
        expectedBranch: "main"
      }),
      runUpdateWithResilience: async (input) => ({
        result: await input.run(),
        logAvailable: false,
        logFailure: "disk full",
        sighupReceived: false
      }),
      applyManagedSourceUpdate: async (): Promise<UpdateApplyResult> => ({
        kind: "success",
        message: "Update applied."
      })
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Update applied.");
    expect(result.output).toContain("Update log unavailable: disk full");
  });

  it("passes explicit backup modes to managed-source updates", async () => {
    const seenModes: Array<"default" | "force" | "skip" | undefined> = [];

    for (const backupMode of ["force", "skip"] as const) {
      const result = await runUpdateCommand({
        dryRun: false,
        apply: true,
        explicitApply: true,
        backupMode,
        homeDir: "/tmp/estacoda-home",
        installMethodInfo: installInfo("managed-source", {
          source: "stamp",
          installDir: "/repo",
          sourceUrl: "https://github.com/KemetResearch/EstaCoda.git",
          expectedBranch: "main"
        }),
        applyManagedSourceUpdate: async (input): Promise<UpdateApplyResult> => {
          seenModes.push(input.backupMode);
          return { kind: "success", message: `Update applied with ${input.backupMode}` };
        }
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(`Update applied with ${backupMode}`);
    }

    expect(seenModes).toEqual(["force", "skip"]);
  });

  it("managed-source --gateway uses the non-interactive resilience path and appends restart handoff on success", async () => {
    let restarted = false;
    let usedResilience = false;
    const result = await runUpdateCommand({
      dryRun: false,
      apply: true,
      gatewayMode: true,
      homeDir: "/tmp/estacoda-home",
      profileId: "gateway-profile",
      installMethodInfo: installInfo("managed-source", {
        source: "stamp",
        installDir: "/repo",
        sourceUrl: "https://github.com/KemetResearch/EstaCoda.git",
        expectedBranch: "main"
      }),
      runUpdateWithResilience: async (input) => {
        usedResilience = true;
        return {
          result: await input.run(),
          logAvailable: true,
          logPath: "/tmp/estacoda-home/.estacoda/logs/update.log",
          sighupReceived: false
        };
      },
      applyManagedSourceUpdate: async (): Promise<UpdateApplyResult> => ({
        kind: "success",
        message: "Update applied."
      }),
      restartGatewayService: async (options: GatewayRestartHandoffOptions) => {
        restarted = true;
        expect(options.profileId).toBe("gateway-profile");
        return {
          restarted: true,
          message: "Gateway service restarted (user scope, profile: gateway-profile)."
        };
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Update applied.");
    expect(result.output).toContain("Gateway service restarted");
    expect(result.output).toContain("Update log: /tmp/estacoda-home/.estacoda/logs/update.log");
    expect(usedResilience).toBe(true);
    expect(restarted).toBe(true);
  });

  it("managed-source --gateway falls back to manual restart guidance when no service handoff is available", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "estacoda-update-command-"));
    try {
      const result = await runUpdateCommand({
        dryRun: false,
        apply: true,
        gatewayMode: true,
        homeDir,
        profileId: "gateway-profile",
        installMethodInfo: installInfo("managed-source", {
          source: "stamp",
          installDir: "/repo",
          sourceUrl: "https://github.com/KemetResearch/EstaCoda.git",
          expectedBranch: "main"
        }),
        applyManagedSourceUpdate: async (): Promise<UpdateApplyResult> => ({
          kind: "success",
          message: "Update applied."
        })
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Update applied.");
      expect(result.output).toContain("Gateway restart:");
      expect(result.output).toContain("estacoda gateway restart");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("managed-source --gateway failure does not restart the gateway", async () => {
    let restarted = false;
    const result = await runUpdateCommand({
      dryRun: false,
      apply: true,
      gatewayMode: true,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo("managed-source", { source: "stamp" }),
      applyManagedSourceUpdate: async (): Promise<UpdateApplyResult> => ({
        kind: "error",
        message: "Update failed during build."
      }),
      restartGatewayService: async () => {
        restarted = true;
        return { restarted: true, message: "should not restart" };
      }
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Update failed during build.");
    expect(result.output).not.toContain("Gateway service restarted");
    expect(restarted).toBe(false);
  });

  it("maps managed-source dirty worktree refusal to exit 3", async () => {
    const result = await runUpdateCommand({
      dryRun: false,
      apply: true,
      explicitApply: true,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo("managed-source", { source: "stamp" }),
      applyManagedSourceUpdate: async (): Promise<UpdateApplyResult> => ({
        kind: "error",
        message: "Update refused: managed-source worktree has uncommitted changes.\nExit code: 3"
      })
    });

    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("uncommitted changes");
  });

  it("managed-source --gateway dirty worktree refusal exits 3 and does not restart", async () => {
    let restarted = false;
    const result = await runUpdateCommand({
      dryRun: false,
      apply: true,
      gatewayMode: true,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo("managed-source", { source: "stamp" }),
      applyManagedSourceUpdate: async (): Promise<UpdateApplyResult> => ({
        kind: "error",
        message: "Update refused: managed-source worktree has uncommitted changes.\nExit code: 3"
      }),
      restartGatewayService: async () => {
        restarted = true;
        return { restarted: true, message: "should not restart" };
      }
    });

    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("uncommitted changes");
    expect(restarted).toBe(false);
  });

  it.each([
    "homebrew",
    "docker",
    "npm-global",
    "pnpm-global",
    "unknown"
  ] as const)("routes %s apply without source or artifact mutation", async (method) => {
    const homeDir = mkdtempSync(join(tmpdir(), "estacoda-update-command-"));
    let appliedSource = false;
    let appliedArtifact = false;
    try {
      const result = await runUpdateCommand({
        dryRun: false,
        apply: true,
        explicitApply: true,
        homeDir,
        installMethodInfo: installInfo(method),
        applyManagedSourceUpdate: async (): Promise<UpdateApplyResult> => {
          appliedSource = true;
          return { kind: "success", message: "should not apply" };
        },
        applyUpdate: async () => {
          appliedArtifact = true;
          return { kind: "success", message: "should not apply" };
        }
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("No files were modified.");
      expect(appliedSource).toBe(false);
      expect(appliedArtifact).toBe(false);
      expect(existsSync(updateLogPath(homeDir))).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("treats default non-self-update routing as successful guidance", async () => {
    const result = await runUpdateCommand({
      dryRun: false,
      apply: true,
      explicitApply: false,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo("homebrew")
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Homebrew install detected");
    expect(result.output).toContain("No files were modified.");
  });

  it.each([
    ["manual-source", "git fetch origin && git status"],
    ["homebrew", "brew upgrade kemetresearch/tap/estacoda"],
    ["docker", "docker pull ghcr.io/kemetresearch/estacoda:latest"],
    ["npm-global", "npm install -g estacoda@latest"],
    ["pnpm-global", "pnpm add -g estacoda@latest"],
    ["unknown", "reinstall using documented install path"]
  ] as const)("--gateway routes %s without self-mutation and prints restart instruction", async (method, command) => {
    const homeDir = mkdtempSync(join(tmpdir(), "estacoda-update-command-"));
    let appliedSource = false;
    let restarted = false;
    try {
      const result = await runUpdateCommand({
        dryRun: false,
        apply: true,
        gatewayMode: true,
        homeDir,
        installMethodInfo: installInfo(method),
        applyManagedSourceUpdate: async (): Promise<UpdateApplyResult> => {
          appliedSource = true;
          return { kind: "success", message: "should not apply" };
        },
        restartGatewayService: async () => {
          restarted = true;
          return { restarted: true, message: "should not restart" };
        }
      });

      expect(result.output).toContain(command);
      expect(result.output).toContain("No files were modified.");
      expect(result.output).toContain("Gateway mode: no gateway restart was attempted.");
      expect(result.output).toContain("estacoda gateway restart");
      expect(appliedSource).toBe(false);
      expect(restarted).toBe(false);
      expect(existsSync(updateLogPath(homeDir))).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("reports managed-source update availability through git without applying", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "estacoda-update-command-"));
    let appliedSource = false;
    try {
      const result = await runUpdateCommand({
        check: true,
        dryRun: true,
        apply: false,
        homeDir,
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
        },
        applyManagedSourceUpdate: async (): Promise<UpdateApplyResult> => {
          appliedSource = true;
          return { kind: "success", message: "should not apply" };
        }
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Update available: 3 commits behind origin/main.");
      expect(result.output).toContain("Run: estacoda update");
      expect(result.output).toContain("No files were modified.");
      expect(appliedSource).toBe(false);
      expect(existsSync(updateLogPath(homeDir))).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
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

  it("--gateway plus --check does not mutate or restart", async () => {
    let appliedSource = false;
    let restarted = false;
    const result = await runUpdateCommand({
      check: true,
      dryRun: true,
      apply: false,
      gatewayMode: true,
      homeDir: "/tmp/estacoda-home",
      installMethodInfo: installInfo("managed-source", { installDir: "/repo", expectedBranch: "main" }),
      checkGitUpdate: async (): Promise<GitUpdateResolverResult> => ({
        ok: true,
        kind: "available",
        info: {
          current: "local",
          latest: "remote",
          branch: "main",
          remote: "origin",
          repoDir: "/repo",
          commitsBehind: 1
        }
      }),
      applyManagedSourceUpdate: async (): Promise<UpdateApplyResult> => {
        appliedSource = true;
        return { kind: "success", message: "should not apply" };
      },
      restartGatewayService: async () => {
        restarted = true;
        return { restarted: true, message: "should not restart" };
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Update available: 1 commits behind origin/main.");
    expect(result.output).toContain("Gateway mode: no gateway restart was attempted.");
    expect(appliedSource).toBe(false);
    expect(restarted).toBe(false);
  });

  it("--gateway plus --dry-run does not mutate or restart", async () => {
    let appliedSource = false;
    let restarted = false;
    const result = await runUpdateCommand({
      dryRun: true,
      apply: false,
      gatewayMode: true,
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
      }),
      applyManagedSourceUpdate: async (): Promise<UpdateApplyResult> => {
        appliedSource = true;
        return { kind: "success", message: "should not apply" };
      },
      restartGatewayService: async () => {
        restarted = true;
        return { restarted: true, message: "should not restart" };
      }
    });

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("Already up to date.");
    expect(result.output).toContain("Gateway mode: no gateway restart was attempted.");
    expect(appliedSource).toBe(false);
    expect(restarted).toBe(false);
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
    const homeDir = mkdtempSync(join(tmpdir(), "estacoda-update-command-"));
    let appliedSource = false;
    try {
      const result = await runUpdateCommand({
        dryRun: true,
        apply: false,
        homeDir,
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
        }),
        applyManagedSourceUpdate: async (): Promise<UpdateApplyResult> => {
          appliedSource = true;
          return { kind: "success", message: "should not apply" };
        }
      });

      expect(result.exitCode).toBe(2);
      expect(result.output).toContain("Already up to date.");
      expect(appliedSource).toBe(false);
      expect(existsSync(updateLogPath(homeDir))).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
