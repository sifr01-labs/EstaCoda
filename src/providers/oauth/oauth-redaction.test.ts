import { describe, expect, it } from "vitest";
import { redactOAuthTokenRecord, redactOAuthStore } from "./oauth-redaction.js";

describe("redactOAuthTokenRecord", () => {
  it("redacts accessToken", () => {
    const record = {
      authMethod: "oauth_device_pkce" as const,
      accessToken: "secret-access",
      refreshToken: "secret-refresh",
      expiresAt: "2026-05-15T12:00:00.000Z",
      scopes: ["read", "write"],
      source: "estacoda"
    };
    const redacted = redactOAuthTokenRecord(record);
    expect(redacted.accessToken).toBe("[REDACTED]");
    expect(redacted.refreshToken).toBe("[REDACTED]");
    expect(redacted.expiresAt).toBe("2026-05-15T12:00:00.000Z");
    expect(redacted.scopes).toEqual(["read", "write"]);
    expect(redacted.source).toBe("estacoda");
    expect(redacted.authMethod).toBe("oauth_device_pkce");
  });

  it("redacts accessToken even when refreshToken is absent", () => {
    const record = {
      authMethod: "oauth_external" as const,
      accessToken: "only-access"
    };
    const redacted = redactOAuthTokenRecord(record);
    expect(redacted.accessToken).toBe("[REDACTED]");
    expect(redacted).not.toHaveProperty("refreshToken");
    expect(redacted.authMethod).toBe("oauth_external");
  });

  it("does not mutate the original record", () => {
    const record = {
      authMethod: "oauth_device_pkce" as const,
      accessToken: "original",
      refreshToken: "original-refresh"
    };
    const redacted = redactOAuthTokenRecord(record);
    expect(record.accessToken).toBe("original");
    expect(record.refreshToken).toBe("original-refresh");
    expect(redacted.accessToken).toBe("[REDACTED]");
  });

  it("returns a new object", () => {
    const record = {
      authMethod: "oauth_device_pkce" as const,
      accessToken: "tok"
    };
    const redacted = redactOAuthTokenRecord(record);
    expect(redacted).not.toBe(record);
  });
});

describe("redactOAuthStore", () => {
  it("redacts all provider records", () => {
    const store = {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce" as const,
          accessToken: "codex-access",
          refreshToken: "codex-refresh"
        },
        openai: {
          authMethod: "oauth_external" as const,
          accessToken: "openai-access"
        }
      }
    };
    const redacted = redactOAuthStore(store);
    expect(redacted.version).toBe(1);
    expect(redacted.providers.codex.accessToken).toBe("[REDACTED]");
    expect(redacted.providers.codex.refreshToken).toBe("[REDACTED]");
    expect(redacted.providers.openai.accessToken).toBe("[REDACTED]");
    expect(redacted.providers.openai).not.toHaveProperty("refreshToken");
  });

  it("handles empty store", () => {
    const store = { version: 1, providers: {} };
    const redacted = redactOAuthStore(store);
    expect(redacted).toEqual({ version: 1, providers: {} });
  });

  it("does not mutate the original store", () => {
    const store = {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce" as const,
          accessToken: "original"
        }
      }
    };
    const redacted = redactOAuthStore(store);
    expect(store.providers.codex.accessToken).toBe("original");
    expect(redacted.providers.codex.accessToken).toBe("[REDACTED]");
  });

  it("returns a new object for the store", () => {
    const store = { version: 1, providers: {} };
    const redacted = redactOAuthStore(store);
    expect(redacted).not.toBe(store);
    expect(redacted.providers).not.toBe(store.providers);
  });
});
