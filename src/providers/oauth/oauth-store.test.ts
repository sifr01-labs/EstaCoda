import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile, access, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadOAuthStore,
  writeOAuthStore,
  validateOAuthStore,
  defaultOAuthStorePath
} from "./oauth-store.js";
import { CURRENT_OAUTH_STORE_VERSION } from "./oauth-types.js";

describe("defaultOAuthStorePath", () => {
  it("derives path from resolveProfileStateHome", () => {
    const path = defaultOAuthStorePath();
    expect(path).toMatch(/\.estacoda[/\\]profiles[/\\]default[/\\]auth\.json$/u);
  });

  it("accepts explicit homeDir", () => {
    const path = defaultOAuthStorePath("/tmp/fake-home");
    expect(path).toBe("/tmp/fake-home/.estacoda/profiles/default/auth.json");
  });
});

describe("loadOAuthStore missing file", () => {
  it("returns empty store when auth.json does not exist", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "auth.json");
    const result = await loadOAuthStore({ path });
    expect(result.store).toEqual({ version: 1, providers: {} });
    expect(result.diagnostics).toEqual([]);
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns empty store when auth.json is empty", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "auth.json");
    await writeFile(path, "", "utf8");
    const result = await loadOAuthStore({ path });
    expect(result.store).toEqual({ version: 1, providers: {} });
    expect(result.diagnostics).toEqual([]);
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns empty store when auth.json is whitespace only", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "auth.json");
    await writeFile(path, "   \n\n  ", "utf8");
    const result = await loadOAuthStore({ path });
    expect(result.store).toEqual({ version: 1, providers: {} });
    expect(result.diagnostics).toEqual([]);
    await rm(workspace, { recursive: true, force: true });
  });
});

describe("loadOAuthStore malformed top-level", () => {
  it("returns empty store for invalid JSON", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "auth.json");
    await writeFile(path, "not json", "utf8");
    const result = await loadOAuthStore({ path });
    expect(result.store).toEqual({ version: 1, providers: {} });
    expect(result.diagnostics).toContain("auth.json contains invalid JSON; treating as empty store.");
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns empty store for top-level array", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "auth.json");
    await writeFile(path, JSON.stringify([]), "utf8");
    const result = await loadOAuthStore({ path });
    expect(result.store).toEqual({ version: 1, providers: {} });
    expect(result.diagnostics).toContain("auth.json top-level value is not an object; treating as empty store.");
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns empty store for missing version", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "auth.json");
    await writeFile(path, JSON.stringify({ providers: {} }), "utf8");
    const result = await loadOAuthStore({ path });
    expect(result.store).toEqual({ version: 1, providers: {} });
    expect(result.diagnostics).toContain("auth.json is missing version field; treating as empty store.");
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns empty store for unsupported version", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "auth.json");
    await writeFile(path, JSON.stringify({ version: 99, providers: {} }), "utf8");
    const result = await loadOAuthStore({ path });
    expect(result.store).toEqual({ version: 1, providers: {} });
    expect(result.diagnostics).toContain("Unsupported auth store version 99; treating as empty store.");
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns empty store for missing providers field", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "auth.json");
    await writeFile(path, JSON.stringify({ version: 1 }), "utf8");
    const result = await loadOAuthStore({ path });
    expect(result.store).toEqual({ version: 1, providers: {} });
    expect(result.diagnostics).toContain("auth.json providers field is missing or not an object; treating as empty store.");
    await rm(workspace, { recursive: true, force: true });
  });
});

