import { describe, it, expect } from "vitest";
import { computeRuntimeFingerprint, stableJsonHash, type RuntimeFingerprint } from "./runtime-fingerprint.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { ToolsetName } from "../contracts/tool.js";
import type { ResolvedTokens } from "../contracts/ui-tokens.js";
import { resolveTokens } from "../theme/token-resolver.js";

type FingerprintOptions = Parameters<typeof computeRuntimeFingerprint>[1];

function fakeLoadedRuntimeConfig(overrides?: Partial<LoadedRuntimeConfig>): LoadedRuntimeConfig {
  return {
    config: {},
    sources: ["test"],
    model: {
      id: "test-model",
      provider: "openai",
      contextWindowTokens: 128_000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true,
    },
    providerRegistry: {} as unknown as LoadedRuntimeConfig["providerRegistry"],
    web: { enableNetwork: true, maxContentChars: 5000 },
    compression: {
      enabled: false,
      threshold: 0.50,
      targetRatio: 0.20,
      protectFirstN: 3,
      protectLastN: 20,
      experimental: false,
    },
    externalMemory: {
      enabled: false,
      timeoutMs: 750,
      maxResults: 3,
      maxChars: 2500,
      mirrorWrites: false,
    },
    browser: { backend: "unconfigured", autoLaunch: false, supervised: false },
    imageGen: { provider: "fal", model: "test", useGateway: false },
    tts: { provider: "edge", speed: 1.0 },
    stt: { provider: "local" },
    mcp: { servers: {} },
    skills: { externalDirs: [], autonomy: "suggest", config: {} },
    ui: { language: "en", flavor: "standard", activityLabels: "en" },
    profile: { mode: "focused", responseLanguage: "en" },
    security: {
      approvalMode: "adaptive",
      allowPrivateUrls: false,
      websiteBlocklist: {},
      assessor: { enabled: false, timeoutMs: 30_000 },
    },
    channels: {
      telegram: { ready: false },
      discord: { ready: false },
      email: { ready: false },
      whatsapp: { ready: false },
    },
    auxiliaryModels: {},
    ...overrides,
  } as LoadedRuntimeConfig;
}

function fakeOptions(overrides?: Partial<{
  profileId: string;
  workspaceRoot: string;
  homeDir: string;
  localSkillsRoot: string;
  userMemoryRoot?: string;
  projectMemoryRoot?: string;
  trustStorePath?: string;
  disabledToolsets: ToolsetName[];
  disableCronTools: boolean;
  approvalControllerPresent: boolean;
  explicitSecurityPolicyPresent: boolean;
  currentPlatform: string;
  tokens?: ResolvedTokens;
}>): Required<Omit<FingerprintOptions, "userMemoryRoot" | "projectMemoryRoot" | "trustStorePath" | "tokens">> &
  Partial<Pick<FingerprintOptions, "userMemoryRoot" | "projectMemoryRoot" | "trustStorePath" | "tokens">> {
  return {
    profileId: "default",
    workspaceRoot: "/workspace",
    homeDir: "/home/test",
    localSkillsRoot: "/home/test/.estacoda/skills",
    disabledToolsets: [],
    disableCronTools: false,
    approvalControllerPresent: false,
    explicitSecurityPolicyPresent: false,
    currentPlatform: "linux",
    ...overrides,
  };
}

describe("stableJsonHash", () => {
  it("produces same hash for same object", () => {
    const obj = { a: 1, b: 2 };
    expect(stableJsonHash(obj)).toBe(stableJsonHash(obj));
  });

  it("is stable across key order changes", () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    expect(stableJsonHash(a)).toBe(stableJsonHash(b));
  });

  it("handles nested objects", () => {
    const obj = { a: { b: { c: 1 } } };
    expect(stableJsonHash(obj)).toBe(stableJsonHash({ a: { b: { c: 1 } } }));
  });

  it("handles arrays", () => {
    const obj = { arr: [3, 1, 2] };
    expect(stableJsonHash(obj)).toBe(stableJsonHash({ arr: [3, 1, 2] }));
  });

  it("treats null consistently", () => {
    expect(stableJsonHash(null)).toBe(stableJsonHash(null));
  });

  it("treats undefined consistently (omitted in JSON)", () => {
    expect(stableJsonHash({ a: undefined })).toBe(stableJsonHash({}));
  });

  it("produces different hashes for different values", () => {
    expect(stableJsonHash({ a: 1 })).not.toBe(stableJsonHash({ a: 2 }));
  });

  it("produces different hashes for different structures", () => {
    expect(stableJsonHash({ a: [1, 2] })).not.toBe(stableJsonHash({ a: [2, 1] }));
  });
});

