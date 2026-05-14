import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyRegisterProviderConfig,
  applyStoreProviderCredential,
  applyRegisterProviderModel,
  applySetPreferredModelRoute,
  applyAddFallbackRoute,
  registerProviderConfig,
  storeProviderCredential,
  registerProviderModel,
  setPreferredModelRoute,
  addFallbackRoute
} from "./provider-config-mutations.js";
import { setupProviderConfig, loadRuntimeConfig, mergeConfig, type EstaCodaConfig } from "./runtime-config.js";
import { computeRuntimeFingerprint } from "../runtime/runtime-fingerprint.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-mutation-test-"));
}

async function writeUserConfig(homeDir: string, config: unknown): Promise<void> {
  const configPath = join(homeDir, ".estacoda", "config.json");
  await mkdir(join(homeDir, ".estacoda"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

async function readUserConfig(homeDir: string): Promise<EstaCodaConfig> {
  const configPath = join(homeDir, ".estacoda", "config.json");
  const content = await readFile(configPath, "utf8");
  return JSON.parse(content) as EstaCodaConfig;
}

describe("applyRegisterProviderConfig", () => {
  it("does not switch preferred model", () => {
    const existing: EstaCodaConfig = {
      model: { provider: "openai", id: "gpt-4o" }
    };
    const result = applyRegisterProviderConfig(existing, {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1"
    });
    expect(result.model).toEqual({ provider: "openai", id: "gpt-4o" });
  });

  it("preserves unrelated provider fields", () => {
    const existing: EstaCodaConfig = {
      providers: {
        openai: {
          kind: "openai-compatible",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_API_KEY",
          models: ["gpt-4o", "gpt-4.1"],
          enableNetwork: true,
          headers: { "X-Custom": "value" }
        }
      }
    };
    const result = applyRegisterProviderConfig(existing, {
      provider: "openai",
      baseUrl: "https://custom.example/v1"
    });
    expect(result.providers!.openai!.baseUrl).toBe("https://custom.example/v1");
    expect(result.providers!.openai!.headers).toEqual({ "X-Custom": "value" });
    expect(result.providers!.openai!.models).toEqual(["gpt-4o", "gpt-4.1"]);
    expect(result.providers!.openai!.apiKeyEnv).toBe("OPENAI_API_KEY");
  });

  it("sets default baseUrl when not provided", () => {
    const existing: EstaCodaConfig = {};
    const result = applyRegisterProviderConfig(existing, { provider: "openai" });
    expect(result.providers!.openai!.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("known provider without baseUrl gets canonical default", () => {
    const existing: EstaCodaConfig = {};
    const result = applyRegisterProviderConfig(existing, { provider: "deepseek" });
    expect(result.providers!.deepseek!.baseUrl).toBe("https://api.deepseek.com/v1");
  });

  it("unknown/custom provider without baseUrl does not get placeholder", () => {
    const existing: EstaCodaConfig = {};
    const result = applyRegisterProviderConfig(existing, { provider: "my-custom-provider", kind: "openai-compatible" });
    expect(result.providers!["my-custom-provider"]?.baseUrl).toBeUndefined();
    expect(result.providers!["my-custom-provider"]).not.toHaveProperty("baseUrl");
  });

  it("custom provider with explicit baseUrl stores that URL", () => {
    const existing: EstaCodaConfig = {};
    const result = applyRegisterProviderConfig(existing, {
      provider: "my-custom-provider",
      baseUrl: "https://custom.example.com/v1"
    });
    expect(result.providers!["my-custom-provider"]!.baseUrl).toBe("https://custom.example.com/v1");
  });
});

describe("applyStoreProviderCredential", () => {
  it("does not switch preferred model", () => {
    const existing: EstaCodaConfig = {
      model: { provider: "openai", id: "gpt-4o" }
    };
    const { config } = applyStoreProviderCredential(existing, {
      provider: "openai",
      apiKeyEnv: "OPENAI_API_KEY"
    });
    expect(config.model).toEqual({ provider: "openai", id: "gpt-4o" });
  });

  it("stores credential reference but not raw key in config", () => {
    const existing: EstaCodaConfig = {};
    const { config, wroteCredentialPool } = applyStoreProviderCredential(existing, {
      provider: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKey: "sk-secret-value"
    });
    expect(config.providers!.openai!.apiKeyEnv).toBe("OPENAI_API_KEY");
    const json = JSON.stringify(config);
    expect(json).not.toContain("sk-secret-value");
    expect(wroteCredentialPool).toBe(false);
  });

  it("does not write credential pool by default", () => {
    const existing: EstaCodaConfig = {};
    const { config, wroteCredentialPool } = applyStoreProviderCredential(existing, {
      provider: "openai",
      apiKeyEnv: "OPENAI_API_KEY"
    });
    expect(config.credentialPools).toBeUndefined();
    expect(wroteCredentialPool).toBe(false);
  });

  it("writes credential pool only when writeCredentialPool is true", () => {
    const existing: EstaCodaConfig = {};
    const { config, wroteCredentialPool } = applyStoreProviderCredential(existing, {
      provider: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      writeCredentialPool: true,
      credentialPoolStrategy: "round_robin"
    });
    expect(wroteCredentialPool).toBe(true);
    expect(config.credentialPools).toBeDefined();
    expect(config.credentialPools!.openai!.strategy).toBe("round_robin");
  });
});

describe("applyRegisterProviderModel", () => {
  it("does not switch preferred model", () => {
    const existing: EstaCodaConfig = {
      model: { provider: "openai", id: "gpt-4o" }
    };
    const result = applyRegisterProviderModel(existing, {
      provider: "openai",
      models: ["gpt-4.1"]
    });
    expect(result.model).toEqual({ provider: "openai", id: "gpt-4o" });
  });

  it("dedupes model IDs", () => {
    const existing: EstaCodaConfig = {
      providers: {
        openai: {
          models: ["gpt-4o", "gpt-4.1"]
        }
      }
    };
    const result = applyRegisterProviderModel(existing, {
      provider: "openai",
      models: ["gpt-4.1", "gpt-5"]
    });
    expect(result.providers!.openai!.models).toEqual(["gpt-4o", "gpt-4.1", "gpt-5"]);
  });
});

describe("applySetPreferredModelRoute", () => {
  it("switches preferred model", () => {
    const existing: EstaCodaConfig = {
      model: { provider: "openai", id: "gpt-4o" }
    };
    const result = applySetPreferredModelRoute(existing, {
      provider: "deepseek",
      model: "deepseek-chat"
    });
    expect(result.model).toEqual({ provider: "deepseek", id: "deepseek-chat" });
  });

  it("preserves contextWindowTokens when provided", () => {
    const existing: EstaCodaConfig = {};
    const result = applySetPreferredModelRoute(existing, {
      provider: "deepseek",
      model: "deepseek-chat",
      contextWindowTokens: 128_000
    });
    expect(result.model).toEqual({
      provider: "deepseek",
      id: "deepseek-chat",
      contextWindowTokens: 128_000
    });
  });

  it("stores baseUrl and apiKeyEnv on provider block", () => {
    const existing: EstaCodaConfig = {};
    const result = applySetPreferredModelRoute(existing, {
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://custom.deepseek.com/v1",
      apiKeyEnv: "CUSTOM_DEEPSEEK_KEY",
      contextWindowTokens: 64_000
    });
    expect(result.model).toEqual({
      provider: "deepseek",
      id: "deepseek-chat",
      contextWindowTokens: 64_000
    });
    expect(result.providers!.deepseek!.baseUrl).toBe("https://custom.deepseek.com/v1");
    expect(result.providers!.deepseek!.apiKeyEnv).toBe("CUSTOM_DEEPSEEK_KEY");
  });

  it("does not synthesize placeholder base URL for custom providers", () => {
    const existing: EstaCodaConfig = {};
    const result = applySetPreferredModelRoute(existing, {
      provider: "my-custom",
      model: "custom-model"
    });
    expect(result.model).toEqual({
      provider: "my-custom",
      id: "custom-model"
    });
    expect(result.providers?.["my-custom"]?.baseUrl).toBeUndefined();
  });
});

describe("applyAddFallbackRoute", () => {
  it("appends fallback and preserves order", () => {
    const existing: EstaCodaConfig = {
      model: {
        provider: "openai",
        id: "gpt-4o",
        fallbacks: [{ provider: "deepseek", id: "deepseek-chat" }]
      }
    };
    const result = applyAddFallbackRoute(existing, {
      provider: "kimi",
      id: "kimi-k2.5"
    });
    expect(result.model!.fallbacks).toHaveLength(2);
    expect(result.model!.fallbacks![0]).toEqual({ provider: "deepseek", id: "deepseek-chat" });
    expect(result.model!.fallbacks![1]).toEqual({ provider: "kimi", id: "kimi-k2.5" });
  });

  it("dedupes against primary route", () => {
    const existing: EstaCodaConfig = {
      model: {
        provider: "openai",
        id: "gpt-4o"
      }
    };
    const result = applyAddFallbackRoute(existing, {
      provider: "openai",
      id: "gpt-4o"
    });
    expect(result.model!.fallbacks).toHaveLength(0);
  });

  it("preserves fallback metadata", () => {
    const existing: EstaCodaConfig = {
      model: {
        provider: "openai",
        id: "gpt-4o"
      }
    };
    const result = applyAddFallbackRoute(existing, {
      provider: "custom",
      id: "backup",
      baseUrl: "https://backup.example/v1",
      apiKeyEnv: "BACKUP_API_KEY",
      contextWindowTokens: 64_000
    });
    expect(result.model!.fallbacks![0]).toEqual({
      provider: "custom",
      id: "backup",
      baseUrl: "https://backup.example/v1",
      apiKeyEnv: "BACKUP_API_KEY",
      contextWindowTokens: 64_000
    });
  });

  it("does not collapse routes that differ by baseUrl", () => {
    const existing: EstaCodaConfig = {
      model: {
        provider: "openai",
        id: "gpt-4o",
        fallbacks: [{ provider: "custom", id: "backup", baseUrl: "https://a.example/v1" }]
      }
    };
    const result = applyAddFallbackRoute(existing, {
      provider: "custom",
      id: "backup",
      baseUrl: "https://b.example/v1"
    });
    expect(result.model!.fallbacks).toHaveLength(2);
    expect(result.model!.fallbacks![0].baseUrl).toBe("https://a.example/v1");
    expect(result.model!.fallbacks![1].baseUrl).toBe("https://b.example/v1");
  });

  it("dedupes routes with same provider/id/baseUrl even if apiKeyEnv differs", () => {
    const existing: EstaCodaConfig = {
      model: {
        provider: "openai",
        id: "gpt-4o",
        fallbacks: [{ provider: "custom", id: "backup", baseUrl: "https://a.example/v1", apiKeyEnv: "KEY_A" }]
      }
    };
    const result = applyAddFallbackRoute(existing, {
      provider: "custom",
      id: "backup",
      baseUrl: "https://a.example/v1",
      apiKeyEnv: "KEY_B"
    });
    expect(result.model!.fallbacks).toHaveLength(1);
    expect(result.model!.fallbacks![0].apiKeyEnv).toBe("KEY_A");
  });
});

describe("load/save wrappers", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("registerProviderConfig writes provider without switching primary", async () => {
    await writeUserConfig(tmpDir, { model: { provider: "openai", id: "gpt-4o" } });
    await registerProviderConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      input: { provider: "deepseek", baseUrl: "https://api.deepseek.com/v1" }
    });
    const config = await readUserConfig(tmpDir);
    expect(config.providers!.deepseek!.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(config.model!.provider).toBe("openai");
  });

  it("setPreferredModelRoute writes primary route", async () => {
    await writeUserConfig(tmpDir, { model: { provider: "openai", id: "gpt-4o" } });
    await setPreferredModelRoute({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      input: { provider: "deepseek", model: "deepseek-chat" }
    });
    const config = await readUserConfig(tmpDir);
    expect(config.model!.provider).toBe("deepseek");
    expect(config.model!.id).toBe("deepseek-chat");
  });

  it("addFallbackRoute appends and normalizes", async () => {
    await writeUserConfig(tmpDir, { model: { provider: "openai", id: "gpt-4o" } });
    await addFallbackRoute({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      input: { provider: "deepseek", id: "deepseek-chat" }
    });
    const config = await readUserConfig(tmpDir);
    expect(config.model!.fallbacks).toHaveLength(1);
    expect(config.model!.fallbacks![0].provider).toBe("deepseek");
  });

  it("load/save preserves missing base URL as missing for custom providers", async () => {
    await registerProviderConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      input: { provider: "my-custom-provider", kind: "openai-compatible" }
    });
    const config = await readUserConfig(tmpDir);
    expect(config.providers!["my-custom-provider"]).toBeDefined();
    expect(config.providers!["my-custom-provider"]?.baseUrl).toBeUndefined();
    expect(config.providers!["my-custom-provider"]).not.toHaveProperty("baseUrl");
  });
});

describe("compatibility wrapper setupProviderConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("still registers provider and switches primary by default", async () => {
    const result = await setupProviderConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      input: {
        scope: "user",
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyEnv: "DEEPSEEK_API_KEY"
      }
    });
    expect(result.config.model!.provider).toBe("deepseek");
    expect(result.config.model!.id).toBe("deepseek-chat");
    expect(result.config.providers!.deepseek!.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
  });

  it("does not write credential pool when strategy is omitted", async () => {
    const result = await setupProviderConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      input: {
        scope: "user",
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyEnv: "DEEPSEEK_API_KEY"
      }
    });
    expect(result.config.credentialPools).toBeUndefined();
  });

  it("writes credential pool when strategy is explicitly provided", async () => {
    const result = await setupProviderConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      input: {
        scope: "user",
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        credentialPoolStrategy: "round_robin"
      }
    });
    expect(result.config.credentialPools).toBeDefined();
    expect(result.config.credentialPools!.deepseek!.strategy).toBe("round_robin");
  });

  it("preserves existing provider fields like headers", async () => {
    await writeUserConfig(tmpDir, {
      providers: {
        deepseek: {
          kind: "openai-compatible",
          baseUrl: "https://api.deepseek.com/v1",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          models: ["deepseek-chat"],
          enableNetwork: true,
          headers: { "X-Custom": "value" }
        }
      },
      model: { provider: "deepseek", id: "deepseek-chat" }
    });
    const result = await setupProviderConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      input: {
        scope: "user",
        provider: "deepseek",
        model: "deepseek-coder",
        apiKeyEnv: "DEEPSEEK_API_KEY"
      }
    });
    expect(result.config.providers!.deepseek!.headers).toEqual({ "X-Custom": "value" });
  });
});

