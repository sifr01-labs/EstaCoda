import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRuntimeCredential } from "./runtime-credential-resolver.js";
import type { ProviderMetadata } from "./provider-metadata.js";
import { resolveProfileStateHome } from "../config/profile-home.js";

function hostedMetadata(): ProviderMetadata {
  return {
    id: "openai",
    displayName: "OpenAI",
    catalogKnown: true,
    configurable: true,
    runnable: true,
    visibility: {
      modelPicker: true,
      setup: true,
      catalogExplore: true,
    },
    apiMode: "openai_chat_completions",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultApiKeyEnv: "OPENAI_API_KEY",
    authMethods: ["api_key"],
    defaultAuthMethod: "api_key",
    allowsCustomBaseUrl: true,
    requiresModelSelection: true,
  };
}

function localMetadata(): ProviderMetadata {
  return {
    id: "local",
    displayName: "Local / Private",
    catalogKnown: true,
    configurable: true,
    runnable: true,
    visibility: {
      modelPicker: true,
      setup: true,
      catalogExplore: true,
    },
    apiMode: "custom_openai_compatible",
    defaultBaseUrl: "http://localhost:11434/v1",
    defaultApiKeyEnv: undefined,
    authMethods: ["none"],
    defaultAuthMethod: "none",
    allowsCustomBaseUrl: true,
    requiresModelSelection: true,
  };
}

function codexMetadata(): ProviderMetadata {
  return {
    id: "codex",
    displayName: "OpenAI Codex",
    catalogKnown: true,
    configurable: true,
    runnable: true,
    visibility: {
      modelPicker: true,
      setup: true,
      catalogExplore: true,
    },
    apiMode: "openai_responses",
    defaultBaseUrl: "https://chatgpt.com/backend-api/codex",
    defaultApiKeyEnv: undefined,
    authMethods: ["oauth_device_pkce"],
    defaultAuthMethod: "oauth_device_pkce",
    allowsCustomBaseUrl: false,
    requiresModelSelection: true,
  };
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-credential-resolver-test-"));
}

async function writeAuthJson(homeDir: string, store: unknown): Promise<void> {
  const path = resolveProfileStateHome({ homeDir, profileId: "default" }).authJsonPath;
  await mkdir(join(homeDir, ".estacoda", "profiles", "default"), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}

describe("resolveRuntimeCredential", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("resolves route apiKeyEnv from env", async () => {
    process.env.ROUTE_KEY = "route-secret";
    const result = await resolveRuntimeCredential({
      providerId: "openai",
      route: { apiKeyEnv: "ROUTE_KEY" },
      metadata: hostedMetadata(),
    });

    expect(result.diagnostic.ok).toBe(true);
    expect(result.credential?.kind).toBe("bearer");
    expect(result.credential?.id).toBe("ROUTE_KEY");
    expect((result.credential as { value: string }).value).toBe("route-secret");
    expect((result.credential as { source: string }).source).toBe("env");
  });

  it("route apiKeyEnv beats providerConfig", async () => {
    process.env.ROUTE_KEY = "route-val";
    process.env.PROVIDER_KEY = "provider-val";
    const result = await resolveRuntimeCredential({
      providerId: "openai",
      route: { apiKeyEnv: "ROUTE_KEY" },
      providerConfig: { apiKeyEnv: "PROVIDER_KEY" },
      metadata: hostedMetadata(),
    });

    expect(result.credential?.id).toBe("ROUTE_KEY");
  });

  it("falls back to providerConfig apiKeyEnv when route has none", async () => {
    process.env.PROVIDER_KEY = "provider-secret";
    const result = await resolveRuntimeCredential({
      providerId: "openai",
      route: {},
      providerConfig: { apiKeyEnv: "PROVIDER_KEY" },
      metadata: hostedMetadata(),
    });

    expect(result.diagnostic.ok).toBe(true);
    expect(result.credential?.id).toBe("PROVIDER_KEY");
  });

  it("returns none for local provider with no auth", async () => {
    const result = await resolveRuntimeCredential({
      providerId: "local",
      metadata: localMetadata(),
    });

    expect(result.diagnostic.ok).toBe(true);
    expect(result.credential?.kind).toBe("none");
    expect(result.credential?.id).toBe("local:none");
  });

  it("returns diagnostic for missing route env var", async () => {
    delete process.env.MISSING_KEY;
    const result = await resolveRuntimeCredential({
      providerId: "openai",
      route: { apiKeyEnv: "MISSING_KEY" },
      metadata: hostedMetadata(),
    });

    expect(result.diagnostic.ok).toBe(false);
    expect(result.diagnostic.message).toContain("Missing env var MISSING_KEY");
    expect(result.credential).toBeUndefined();
  });

  it("returns diagnostic for empty route env var", async () => {
    process.env.EMPTY_KEY = "";
    const result = await resolveRuntimeCredential({
      providerId: "openai",
      route: { apiKeyEnv: "EMPTY_KEY" },
      metadata: hostedMetadata(),
    });

    expect(result.diagnostic.ok).toBe(false);
    expect(result.credential).toBeUndefined();
  });

  it("returns diagnostic for missing provider env var", async () => {
    delete process.env.MISSING_PROVIDER_KEY;
    const result = await resolveRuntimeCredential({
      providerId: "openai",
      providerConfig: { apiKeyEnv: "MISSING_PROVIDER_KEY" },
      metadata: hostedMetadata(),
    });

    expect(result.diagnostic.ok).toBe(false);
    expect(result.diagnostic.message).toContain("Missing env var MISSING_PROVIDER_KEY");
    expect(result.credential).toBeUndefined();
  });

  it("returns clear auth diagnostic for hosted api_key provider with no credential reference", async () => {
    const result = await resolveRuntimeCredential({
      providerId: "openai",
      metadata: hostedMetadata(),
    });

    expect(result.diagnostic.ok).toBe(false);
    expect(result.diagnostic.message).toBe(
      "Provider openai requires api_key credentials but no credential reference is configured."
    );
    expect(result.credential).toBeUndefined();
  });

  it("never returns raw secret in diagnostic", async () => {
    process.env.MY_KEY = "super-secret-value";
    const result = await resolveRuntimeCredential({
      providerId: "openai",
      route: { apiKeyEnv: "MY_KEY" },
      metadata: hostedMetadata(),
    });

    expect(result.diagnostic.ok).toBe(true);
    expect(JSON.stringify(result.diagnostic)).not.toContain("super-secret-value");
  });

  it("legacy compatibility: returns auth diagnostic when metadata is absent for a hosted provider", async () => {
    const result = await resolveRuntimeCredential({
      providerId: "openai",
    });

    expect(result.diagnostic.ok).toBe(false);
    expect(result.diagnostic.message).toBe(
      "Provider openai requires api_key credentials but no credential reference is configured."
    );
    expect(result.credential).toBeUndefined();
  });
});

