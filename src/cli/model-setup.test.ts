import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runCliCommand } from "./cli.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { resetModelsDevRegistryForTest } from "../providers/model-selection-catalog.js";
import type { FetchLike } from "../providers/openai-compatible-provider.js";
import { resolveProfileStateHome } from "../config/profile-home.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-model-setup-test-"));
}

async function writeUserConfig(homeDir: string, config: unknown): Promise<void> {
  const configPath = profileConfigPath(homeDir);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

async function readUserConfig(homeDir: string): Promise<unknown> {
  const configPath = profileConfigPath(homeDir);
  const content = await readFile(configPath, "utf8");
  return JSON.parse(content);
}

function profileConfigPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
}

function profileEnvPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).envPath;
}

function mockFetchForModels(models: string[] | "fail" | "empty"): FetchLike {
  return async (url: string, _init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => {
    if (url.endsWith("/models")) {
      if (models === "fail") {
        return {
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          json: async () => ({}),
          text: async () => "Unavailable"
        };
      }
      if (models === "empty") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ data: [] }),
          text: async () => JSON.stringify({ data: [] })
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: models.map((id) => ({ id })) }),
        text: async () => JSON.stringify({ data: models.map((id) => ({ id })) })
      };
    }
    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({}),
      text: async () => "Not Found"
    };
  };
}

