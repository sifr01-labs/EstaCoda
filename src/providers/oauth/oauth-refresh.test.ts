import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { refreshOAuthToken, shouldRefreshToken, type FetchLike } from "./oauth-refresh.js";
import { resolveProfileStateHome } from "../../config/profile-home.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-oauth-refresh-test-"));
}

async function writeAuthJson(homeDir: string, store: unknown): Promise<void> {
  const path = profileAuthPath(homeDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}

async function readAuthJson(homeDir: string): Promise<unknown> {
  const path = profileAuthPath(homeDir);
  const content = await readFile(path, "utf8");
  return JSON.parse(content);
}

function profileAuthPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).authJsonPath;
}

function createMockFetch(
  result: () => { ok: boolean; status: number; statusText: string; json: unknown }
): FetchLike {
  return async (_url: string, _init: { method: string; headers: Record<string, string>; body: string }) => {
    const r = result();
    return {
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      json: async () => r.json
    };
  };
}

describe("refreshOAuthToken", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns success and updates auth.json on valid refresh", async () => {
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: "2026-01-01T00:00:00.000Z",
          source: "estacoda"
        }
      }
    });

    const fetchLike = createMockFetch(() => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600
      }
    }));

    const result = await refreshOAuthToken({
      providerId: "codex",
      record: {
        authMethod: "oauth_device_pkce",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: "2026-01-01T00:00:00.000Z",
        source: "estacoda"
      },
      fetchLike,
      homeDir: tmpDir
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.accessToken).toBe("new-access-token");
      expect(result.refreshToken).toBe("new-refresh-token");
      expect(result.expiresAt).toBeDefined();
    }

    const auth = await readAuthJson(tmpDir) as any;
    expect(auth.providers.codex.accessToken).toBe("new-access-token");
    expect(auth.providers.codex.refreshToken).toBe("new-refresh-token");
  });

  it("preserves existing refresh token when server omits new one", async () => {
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "old-access",
          refreshToken: "preserved-refresh",
          source: "estacoda"
        }
      }
    });

    const fetchLike = createMockFetch(() => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: {
        access_token: "new-access-token",
        expires_in: 3600
      }
    }));

    const result = await refreshOAuthToken({
      providerId: "codex",
      record: {
        authMethod: "oauth_device_pkce",
        accessToken: "old-access",
        refreshToken: "preserved-refresh",
        source: "estacoda"
      },
      fetchLike,
      homeDir: tmpDir
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.refreshToken).toBe("preserved-refresh");
    }

    const auth = await readAuthJson(tmpDir) as any;
    expect(auth.providers.codex.refreshToken).toBe("preserved-refresh");
  });

  it("returns error with needsReauthentication=true on invalid_grant", async () => {
    const fetchLike = createMockFetch(() => ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: { error: "invalid_grant", error_description: "The refresh token is invalid." }
    }));

    const result = await refreshOAuthToken({
      providerId: "codex",
      record: {
        authMethod: "oauth_device_pkce",
        accessToken: "old-access",
        refreshToken: "bad-refresh",
        source: "estacoda"
      },
      fetchLike,
      homeDir: tmpDir
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.needsReauthentication).toBe(true);
      expect(result.reason).toContain("The refresh token is invalid");
    }
  });

  it("returns error with needsReauthentication=false on network failure", async () => {
    const fetchLike: FetchLike = async () => {
      throw new Error("Connection refused");
    };

    const result = await refreshOAuthToken({
      providerId: "codex",
      record: {
        authMethod: "oauth_device_pkce",
        accessToken: "old-access",
        refreshToken: "valid-refresh",
        source: "estacoda"
      },
      fetchLike,
      homeDir: tmpDir
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.needsReauthentication).toBe(false);
      expect(result.reason).toContain("Connection refused");
    }
  });

  it("returns error when record lacks refreshToken", async () => {
    const result = await refreshOAuthToken({
      providerId: "codex",
      record: {
        authMethod: "oauth_device_pkce",
        accessToken: "old-access",
        source: "estacoda"
      },
      homeDir: tmpDir
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.needsReauthentication).toBe(true);
      expect(result.reason).toContain("missing a refresh token");
    }
  });

  it("does not mutate auth.json on refresh failure", async () => {
    await writeAuthJson(tmpDir, {
      version: 1,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "old-access",
          refreshToken: "old-refresh",
          source: "estacoda"
        }
      }
    });

    const fetchLike = createMockFetch(() => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: { error: "server_error" }
    }));

    const result = await refreshOAuthToken({
      providerId: "codex",
      record: {
        authMethod: "oauth_device_pkce",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        source: "estacoda"
      },
      fetchLike,
      homeDir: tmpDir
    });

    expect(result.kind).toBe("error");

    const auth = await readAuthJson(tmpDir) as any;
    expect(auth.providers.codex.accessToken).toBe("old-access");
    expect(auth.providers.codex.refreshToken).toBe("old-refresh");
  });

  it("redacts token values from error output", async () => {
    const fetchLike = createMockFetch(() => ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: { error: "invalid_request" }
    }));

    const result = await refreshOAuthToken({
      providerId: "codex",
      record: {
        authMethod: "oauth_device_pkce",
        accessToken: "eyJfake.codex.token.12345",
        refreshToken: "def502.fake.refresh.token.67890",
        source: "estacoda"
      },
      fetchLike,
      homeDir: tmpDir
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).not.toContain("eyJfake.codex.token.12345");
      expect(result.reason).not.toContain("def502.fake.refresh.token.67890");
      expect(result.reason).not.toContain("Bearer");
    }
  });
});

describe("shouldRefreshToken", () => {
  it("returns false when no expiry is set", () => {
    expect(shouldRefreshToken({})).toBe(false);
  });

  it("returns false when expiry is far in the future", () => {
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    expect(shouldRefreshToken({ expiresAt: future })).toBe(false);
  });

  it("returns true when expiry is in the past", () => {
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    expect(shouldRefreshToken({ expiresAt: past })).toBe(true);
  });

  it("returns true when expiry is within default skew (120s)", () => {
    const soon = new Date(Date.now() + 60 * 1000).toISOString();
    expect(shouldRefreshToken({ expiresAt: soon })).toBe(true);
  });

  it("returns false when expiry is beyond custom skew", () => {
    const soon = new Date(Date.now() + 60 * 1000).toISOString();
    expect(shouldRefreshToken({ expiresAt: soon }, 30)).toBe(false);
    const further = new Date(Date.now() + 90 * 1000).toISOString();
    expect(shouldRefreshToken({ expiresAt: further }, 30)).toBe(false);
  });
});
