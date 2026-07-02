import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runCliCommand } from "./cli.js";
import type { Prompt } from "./prompt-contract.js";
import type { SelectPromptInput } from "./interactive-select.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import { runInitCommand } from "./init-command.js";
import { CURRENT_OAUTH_STORE_VERSION } from "../providers/oauth/oauth-types.js";
import { openSQLiteDatabase } from "../storage/factory.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-cli-setup-test-"));
}

function profileConfigPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
}

describe("cli setup command", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    await mkdir(join(tempDir, "workspace"), { recursive: true });
  });

  afterEach(async () => {
    await chmod(join(tempDir, ".estacoda"), 0o700).catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps no-arg noninteractive setup output deterministic", async () => {
    const input = {
      argv: ["setup"],
      workspaceRoot: join(tempDir, "workspace"),
      homeDir: tempDir,
      interactive: false,
    };

    const first = await runCliCommand(input);
    const second = await runCliCommand(input);

    expect(first.handled).toBe(true);
    expect(first.exitCode).toBe(0);
    expect(first.output).toBe(second.output);
    expect(first.output).toContain("EstaCoda setup");
    expect(first.output).toContain("Recommended path:");
    expect(first.output).toContain("Direct provider example:");
  });

  it("renders setup help without collecting setup state", async () => {
    const result = await runCliCommand({
      argv: ["setup", "--help"],
      workspaceRoot: join(tempDir, "workspace"),
      homeDir: tempDir,
      interactive: false,
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Usage:");
    expect(result.output).toContain("estacoda setup [--interactive] [--advanced]");
    expect(result.output).toContain("Open reviewed setup, repair, and onboarding");
    expect(result.output).not.toContain("Recommended path:");
    expect(result.output).not.toContain("Setup check");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).rejects.toThrow();
  });

  it("preserves direct noninteractive provider setup flags", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const result = await runCliCommand({
      argv: ["setup", "--provider", "local", "--model", "local-test-model", "--offline", "--user"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { provider?: string; id?: string };
      providers?: Record<string, { enableNetwork?: boolean; models?: string[] }>;
    };

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Configured local/local-test-model.");
    expect(config.model).toEqual({ provider: "local", id: "local-test-model" });
    expect(config.providers?.local?.enableNetwork).toBe(false);
    expect(config.providers?.local?.models).toContain("local-test-model");
  });

  it("preserves direct advanced provider setup flags", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const result = await runCliCommand({
      argv: ["setup", "--advanced", "--provider", "local", "--model", "advanced-local", "--offline", "--user"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { provider?: string; id?: string };
      providers?: Record<string, { enableNetwork?: boolean; models?: string[] }>;
    };

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Configured local/advanced-local.");
    expect(config.model).toEqual({ provider: "local", id: "advanced-local" });
    expect(config.providers?.local?.enableNetwork).toBe(false);
  });

  it("routes first-run interactive setup through the reviewed runner and apply executor", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const result = await runCliCommand({
      argv: ["setup", "--interactive"],
      workspaceRoot,
      homeDir: tempDir,
      prompt: firstRunPrompt({ reviewAccepted: true }),
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { provider?: string; id?: string };
      providers?: Record<string, { apiKeyEnv?: string }>;
    };
    const trusted = await new WorkspaceTrustStore({
      path: join(tempDir, ".estacoda", "trust.json"),
    }).isTrusted(workspaceRoot);

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(config.model?.provider).toBe("local");
    expect(config.providers?.local?.apiKeyEnv).toBeUndefined();
    expect(trusted).toBe(true);
    expect(result.output).not.toContain("Dry-run apply plan");
  });

  it("returns a launch request after first-run setup when requested", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-openai-key";
    try {
      const result = await runCliCommand({
        argv: ["setup", "--interactive"],
        workspaceRoot,
        homeDir: tempDir,
        prompt: firstRunPrompt({
          reviewAccepted: true,
          launchRequested: true,
          providerId: "openai",
        }),
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.launchRequested).toBe(true);
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
    }
  });

  it("exits normally after first-run setup when launch is not requested", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const result = await runCliCommand({
      argv: ["setup", "--interactive"],
      workspaceRoot,
      homeDir: tempDir,
      prompt: firstRunPrompt({ reviewAccepted: true, launchRequested: false }),
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.launchRequested).toBe(false);
  });

  it("cancels reviewed setup without applying config changes or trust", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const result = await runCliCommand({
      argv: ["setup", "--interactive"],
      workspaceRoot,
      homeDir: tempDir,
      prompt: firstRunPrompt({ reviewAccepted: false }),
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Setup cancelled. No settings were written, no credentials were saved, and this workspace was not trusted.");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toContain("\"provider\": \"unconfigured\"");
    expect(await new WorkspaceTrustStore({
      path: join(tempDir, ".estacoda", "trust.json"),
    }).isTrusted(workspaceRoot)).toBe(false);
  });

  it("starts interactive setup through the real entrypoint without Node unsettled top-level await", async () => {
    const result = await runEntrypoint({
      argv: ["setup", "--interactive"],
      cwd: process.cwd(),
      homeDir: tempDir,
      input: "n\n",
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("EstaCoda Onboarding Wizard");
    expect(result.stdout).toContain("Setup language");
    expect(result.stderr).not.toContain("unsettled top-level await");
    expect(result.stderr).not.toContain("Warning: Detected unsettled");
  });

  it("routes init-created default profile state through the real entrypoint to onboarding", async () => {
    const init = await runInitCommand({ homeDir: tempDir });
    const result = await runEntrypoint({
      argv: ["setup", "--interactive"],
      cwd: process.cwd(),
      homeDir: tempDir,
      input: "n\n",
    });

    expect(init.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("EstaCoda Onboarding Wizard");
    expect(result.stdout).toContain("Setup language");
    expect(result.stdout).not.toContain("Setup editor");
    expect(result.stderr).not.toContain("unsettled top-level await");
  });

  it("routes configured-ready interactive setup through the guided editor shell", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runCliCommand({
      argv: ["setup", "--interactive"],
      workspaceRoot,
      homeDir: tempDir,
      prompt: firstRunPrompt({ reviewAccepted: true, setupEditorActionId: "exit" }),
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Exited setup editor without applying changes.");
    expect(result.output).not.toContain("EstaCoda guided setup editor");
    expect(result.output).not.toContain("Kind: configured-ready");
    expect(result.output).not.toContain("Available actions:");
    expect(result.output).not.toContain("Sections:");
    expect(result.output).not.toContain("review-edit-config - Review/edit config");
    expect(result.output).not.toContain("launch-agent - Launch agent");
  });

  it("routes configured-degraded interactive setup through the guided editor shell", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await writeUserConfig(tempDir, localReadyConfig("ollama/auto"));
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runCliCommand({
      argv: ["setup", "--interactive"],
      workspaceRoot,
      homeDir: tempDir,
      prompt: firstRunPrompt({ reviewAccepted: true, setupEditorActionId: "show-diagnostics" }),
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Setup diagnostics");
    expect(result.output).toContain("State: configured-degraded");
    expect(result.output).toContain("Setup path: configured-degraded-menu");
    expect(result.output).toContain("Configured model context window is below 64K tokens.");
    expect(result.output).not.toContain("Available actions:");
    expect(result.output).not.toContain("Sections:");
    expect(result.output).not.toContain("repair-setup - Fix now");
    expect(result.output).not.toContain("launch-agent - Continue in limited mode");
    expect(result.output).not.toContain("review-edit-config - Review/edit config");
  });

  it("routes missing-secret setup to credential repair without exposing secrets", async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const workspaceRoot = join(tempDir, "workspace");
      await writeUserConfig(tempDir, {
        model: { provider: "openai", id: "gpt-4.1-mini" },
        providers: {
          openai: {
            kind: "openai-compatible",
            baseUrl: "https://api.openai.com/v1",
            apiKeyEnv: "OPENAI_API_KEY",
            models: ["gpt-4.1-mini"],
            enableNetwork: true,
          },
        },
      });
      await trustWorkspace(tempDir, workspaceRoot);

      const result = await runCliCommand({
        argv: ["setup", "--interactive"],
        workspaceRoot,
        homeDir: tempDir,
        prompt: firstRunPrompt({ reviewAccepted: true, setupEditorActionId: "show-diagnostics" }),
      });

      expect(result.handled).toBe(true);
      expect(result.output).toContain("Setup diagnostics");
      expect(result.output).toContain("State: missing-secret");
      expect(result.output).toContain("Setup path: repair-first-menu");
      expect(result.output).toContain("Blockers:");
      expect(result.output).toContain("OPENAI_API_KEY");
      expect(result.output).not.toContain("Available actions:");
      expect(result.output).not.toContain("Sections:");
      expect(result.output).not.toContain("repair-setup - Repair setup");
      expect(result.output).not.toContain("sk-");
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
    }
  });

  it("routes broken config to diagnostic repair instead of normal editing", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const configPath = profileConfigPath(tempDir);
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(configPath, "{not-json", "utf8");

    const result = await runCliCommand({
      argv: ["setup", "--interactive"],
      workspaceRoot,
      homeDir: tempDir,
      prompt: firstRunPrompt({ reviewAccepted: true, setupEditorActionId: "show-diagnostics" }),
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Setup diagnostics");
    expect(result.output).toContain("State: broken-config");
    expect(result.output).toContain("Setup path: repair-first-menu");
    expect(result.output).toContain(configPath);
    expect(result.output).toContain("Normal config edits are blocked until the config file can be parsed.");
    expect(result.output).toContain("Only diagnostics, verification, and exit are available");
    expect(result.output).not.toContain("Available actions:");
    expect(result.output).not.toContain("Sections:");
    expect(result.output).not.toContain("repair-setup - Repair setup");
    expect(result.output).not.toContain("review-edit-config - Open config editor");
    expect(result.output).not.toContain("edit-primary-model-route");
    expect(result.output).not.toContain("edit-security-mode");
  });

  it("routes untrusted workspaces to explicit trust repair", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await writeUserConfig(tempDir, localReadyConfig());

    const result = await runCliCommand({
      argv: ["setup", "--interactive"],
      workspaceRoot,
      homeDir: tempDir,
      prompt: firstRunPrompt({ reviewAccepted: true, setupEditorActionId: "repair-workspace-trust" }),
    });
    const trusted = await new WorkspaceTrustStore({
      path: join(tempDir, ".estacoda", "trust.json"),
    }).isTrusted(workspaceRoot);

    expect(result.handled).toBe(true);
    expect(trusted).toBe(true);
    expect(result.output).toContain("Verification passed. Setup is ready.");
    expect(result.output).not.toContain("Setup cancelled");
    expect(result.output).not.toContain("Available actions:");
    expect(result.output).not.toContain("Sections:");
    expect(result.output).not.toContain("Workspace is not trusted.\n- Warning: Workspace is not trusted.");
    expect(result.output).not.toContain("trust-workspace - Trust workspace");
  });

  it("routes non-writable setup state to state repair guidance", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    await chmod(join(tempDir, ".estacoda"), 0o500);

    const result = await runCliCommand({
      argv: ["setup", "--interactive"],
      workspaceRoot,
      homeDir: tempDir,
      prompt: firstRunPrompt({ reviewAccepted: true, setupEditorActionId: "show-diagnostics" }),
    });

    expect(result.handled).toBe(true);
    expect(result.output).toContain("Setup diagnostics");
    expect(result.output).toContain("State: state-not-writable");
    expect(result.output).toContain("Setup path: repair-first-menu");
    expect(result.output).toContain(profileConfigPath(tempDir));
    expect(result.output).toContain("fix-state-directory");
    expect(result.output).toContain("Restore write permission");
    expect(result.output).toContain("Only diagnostics, verification, and exit are available");
    expect(result.output).not.toContain("Available actions:");
    expect(result.output).not.toContain("Sections:");
    expect(result.output).not.toContain("repair-setup - Repair setup");
    expect(result.output).not.toContain("review-edit-config - Open config editor");
    expect(result.output).not.toContain("edit-primary-model-route");
    expect(result.output).not.toContain("edit-security-mode");
  });

  it("doctor reports broken config through setup state instead of throwing", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const configPath = profileConfigPath(tempDir);
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(configPath, "{not-json", "utf8");

    const result = await runCliCommand({
      argv: ["doctor"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Config syntax error:");
    expect(result.output).toMatch(/Model:\s+unknown\/unknown/u);
  });

  it("doctor reports invalid active profile state instead of throwing", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await writeUserConfig(tempDir, localReadyConfig());
    await writeFile(join(tempDir, ".estacoda", "active-profile.json"), "{", "utf8");

    const result = await runCliCommand({
      argv: ["doctor"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Active profile state is invalid:");
    expect(result.output).toMatch(/Profile:\s+default/u);
  });

  it("doctor does not create setup or backup probe files", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runCliCommand({
      argv: ["doctor"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });

    expect(result.handled).toBe(true);
    await expect(stat(join(tempDir, ".estacoda", ".verify"))).rejects.toThrow();
    await expect(stat(join(tempDir, ".estacoda", ".backups"))).rejects.toThrow();
  });

  it("doctor keeps dependency audit opt-in by default", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runCliCommand({
      argv: ["doctor"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });

    expect(result.handled).toBe(true);
    expect(result.output).toContain("Dependencies");
    expect(result.output).toContain("audit not run");
    expect(result.output).toContain("Python Environments");
    expect(result.output).toContain("Run: estacoda doctor --audit");
    expect(result.output).not.toContain("Dependency audit found");
  });

  it("doctor renders operational diagnostics without leaking OAuth or MCP secrets", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const profilePaths = resolveProfileStateHome({ homeDir: tempDir, profileId: "default" });
    await writeUserConfig(tempDir, {
      ...(localReadyConfig() as Record<string, unknown>),
      mcpServers: {
        localDev: {
          command: "sh",
          args: ["-c", "node server.js"],
          env: {
            API_TOKEN: "super-secret-mcp-token"
          }
        }
      }
    });
    await mkdir(dirname(profilePaths.authJsonPath), { recursive: true });
    await writeFile(profilePaths.authJsonPath, `${JSON.stringify({
      version: CURRENT_OAUTH_STORE_VERSION,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "secret-access-token",
          refreshToken: "secret-refresh-token",
          expiresAt: "2025-01-01T00:00:00.000Z"
        }
      }
    })}\n`, "utf8");

    const result = await runCliCommand({
      argv: ["doctor"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });

    expect(result.handled).toBe(true);
    expect(result.output).toContain("OAuth");
    expect(result.output).toContain("MCP");
    expect(result.output).toContain("External tools");
    expect(result.output).toContain("OAuth credentials are expired for providers: codex");
    expect(result.output).toContain("MCP server localDev passes secret-looking env keys: API_TOKEN");
    expect(result.output).not.toContain("secret-access-token");
    expect(result.output).not.toContain("secret-refresh-token");
    expect(result.output).not.toContain("super-secret-mcp-token");
  });

  it("doctor --json returns the structured DoctorReport without Papyrus framing", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await writeUserConfig(tempDir, localReadyConfig());

    const result = await runCliCommand({
      argv: ["doctor", "--json"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });
    const report = JSON.parse(result.output) as {
      profile: string;
      sections: Array<{ checks: Array<{ id: string }> }>;
      providerRoutes: Array<{ kind: string; label: string; provider?: string; model?: string }>;
    };

    expect(result.handled).toBe(true);
    expect(result.output).not.toContain("╭─");
    expect(report.profile).toBe("default");
    expect(report.sections.flatMap((section) => section.checks).map((check) => check.id)).toContain("providers");
    expect(report.providerRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "primary",
        label: "primary",
        provider: "local",
        model: "local-test-model"
      })
    ]));
  });

  it("doctor --json reports config drift with a future safe fix command", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const profilePaths = resolveProfileStateHome({ homeDir: tempDir, profileId: "default" });
    await writeUserConfig(tempDir, {
      ...(localReadyConfig() as Record<string, unknown>),
      provider: "local",
      baseUrl: "http://legacy.local/v1"
    });
    await writeFile(profilePaths.envPath, "UNUSED_API_KEY=ghost-secret\n", "utf8");

    const result = await runCliCommand({
      argv: ["doctor", "--json"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });
    const report = JSON.parse(result.output) as {
      sections: Array<{ checks: Array<{ id: string; severity: string; summary?: string }> }>;
      actions: Array<{ title: string; detailLines?: string[]; command?: string; severity: string }>;
    };
    const configurationCheck = report.sections.flatMap((section) => section.checks).find((check) => check.id === "configuration");

    expect(configurationCheck).toEqual(expect.objectContaining({
      severity: "warning",
      summary: "3 config drift item(s)"
    }));
    expect(report.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Config contains stale root-level key",
        detailLines: ["provider → model.provider"],
        command: "estacoda doctor --fix-config",
        severity: "warning"
      }),
      expect.objectContaining({
        title: "Profile .env contains unreferenced credential key",
        detailLines: ["Env: UNUSED_API_KEY"],
        command: "estacoda doctor --fix-config --remove-env-ghosts",
        severity: "warning"
      })
    ]));
    expect(result.output).not.toContain("ghost-secret");
  });

  it("doctor --fix-config backs up and migrates stale config keys", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await writeUserConfig(tempDir, {
      ...(localReadyConfig() as Record<string, unknown>),
      provider: "local",
      baseUrl: "http://legacy.local/v1"
    });

    const result = await runCliCommand({
      argv: ["doctor", "--fix-config"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      provider?: string;
      baseUrl?: string;
      providers?: Record<string, { baseUrl?: string }>;
    };

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("EstaCoda Doctor Config Repair");
    expect(result.output).toContain("Applied config migration");
    expect(result.output).toContain("Config backup");
    expect(config.provider).toBeUndefined();
    expect(config.baseUrl).toBeUndefined();
    expect(config.providers?.local?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("doctor --json marks OAuth primary route failures as provider blockers", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await writeUserConfig(tempDir, {
      model: {
        provider: "codex",
        id: "gpt-5.5",
      },
      providers: {
        codex: {
          baseUrl: "https://chatgpt.com/backend-api/codex",
          apiMode: "openai_responses",
          authMethod: "oauth_device_pkce",
          enableNetwork: true,
        },
      },
    });

    const result = await runCliCommand({
      argv: ["doctor", "--json"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });
    const report = JSON.parse(result.output) as {
      sections: Array<{ checks: Array<{ id: string; severity: string; summary?: string }> }>;
      providerRoutes: Array<{ kind: string; label: string; status: string; summary: string }>;
      actions: Array<{ title: string; command?: string; severity: string }>;
      verdict: { status: string };
    };
    const providerCheck = report.sections.flatMap((section) => section.checks).find((check) => check.id === "providers");

    expect(providerCheck).toEqual(expect.objectContaining({
      severity: "blocked",
      summary: "1 route(s) unavailable"
    }));
    expect(report.verdict.status).toBe("blocked");
    expect(report.providerRoutes).toEqual([
      expect.objectContaining({
        kind: "primary",
        label: "primary",
        status: "blocked",
        summary: expect.stringContaining("missing OAuth credentials for codex")
      })
    ]);
    expect(report.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: expect.stringContaining("missing OAuth credentials for codex"),
        command: "estacoda model setup",
        severity: "blocked"
      })
    ]));
  });

  it("doctor maps missing managed Python capabilities to explicit setup commands", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await writeUserConfig(tempDir, {
      ...(localReadyConfig() as Record<string, unknown>),
      web: {
        searchBackend: "ddgs"
      }
    });

    const result = await runCliCommand({
      argv: ["doctor", "--json"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });
    const report = JSON.parse(result.output) as {
      sections: Array<{ checks: Array<{ id: string; severity: string; summary?: string }> }>;
      actions: Array<{ title: string; command?: string; detailLines?: string[]; severity: string }>;
    };
    const pythonCheck = report.sections.flatMap((section) => section.checks).find((check) => check.id === "python-environments");

    expect(pythonCheck).toEqual(expect.objectContaining({
      severity: "warning",
      summary: "ddgs"
    }));
    expect(report.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: expect.stringContaining("Managed Python capability ddgs is not ready"),
        detailLines: ["Capability: ddgs"],
        command: "estacoda python-env setup ddgs",
        severity: "warning"
      })
    ]));
  });

  it("doctor --json surfaces a backup-gated SQLite repair action for blocked session DBs", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await writeUserConfig(tempDir, localReadyConfig());
    const sessionPath = resolveGlobalStateHome({ homeDir: tempDir }).sessionsSqlitePath;
    await mkdir(dirname(sessionPath), { recursive: true });
    const db = await openSQLiteDatabase({ path: sessionPath });
    try {
      db.exec("create table sessions (id text primary key)");
    } finally {
      db.close();
    }

    const result = await runCliCommand({
      argv: ["doctor", "--json"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });
    const report = JSON.parse(result.output) as {
      sections: Array<{ checks: Array<{ id: string; severity: string; summary?: string }> }>;
      actions: Array<{ id: string; title: string; command?: string; detailLines?: string[]; severity: string }>;
    };
    const sessionsCheck = report.sections.flatMap((section) => section.checks).find((check) => check.id === "sessions");

    expect(sessionsCheck).toEqual(expect.objectContaining({
      severity: "blocked",
      summary: "schema invalid"
    }));
    expect(report.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "sqlite-session-repair",
        title: "SQLite session DB needs repair",
        detailLines: ["Backup required before repair"],
        command: "estacoda doctor --repair-sessions",
        severity: "blocked"
      })
    ]));
    expect(report.actions.filter((action) => action.id === "sqlite-session-repair")).toHaveLength(1);
  });

  it("doctor --repair-sessions backs up and rebuilds broken SQLite FTS", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await writeUserConfig(tempDir, localReadyConfig());
    const sessionPath = resolveGlobalStateHome({ homeDir: tempDir }).sessionsSqlitePath;
    await createBrokenFtsSessionDb(sessionPath);

    const result = await runCliCommand({
      argv: ["doctor", "--repair-sessions"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("EstaCoda Doctor Repair");
    expect(result.output).toContain("Repaired session database");
    expect(result.output).toContain("Backup");
    await expect(ftsSearch(sessionPath, "repairable")).resolves.toEqual(["message-1"]);
  });

  it("doctor --fix does not repair broken SQLite FTS", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await writeUserConfig(tempDir, localReadyConfig());
    const sessionPath = resolveGlobalStateHome({ homeDir: tempDir }).sessionsSqlitePath;
    await createBrokenFtsSessionDb(sessionPath);

    const result = await runCliCommand({
      argv: ["doctor", "--fix"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    await expect(ftsSearch(sessionPath, "repairable")).rejects.toThrow();
  });

  it("doctor --fix creates only safe local state skeleton repairs", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const globalPaths = resolveGlobalStateHome({ homeDir: tempDir });
    const profilePaths = resolveProfileStateHome({ homeDir: tempDir, profileId: "default" });

    const result = await runCliCommand({
      argv: ["doctor", "--fix"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("EstaCoda Doctor Fix");
    expect(result.output).toContain("Applied safe repairs");
    expect(result.output).toContain("◇ Fixed");
    expect(result.output).toContain("◇ Not Changed");
    expect(result.output).toContain("Workspace trust requires explicit user approval");
    expect(result.output).toContain("Provider credentials were not created");
    expect(result.output).toContain("Config migrations were not applied");
    await expect(stat(globalPaths.sharedMemoryPath)).resolves.toMatchObject({ });
    await expect(stat(globalPaths.packsPath)).resolves.toMatchObject({ });
    await expect(stat(profilePaths.userMdPath)).resolves.toMatchObject({ });
    await expect(stat(profilePaths.soulMdPath)).resolves.toMatchObject({ });
    await expect(stat(profilePaths.memoryMdPath)).resolves.toMatchObject({ });
    await expect(stat(profilePaths.envPath)).resolves.toMatchObject({ });
    await expect(stat(profilePaths.authJsonPath)).resolves.toMatchObject({ });
    await expect(stat(globalPaths.trustJsonPath)).rejects.toThrow();
    await expect(stat(globalPaths.workspaceApprovalsPath)).rejects.toThrow();
    await expect(stat(globalPaths.sessionsSqlitePath)).rejects.toThrow();
    await expect(stat(join(globalPaths.stateRoot, "python-env"))).rejects.toThrow();
    await expect(stat(join(globalPaths.stateRoot, "python-envs"))).rejects.toThrow();
    expect(await readFile(profilePaths.envPath, "utf8")).toBe("");
    expect(await readFile(profilePaths.authJsonPath, "utf8")).toBe("{}\n");
  });

  it("doctor --fix repairs private auth file modes without creating credentials", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const profilePaths = resolveProfileStateHome({ homeDir: tempDir, profileId: "default" });
    await mkdir(dirname(profilePaths.envPath), { recursive: true });
    await writeFile(profilePaths.envPath, "", "utf8");
    await writeFile(profilePaths.authJsonPath, "{}\n", "utf8");
    await chmod(profilePaths.envPath, 0o644);
    await chmod(profilePaths.authJsonPath, 0o644);

    const result = await runCliCommand({
      argv: ["doctor", "--fix"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });

    expect(result.handled).toBe(true);
    expect(result.output).toContain("mode to 0600");
    expect((await stat(profilePaths.envPath)).mode & 0o777).toBe(0o600);
    expect((await stat(profilePaths.authJsonPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(profilePaths.envPath, "utf8")).toBe("");
    expect(await readFile(profilePaths.authJsonPath, "utf8")).toBe("{}\n");
  });

  it("doctor --fix does not overwrite malformed config", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const configPath = profileConfigPath(tempDir);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "{not-json", "utf8");

    const result = await runCliCommand({
      argv: ["doctor", "--fix"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(await readFile(configPath, "utf8")).toBe("{not-json");
    expect(result.output).toContain("Config migrations were not applied");
  });

  it("doctor --fix is idempotent after safe repairs are applied", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await runCliCommand({
      argv: ["doctor", "--fix"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });

    const second = await runCliCommand({
      argv: ["doctor", "--fix"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });

    expect(second.handled).toBe(true);
    expect(second.exitCode).toBe(0);
    expect(second.output).toContain("No safe repairs needed");
    expect(second.output).toContain("No safe repairs were needed");
    expect(second.output).not.toContain("✓ Created");
    expect(second.output).not.toContain("mode to 0600");
  });

  it("doctor --fix reports the default skeleton created for a non-default selected profile", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const researchPaths = resolveProfileStateHome({ homeDir: tempDir, profileId: "research" });
    const defaultPaths = resolveProfileStateHome({ homeDir: tempDir, profileId: "default" });

    const result = await runCliCommand({
      argv: ["doctor", "--fix"],
      workspaceRoot,
      homeDir: tempDir,
      profileId: "research",
      interactive: false,
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("~/.estacoda/profiles/research/");
    expect(result.output).toContain("~/.estacoda/profiles/default/");
    await expect(stat(researchPaths.userMdPath)).resolves.toMatchObject({ });
    await expect(stat(defaultPaths.userMdPath)).resolves.toMatchObject({ });
  });

  it("keeps live CLI entrypoints free of the legacy interactive onboarding runner", async () => {
    const cliSource = await readFile(join(process.cwd(), "src", "cli", "cli.ts"), "utf8");
    const launcherSource = await readFile(join(process.cwd(), "src", "cli", "interactive-launcher.ts"), "utf8");

    expect(cliSource).not.toContain("runInteractiveOnboarding");
    expect(launcherSource).not.toContain("runInteractiveOnboarding");
  });

  it("entrypoint setup launch handoff re-enters the fresh interactive launch path", async () => {
    const entrypointSource = await readFile(join(process.cwd(), "src", "index.ts"), "utf8");

    expect(entrypointSource).toContain("setupCommand.launchRequested === true");
    expect(entrypointSource).toContain("launchInteractiveSession({ workspaceRoot, homeDir, profileId })");
    expect(entrypointSource).toContain("argv = []");
    expect(entrypointSource).toContain("const nowTrusted = await trustStore.isTrusted(workspaceRoot)");
    expect(entrypointSource).toContain("const latestConfig = await loadRuntimeConfig({ workspaceRoot, homeDir, profileId })");
    expect(entrypointSource).toContain("onboarding.workspace.trust.deferredFinal");
    expect(entrypointSource).toContain("return createRuntime({");
  });
});

type FirstRunPromptOptions = {
  readonly reviewAccepted: boolean;
  readonly launchRequested?: boolean;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly setupEditorActionId?: string;
};

function firstRunPrompt(options: FirstRunPromptOptions): Prompt {
  const prompt = (async () => "") as Prompt;
  prompt.select = async <T>(selection: SelectPromptInput<T>): Promise<T> => {
    const title = selection.title.toLowerCase();
    if (title.includes("interface language")) {
      return valueOrDefault(selection, "en");
    }
    if (title.includes("workspace trust")) {
      return valueOrDefault(selection, true);
    }
    if (title.includes("provider")) {
      return valueWithIdOrDefault(selection, options.providerId ?? "local");
    }
    if (title.includes("model")) {
      return valueWithIdOrDefault(selection, options.modelId ?? "gpt-5.5");
    }
    if (title.includes("setup editor") && options.setupEditorActionId !== undefined) {
      return valueWithIdOrDefault(selection, options.setupEditorActionId);
    }
    if (title.includes("configuration summary")) {
      return valueWithIdOrDefault(selection, options.reviewAccepted ? "confirm" : "cancel");
    }
    if (title.includes("review") || title.includes("finalize configuration")) {
      return valueOrDefault(selection, options.reviewAccepted);
    }
    if (title.includes("start estacoda")) {
      return valueOrDefault(selection, options.launchRequested ?? false);
    }
    if (allBooleanOptions(selection)) {
      return valueOrDefault(selection, false);
    }
    return selection.options[selection.defaultIndex ?? 0]?.value ?? selection.options[0]!.value;
  };
  prompt.onboardingCard = () => undefined;
  prompt.close = () => undefined;
  return prompt;
}

function valueOrDefault<T>(selection: SelectPromptInput<T>, value: unknown): T {
  return selection.options.find((option) => Object.is(option.value, value))?.value
    ?? selection.options[selection.defaultIndex ?? 0]?.value
    ?? selection.options[0]!.value;
}

function valueWithIdOrDefault<T>(selection: SelectPromptInput<T>, id: string): T {
  return selection.options.find((option) => option.id === id || optionValueId(option.value) === id)?.value
    ?? selection.options[selection.defaultIndex ?? 0]?.value
    ?? selection.options[0]!.value;
}

function optionValueId(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string"
    ? value.id
    : undefined;
}

function allBooleanOptions<T>(selection: SelectPromptInput<T>): boolean {
  return selection.options.every((option) => typeof option.value === "boolean");
}

type EntrypointResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function runEntrypoint(input: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly homeDir: string;
  readonly input: string;
}): Promise<EntrypointResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      join(process.cwd(), "src", "index.ts"),
      ...input.argv
    ], {
      cwd: input.cwd,
      env: {
        ...process.env,
        HOME: input.homeDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for entrypoint setup command."));
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input.input);
  });
}

async function writeUserConfig(homeDir: string, config: unknown): Promise<void> {
  await mkdir(dirname(profileConfigPath(homeDir)), { recursive: true });
  await writeFile(profileConfigPath(homeDir), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function trustWorkspace(homeDir: string, workspaceRoot: string): Promise<void> {
  await new WorkspaceTrustStore({
    path: join(homeDir, ".estacoda", "trust.json"),
  }).grant(workspaceRoot, { label: "test" });
}

async function createBrokenFtsSessionDb(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const db = await openSQLiteDatabase({ path });
  try {
    db.exec(`
      create table sessions (
        id text primary key,
        profile_id text not null default 'default',
        created_at text not null,
        updated_at text not null
      );
      create table messages (
        id text primary key,
        session_id text not null,
        role text not null,
        content text not null,
        created_at text not null
      );
      create table messages_fts (
        message_id text,
        content text
      );
      insert into sessions (id, profile_id, created_at, updated_at)
      values ('session-1', 'default', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z');
      insert into messages (id, session_id, role, content, created_at)
      values ('message-1', 'session-1', 'user', 'repairable search needle', '2026-07-02T00:00:00.000Z');
    `);
  } finally {
    db.close();
  }
}

async function ftsSearch(path: string, query: string): Promise<readonly string[]> {
  const db = await openSQLiteDatabase({ path, readonly: true });
  try {
    return db.query<{ message_id: string }>(
      "select message_id from messages_fts where messages_fts match ? order by rowid"
    ).all(query).map((row) => row.message_id);
  } finally {
    db.close();
  }
}

function localReadyConfig(modelId = "local-test-model"): unknown {
  return {
    model: {
      provider: "local",
      id: modelId,
    },
    providers: {
      local: {
        kind: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        models: [modelId],
        enableNetwork: true,
      },
    },
  };
}