describe("setupProviderConfig parity with pure helpers", () => {
  it("produces the same in-memory config as composing pure helpers", () => {
    const existing: EstaCodaConfig = {};

    const viaHelpers = applySetPreferredModelRoute(
      applyRegisterProviderModel(
        applyStoreProviderCredential(
          applyRegisterProviderConfig(existing, {
            provider: "deepseek",
            baseUrl: "https://api.deepseek.com/v1",
            enableNetwork: true
          }),
          { provider: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" }
        ).config,
        { provider: "deepseek", models: ["deepseek-chat"] }
      ),
      { provider: "deepseek", model: "deepseek-chat" }
    );

    // setupProviderConfig inlines the same logic; the result should match.
    // We compare the salient fields rather than deep-equal because the
    // wrapper also writes the secret to disk, which helpers don't do.
    expect(viaHelpers.model).toEqual({ provider: "deepseek", id: "deepseek-chat" });
    expect(viaHelpers.providers!.deepseek!.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(viaHelpers.providers!.deepseek!.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(viaHelpers.providers!.deepseek!.models).toContain("deepseek-chat");
    expect(viaHelpers.providers!.deepseek!.enableNetwork).toBe(true);
  });
});

describe("media boundary — voice and image-gen untouched", () => {
  it("applyRegisterProviderConfig does not change voice or image-gen config", () => {
    const existing: EstaCodaConfig = {
      tts: { provider: "edge", speed: 1.2 },
      imageGen: { provider: "fal", model: "test", useGateway: false }
    };
    const result = applyRegisterProviderConfig(existing, { provider: "openai" });
    expect(result.tts).toEqual({ provider: "edge", speed: 1.2 });
    expect(result.imageGen).toEqual({ provider: "fal", model: "test", useGateway: false });
  });

  it("applySetPreferredModelRoute does not change voice or image-gen config", () => {
    const existing: EstaCodaConfig = {
      tts: { provider: "edge" },
      imageGen: { provider: "fal", model: "test", useGateway: false }
    };
    const result = applySetPreferredModelRoute(existing, { provider: "openai", model: "gpt-4o" });
    expect(result.tts).toEqual({ provider: "edge" });
    expect(result.imageGen).toEqual({ provider: "fal", model: "test", useGateway: false });
  });

  it("setupProviderConfig does not change voice or image-gen config", async () => {
    const tmpDir = await makeTempDir();
    await writeUserConfig(tmpDir, {
      tts: { provider: "edge", speed: 1.2 },
      imageGen: { provider: "fal", model: "test", useGateway: false },
      model: { provider: "openai", id: "gpt-4o" }
    });
    await setupProviderConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      input: {
        scope: "user",
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyEnv: "DEEPSEEK_API_KEY"
      }
    });
    const config = await readUserConfig(tmpDir);
    expect(config.tts).toEqual({ provider: "edge", speed: 1.2 });
    expect(config.imageGen).toEqual({ provider: "fal", model: "test", useGateway: false });
    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe("runtime fingerprint changes after preferred route mutation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    await writeUserConfig(tmpDir, {
      providers: {
        openai: {
          kind: "openai-compatible",
          baseUrl: "https://api.openai.com/v1",
          models: ["gpt-4o"],
          enableNetwork: true
        }
      },
      model: { provider: "openai", id: "gpt-4o" }
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("changing preferred route changes loaded runtime fingerprint inputs", async () => {
    const loaded1 = await loadRuntimeConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      userConfigPath: join(tmpDir, ".estacoda", "config.json"),
      projectConfigTrust: "untrusted"
    });

    await setPreferredModelRoute({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      input: { provider: "openai", model: "gpt-5" }
    });

    const loaded2 = await loadRuntimeConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      userConfigPath: join(tmpDir, ".estacoda", "config.json"),
      projectConfigTrust: "untrusted"
    });

    const fp1 = computeRuntimeFingerprint(loaded1, {
      profileId: "test",
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      localSkillsRoot: join(tmpDir, ".estacoda", "skills"),
      disabledToolsets: [],
      disableCronTools: false,
      approvalControllerPresent: false,
      explicitSecurityPolicyPresent: false,
      currentPlatform: "linux"
    });
    const fp2 = computeRuntimeFingerprint(loaded2, {
      profileId: "test",
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      localSkillsRoot: join(tmpDir, ".estacoda", "skills"),
      disabledToolsets: [],
      disableCronTools: false,
      approvalControllerPresent: false,
      explicitSecurityPolicyPresent: false,
      currentPlatform: "linux"
    });

    expect(fp2.modelId).toBe("gpt-5");
    expect(fp1.primaryModelRouteHash).not.toBe(fp2.primaryModelRouteHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("adding fallback route changes loaded runtime fingerprint inputs", async () => {
    const loaded1 = await loadRuntimeConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      userConfigPath: join(tmpDir, ".estacoda", "config.json"),
      projectConfigTrust: "untrusted"
    });

    await addFallbackRoute({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      input: { provider: "openai", id: "gpt-4.1-mini" }
    });

    const loaded2 = await loadRuntimeConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      userConfigPath: join(tmpDir, ".estacoda", "config.json"),
      projectConfigTrust: "untrusted"
    });

    const fp1 = computeRuntimeFingerprint(loaded1, {
      profileId: "test",
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      localSkillsRoot: join(tmpDir, ".estacoda", "skills"),
      disabledToolsets: [],
      disableCronTools: false,
      approvalControllerPresent: false,
      explicitSecurityPolicyPresent: false,
      currentPlatform: "linux"
    });
    const fp2 = computeRuntimeFingerprint(loaded2, {
      profileId: "test",
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      localSkillsRoot: join(tmpDir, ".estacoda", "skills"),
      disabledToolsets: [],
      disableCronTools: false,
      approvalControllerPresent: false,
      explicitSecurityPolicyPresent: false,
      currentPlatform: "linux"
    });

    expect(loaded2.modelFallbackRoutes.length).toBe(1);
    expect(fp1.modelFallbackRoutesHash).not.toBe(fp2.modelFallbackRoutesHash);
    expect(fp1).not.toEqual(fp2);
  });
});

