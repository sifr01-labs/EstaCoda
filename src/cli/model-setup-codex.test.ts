import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runModelSetupCodex, type ModelSetupCodexOptions } from "./model-setup-codex.js";
import type { Prompt } from "./readline-prompt.js";
import type { FetchLike } from "../providers/oauth/codex-oauth.js";
import { loadOAuthStore } from "../providers/oauth/oauth-store.js";
import { resolveProfileStateHome } from "../config/profile-home.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-codex-setup-test-"));
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

function profileConfigPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
}

function profileAuthPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).authJsonPath;
}

function createMockPrompt(responses: string[]): Prompt {
  let index = 0;
  const prompt = async (_question: string, _options?: { secret?: boolean }) => {
    const value = responses[index] ?? "";
    index++;
    return value;
  };
  prompt.select = async <T>(_input: any): Promise<T> => {
    throw new Error("select not used in these tests");
  };
  return prompt as Prompt;
}

function createMockFetch(scenarios: {
  authorize?: () => { ok: boolean; status: number; statusText: string; json: unknown };
  tokenPolls?: Array<() => { ok: boolean; status: number; statusText: string; json: unknown }>;
}): FetchLike {
  let authorizeCalled = false;
  let pollIndex = 0;

  return async (url: string, _init: { method: string; headers: Record<string, string>; body: string }) => {
    if (url.includes("/authorize")) {
      authorizeCalled = true;
      const result = scenarios.authorize?.() ?? { ok: true, status: 200, statusText: "OK", json: {} };
      return {
        ok: result.ok,
        status: result.status,
        statusText: result.statusText,
        json: async () => result.json
      };
    }

    if (url.includes("/token")) {
      const polls = scenarios.tokenPolls ?? [];
      const result = polls[pollIndex]?.() ?? { ok: false, status: 404, statusText: "Not Found", json: {} };
      pollIndex++;
      return {
        ok: result.ok,
        status: result.status,
        statusText: result.statusText,
        json: async () => result.json
      };
    }

    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({})
    };
  };
}

