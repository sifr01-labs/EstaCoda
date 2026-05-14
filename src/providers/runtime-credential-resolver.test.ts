import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { resolveRuntimeCredential } from "./runtime-credential-resolver.js";
import { CredentialPool, CredentialPoolRegistry } from "./credential-pool.js";
import type { ProviderMetadata } from "./provider-metadata.js";

describe("resolveRuntimeCredential", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("resolves route apiKeyEnv from env", () => {
    process.env.ROUTE_KEY = "route-secret";
    const result = resolveRuntimeCredential({
      providerId: "openai",
      route: { apiKeyEnv: "ROUTE_KEY" },
    });

    expect(result.diagnostic.ok).toBe(true);
    expect(result.credential?.kind).toBe("bearer");
    expect(result.credential?.id).toBe("ROUTE_KEY");
    expect((result.credential as { value: string }).value).toBe("route-secret");
    expect((result.credential as { source: string }).source).toBe("env");
  });

  it("route apiKeyEnv beats providerConfig", () => {
    process.env.ROUTE_KEY = "route-val";
    process.env.PROVIDER_KEY = "provider-val";
    const result = resolveRuntimeCredential({
      providerId: "openai",
      route: { apiKeyEnv: "ROUTE_KEY" },
      providerConfig: { apiKeyEnv: "PROVIDER_KEY" },
    });

    expect(result.credential?.id).toBe("ROUTE_KEY");
  });

  it("falls back to providerConfig apiKeyEnv when route has none", () => {
    process.env.PROVIDER_KEY = "provider-secret";
    const result = resolveRuntimeCredential({
      providerId: "openai",
      route: {},
      providerConfig: { apiKeyEnv: "PROVIDER_KEY" },
    });

    expect(result.diagnostic.ok).toBe(true);
    expect(result.credential?.id).toBe("PROVIDER_KEY");
  });

  it("falls back to credential pool when no env reference", () => {
    const poolRegistry = new CredentialPoolRegistry();
    poolRegistry.register(
      new CredentialPool({
        provider: "openai",
        entries: [
          {
            id: "pool-1",
            source: { kind: "literal", value: "pool-secret" },
            priority: 1,
          },
        ],
      })
    );

    const result = resolveRuntimeCredential({
      providerId: "openai",
      credentialPools: poolRegistry,
    });

    expect(result.diagnostic.ok).toBe(true);
    expect(result.credential?.kind).toBe("bearer");
    expect(result.credential?.id).toBe("pool-1");
    expect((result.credential as { source: string }).source).toBe("pool");
  });

  it("env reference beats pool even when pool is configured", () => {
    process.env.ENV_KEY = "env-secret";
    const poolRegistry = new CredentialPoolRegistry();
    poolRegistry.register(
      new CredentialPool({
        provider: "openai",
        entries: [
          {
            id: "pool-1",
            source: { kind: "literal", value: "pool-secret" },
            priority: 1,
          },
        ],
      })
    );

    const result = resolveRuntimeCredential({
      providerId: "openai",
      route: { apiKeyEnv: "ENV_KEY" },
      credentialPools: poolRegistry,
    });

    expect(result.credential?.id).toBe("ENV_KEY");
    expect((result.credential as { source: string }).source).toBe("env");
  });

  it("returns none for local provider with no auth", () => {
    const metadata: ProviderMetadata = {
      id: "local",
      displayName: "Local",
      catalogKnown: true,
      configurable: true,
      runnable: true,
      visibility: { modelPicker: true, setup: true, catalogExplore: true },
      apiMode: "custom_openai_compatible",
      authMethods: ["none"],
      defaultAuthMethod: "none",
      allowsCustomBaseUrl: true,
      requiresModelSelection: true,
    };

    const result = resolveRuntimeCredential({
      providerId: "local",
      metadata,
    });

    expect(result.diagnostic.ok).toBe(true);
    expect(result.credential?.kind).toBe("none");
    expect(result.credential?.id).toBe("local:none");
  });

  it("returns diagnostic for missing env var", () => {
    delete process.env.MISSING_KEY;
    const result = resolveRuntimeCredential({
      providerId: "openai",
      route: { apiKeyEnv: "MISSING_KEY" },
    });

    expect(result.diagnostic.ok).toBe(false);
    expect(result.diagnostic.message).toContain("Missing env var MISSING_KEY");
    expect(result.credential).toBeUndefined();
  });

  it("returns diagnostic for empty env var", () => {
    process.env.EMPTY_KEY = "";
    const result = resolveRuntimeCredential({
      providerId: "openai",
      route: { apiKeyEnv: "EMPTY_KEY" },
    });

    expect(result.diagnostic.ok).toBe(false);
    expect(result.credential).toBeUndefined();
  });

  it("returns none when no credential is available", () => {
    const result = resolveRuntimeCredential({
      providerId: "openai",
    });

    expect(result.diagnostic.ok).toBe(true);
    expect(result.credential?.kind).toBe("none");
    expect(result.credential?.id).toBe("openai:none");
  });

  it("never returns raw secret in diagnostic", () => {
    process.env.MY_KEY = "super-secret-value";
    const result = resolveRuntimeCredential({
      providerId: "openai",
      route: { apiKeyEnv: "MY_KEY" },
    });

    expect(result.diagnostic.ok).toBe(true);
    expect(JSON.stringify(result.diagnostic)).not.toContain("super-secret-value");
  });

  it("returns none when pool is empty", () => {
    const poolRegistry = new CredentialPoolRegistry();
    poolRegistry.register(
      new CredentialPool({
        provider: "openai",
        entries: [],
      })
    );

    const result = resolveRuntimeCredential({
      providerId: "openai",
      credentialPools: poolRegistry,
    });

    expect(result.diagnostic.ok).toBe(true);
    expect(result.credential?.kind).toBe("none");
  });
});