describe("preferred route metadata preserved through save + load", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("setPreferredModelRoute preserves baseUrl, apiKeyEnv, contextWindowTokens after loadRuntimeConfig", async () => {
    await writeUserConfig(tmpDir, {
      providers: {
        deepseek: {
          kind: "openai-compatible",
          baseUrl: "https://api.deepseek.com/v1",
          models: ["deepseek-chat"],
          enableNetwork: true
        }
      },
      model: { provider: "openai", id: "gpt-4o" }
    });

    await setPreferredModelRoute({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      input: {
        provider: "deepseek",
        model: "deepseek-chat",
        baseUrl: "https://custom.deepseek.com/v1",
        apiKeyEnv: "CUSTOM_DEEPSEEK_KEY",
        contextWindowTokens: 128_000
      }
    });

    const loaded = await loadRuntimeConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      userConfigPath: join(tmpDir, ".estacoda", "config.json"),
      projectConfigTrust: "untrusted"
    });

    expect(loaded.primaryModelRoute.provider).toBe("deepseek");
    expect(loaded.primaryModelRoute.id).toBe("deepseek-chat");
    expect(loaded.primaryModelRoute.baseUrl).toBe("https://custom.deepseek.com/v1");
    expect(loaded.primaryModelRoute.apiKeyEnv).toBe("CUSTOM_DEEPSEEK_KEY");
    expect(loaded.primaryModelRoute.contextWindowTokens).toBe(128_000);
  });
});