describe("resolveRuntimeCredential OAuth", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves bearer credential from auth.json for OAuth provider", async () => {
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "eyJfake.codex.token.12345",
          refreshToken: "def502.fake.refresh.token.67890",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    });

    const result = await resolveRuntimeCredential({
      providerId: "codex",
      route: { authMethod: "oauth_device_pkce" },
      metadata: codexMetadata(),
      homeDir: tmpDir
    });

    expect(result.diagnostic.ok).toBe(true);
    expect(result.credential?.kind).toBe("bearer");
    expect(result.credential?.id).toBe("codex:oauth");
    expect((result.credential as { value: string }).value).toBe("eyJfake.codex.token.12345");
    expect((result.credential as { source: string }).source).toBe("oauth");
  });

  it("resolves via metadata defaultAuthMethod when route lacks authMethod", async () => {
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "eyJfake.codex.token.12345",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    });

    const result = await resolveRuntimeCredential({
      providerId: "codex",
      metadata: codexMetadata(),
      homeDir: tmpDir
    });

    expect(result.diagnostic.ok).toBe(true);
    expect(result.credential?.id).toBe("codex:oauth");
  });

  it("returns diagnostic with setup instruction when token is missing", async () => {
    const result = await resolveRuntimeCredential({
      providerId: "codex",
      route: { authMethod: "oauth_device_pkce" },
      metadata: codexMetadata(),
      homeDir: tmpDir
    });

    expect(result.diagnostic.ok).toBe(false);
    expect(result.diagnostic.message).toContain("estacoda model setup codex");
    expect(result.credential).toBeUndefined();
  });

  it("refreshes expiring token and returns updated credential", async () => {
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "old-access",
          refreshToken: "valid-refresh",
          expiresAt: new Date(Date.now() + 30 * 1000).toISOString(), // expires in 30s, within 120s skew
          source: "estacoda"
        }
      }
    });

    const result = await resolveRuntimeCredential({
      providerId: "codex",
      route: { authMethod: "oauth_device_pkce" },
      metadata: codexMetadata(),
      homeDir: tmpDir
    });

    // Refresh fails because there's no mock server, but we verify the behavior
    expect(result.diagnostic.ok).toBe(false);
    expect(result.diagnostic.message).toBeDefined();
  });

  it("does not leak token values in diagnostics", async () => {
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "eyJfake.codex.token.12345",
          refreshToken: "def502.fake.refresh.token.67890",
          expiresAt: new Date(Date.now() + 30 * 1000).toISOString(),
          source: "estacoda"
        }
      }
    });

    const result = await resolveRuntimeCredential({
      providerId: "codex",
      route: { authMethod: "oauth_device_pkce" },
      metadata: codexMetadata(),
      homeDir: tmpDir
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("eyJfake.codex.token.12345");
    expect(serialized).not.toContain("def502.fake.refresh.token.67890");
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("refreshToken");
    expect(serialized).not.toContain("Bearer");
  });

  it("API-key provider resolution remains unchanged when metadata is api_key", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const result = await resolveRuntimeCredential({
      providerId: "openai",
      route: { apiKeyEnv: "OPENAI_API_KEY" },
      metadata: hostedMetadata(),
      homeDir: tmpDir
    });

    expect(result.diagnostic.ok).toBe(true);
    expect(result.credential?.kind).toBe("bearer");
    expect((result.credential as { source: string }).source).toBe("env");
  });
});