describe("model setup local", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    resetModelsDevRegistryForTest();
  });

  afterEach(async () => {
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("auto-selects exactly one discovered model", async () => {
    const result = await runCliCommand({
      argv: ["model", "setup", "local"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      providerFetch: mockFetchForModels(["qwen2.5:3b"])
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Model: qwen2.5:3b");
    expect(result.output).toContain("Base URL: http://localhost:11434/v1");
    expect(result.output).toContain("API key: none");

    const config = await readUserConfig(tmpDir) as any;
    expect(config.model?.provider).toBe("local");
    expect(config.model?.id).toBe("qwen2.5:3b");
    expect(config.providers?.local?.models).toContain("qwen2.5:3b");
    expect(config.providers?.local?.baseUrl).toBeUndefined();
    expect(config.providers?.local?.apiKeyEnv).toBeUndefined();
  });

  it("stores optional API key for local setup without printing the raw value", async () => {
    const rawKey = "sk-local-secret-value-12345";
    const result = await runCliCommand({
      argv: ["model", "setup", "local", "--model", "private-model", "--api-key", rawKey],
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      providerFetch: mockFetchForModels(["private-model"])
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("API key: stored as OPENAI_COMPATIBLE_API_KEY");
    expect(result.output).not.toContain(rawKey);

    const configContent = await readFile(profileConfigPath(tmpDir), "utf8");
    const config = JSON.parse(configContent) as any;
    expect(config.providers?.local?.apiKeyEnv).toBe("OPENAI_COMPATIBLE_API_KEY");
    expect(configContent).not.toContain(rawKey);

    const envContent = await readFile(profileEnvPath(tmpDir), "utf8");
    expect(envContent).toContain(`OPENAI_COMPATIBLE_API_KEY="${rawKey}"`);
  });

  it("saves manual model when probing fails and --model is provided", async () => {
    const result = await runCliCommand({
      argv: ["model", "setup", "local", "--model", "manual-model"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      providerFetch: mockFetchForModels("fail")
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Model: manual-model");

    const config = await readUserConfig(tmpDir) as any;
    expect(config.model?.id).toBe("manual-model");
    expect(config.providers?.local?.models).toContain("manual-model");
  });

  it("keeps manual model selection warning when probe discovers different models", async () => {
    const result = await runCliCommand({
      argv: ["model", "setup", "local", "--model", "manual-model"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      providerFetch: mockFetchForModels(["discovered-model"])
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Model: manual-model");
    expect(result.output).toContain('Warning: "manual-model" was not found in the discovered models.');

    const config = await readUserConfig(tmpDir) as any;
    expect(config.model?.id).toBe("manual-model");
    expect(config.providers?.local?.models).toEqual(expect.arrayContaining([
      "discovered-model",
      "manual-model"
    ]));
  });

  it("fails with rerun guidance when multiple models discovered without --model", async () => {
    const result = await runCliCommand({
      argv: ["model", "setup", "local"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      providerFetch: mockFetchForModels(["model-a", "model-b"])
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("model-a");
    expect(result.output).toContain("model-b");
    expect(result.output).toContain("--model");

    const configPath = profileConfigPath(tmpDir);
    const fileExists = await readFile(configPath, "utf8").then(() => true).catch(() => false);
    // Config may or may not be written; the important thing is the user-facing failure
    expect(fileExists).toBe(false);
  });

  it("resolves local route as credential-ready (no missing key warnings)", async () => {
    await runCliCommand({
      argv: ["model", "setup", "local", "--model", "qwen2.5:3b"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      providerFetch: mockFetchForModels("fail")
    });

    const result = await runCliCommand({
      argv: ["model", "diagnose"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir
    });

    expect(result.handled).toBe(true);
    expect(result.output).toContain("Status: ready");
    expect(result.output).not.toContain("Missing API key");
    expect(result.output).not.toContain("No credential pool");
  });

  it("persists context window override and resolves it on primaryModelRoute", async () => {
    const setupResult = await runCliCommand({
      argv: ["model", "setup", "local", "--model", "qwen2.5:3b", "--context-window", "128000"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      providerFetch: mockFetchForModels("fail")
    });

    expect(setupResult.output).toContain("Context window: 128000 tokens");

    const config = await readUserConfig(tmpDir) as any;
    expect(config.model?.contextWindowTokens).toBe(128000);

    const runtime = await loadRuntimeConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir
    });
    expect(runtime.primaryModelRoute.contextWindowTokens).toBe(128000);
  });

  it("rejects invalid base URL", async () => {
    const result = await runCliCommand({
      argv: ["model", "setup", "local", "--base-url", "not-a-url"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("invalid base URL");
  });
});

describe("model setup custom", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    resetModelsDevRegistryForTest();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("shows custom endpoint URL before saving", async () => {
    const result = await runCliCommand({
      argv: ["model", "setup", "custom", "--base-url", "http://custom.example.com/v1", "--model", "gpt-4"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      providerFetch: mockFetchForModels("fail")
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    const customLineIndex = result.output.indexOf("Custom endpoint: http://custom.example.com/v1");
    const savingIndex = result.output.indexOf("Saving configuration...");
    expect(customLineIndex).toBeGreaterThanOrEqual(0);
    expect(savingIndex).toBeGreaterThanOrEqual(0);
    expect(customLineIndex).toBeLessThan(savingIndex);
  });

  it("honors explicit --provider-id", async () => {
    const result = await runCliCommand({
      argv: ["model", "setup", "custom", "--base-url", "http://custom.example.com/v1", "--provider-id", "my-provider", "--model", "gpt-4"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      providerFetch: mockFetchForModels("fail")
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Provider ID: my-provider");

    const config = await readUserConfig(tmpDir) as any;
    expect(config.providers?.["my-provider"]?.kind).toBe("openai-compatible");
    expect(config.model?.provider).toBe("my-provider");
  });

  it("fails when existing provider-id has different baseUrl and does not overwrite", async () => {
    await writeUserConfig(tmpDir, {
      providers: {
        "my-provider": {
          kind: "openai-compatible",
          baseUrl: "http://old.example.com/v1",
          models: ["old-model"],
          enableNetwork: true
        }
      },
      model: { provider: "my-provider", id: "old-model" }
    });

    const result = await runCliCommand({
      argv: ["model", "setup", "custom", "--base-url", "http://new.example.com/v1", "--provider-id", "my-provider", "--model", "gpt-4"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      providerFetch: mockFetchForModels("fail")
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("already exists with a different base URL");

    const config = await readUserConfig(tmpDir) as any;
    expect(config.providers?.["my-provider"]?.baseUrl).toBe("http://old.example.com/v1");
    expect(config.model?.id).toBe("old-model");
  });

  it("resolves custom route through ResolvedModelRoute with correct baseUrl", async () => {
    await runCliCommand({
      argv: ["model", "setup", "custom", "--base-url", "http://custom.example.com/v1", "--provider-id", "my-custom", "--model", "gpt-4"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      providerFetch: mockFetchForModels("fail")
    });

    const runtime = await loadRuntimeConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir
    });

    expect(runtime.primaryModelRoute.provider).toBe("my-custom");
    expect(runtime.primaryModelRoute.id).toBe("gpt-4");
    expect(runtime.primaryModelRoute.baseUrl).toBe("http://custom.example.com/v1");
  });

  it("never prints API key values", async () => {
    process.env.MY_SECRET_KEY = "super-secret-key-value-12345";
    const result = await runCliCommand({
      argv: ["model", "setup", "custom", "--base-url", "http://custom.example.com/v1", "--provider-id", "secure-provider", "--model", "gpt-4", "--api-key-env", "MY_SECRET_KEY"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      providerFetch: mockFetchForModels("fail")
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain("super-secret-key-value-12345");
    expect(result.output).toContain("API key env: MY_SECRET_KEY");
    delete process.env.MY_SECRET_KEY;
  });

  it("rejects invalid provider ID syntax", async () => {
    const result = await runCliCommand({
      argv: ["model", "setup", "custom", "--base-url", "http://custom.example.com/v1", "--provider-id", "bad id!", "--model", "gpt-4"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("invalid characters");
  });

  it("rejects invalid base URL", async () => {
    const result = await runCliCommand({
      argv: ["model", "setup", "custom", "--base-url", "not-a-url", "--model", "gpt-4"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("invalid base URL");
  });

  it("merges model list when existing provider-id has same baseUrl", async () => {
    await writeUserConfig(tmpDir, {
      providers: {
        "my-provider": {
          kind: "openai-compatible",
          baseUrl: "http://same.example.com/v1",
          models: ["old-model"],
          enableNetwork: true
        }
      },
      model: { provider: "my-provider", id: "old-model" }
    });

    const result = await runCliCommand({
      argv: ["model", "setup", "custom", "--base-url", "http://same.example.com/v1", "--provider-id", "my-provider", "--model", "new-model"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      providerFetch: mockFetchForModels(["new-model"])
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);

    const config = await readUserConfig(tmpDir) as any;
    expect(config.providers?.["my-provider"]?.models).toContain("old-model");
    expect(config.providers?.["my-provider"]?.models).toContain("new-model");
    expect(config.model?.id).toBe("new-model");
  });
});

describe("estacoda local setup wrapper", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    resetModelsDevRegistryForTest();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("delegates to estacoda model setup local", async () => {
    const result = await runCliCommand({
      argv: ["local", "setup", "--model", "wrapper-model"],
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      providerFetch: mockFetchForModels("fail")
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Configured local OpenAI-compatible provider.");

    const config = await readUserConfig(tmpDir) as any;
    expect(config.model?.provider).toBe("local");
    expect(config.model?.id).toBe("wrapper-model");
  });
});