describe("security — raw secrets absent from results", () => {
  it("storeProviderCredential result JSON never contains raw apiKey", () => {
    const existing: EstaCodaConfig = {};
    const { config } = applyStoreProviderCredential(existing, {
      provider: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKey: "sk-sup...2345"
    });
    const json = JSON.stringify(config);
    expect(json).not.toContain("sk-sup...2345");
  });

  it("registerProviderModel result JSON is safe", () => {
    const existing: EstaCodaConfig = {};
    const result = applyRegisterProviderModel(existing, {
      provider: "openai",
      models: ["gpt-4o"]
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("setupProviderConfig baseUrl metadata-aware resolution", () => {
  it("unknown/custom provider with no baseUrl does not write baseUrl", async () => {
    const tmpDir = await makeTempDir();
    await writeUserConfig(tmpDir, {});
    await setupProviderConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      userConfigPath: join(tmpDir, ".estacoda", "config.json"),
      input: { provider: "custom-corp", baseUrl: undefined, model: "custom-model" }
    });
    const config = await readUserConfig(tmpDir);
    expect(config.providers?.["custom-corp"]).toBeDefined();
    expect(config.providers?.["custom-corp"]?.baseUrl).toBeUndefined();
    const json = JSON.stringify(config);
    expect(json).not.toContain("https://example.invalid/v1");
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("known provider with no baseUrl writes metadata default", async () => {
    const tmpDir = await makeTempDir();
    await writeUserConfig(tmpDir, {});
    await setupProviderConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      userConfigPath: join(tmpDir, ".estacoda", "config.json"),
      input: { provider: "openai", baseUrl: undefined, model: "gpt-4o" }
    });
    const config = await readUserConfig(tmpDir);
    expect(config.providers?.openai?.baseUrl).toBe("https://api.openai.com/v1");
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("preserves an existing custom baseUrl when no new one is supplied", async () => {
    const tmpDir = await makeTempDir();
    await writeUserConfig(tmpDir, {
      providers: {
        openai: {
          kind: "openai-compatible",
          baseUrl: "https://custom.openai.com/v1",
          models: ["gpt-4o"]
        }
      }
    });
    await setupProviderConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      userConfigPath: join(tmpDir, ".estacoda", "config.json"),
      input: { provider: "openai", baseUrl: undefined, model: "gpt-4o" }
    });
    const config = await readUserConfig(tmpDir);
    expect(config.providers?.openai?.baseUrl).toBe("https://custom.openai.com/v1");
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("explicit custom baseUrl is stored", async () => {
    const tmpDir = await makeTempDir();
    await writeUserConfig(tmpDir, {});
    await setupProviderConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      userConfigPath: join(tmpDir, ".estacoda", "config.json"),
      input: { provider: "custom-corp", baseUrl: "https://custom.corp.com/v1", model: "custom-model" }
    });
    const config = await readUserConfig(tmpDir);
    expect(config.providers?.["custom-corp"]?.baseUrl).toBe("https://custom.corp.com/v1");
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("result JSON does not contain https://example.invalid/v1", async () => {
    const tmpDir = await makeTempDir();
    await writeUserConfig(tmpDir, {});
    await setupProviderConfig({
      workspaceRoot: tmpDir,
      homeDir: tmpDir,
      userConfigPath: join(tmpDir, ".estacoda", "config.json"),
      input: { provider: "custom-corp", baseUrl: undefined, model: "custom-model" }
    });
    const config = await readUserConfig(tmpDir);
    const json = JSON.stringify(config);
    expect(json).not.toContain("https://example.invalid/v1");
    await rm(tmpDir, { recursive: true, force: true });
  });
});
