import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCliCommand } from "./cli.js";
import type { Prompt } from "./readline-prompt.js";
import type { SelectPromptInput } from "./interactive-select.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-cli-setup-test-"));
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

  it("preserves direct noninteractive provider setup flags", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const result = await runCliCommand({
      argv: ["setup", "--provider", "local", "--model", "hermes-local", "--offline", "--user"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });
    const config = JSON.parse(await readFile(join(tempDir, ".estacoda", "config.json"), "utf8")) as {
      model?: { provider?: string; id?: string };
      providers?: Record<string, { enableNetwork?: boolean; models?: string[] }>;
    };

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Configured local/hermes-local.");
    expect(config.model).toEqual({ provider: "local", id: "hermes-local" });
    expect(config.providers?.local?.enableNetwork).toBe(false);
    expect(config.providers?.local?.models).toContain("hermes-local");
  });

  it("preserves direct advanced provider setup flags", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const result = await runCliCommand({
      argv: ["setup", "--advanced", "--provider", "local", "--model", "advanced-local", "--offline", "--user"],
      workspaceRoot,
      homeDir: tempDir,
      interactive: false,
    });
    const config = JSON.parse(await readFile(join(tempDir, ".estacoda", "config.json"), "utf8")) as {
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
    const config = JSON.parse(await readFile(join(tempDir, ".estacoda", "config.json"), "utf8")) as {
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

  it("cancels reviewed setup without writing config or trust", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const result = await runCliCommand({
      argv: ["setup", "--interactive"],
      workspaceRoot,
      homeDir: tempDir,
      prompt: firstRunPrompt({ reviewAccepted: false }),
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Review cancelled");
    await expect(access(join(tempDir, ".estacoda", "config.json"))).rejects.toThrow();
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
    expect(result.stdout).toContain("EstaCoda setup");
    expect(result.stdout).toContain("Setup language");
    expect(result.stderr).not.toContain("unsettled top-level await");
    expect(result.stderr).not.toContain("Warning: Detected unsettled");
  });

  it("routes configured-ready interactive setup through the guided editor shell", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runCliCommand({
      argv: ["setup", "--interactive"],
      workspaceRoot,
      homeDir: tempDir,
      prompt: firstRunPrompt({ reviewAccepted: true }),
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("EstaCoda guided setup editor");
    expect(result.output).toContain("EstaCoda is already configured");
    expect(result.output).toContain("kind: configured-ready");
    expect(result.output).toContain("verify-setup - Verify setup");
    expect(result.output).toContain("show-diagnostics - Show diagnostics");
    expect(result.output).toContain("exit - Exit");
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
      prompt: firstRunPrompt({ reviewAccepted: true }),
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("EstaCoda guided setup editor");
    expect(result.output).toContain("kind: configured-degraded");
    expect(result.output).toContain("show-diagnostics - Show diagnostics");
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
        prompt: firstRunPrompt({ reviewAccepted: true }),
      });

      expect(result.handled).toBe(true);
      expect(result.output).toContain("EstaCoda guided setup editor");
      expect(result.output).toContain("kind: missing-secret");
      expect(result.output).toContain("OPENAI_API_KEY");
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
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    await writeFile(join(tempDir, ".estacoda", "config.json"), "{not-json", "utf8");

    const result = await runCliCommand({
      argv: ["setup", "--interactive"],
      workspaceRoot,
      homeDir: tempDir,
      prompt: firstRunPrompt({ reviewAccepted: true }),
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("EstaCoda guided setup editor");
    expect(result.output).toContain("kind: broken-config");
    expect(result.output).toContain("show-diagnostics - Show diagnostics");
    expect(result.output).not.toContain("repair-setup - Repair setup");
    expect(result.output).not.toContain("review-edit-config - Open config editor");
  });

  it("routes untrusted workspaces to explicit trust repair", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    await writeUserConfig(tempDir, localReadyConfig());

    const result = await runCliCommand({
      argv: ["setup", "--interactive"],
      workspaceRoot,
      homeDir: tempDir,
      prompt: firstRunPrompt({ reviewAccepted: true }),
    });

    expect(result.handled).toBe(true);
    expect(result.output).toContain("EstaCoda guided setup editor");
    expect(result.output).toContain("kind: untrusted-workspace");
    expect(result.output).toContain("workspace-trust");
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
      prompt: firstRunPrompt({ reviewAccepted: true }),
    });

    expect(result.handled).toBe(true);
    expect(result.output).toContain("EstaCoda guided setup editor");
    expect(result.output).toContain("kind: state-not-writable");
    expect(result.output).toContain("fix-state-directory");
    expect(result.output).not.toContain("repair-setup - Repair setup");
    expect(result.output).not.toContain("review-edit-config - Open config editor");
  });

  it("doctor reports broken config through setup state instead of throwing", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const configPath = join(tempDir, ".estacoda", "config.json");
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
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
    expect(result.output).toContain("Model: unknown/unknown");
  });

  it("keeps live CLI entrypoints free of the legacy interactive onboarding runner", async () => {
    const cliSource = await readFile(join(process.cwd(), "src", "cli", "cli.ts"), "utf8");
    const launcherSource = await readFile(join(process.cwd(), "src", "cli", "interactive-launcher.ts"), "utf8");

    expect(cliSource).not.toContain("runInteractiveOnboarding");
    expect(launcherSource).not.toContain("runInteractiveOnboarding");
  });
});

type FirstRunPromptOptions = {
  readonly reviewAccepted: boolean;
  readonly launchSelected?: boolean;
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
      return valueOrDefault(selection, "local");
    }
    if (title.includes("review")) {
      return valueOrDefault(selection, options.reviewAccepted);
    }
    if (title.includes("launch")) {
      return valueOrDefault(selection, options.launchSelected ?? false);
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
  await mkdir(join(homeDir, ".estacoda"), { recursive: true });
  await writeFile(join(homeDir, ".estacoda", "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function trustWorkspace(homeDir: string, workspaceRoot: string): Promise<void> {
  await new WorkspaceTrustStore({
    path: join(homeDir, ".estacoda", "trust.json"),
  }).grant(workspaceRoot, { label: "test" });
}

function localReadyConfig(modelId = "hermes-local"): unknown {
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