describe("computeRuntimeFingerprint", () => {
  it("same config produces same fingerprint", () => {
    const config = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(config, opts);
    const fp2 = computeRuntimeFingerprint(config, opts);
    expect(fp1).toEqual(fp2);
  });

  it("object key order does not change hash", () => {
    const config1 = fakeLoadedRuntimeConfig({
      mcp: {
        servers: {
          serverB: { enabled: true, command: "b" },
          serverA: { enabled: true, command: "a" },
        },
      },
    });
    const config2 = fakeLoadedRuntimeConfig({
      mcp: {
        servers: {
          serverA: { enabled: true, command: "a" },
          serverB: { enabled: true, command: "b" },
        },
      },
    });
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(config1, opts);
    const fp2 = computeRuntimeFingerprint(config2, opts);
    expect(fp1.mcpServersHash).toBe(fp2.mcpServersHash);
    expect(fp1).toEqual(fp2);
  });

  it("model provider change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({ model: { ...base.model, provider: "anthropic" } }),
      opts
    );
    expect(fp2.modelProvider).toBe("anthropic");
    expect(fp1).not.toEqual(fp2);
  });

  it("model id change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({ model: { ...base.model, id: "gpt-5" } }),
      opts
    );
    expect(fp2.modelId).toBe("gpt-5");
    expect(fp1).not.toEqual(fp2);
  });

  it("primary model route endpoint metadata changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig({
      primaryModelRoute: {
        provider: "custom",
        id: "main",
        profile: {
          id: "main",
          provider: "custom",
          contextWindowTokens: 128_000,
          supportsTools: true,
          supportsVision: false,
          supportsStructuredOutput: true,
        },
        baseUrl: "https://one.example/v1",
        apiKeyEnv: "CUSTOM_API_KEY",
      },
    });
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        primaryModelRoute: {
          provider: "custom",
          id: "main",
          profile: {
            id: "main",
            provider: "custom",
            contextWindowTokens: 128_000,
            supportsTools: true,
            supportsVision: false,
            supportsStructuredOutput: true,
          },
          baseUrl: "https://two.example/v1",
          apiKeyEnv: "CUSTOM_API_KEY",
        },
      }),
      opts
    );
    expect(fp1.primaryModelRouteHash).toBeDefined();
    expect(fp2.primaryModelRouteHash).toBeDefined();
    expect(fp1.primaryModelRouteHash).not.toBe(fp2.primaryModelRouteHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("fallback route ordering and credential env metadata changes fingerprint without secrets", () => {
    const base = fakeLoadedRuntimeConfig({
      config: {
        providers: {
          custom: {
            headers: {
              Authorization: "Bearer sk-test-secret",
            },
          },
        },
      },
      modelFallbackRoutes: [
        {
          provider: "openai",
          id: "gpt-5-mini",
          profile: {
            id: "gpt-5-mini",
            provider: "openai",
            contextWindowTokens: 128_000,
            supportsTools: true,
            supportsVision: false,
            supportsStructuredOutput: true,
          },
          apiKeyEnv: "OPENAI_API_KEY",
        },
        {
          provider: "custom",
          id: "backup",
          profile: {
            id: "backup",
            provider: "custom",
            contextWindowTokens: 128_000,
            supportsTools: true,
            supportsVision: false,
            supportsStructuredOutput: true,
          },
          baseUrl: "https://backup.example/v1",
          apiKeyEnv: "BACKUP_API_KEY",
        },
      ],
    });
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        modelFallbackRoutes: [
          {
            provider: "custom",
            id: "backup",
            profile: {
              id: "backup",
              provider: "custom",
              contextWindowTokens: 128_000,
              supportsTools: true,
              supportsVision: false,
              supportsStructuredOutput: true,
            },
            baseUrl: "https://backup.example/v1",
            apiKeyEnv: "BACKUP_API_KEY",
          },
          {
            provider: "openai",
            id: "gpt-5-mini",
            profile: {
              id: "gpt-5-mini",
              provider: "openai",
              contextWindowTokens: 128_000,
              supportsTools: true,
              supportsVision: false,
              supportsStructuredOutput: true,
            },
            apiKeyEnv: "OPENAI_API_KEY",
          },
        ],
      }),
      opts
    );
    expect(fp1.modelFallbackRoutesHash).toBeDefined();
    expect(fp2.modelFallbackRoutesHash).toBeDefined();
    expect(fp1.modelFallbackRoutesHash).not.toBe(fp2.modelFallbackRoutesHash);
    expect(JSON.stringify(fp1)).not.toContain("sk-test-secret");
    expect(fp1).not.toEqual(fp2);
  });

  it("primary model route apiMode change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig({
      primaryModelRoute: {
        provider: "openai",
        id: "gpt-4o",
        profile: {
          id: "gpt-4o",
          provider: "openai",
          contextWindowTokens: 128_000,
          supportsTools: true,
          supportsVision: false,
          supportsStructuredOutput: true,
        },
        apiMode: "openai_chat_completions",
      },
    });
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        primaryModelRoute: {
          provider: "openai",
          id: "gpt-4o",
          profile: {
            id: "gpt-4o",
            provider: "openai",
            contextWindowTokens: 128_000,
            supportsTools: true,
            supportsVision: false,
            supportsStructuredOutput: true,
          },
          apiMode: "openai_responses",
        },
      }),
      opts
    );
    expect(fp1.primaryModelRouteHash).toBeDefined();
    expect(fp2.primaryModelRouteHash).toBeDefined();
    expect(fp1.primaryModelRouteHash).not.toBe(fp2.primaryModelRouteHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("fallback route apiMode change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig({
      modelFallbackRoutes: [
        {
          provider: "deepseek",
          id: "deepseek-chat",
          profile: {
            id: "deepseek-chat",
            provider: "deepseek",
            contextWindowTokens: 128_000,
            supportsTools: true,
            supportsVision: false,
            supportsStructuredOutput: true,
          },
          apiMode: "openai_chat_completions",
        },
      ],
    });
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        modelFallbackRoutes: [
          {
            provider: "deepseek",
            id: "deepseek-chat",
            profile: {
              id: "deepseek-chat",
              provider: "deepseek",
              contextWindowTokens: 128_000,
              supportsTools: true,
              supportsVision: false,
              supportsStructuredOutput: true,
            },
            apiMode: "custom_openai_compatible",
          },
        ],
      }),
      opts
    );
    expect(fp1.modelFallbackRoutesHash).toBeDefined();
    expect(fp2.modelFallbackRoutesHash).toBeDefined();
    expect(fp1.modelFallbackRoutesHash).not.toBe(fp2.modelFallbackRoutesHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("security mode change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        security: { ...base.security, approvalMode: "strict" },
      }),
      opts
    );
    expect(fp2.securityMode).toBe("strict");
    expect(fp1).not.toEqual(fp2);
  });

  it("security assessor config change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        security: {
          ...base.security,
          assessor: { enabled: true, provider: "openai", model: "gpt-4", timeoutMs: 30_000 },
        },
      }),
      opts
    );
    expect(fp2.securityAssessorEnabled).toBe(true);
    expect(fp1).not.toEqual(fp2);
  });

  it("security allow-private URL policy change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        security: {
          ...base.security,
          allowPrivateUrls: true,
        },
      }),
      opts
    );
    expect(fp2.securityUrlPolicyHash).not.toBe(fp1.securityUrlPolicyHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("security website blocklist policy change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        security: {
          ...base.security,
          websiteBlocklist: {
            domains: ["blocked.test", "*.internal.test"],
            sharedFiles: ["/policy/shared-blocklist.txt"],
          },
        },
      }),
      opts
    );
    expect(fp2.securityUrlPolicyHash).not.toBe(fp1.securityUrlPolicyHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("MCP config change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        mcp: {
          servers: {
            test: { enabled: true, command: "test" },
          },
        },
      }),
      opts
    );
    expect(fp2.mcpServersHash).not.toBe(fp1.mcpServersHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("skill config change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        skills: { ...base.skills, config: { mySkill: { key: "value" } } },
      }),
      opts
    );
    expect(fp2.skillConfigHash).not.toBe(fp1.skillConfigHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("skill autonomy change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        skills: { ...base.skills, autonomy: "proactive" },
      }),
      opts
    );
    expect(fp2.skillAutonomy).toBe("proactive");
    expect(fp1).not.toEqual(fp2);
  });

  it("browser config change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        browser: { backend: "local-cdp", autoLaunch: true, cdpUrl: "ws://localhost:9222", supervised: true },
      }),
      opts
    );
    expect(fp2.browserHash).not.toBe(fp1.browserHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("browser cloud provider change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        browser: { ...base.browser, cloudProvider: "browserbase" },
      }),
      opts
    );
    expect(fp2.browserHash).not.toBe(fp1.browserHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("web config change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        web: { enableNetwork: false, maxContentChars: 1000 },
      }),
      opts
    );
    expect(fp2.enableWebNetwork).toBe(false);
    expect(fp2.webMaxContentChars).toBe(1000);
    expect(fp1).not.toEqual(fp2);
  });

  it("web research backend config change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        web: {
          ...base.web,
          backend: "firecrawl",
          searchBackend: "tavily",
          extractBackend: "fetch",
          crawlBackend: "firecrawl",
        },
      }),
      opts
    );
    expect(fp2.webResearchHash).not.toBe(fp1.webResearchHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("compression config change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        compression: {
          ...base.compression,
          threshold: 0.75,
        },
      }),
      opts
    );
    expect(fp2.compressionConfigHash).not.toBe(fp1.compressionConfigHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("external memory config change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        externalMemory: {
          ...base.externalMemory,
          enabled: true,
          provider: "fake",
        },
      }),
      opts
    );
    expect(fp2.externalMemoryConfigHash).not.toBe(fp1.externalMemoryConfigHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("disabled toolsets change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      base,
      fakeOptions({ disabledToolsets: ["web", "browser"] })
    );
    expect(fp2.disabledToolsets).toEqual(["browser", "web"]);
    expect(fp1).not.toEqual(fp2);
  });

  it("workspace root change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      base,
      fakeOptions({ workspaceRoot: "/other" })
    );
    expect(fp2.workspaceRoot).toBe("/other");
    expect(fp1).not.toEqual(fp2);
  });

  it("home dir change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      base,
      fakeOptions({ homeDir: "/other/home" })
    );
    expect(fp2.homeDir).toBe("/other/home");
    expect(fp1).not.toEqual(fp2);
  });

  it("local skills root change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      base,
      fakeOptions({ localSkillsRoot: "/other/skills" })
    );
    expect(fp2.localSkillsRoot).toBe("/other/skills");
    expect(fp1).not.toEqual(fp2);
  });

  it("profile id change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      base,
      fakeOptions({ profileId: "other" })
    );
    expect(fp2.profileId).toBe("other");
    expect(fp1).not.toEqual(fp2);
  });

  it("ui config change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        ui: { language: "ar", flavor: "kemet-full", activityLabels: "ar" },
      }),
      opts
    );
    expect(fp2.uiLanguage).toBe("ar");
    expect(fp1).not.toEqual(fp2);
  });

  it("agent profile change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        profile: { mode: "operator", responseLanguage: "ar" },
      }),
      opts
    );
    expect(fp2.agentProfileMode).toBe("operator");
    expect(fp1).not.toEqual(fp2);
  });

  it("image gen config change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        imageGen: { provider: "byteplus", model: "other", useGateway: true },
      }),
      opts
    );
    expect(fp2.imageGenHash).not.toBe(fp1.imageGenHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("tts config change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        tts: { provider: "openai", speed: 1.5 },
      }),
      opts
    );
    expect(fp2.ttsHash).not.toBe(fp1.ttsHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("stt config change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        stt: { provider: "groq" },
      }),
      opts
    );
    expect(fp2.sttHash).not.toBe(fp1.sttHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("telegram ready change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        channels: {
          ...base.channels,
          telegram: { ...base.channels.telegram, ready: true },
        },
      }),
      opts
    );
    expect(fp2.telegramReady).toBe(true);
    expect(fp1).not.toEqual(fp2);
  });

  it("current platform change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      base,
      fakeOptions({ currentPlatform: "darwin" })
    );
    expect(fp2.currentPlatform).toBe("darwin");
    expect(fp1).not.toEqual(fp2);
  });

  it("approval controller present change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      base,
      fakeOptions({ approvalControllerPresent: true })
    );
    expect(fp2.approvalControllerPresent).toBe(true);
    expect(fp1).not.toEqual(fp2);
  });

  it("explicit security policy present change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      base,
      fakeOptions({ explicitSecurityPolicyPresent: true })
    );
    expect(fp2.explicitSecurityPolicyPresent).toBe(true);
    expect(fp1).not.toEqual(fp2);
  });

  it("disable cron tools change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      base,
      fakeOptions({ disableCronTools: true })
    );
    expect(fp2.disableCronTools).toBe(true);
    expect(fp1).not.toEqual(fp2);
  });

  it("auxiliary models change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        auxiliaryModels: { vision: { provider: "openai", enabled: true } },
      }),
      opts
    );
    expect(fp2.auxiliaryModelsHash).not.toBe(fp1.auxiliaryModelsHash);
    expect(fp1).not.toEqual(fp2);
  });

  it("external skill roots are sorted deterministically", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        skills: { ...base.skills, externalDirs: ["/z", "/a", "/m"] },
      }),
      opts
    );
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        skills: { ...base.skills, externalDirs: ["/a", "/m", "/z"] },
      }),
      opts
    );
    expect(fp1.externalSkillRoots).toEqual(["/a", "/m", "/z"]);
    expect(fp2.externalSkillRoots).toEqual(["/a", "/m", "/z"]);
    expect(fp1.externalSkillRoots).toEqual(fp2.externalSkillRoots);
  });

  it("disabled toolsets are sorted deterministically", () => {
    const base = fakeLoadedRuntimeConfig();
    const fp1 = computeRuntimeFingerprint(
      base,
      fakeOptions({ disabledToolsets: ["web", "core", "browser"] })
    );
    const fp2 = computeRuntimeFingerprint(
      base,
      fakeOptions({ disabledToolsets: ["browser", "core", "web"] })
    );
    expect(fp1.disabledToolsets).toEqual(["browser", "core", "web"]);
    expect(fp2.disabledToolsets).toEqual(["browser", "core", "web"]);
    expect(fp1.disabledToolsets).toEqual(fp2.disabledToolsets);
  });

  it("memory roots change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      base,
      fakeOptions({ userMemoryRoot: "/other/memory", projectMemoryRoot: "/other/project-memory" })
    );
    expect(fp2.userMemoryRoot).toBe("/other/memory");
    expect(fp2.projectMemoryRoot).toBe("/other/project-memory");
    expect(fp1).not.toEqual(fp2);
  });

  it("security assessor timeout change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        security: {
          ...base.security,
          assessor: { ...base.security.assessor, timeoutMs: 60_000 },
        },
      }),
      opts
    );
    expect(fp2.securityAssessorTimeoutMs).toBe(60_000);
    expect(fp1).not.toEqual(fp2);
  });

  it("model context window tokens change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig({
        model: { ...base.model, contextWindowTokens: 256_000 },
      }),
      opts
    );
    expect(fp2.modelContextWindowTokens).toBe(256_000);
    expect(fp1).not.toEqual(fp2);
  });

  it("excludes dynamic per-turn fields", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp = computeRuntimeFingerprint(base, opts);

    // These fields should NOT exist on the fingerprint
    expect("sessionId" in fp).toBe(false);
    expect("sessionMetadata" in fp).toBe(false);
    expect("theme" in fp).toBe(false);
  });

  it("captures token skin and theme identity when tokens are supplied", () => {
    const fp = computeRuntimeFingerprint(
      fakeLoadedRuntimeConfig(),
      fakeOptions({ tokens: resolveTokens("standard", "dark", "kemetBlue") })
    );

    expect(fp.runtimeUiIdentity).toBe("kemetBlue-dark");
  });

  it("omits runtime UI identity when tokens are not supplied", () => {
    const fp = computeRuntimeFingerprint(fakeLoadedRuntimeConfig(), fakeOptions());

    expect("runtimeUiIdentity" in fp).toBe(false);
  });

  it("trustStorePath change changes fingerprint", () => {
    const base = fakeLoadedRuntimeConfig();
    const opts = fakeOptions();
    const fp1 = computeRuntimeFingerprint(base, opts);
    const fp2 = computeRuntimeFingerprint(
      base,
      fakeOptions({ trustStorePath: "/custom/trust.json" })
    );
    expect(fp2.trustStorePath).toBe("/custom/trust.json");
    expect(fp1).not.toEqual(fp2);
  });

  it("defaults trustStorePath from homeDir when not provided", () => {
    const base = fakeLoadedRuntimeConfig();
    const fp = computeRuntimeFingerprint(
      base,
      fakeOptions({ homeDir: "/home/test" })
    );
    expect(fp.trustStorePath).toBe("/home/test/.estacoda/trust.json");
  });
});