describe("model setup codex", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function baseOptions(overrides?: Partial<ModelSetupCodexOptions>): ModelSetupCodexOptions {
    return {
      homeDir: tmpDir,
      workspaceRoot: tmpDir,
      ...overrides
    } as ModelSetupCodexOptions;
  }

  describe("new authentication", () => {
    it("completes device flow and writes auth.json + config.json", async () => {
      const fetchLike = createMockFetch({
        authorize: () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: {
            device_code: "dev-123",
            user_code: "ABC-DEF",
            verification_uri: "https://auth.openai.com/verify",
            expires_in: 60,
            interval: 1
          }
        }),
        tokenPolls: [
          () => ({ ok: false, status: 403, statusText: "Forbidden", json: {} }),
          () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: {
              access_token: "eyJfake.codex.token.12345",
              refresh_token: "def502.fake.refresh.token.67890",
              expires_in: 3600
            }
          })
        ]
      });

      const result = await runModelSetupCodex(baseOptions({
        prompt: createMockPrompt(["1"]), // "Sign in with device code"
        fetchLike
      }));

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Codex route configured");
      expect(result.output).toContain("Provider: codex");

      // Verify auth.json
      const auth = await readAuthJson(tmpDir) as any;
      expect(auth.version).toBe(1);
      expect(auth.providers.codex.accessToken).toBe("eyJfake.codex.token.12345");
      expect(auth.providers.codex.refreshToken).toBe("def502.fake.refresh.token.67890");
      expect(auth.providers.codex.authMethod).toBe("oauth_device_pkce");
      expect(auth.providers.codex.source).toBe("estacoda");

      // Verify config.json
      const config = await readUserConfig(tmpDir) as any;
      expect(config.model.provider).toBe("codex");
      expect(config.model.id).toBe("o3");
      expect(config.providers.codex.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
      expect(config.providers.codex.authMethod).toBe("oauth_device_pkce");
    });

    it("cancellation prints exactly the required message and exit code 0", async () => {
      const fetchLike = createMockFetch({
        authorize: () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: {
            device_code: "dev-123",
            user_code: "ABC-DEF",
            verification_uri: "https://auth.openai.com/verify",
            expires_in: 60,
            interval: 1
          }
        }),
        tokenPolls: [
          () => ({ ok: false, status: 403, statusText: "Forbidden", json: {} })
        ]
      });

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);

      const result = await runModelSetupCodex(baseOptions({
        prompt: createMockPrompt(["1"]),
        fetchLike,
        signal: controller.signal
      }));

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("Cancelled. No changes were made.");

      // Verify auth.json was NOT written
      const authPath = profileAuthPath(tmpDir);
      const authExists = await readFile(authPath, "utf8").then(() => true).catch(() => false);
      expect(authExists).toBe(false);
    });

    it("cancel at initial prompt prints cancellation message", async () => {
      const result = await runModelSetupCodex(baseOptions({
        prompt: createMockPrompt(["2"]) // "Cancel"
      }));

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("Cancelled. No changes were made.");
    });

    it("empty/invalid choice at prompt is treated as cancel", async () => {
      const result = await runModelSetupCodex(baseOptions({
        prompt: createMockPrompt(["invalid"])
      }));

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("Cancelled. No changes were made.");
    });

    it("timeout during polling returns exit code 1 with timed out message", async () => {
      const fetchLike = createMockFetch({
        authorize: () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: {
            device_code: "dev-123",
            user_code: "ABC-DEF",
            verification_uri: "https://auth.openai.com/verify",
            expires_in: 0, // immediate timeout
            interval: 0
          }
        })
        // No token polls: timeout happens before first poll
      });

      const result = await runModelSetupCodex(baseOptions({
        prompt: createMockPrompt(["1"]),
        fetchLike
      }));

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Authentication timed out");
    });

    it("writes auth.json with 0600 permissions through existing store behavior", async () => {
      const fetchLike = createMockFetch({
        authorize: () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: {
            device_code: "dev-123",
            user_code: "ABC-DEF",
            verification_uri: "https://auth.openai.com/verify",
            expires_in: 60,
            interval: 1
          }
        }),
        tokenPolls: [
          () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: {
              access_token: "eyJfake.codex.token.12345",
              expires_in: 3600
            }
          })
        ]
      });

      await runModelSetupCodex(baseOptions({
        prompt: createMockPrompt(["1"]),
        fetchLike
      }));

      const authPath = profileAuthPath(tmpDir);
      if (process.platform !== "win32") {
        const s = await stat(authPath);
        const mode = s.mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });
  });

  describe("existing credentials", () => {
    it("use-existing configures route without reauthenticating", async () => {
      await writeAuthJson(tmpDir, {
        version: 1,
        providers: {
          codex: {
            authMethod: "oauth_device_pkce",
            accessToken: "eyJfake.codex.token.12345",
            refreshToken: "def502.fake.refresh.token.67890",
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            scopes: ["read"],
            source: "estacoda"
          }
        }
      });

      const result = await runModelSetupCodex(baseOptions({
        prompt: createMockPrompt(["1"]) // "Use existing credentials"
      }));

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Using existing Codex credentials");
      expect(result.output).toContain("Codex route configured");

      // Verify config.json was written
      const config = await readUserConfig(tmpDir) as any;
      expect(config.model.provider).toBe("codex");
      expect(config.model.id).toBe("o3");
      expect(config.providers.codex.authMethod).toBe("oauth_device_pkce");

      // Verify auth.json was NOT overwritten (still has original tokens)
      const auth = await readAuthJson(tmpDir) as any;
      expect(auth.providers.codex.accessToken).toBe("eyJfake.codex.token.12345");
    });

    it("reauthenticate overwrites existing tokens", async () => {
      await writeAuthJson(tmpDir, {
        version: 1,
        providers: {
          codex: {
            authMethod: "oauth_device_pkce",
            accessToken: "old-token",
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            source: "estacoda"
          }
        }
      });

      const fetchLike = createMockFetch({
        authorize: () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: {
            device_code: "dev-123",
            user_code: "ABC-DEF",
            verification_uri: "https://auth.openai.com/verify",
            expires_in: 60,
            interval: 1
          }
        }),
        tokenPolls: [
          () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: {
              access_token: "new-token-12345",
              expires_in: 3600
            }
          })
        ]
      });

      const result = await runModelSetupCodex(baseOptions({
        prompt: createMockPrompt(["2"]), // "Reauthenticate"
        fetchLike
      }));

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);

      const auth = await readAuthJson(tmpDir) as any;
      expect(auth.providers.codex.accessToken).toBe("new-token-12345");
    });

    it("cancel with existing credentials prints cancellation", async () => {
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

      const result = await runModelSetupCodex(baseOptions({
        prompt: createMockPrompt(["3"]) // "Cancel"
      }));

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("Cancelled. No changes were made.");

      // Config should not be written
      const configPath = profileConfigPath(tmpDir);
      const configExists = await readFile(configPath, "utf8").then(() => true).catch(() => false);
      expect(configExists).toBe(false);
    });
  });

  describe("partial-write recovery", () => {
    it("preserves auth.json and exits non-zero when config write fails", async () => {
      // Write a config.json that is a directory (so writing to it fails)
      const configDir = profileConfigPath(tmpDir);
      await mkdir(join(tmpDir, ".estacoda"), { recursive: true });
      await mkdir(configDir, { recursive: true });

      const fetchLike = createMockFetch({
        authorize: () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: {
            device_code: "dev-123",
            user_code: "ABC-DEF",
            verification_uri: "https://auth.openai.com/verify",
            expires_in: 60,
            interval: 1
          }
        }),
        tokenPolls: [
          () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: {
              access_token: "eyJfake.codex.token.12345",
              expires_in: 3600
            }
          })
        ]
      });

      const result = await runModelSetupCodex(baseOptions({
        prompt: createMockPrompt(["1"]),
        fetchLike
      }));

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Codex authentication succeeded, but route configuration failed");

      // auth.json should still be written and preserved
      const auth = await readAuthJson(tmpDir) as any;
      expect(auth.providers.codex.accessToken).toBe("eyJfake.codex.token.12345");
    });

    it("rerun via valid-existing-credentials path recovers by configuring route", async () => {
      // Step 1: auth.json exists, config write fails
      const configDir = profileConfigPath(tmpDir);
      await mkdir(join(tmpDir, ".estacoda"), { recursive: true });
      await mkdir(configDir, { recursive: true });

      const fetchLike = createMockFetch({
        authorize: () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: {
            device_code: "dev-123",
            user_code: "ABC-DEF",
            verification_uri: "https://auth.openai.com/verify",
            expires_in: 60,
            interval: 1
          }
        }),
        tokenPolls: [
          () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: {
              access_token: "eyJfake.codex.token.12345",
              expires_in: 3600
            }
          })
        ]
      });

      const failResult = await runModelSetupCodex(baseOptions({
        prompt: createMockPrompt(["1"]),
        fetchLike
      }));
      expect(failResult.exitCode).toBe(1);

      // Step 2: Remove the directory obstruction
      await rm(configDir, { recursive: true, force: true });

      // Step 3: Rerun with "use existing credentials"
      const recoverResult = await runModelSetupCodex(baseOptions({
        prompt: createMockPrompt(["1"]) // "Use existing credentials"
      }));

      expect(recoverResult.handled).toBe(true);
      expect(recoverResult.exitCode).toBe(0);
      expect(recoverResult.output).toContain("Using existing Codex credentials");

      // Config should now exist
      const config = await readUserConfig(tmpDir) as any;
      expect(config.model.provider).toBe("codex");
      expect(config.model.id).toBe("o3");
    });
  });

  describe("redaction", () => {
    it("CLI output never contains raw token values", async () => {
      const fetchLike = createMockFetch({
        authorize: () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: {
            device_code: "dev-123",
            user_code: "ABC-DEF",
            verification_uri: "https://auth.openai.com/verify",
            expires_in: 60,
            interval: 1
          }
        }),
        tokenPolls: [
          () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: {
              access_token: "eyJfake.codex.token.12345",
              refresh_token: "def502.fake.refresh.token.67890",
              expires_in: 3600
            }
          })
        ]
      });

      const result = await runModelSetupCodex(baseOptions({
        prompt: createMockPrompt(["1"]),
        fetchLike
      }));

      expect(result.output).not.toContain("eyJfake.codex.token.12345");
      expect(result.output).not.toContain("def502.fake.refresh.token.67890");
      expect(result.output).not.toContain("accessToken");
      expect(result.output).not.toContain("refreshToken");
      expect(result.output).not.toContain("Bearer");
    });

    it("config.json never contains token values", async () => {
      const fetchLike = createMockFetch({
        authorize: () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: {
            device_code: "dev-123",
            user_code: "ABC-DEF",
            verification_uri: "https://auth.openai.com/verify",
            expires_in: 60,
            interval: 1
          }
        }),
        tokenPolls: [
          () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: {
              access_token: "eyJfake.codex.token.12345",
              refresh_token: "def502.fake.refresh.token.67890",
              expires_in: 3600
            }
          })
        ]
      });

      await runModelSetupCodex(baseOptions({
        prompt: createMockPrompt(["1"]),
        fetchLike
      }));

      const configRaw = await readFile(profileConfigPath(tmpDir), "utf8");
      expect(configRaw).not.toContain("eyJfake.codex.token.12345");
      expect(configRaw).not.toContain("def502.fake.refresh.token.67890");
      expect(configRaw).not.toContain("accessToken");
      expect(configRaw).not.toContain("refreshToken");
    });

    it("diagnostics and error output never contain token substrings", async () => {
      const fetchLike = createMockFetch({
        authorize: () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: {
            device_code: "dev-123",
            user_code: "ABC-DEF",
            verification_uri: "https://auth.openai.com/verify",
            expires_in: 60,
            interval: 1
          }
        }),
        tokenPolls: [
          () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: {
              access_token: "eyJfake.codex.token.12345",
              expires_in: 3600
            }
          })
        ]
      });

      // Force config write to fail
      const configDir = profileConfigPath(tmpDir);
      await mkdir(configDir, { recursive: true });

      const result = await runModelSetupCodex(baseOptions({
        prompt: createMockPrompt(["1"]),
        fetchLike
      }));

      expect(result.exitCode).toBe(1);
      expect(result.output).not.toContain("eyJfake.codex.token.12345");
      expect(result.output).not.toContain("def502");
      expect(result.output).not.toContain("Bearer");
      expect(result.output).not.toContain("accessToken");
      expect(result.output).not.toContain("refreshToken");
    });
  });

  describe("expired credentials", () => {
    it("treats expired credentials as missing and prompts for sign-in", async () => {
      await writeAuthJson(tmpDir, {
        version: 1,
        providers: {
          codex: {
            authMethod: "oauth_device_pkce",
            accessToken: "eyJfake.codex.token.12345",
            expiresAt: new Date(Date.now() - 3600 * 1000).toISOString(), // expired
            source: "estacoda"
          }
        }
      });

      const fetchLike = createMockFetch({
        authorize: () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: {
            device_code: "dev-123",
            user_code: "ABC-DEF",
            verification_uri: "https://auth.openai.com/verify",
            expires_in: 60,
            interval: 1
          }
        }),
        tokenPolls: [
          () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: {
              access_token: "new-token",
              expires_in: 3600
            }
          })
        ]
      });

      const result = await runModelSetupCodex(baseOptions({
        prompt: createMockPrompt(["1"]), // "Sign in with device code" (because expired)
        fetchLike
      }));

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);

      const auth = await readAuthJson(tmpDir) as any;
      expect(auth.providers.codex.accessToken).toBe("new-token");
    });
  });
});