describe("loadOAuthStore malformed provider records", () => {
  it("skips record that is not an object", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "auth.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      providers: {
        codex: "not-an-object",
        openai: { authMethod: "oauth_device_pkce", accessToken: "tok" }
      }
    }), "utf8");
    const result = await loadOAuthStore({ path });
    expect(Object.keys(result.store.providers)).toEqual(["openai"]);
    expect(result.diagnostics).toContain("Malformed auth record for provider codex: not an object.");
    await rm(workspace, { recursive: true, force: true });
  });

  it("skips record missing authMethod", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "auth.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      providers: {
        bad: { accessToken: "tok" },
        good: { authMethod: "oauth_external", accessToken: "tok" }
      }
    }), "utf8");
    const result = await loadOAuthStore({ path });
    expect(Object.keys(result.store.providers)).toEqual(["good"]);
    expect(result.diagnostics).toContain("Malformed auth record for provider bad: missing authMethod.");
    await rm(workspace, { recursive: true, force: true });
  });

  it("skips record missing accessToken", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "auth.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      providers: {
        bad: { authMethod: "oauth_device_pkce" },
        good: { authMethod: "oauth_device_pkce", accessToken: "tok" }
      }
    }), "utf8");
    const result = await loadOAuthStore({ path });
    expect(Object.keys(result.store.providers)).toEqual(["good"]);
    expect(result.diagnostics).toContain("Malformed auth record for provider bad: missing accessToken.");
    await rm(workspace, { recursive: true, force: true });
  });

  it("skips record with non-OAuth authMethod", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "auth.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      providers: {
        apikey: { authMethod: "api_key", accessToken: "tok" },
        none: { authMethod: "none", accessToken: "tok" },
        good: { authMethod: "oauth_device_pkce", accessToken: "tok" }
      }
    }), "utf8");
    const result = await loadOAuthStore({ path });
    expect(Object.keys(result.store.providers)).toEqual(["good"]);
    expect(result.diagnostics).toContain('Malformed auth record for provider apikey: authMethod "api_key" is not an OAuth method.');
    expect(result.diagnostics).toContain('Malformed auth record for provider none: authMethod "none" is not an OAuth method.');
    await rm(workspace, { recursive: true, force: true });
  });

  it("valid neighboring records survive when one is malformed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "auth.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      providers: {
        codex: { authMethod: "oauth_device_pkce", accessToken: "tok1", refreshToken: "ref1", expiresAt: "2026-01-01T00:00:00.000Z", scopes: ["read"], source: "estacoda" },
        bad: { authMethod: "api_key", accessToken: "tok2" },
        external: { authMethod: "oauth_external", accessToken: "tok3" }
      }
    }), "utf8");
    const result = await loadOAuthStore({ path });
    expect(Object.keys(result.store.providers).sort()).toEqual(["codex", "external"]);
    expect(result.store.providers.codex.accessToken).toBe("tok1");
    expect(result.store.providers.codex.refreshToken).toBe("ref1");
    expect(result.store.providers.codex.expiresAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.store.providers.codex.scopes).toEqual(["read"]);
    expect(result.store.providers.codex.source).toBe("estacoda");
    expect(result.diagnostics).toContain('Malformed auth record for provider bad: authMethod "api_key" is not an OAuth method.');
    await rm(workspace, { recursive: true, force: true });
  });
});

describe("writeOAuthStore", () => {
  it("round-trips a valid store", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "auth.json");
    const store = {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce" as const,
          accessToken: "atok",
          refreshToken: "rtok",
          expiresAt: "2026-05-15T12:00:00.000Z",
          scopes: ["read", "write"],
          source: "estacoda"
        }
      }
    };
    const result = await writeOAuthStore(store, { path });
    expect(result.path).toBe(path);

    const loaded = await loadOAuthStore({ path });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.store).toEqual(store);
    await rm(workspace, { recursive: true, force: true });
  });

  it("creates parent directories if missing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "nested", "deep", "auth.json");
    await writeOAuthStore({ version: 1, providers: {} }, { path });
    const loaded = await loadOAuthStore({ path });
    expect(loaded.store).toEqual({ version: 1, providers: {} });
    await rm(workspace, { recursive: true, force: true });
  });

  it("writes with 0600 permissions where supported", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "auth.json");
    await writeOAuthStore({ version: 1, providers: {} }, { path });
    const s = await stat(path);
    const mode = s.mode & 0o777;
    // On Unix the file should be 0o600; on Windows chmod may be a no-op
    // so we only assert when the platform supports it.
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
    await rm(workspace, { recursive: true, force: true });
  });

  it("does not throw if chmod fails", async () => {
    // This is implicitly covered by the write test on all platforms,
    // but we assert the function completes without error even on Windows.
    const workspace = await mkdtemp(join(tmpdir(), "estacoda-oauth-test-"));
    const path = join(workspace, "auth.json");
    await expect(writeOAuthStore({ version: 1, providers: {} }, { path })).resolves.not.toThrow();
    await rm(workspace, { recursive: true, force: true });
  });
});

describe("validateOAuthStore direct", () => {
  it("accepts a fully valid store", () => {
    const data = {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "tok",
          refreshToken: "ref",
          expiresAt: "2026-01-01T00:00:00.000Z",
          scopes: ["read"],
          source: "estacoda"
        }
      }
    };
    const result = validateOAuthStore(data);
    expect(result.diagnostics).toEqual([]);
    expect(result.store.providers.codex.authMethod).toBe("oauth_device_pkce");
    expect(result.store.providers.codex.accessToken).toBe("tok");
    expect(result.store.providers.codex.refreshToken).toBe("ref");
    expect(result.store.providers.codex.expiresAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.store.providers.codex.scopes).toEqual(["read"]);
    expect(result.store.providers.codex.source).toBe("estacoda");
  });

  it("filters non-string scopes", () => {
    const data = {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "tok",
          scopes: ["read", 42, null, "write"]
        }
      }
    };
    const result = validateOAuthStore(data);
    expect(result.store.providers.codex.scopes).toEqual(["read", "write"]);
  });

  it("ignores extra fields on records", () => {
    const data = {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "tok",
          extraField: "should-be-ignored"
        }
      }
    };
    const result = validateOAuthStore(data);
    expect(result.store.providers.codex).not.toHaveProperty("extraField");
    expect(result.diagnostics).toEqual([]);
  });
});
