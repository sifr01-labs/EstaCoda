import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCodexOAuthTokenRecord,
  CODEX_OAUTH_AUTH_METHOD,
  readCodexOAuthStatus,
} from "./codex-setup.js";

async function withHomeDir(testFn: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "estacoda-codex-setup-helper-test-"));
  try {
    await testFn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writeAuthJson(homeDir: string, providerRecord: unknown): Promise<void> {
  const profileDir = join(homeDir, ".estacoda", "profiles", "default");
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "auth.json"), JSON.stringify({
    version: 1,
    providers: {
      codex: providerRecord,
    },
  }, null, 2) + "\n", "utf8");
}

describe("codex setup helpers", () => {
  it("reports required status without writing auth state", async () => {
    await withHomeDir(async (homeDir) => {
      await expect(readCodexOAuthStatus({ homeDir })).resolves.toEqual({
        providerId: "codex",
        authMethod: CODEX_OAUTH_AUTH_METHOD,
        status: "required",
      });
    });
  });

  it("reports ready status for a valid token without exposing token values", async () => {
    await withHomeDir(async (homeDir) => {
      await writeAuthJson(homeDir, {
        authMethod: CODEX_OAUTH_AUTH_METHOD,
        accessToken: "eyJfake.codex.secret-token",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        source: "estacoda",
      });

      const status = await readCodexOAuthStatus({ homeDir });
      expect(status).toEqual({
        providerId: "codex",
        authMethod: CODEX_OAUTH_AUTH_METHOD,
        status: "ready",
      });
      expect(JSON.stringify(status)).not.toContain("eyJfake.codex.secret-token");
    });
  });

  it("builds sanitized Codex OAuth token records", () => {
    expect(buildCodexOAuthTokenRecord({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-01-01T00:00:00.000Z",
      scopes: ["read"],
    })).toEqual({
      authMethod: CODEX_OAUTH_AUTH_METHOD,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-01-01T00:00:00.000Z",
      scopes: ["read"],
      source: "estacoda",
    });
  });
});
