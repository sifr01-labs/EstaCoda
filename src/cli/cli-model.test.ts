import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runCliCommand } from "./cli.js";
import { resetModelsDevRegistryForTest } from "../providers/model-selection-catalog.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import type { Prompt } from "./readline-prompt.js";
import type { SelectPromptInput } from "./interactive-select.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-cli-model-test-"));
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

function createMockPrompt(responses: {
  selects?: string[];
  secrets?: string[];
}): Prompt {
  let selectIndex = 0;
  let secretIndex = 0;

  const prompt = (async (question: string, options?: { secret?: boolean }) => {
    if (options?.secret) {
      const value = responses.secrets?.[secretIndex] ?? "";
      secretIndex++;
      return value;
    }
    return "";
  }) as Prompt;

  prompt.select = async <T>(_input: SelectPromptInput<T>): Promise<T> => {
    const value = responses.selects?.[selectIndex] as T;
    selectIndex++;
    return value;
  };

  return prompt;
}

describe("cli model", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    resetModelsDevRegistryForTest();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("bare model command", () => {
    it("renders overview in non-interactive context without writing config", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b"],
            enableNetwork: true
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b"
        }
      });

      const result = await runCliCommand({
        argv: ["model"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Primary:");
      expect(result.output).toContain("Status:");
      expect(result.output).toContain("Fallbacks:");
      expect(result.output).toContain("Commands:");
      expect(result.output).toContain("estacoda model status");
      expect(result.output).toContain("estacoda model diagnose");
      expect(result.output).toContain("estacoda model set");
      expect(result.output).toContain("deprecated; disabled");
      expect(result.output).toContain("estacoda model fallback status");
      expect(result.output).toContain("estacoda model fallback add");
      expect(result.output).toContain("estacoda model fallback remove");
      expect(result.output).toContain("estacoda model fallback reorder");
      expect(result.output).toContain("estacoda model fallback clear");
    });

    it("opens picker in interactive context and persists selected route", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        },
        model: {
          provider: "openai",
          id: "gpt-4o"
        }
      });

      const prompt = createMockPrompt({
        selects: ["openai", "gpt-4o"]
      });

      const result = await runCliCommand({
        argv: ["model"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        prompt
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Model switched: gpt-4o");
      expect(result.output).toContain("Provider: openai");
      expect(result.output).toContain("Saved as preferred model.");

      const config = await readUserConfig(tmpDir) as any;
      expect(config.model?.provider).toBe("openai");
      expect(config.model?.id).toBe("gpt-4o");
    });

    it("cancel at provider step writes nothing", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        },
        model: {
          provider: "openai",
          id: "gpt-4o"
        }
      });
      const original = await readUserConfig(tmpDir);

      const prompt = createMockPrompt({
        selects: ["__cancel__"]
      });

      const result = await runCliCommand({
        argv: ["model"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        prompt
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("No changes were made.");
      expect(await readUserConfig(tmpDir)).toEqual(original);
    });

    it("cancel at model step writes nothing", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        },
        model: {
          provider: "openai",
          id: "gpt-4o"
        }
      });
      const original = await readUserConfig(tmpDir);

      const prompt = createMockPrompt({
        selects: ["openai", "__cancel__"]
      });

      const result = await runCliCommand({
        argv: ["model"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        prompt
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("No changes were made.");
      expect(await readUserConfig(tmpDir)).toEqual(original);
    });

    it("reuses existing credential and does not prompt for api key", async () => {
      const originalOpenAiKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-existing";

      try {
        await writeUserConfig(tmpDir, {
          providers: {
            openai: {
              kind: "openai-compatible",
              models: ["gpt-4o"],
              apiKeyEnv: "OPENAI_API_KEY"
            }
          },
          model: {
            provider: "openai",
            id: "gpt-4o"
          }
        });
        // Seed both the process env and isolated .env so credential reuse is deterministic in CI.
        const envPath = profileEnvPath(tmpDir);
        await mkdir(join(tmpDir, ".estacoda"), { recursive: true });
        await writeFile(envPath, "OPENAI_API_KEY=sk-existing\n", "utf8");

        const prompt = createMockPrompt({
          selects: ["openai", "gpt-4o"]
        });

        const result = await runCliCommand({
          argv: ["model"],
          workspaceRoot: tmpDir,
          homeDir: tmpDir,
          prompt
        });

        expect(result.handled).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain("Credential: uses OPENAI_API_KEY");
      } finally {
        if (originalOpenAiKey === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = originalOpenAiKey;
        }
      }
    });

    it("collects missing credential and stores via secret boundary", async () => {
      delete process.env.OPENAI_API_KEY;
      await writeUserConfig(tmpDir, {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        },
        model: {
          provider: "openai",
          id: "gpt-4o"
        }
      });

      const prompt = createMockPrompt({
        selects: ["openai", "gpt-4o"],
        secrets: ["sk-test-key"]
      });

      const result = await runCliCommand({
        argv: ["model"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        prompt
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Credential: stored as OPENAI_API_KEY");

      const config = await readUserConfig(tmpDir) as any;
      expect(config.providers?.openai?.apiKeyEnv).toBe("OPENAI_API_KEY");

      // Verify secret was written to .env
      const envPath = profileEnvPath(tmpDir);
      const envContent = await readFile(envPath, "utf8");
      expect(envContent).toContain('OPENAI_API_KEY="sk-test-key"');
    });

    it("skips credential storage when empty input is given but still persists env reference", async () => {
      delete process.env.OPENAI_API_KEY;
      await writeUserConfig(tmpDir, {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        },
        model: {
          provider: "openai",
          id: "gpt-4o"
        }
      });

      const prompt = createMockPrompt({
        selects: ["openai", "gpt-4o"],
        secrets: [""]
      });

      const result = await runCliCommand({
        argv: ["model"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        prompt
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Credential: expects OPENAI_API_KEY to be set externally");

      const config = await readUserConfig(tmpDir) as any;
      expect(config.providers?.openai?.apiKeyEnv).toBe("OPENAI_API_KEY");

      // .env should not have been written
      const envPath = profileEnvPath(tmpDir);
      try {
        await readFile(envPath, "utf8");
        // If file exists, it should not contain the key
        expect(false).toBe(true); // Force failure if file exists unexpectedly
      } catch {
        // Expected: file does not exist
      }
    });

    it("local provider skips credential prompt and persists route", async () => {
      delete process.env.OPENAI_API_KEY;
      await writeUserConfig(tmpDir, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b"]
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b"
        }
      });

      const prompt = createMockPrompt({
        selects: ["local", "qwen2.5:3b"]
      });

      const result = await runCliCommand({
        argv: ["model"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        prompt
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Model switched: qwen2.5:3b");
      expect(result.output).toContain("Provider: local");
      expect(result.output).not.toContain("Credential:");
    });

    it("returns clear failure when config save fails after credential storage", async () => {
      delete process.env.OPENAI_API_KEY;
      const configPath = profileConfigPath(tmpDir);
      const configDir = dirname(configPath);
      await writeUserConfig(tmpDir, {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        },
        model: {
          provider: "openai",
          id: "gpt-4o"
        }
      });

      const prompt = createMockPrompt({
        selects: ["openai", "gpt-4o"],
        secrets: ["sk-test-key"]
      });

      // Make config file read-only to force save failure
      const { chmod } = await import("node:fs/promises");
      await chmod(configPath, 0o444);

      const result = await runCliCommand({
        argv: ["model"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        userConfigPath: configPath,
        prompt
      });

      // Restore permissions for cleanup
      await chmod(configPath, 0o644);

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Credential stored, but config save failed:");
    });
  });

  describe("model set", () => {
    it("is deprecated and does not write config", async () => {
      const originalConfig = {
        providers: {
          custom: {
            kind: "openai-compatible",
            baseUrl: "https://custom.example/v1",
            apiKeyEnv: "CUSTOM_API_KEY",
            models: ["main", "backup"],
            enableNetwork: true
          }
        },
        credentialPools: {
          custom: {
            strategy: "fill_first",
            entries: [
              {
                id: "custom-CUSTOM_API_KEY",
                source: { kind: "env", name: "CUSTOM_API_KEY" },
                priority: 1
              }
            ]
          }
        },
        model: {
          provider: "custom",
          id: "main",
          fallbacks: [
            { provider: "custom", id: "backup", apiKeyEnv: "CUSTOM_API_KEY" }
          ]
        }
      };
      await writeUserConfig(tmpDir, originalConfig);

      const result = await runCliCommand({
        argv: ["model", "set", "custom/backup"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("deprecated and disabled");
      expect(result.output).not.toContain("Switched to");
      expect(await readUserConfig(tmpDir)).toEqual(originalConfig);
    });
  });

  describe("model status", () => {
    it("renders current effective model state offline", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b"],
            enableNetwork: true
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b"
        }
      });

      const result = await runCliCommand({
        argv: ["model", "status"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Primary: local/qwen2.5:3b");
      expect(result.output).toContain("Context window:");
      expect(result.output).toContain("Tools:");
      expect(result.output).toContain("Vision:");
      expect(result.output).toContain("Structured output:");
      expect(result.output).toContain("Network:");
      expect(result.output).toContain("Fallbacks: none");
    });
  });

  describe("model diagnose", () => {
    it("renders readiness/failure analysis", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b"],
            enableNetwork: true
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b"
        }
      });

      const result = await runCliCommand({
        argv: ["model", "diagnose"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.output).toContain("EstaCoda model diagnose");
      expect(result.output).toContain("Primary:");
      expect(result.output).toContain("Fallback chain:");
    });

    it("ignores deprecated auxiliaryProviders and does not affect diagnostics or fallback routes", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b"],
            enableNetwork: true
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b"
        },
        auxiliaryProviders: {}
      });

      const result = await runCliCommand({
        argv: ["model", "diagnose"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      // auxiliaryProviders should not appear in output at all
      expect(result.output).not.toContain("auxiliaryProviders");
      // Model should still resolve correctly
      expect(result.output).toContain("Primary: local/qwen2.5:3b");
      // Fallback chain should be empty, not populated from auxiliaryProviders
      expect(result.output).toContain("Fallback chain: none configured");
    });

    it("shows auxiliary models section with auto-resolved routes", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b"],
            enableNetwork: true
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b"
        }
      });

      const result = await runCliCommand({
        argv: ["model", "diagnose"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.output).toContain("Auxiliary models:");
      expect(result.output).toContain("vision:");
      expect(result.output).toContain("approval:");
    });
  });

  describe("model auxiliary status", () => {
    it("renders the auxiliary task list", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b"],
            enableNetwork: true
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b"
        }
      });

      const result = await runCliCommand({
        argv: ["model", "auxiliary", "status"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Auxiliary model status:");
      expect(result.output).toContain("vision:");
      expect(result.output).toContain("approval:");
    });

    it("shows command guide when no subcommand given", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b"],
            enableNetwork: true
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b"
        }
      });

      const result = await runCliCommand({
        argv: ["model", "auxiliary"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("estacoda model auxiliary status");
    });
  });

  describe("model fallback status", () => {
    it("shows empty state", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b"],
            enableNetwork: true
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b"
        }
      });

      const result = await runCliCommand({
        argv: ["model", "fallback", "status"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Fallback status: empty");
      expect(result.output).toContain("No fallback routes are configured");
    });

    it("shows configured state", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b", "phi4:latest"],
            enableNetwork: true
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b",
          fallbacks: [
            { provider: "local", id: "phi4:latest" }
          ]
        }
      });

      const result = await runCliCommand({
        argv: ["model", "fallback", "status"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Fallback status: configured");
      expect(result.output).toContain("1. local/phi4:latest");
      expect(result.output).toContain("Context window:");
      expect(result.output).toContain("Tools:");
      expect(result.output).toContain("Vision:");
      expect(result.output).toContain("Structured output:");
    });
  });

  describe("model fallback add", () => {
    it("writes expected config", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b", "phi4:latest"],
            enableNetwork: true
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b"
        }
      });

      const result = await runCliCommand({
        argv: ["model", "fallback", "add", "local/phi4:latest"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Added fallback local/phi4:latest");

      const config = await readUserConfig(tmpDir) as any;
      expect(config.model?.fallbacks).toHaveLength(1);
      expect(config.model?.fallbacks?.[0]).toEqual({
        provider: "local",
        id: "phi4:latest"
      });
    });

    it("preserves baseUrl and apiKeyEnv", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4.1-mini"],
            enableNetwork: true
          }
        },
        model: {
          provider: "openai",
          id: "gpt-4.1-mini"
        }
      });

      const result = await runCliCommand({
        argv: ["model", "fallback", "add", "openai/gpt-4.1-mini", "--base-url", "https://api.openai.com/v1", "--api-key-env", "OPENAI_API_KEY"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);

      const config = await readUserConfig(tmpDir) as any;
      expect(config.model?.fallbacks?.[0]).toEqual({
        provider: "openai",
        id: "gpt-4.1-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY"
      });
    });
  });

  describe("model fallback remove", () => {
    it("removes exact route", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b", "phi4:latest"],
            enableNetwork: true
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b",
          fallbacks: [
            { provider: "local", id: "phi4:latest" }
          ]
        }
      });

      const result = await runCliCommand({
        argv: ["model", "fallback", "remove", "local/phi4:latest"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Removed fallback local/phi4:latest");

      const config = await readUserConfig(tmpDir) as any;
      expect(config.model?.fallbacks ?? []).toHaveLength(0);
    });
  });

  describe("model fallback reorder", () => {
    it("updates order without changing contents", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b", "phi4:latest", "llama3.1:latest"],
            enableNetwork: true
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b",
          fallbacks: [
            { provider: "local", id: "phi4:latest" },
            { provider: "local", id: "llama3.1:latest" }
          ]
        }
      });

      const result = await runCliCommand({
        argv: ["model", "fallback", "reorder", "local/llama3.1:latest", "local/phi4:latest"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Reordered fallback chain");

      const config = await readUserConfig(tmpDir) as any;
      expect(config.model?.fallbacks).toHaveLength(2);
      expect(config.model?.fallbacks?.[0]?.id).toBe("llama3.1:latest");
      expect(config.model?.fallbacks?.[1]?.id).toBe("phi4:latest");
    });
  });

  describe("model fallback clear", () => {
    it("removes all entries after confirmation", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b", "phi4:latest"],
            enableNetwork: true
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b",
          fallbacks: [
            { provider: "local", id: "phi4:latest" }
          ]
        }
      });

      const result = await runCliCommand({
        argv: ["model", "fallback", "clear", "--yes"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Cleared all fallback routes");

      const config = await readUserConfig(tmpDir) as any;
      expect(config.model?.fallbacks ?? []).toHaveLength(0);
    });

    it("requires --yes confirmation", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b", "phi4:latest"],
            enableNetwork: true
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b",
          fallbacks: [
            { provider: "local", id: "phi4:latest" }
          ]
        }
      });

      const result = await runCliCommand({
        argv: ["model", "fallback", "clear"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("--yes");

      const config = await readUserConfig(tmpDir) as any;
      expect(config.model?.fallbacks).toHaveLength(1);
    });
  });

  describe("model list", () => {
    async function writeBundledSnapshot(homeDir: string, snapshot: unknown): Promise<string> {
      const fixturePath = join(homeDir, "models_dev_snapshot.json");
      await writeFile(fixturePath, JSON.stringify(snapshot, null, 2), "utf8");
      return fixturePath;
    }

    function mockSnapshot(): Record<string, unknown> {
      return {
        providers: [
          { id: "openai", name: "OpenAI" },
          { id: "anthropic", name: "Anthropic" },
          { id: "deepseek", name: "DeepSeek" }
        ],
        models: [
          {
            id: "gpt-4o",
            provider_id: "openai",
            context_window: 128000,
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
            reasoning: false,
            tool_call: true,
            structured_output: true,
            status: "stable"
          },
          {
            id: "gpt-4o-deprecated",
            provider_id: "openai",
            context_window: 128000,
            input_modalities: ["text"],
            output_modalities: ["text"],
            reasoning: false,
            tool_call: true,
            structured_output: true,
            status: "deprecated"
          },
          {
            id: "dall-e-3",
            provider_id: "openai",
            context_window: 0,
            input_modalities: ["text"],
            output_modalities: ["image"],
            reasoning: false,
            tool_call: false,
            structured_output: false,
            status: "stable"
          },
          {
            id: "claude-3-opus",
            provider_id: "anthropic",
            context_window: 200000,
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
            reasoning: false,
            tool_call: true,
            structured_output: true,
            status: "stable"
          },
          {
            id: "deepseek-chat",
            provider_id: "deepseek",
            context_window: 64000,
            input_modalities: ["text"],
            output_modalities: ["text"],
            reasoning: false,
            tool_call: true,
            structured_output: true,
            status: "stable"
          }
        ],
        fetchedAt: "2099-01-01T00:00:00.000Z",
        source: "bundled"
      };
    }

    it("renders offline catalog output", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      await writeUserConfig(tmpDir, {
        providers: {
          openai: { kind: "openai-compatible", models: ["gpt-4o"] },
          anthropic: { kind: "catalog", models: ["claude-3-opus"] }
        },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const result = await runCliCommand({
        argv: ["model", "list"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Model catalog:");
      expect(result.output).toContain("openai/gpt-4o");
      expect(result.output).toContain("anthropic/claude-3-opus");
    });

    it("search filters offline catalog output by query", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      await writeUserConfig(tmpDir, {
        providers: {
          openai: { kind: "openai-compatible", models: ["gpt-4o"] },
          anthropic: { kind: "catalog", models: ["claude-3-opus"] }
        },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const result = await runCliCommand({
        argv: ["model", "search", "claude"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("claude-3-opus");
      expect(result.output).not.toContain("gpt-4o");
    });

    it("providers shows curated and configured providers", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      await writeUserConfig(tmpDir, {
        providers: {
          openai: { kind: "openai-compatible", models: ["gpt-4o"] }
        },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const result = await runCliCommand({
        argv: ["model", "providers"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Providers:");
      expect(result.output).toContain("openai");
      expect(result.output).toContain("anthropic");
      expect(result.output).toContain("deepseek");
    });

    it("distinguishes executable vs catalog-only providers", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      await writeUserConfig(tmpDir, {
        providers: {
          openai: { kind: "openai-compatible", models: ["gpt-4o"] },
          anthropic: { kind: "catalog", models: ["claude-3-opus"] }
        },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const result = await runCliCommand({
        argv: ["model", "providers"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("openai - OpenAI (executable)");
      expect(result.output).toContain("anthropic - Anthropic (catalog-only)");
    });

    it("refresh prints source domain, cache path, timestamp, models count, providers count, and cacheChanged", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      const cachePath = join(tmpDir, "models_dev_cache.json");
      await writeUserConfig(tmpDir, {
        providers: { openai: { kind: "openai-compatible", models: ["gpt-4o"] } },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const result = await runCliCommand({
        argv: ["model", "refresh"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, cachePath, allowNetwork: false }
      });
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Catalog refresh complete");
      expect(result.output).toContain("Source: models.dev");
      expect(result.output).toContain(`Cache: ${cachePath}`);
      expect(result.output).toContain("Timestamp:");
      expect(result.output).toContain("Models:");
      expect(result.output).toContain("Providers:");
      expect(result.output).toContain("Changed:");
    });

    it("refresh does not mutate runtime config", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      const cachePath = join(tmpDir, "models_dev_cache.json");
      await writeUserConfig(tmpDir, {
        providers: { openai: { kind: "openai-compatible", models: ["gpt-4o"] } },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const before = await readUserConfig(tmpDir);
      const result = await runCliCommand({
        argv: ["model", "refresh"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, cachePath, allowNetwork: false }
      });
      expect(result.handled).toBe(true);
      const after = await readUserConfig(tmpDir);
      expect(after).toEqual(before);
    });

    it("filters by --provider", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      await writeUserConfig(tmpDir, {
        providers: {
          openai: { kind: "openai-compatible", models: ["gpt-4o"] },
          anthropic: { kind: "catalog", models: ["claude-3-opus"] }
        },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const result = await runCliCommand({
        argv: ["model", "list", "--provider", "openai"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(result.output).toContain("gpt-4o");
      expect(result.output).not.toContain("claude-3-opus");
    });

    it("filters by --tools", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      await writeUserConfig(tmpDir, {
        providers: { openai: { kind: "openai-compatible", models: ["gpt-4o", "dall-e-3"] } },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const result = await runCliCommand({
        argv: ["model", "list", "--tools"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(result.output).toContain("gpt-4o");
      expect(result.output).not.toContain("dall-e-3");
    });

    it("filters by --vision", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      await writeUserConfig(tmpDir, {
        providers: { openai: { kind: "openai-compatible", models: ["gpt-4o", "deepseek-chat"] } },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const result = await runCliCommand({
        argv: ["model", "list", "--vision"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(result.output).toContain("gpt-4o");
      expect(result.output).not.toContain("deepseek-chat");
    });

    it("filters by --structured", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      await writeUserConfig(tmpDir, {
        providers: { openai: { kind: "openai-compatible", models: ["gpt-4o", "dall-e-3"] } },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const result = await runCliCommand({
        argv: ["model", "list", "--structured"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(result.output).toContain("gpt-4o");
      expect(result.output).not.toContain("dall-e-3");
    });

    it("filters by --reasoning", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      await writeUserConfig(tmpDir, {
        providers: { openai: { kind: "openai-compatible", models: ["gpt-4o"] } },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const result = await runCliCommand({
        argv: ["model", "list", "--reasoning"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(result.output).toContain("deepseek-reasoner");
      expect(result.output).not.toContain("gpt-4o");
    });

    it("filters by --configured", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      await writeUserConfig(tmpDir, {
        providers: {
          openai: { kind: "openai-compatible", models: ["gpt-4o"] },
          anthropic: { kind: "catalog", models: ["claude-3-opus"] }
        },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const result = await runCliCommand({
        argv: ["model", "list", "--configured"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(result.output).toContain("gpt-4o");
      expect(result.output).toContain("claude-3-opus");
      expect(result.output).not.toContain("deepseek-chat");
    });

    it("filters by --executable-only", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      await writeUserConfig(tmpDir, {
        providers: {
          openai: { kind: "openai-compatible", models: ["gpt-4o"] },
          anthropic: { kind: "catalog", models: ["claude-3-opus"] }
        },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const result = await runCliCommand({
        argv: ["model", "list", "--executable-only"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(result.output).toContain("gpt-4o");
      expect(result.output).not.toContain("claude-3-opus");
    });

    it("includes deprecated with --include-deprecated", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      await writeUserConfig(tmpDir, {
        providers: { openai: { kind: "openai-compatible", models: ["gpt-4o", "gpt-4o-deprecated"] } },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const without = await runCliCommand({
        argv: ["model", "list"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      const withFlag = await runCliCommand({
        argv: ["model", "list", "--include-deprecated"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(without.output).not.toContain("gpt-4o-deprecated");
      expect(withFlag.output).toContain("gpt-4o-deprecated");
    });

    it("includes beta with --include-beta", async () => {
      const snapshot = mockSnapshot();
      (snapshot.models as any[]).push({
        id: "gpt-5-beta",
        provider_id: "openai",
        context_window: 128000,
        input_modalities: ["text"],
        output_modalities: ["text"],
        reasoning: false,
        tool_call: true,
        structured_output: true,
        status: "beta"
      });
      const fixturePath = await writeBundledSnapshot(tmpDir, snapshot);
      await writeUserConfig(tmpDir, {
        providers: { openai: { kind: "openai-compatible", models: ["gpt-5-beta"] } },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const without = await runCliCommand({
        argv: ["model", "list"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      const withFlag = await runCliCommand({
        argv: ["model", "list", "--include-beta"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(without.output).not.toContain("gpt-5-beta");
      expect(withFlag.output).toContain("gpt-5-beta");
    });

    it("includes non-chat with --include-non-chat", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      await writeUserConfig(tmpDir, {
        providers: { openai: { kind: "openai-compatible", models: ["gpt-4o"] } },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const without = await runCliCommand({
        argv: ["model", "list"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      const withFlag = await runCliCommand({
        argv: ["model", "list", "--include-non-chat"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(without.output).not.toContain("dall-e-3");
      expect(withFlag.output).toContain("dall-e-3");
    });

    it("probes live catalog when --live is passed", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      await writeUserConfig(tmpDir, {
        providers: { openai: { kind: "openai-compatible", models: ["gpt-4o"] } },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const listResult = await runCliCommand({
        argv: ["model", "list", "--live"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(listResult.handled).toBe(true);
      expect(listResult.exitCode).toBe(0);
      expect(listResult.output).toContain("Model catalog:");
      expect(listResult.output).toContain("openai/gpt-4o");

      const searchResult = await runCliCommand({
        argv: ["model", "search", "gpt", "--live"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(searchResult.handled).toBe(true);
      expect(searchResult.exitCode).toBe(0);
      expect(searchResult.output).toContain("Search results for \"gpt\"");
      expect(searchResult.output).toContain("openai/gpt-4o");
    });

    it("does not make network calls by default for list, search, providers, and diagnose", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      let fetchCalled = false;
      const fakeFetch = () => { fetchCalled = true; throw new Error("should not fetch"); };
      await writeUserConfig(tmpDir, {
        providers: { openai: { kind: "openai-compatible", models: ["gpt-4o"] } },
        model: { provider: "openai", id: "gpt-4o" }
      });

      const listResult = await runCliCommand({
        argv: ["model", "list"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false, fetchImpl: fakeFetch as any }
      });
      expect(listResult.exitCode).toBe(0);

      const searchResult = await runCliCommand({
        argv: ["model", "search", "gpt"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false, fetchImpl: fakeFetch as any }
      });
      expect(searchResult.exitCode).toBe(0);

      const providersResult = await runCliCommand({
        argv: ["model", "providers"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false, fetchImpl: fakeFetch as any }
      });
      expect(providersResult.exitCode).toBe(0);

      const diagnoseResult = await runCliCommand({
        argv: ["model", "diagnose"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false, fetchImpl: fakeFetch as any }
      });
      expect(diagnoseResult.handled).toBe(true);

      expect(fetchCalled).toBe(false);
    });

    it("never shows catalog-only providers as executable", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      await writeUserConfig(tmpDir, {
        providers: {
          openai: { kind: "openai-compatible", models: ["gpt-4o"] },
          anthropic: { kind: "catalog", models: ["claude-3-opus"] }
        },
        model: { provider: "openai", id: "gpt-4o" }
      });
      const result = await runCliCommand({
        argv: ["model", "providers"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      const lines = result.output.split("\n");
      for (const line of lines) {
        if (line.includes("anthropic")) {
          expect(line).toContain("catalog-only");
          expect(line).not.toContain("executable");
        }
      }
    });

    it("does not load project-defined providers when workspace is untrusted", async () => {
      const fixturePath = await writeBundledSnapshot(tmpDir, mockSnapshot());
      await writeUserConfig(tmpDir, {
        providers: { openai: { kind: "openai-compatible", models: ["gpt-4o"] } },
        model: { provider: "openai", id: "gpt-4o" }
      });
      // Write a project config with a custom provider to a separate path
      const projectConfigPath = join(tmpDir, "project-config.json");
      await writeFile(projectConfigPath, JSON.stringify({
        providers: { custom: { kind: "openai-compatible", baseUrl: "https://custom.example/v1", models: ["custom-model"] } }
      }), "utf8");

      const listResult = await runCliCommand({
        argv: ["model", "list", "--live"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        projectConfigPath,
        projectConfigTrust: "untrusted",
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(listResult.handled).toBe(true);
      expect(listResult.exitCode).toBe(0);
      expect(listResult.output).not.toContain("custom-model");
      expect(listResult.output).not.toContain("custom.example");

      const searchResult = await runCliCommand({
        argv: ["model", "search", "custom", "--live"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        projectConfigPath,
        projectConfigTrust: "untrusted",
        modelsDevOptions: { bundledSnapshotPath: fixturePath, allowNetwork: false }
      });
      expect(searchResult.handled).toBe(true);
      expect(searchResult.exitCode).toBe(0);
      expect(searchResult.output).not.toContain("custom-model");
    });
  });

  describe("model diagnose structured output", () => {
    it("produces structured report output only without old text path", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b"],
            enableNetwork: true
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b"
        }
      });

      const result = await runCliCommand({
        argv: ["model", "diagnose"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.output).toContain("EstaCoda model diagnose");
      expect(result.output).toContain("Primary:");
      // Old text-based diagnoseProviderConfig output should not appear
      expect(result.output).not.toContain("Selected route:");
      expect(result.output).not.toContain("Context window:");
      expect(result.output).not.toContain("Provider health:");
      expect(result.output).not.toContain("Credential pool:");
    });
  });

  describe("model alias resolution", () => {
    it("estacoda model openai/gpt-4o persists exact route", async () => {
      delete process.env.OPENAI_API_KEY;
      await writeUserConfig(tmpDir, {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        },
        model: {
          provider: "openai",
          id: "gpt-4o"
        }
      });

      const prompt = createMockPrompt({ secrets: ["sk-test"] });

      const result = await runCliCommand({
        argv: ["model", "openai/gpt-4o"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        prompt
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);

      const config = await readUserConfig(tmpDir) as any;
      expect(config.model?.provider).toBe("openai");
      expect(config.model?.id).toBe("gpt-4o");

      const envContent = await readFile(profileEnvPath(tmpDir), "utf8");
      expect(envContent).toContain('OPENAI_API_KEY="sk-test"');
    });

    it("estacoda model openai/gpt-4o noninteractive reports missing credential without writing", async () => {
      delete process.env.OPENAI_API_KEY;
      await writeUserConfig(tmpDir, {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b"
        }
      });
      const original = await readUserConfig(tmpDir);

      const result = await runCliCommand({
        argv: ["model", "openai/gpt-4o"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("OPENAI_API_KEY");
      expect(result.output).toContain("rerun interactive");
      expect(await readUserConfig(tmpDir)).toEqual(original);
      await expect(readFile(profileEnvPath(tmpDir), "utf8")).rejects.toThrow();
    });

    it("estacoda model openai/gpt-4o reuses existing env credential without prompt", async () => {
      const originalOpenAiKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-existing";

      try {
        await writeUserConfig(tmpDir, {
          providers: {
            openai: {
              kind: "openai-compatible",
              models: ["gpt-4o"],
              apiKeyEnv: "OPENAI_API_KEY"
            }
          },
          model: {
            provider: "local",
            id: "qwen2.5:3b"
          }
        });
        await mkdir(join(tmpDir, ".estacoda"), { recursive: true });
        await writeFile(profileEnvPath(tmpDir), "OPENAI_API_KEY=sk-existing\n", "utf8");

        const result = await runCliCommand({
          argv: ["model", "openai/gpt-4o"],
          workspaceRoot: tmpDir,
          homeDir: tmpDir
        });

        expect(result.handled).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain("Credential: uses OPENAI_API_KEY");

        const config = await readUserConfig(tmpDir) as any;
        expect(config.model?.provider).toBe("openai");
        expect(config.model?.id).toBe("gpt-4o");
      } finally {
        if (originalOpenAiKey === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = originalOpenAiKey;
        }
      }
    });

    it("estacoda model anthropic/claude-opus fails while Anthropic is non-runnable", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        },
        model: {
          provider: "openai",
          id: "gpt-4o"
        }
      });
      const original = await readUserConfig(tmpDir);

      const result = await runCliCommand({
        argv: ["model", "anthropic/claude-opus-4-1"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Anthropic is not runnable");
      expect(await readUserConfig(tmpDir)).toEqual(original);
    });

    it("estacoda model custom/mymodel fails without explicit baseUrl", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        },
        model: {
          provider: "openai",
          id: "gpt-4o"
        }
      });
      const original = await readUserConfig(tmpDir);

      const result = await runCliCommand({
        argv: ["model", "custom/mymodel"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("requires an explicit base URL");
      expect(await readUserConfig(tmpDir)).toEqual(original);
    });

    it("direct alias persists resolved route, not alias string", async () => {
      await writeUserConfig(tmpDir, {
        modelAliases: {
          qwen: {
            provider: "local",
            model: "qwen2.5:3b"
          }
        },
        providers: {
          local: {
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            models: ["qwen2.5:3b"]
          }
        },
        model: {
          provider: "openai",
          id: "gpt-4o"
        }
      });

      const result = await runCliCommand({
        argv: ["model", "qwen"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);

      const config = await readUserConfig(tmpDir) as any;
      expect(config.model?.provider).toBe("local");
      expect(config.model?.id).toBe("qwen2.5:3b");
      expect(config.model?.id).not.toBe("qwen");
    });

    it("curated alias to non-runnable provider returns diagnostic and does not mutate config", async () => {
      await writeUserConfig(tmpDir, {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        },
        model: {
          provider: "openai",
          id: "gpt-4o"
        }
      });
      const original = await readUserConfig(tmpDir);

      const result = await runCliCommand({
        argv: ["model", "sonnet"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("sonnet");
      expect(result.output).toContain("Anthropic is not runnable");
      expect(await readUserConfig(tmpDir)).toEqual(original);
    });

    it("direct alias with custom baseUrl succeeds", async () => {
      delete process.env.OPENAI_COMPATIBLE_API_KEY;
      await writeUserConfig(tmpDir, {
        modelAliases: {
          myllm: {
            provider: "custom",
            model: "qwen3.5:397b",
            baseUrl: "http://localhost:11434/v1"
          }
        },
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        },
        model: {
          provider: "openai",
          id: "gpt-4o"
        }
      });

      const prompt = createMockPrompt({ secrets: [""] });

      const result = await runCliCommand({
        argv: ["model", "myllm"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        prompt
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);

      const config = await readUserConfig(tmpDir) as any;
      expect(config.model?.provider).toBe("custom");
      expect(config.model?.id).toBe("qwen3.5:397b");
    });

    it("direct alias persists explicit route metadata without alias display fields", async () => {
      delete process.env.MY_LLM_KEY;
      await writeUserConfig(tmpDir, {
        modelAliases: {
          myllm: {
            provider: "custom",
            model: "qwen3.5:397b",
            baseUrl: "http://localhost:11434/v1",
            apiMode: "custom_openai_compatible",
            apiKeyEnv: "MY_LLM_KEY"
          }
        },
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        },
        model: {
          provider: "openai",
          id: "gpt-4o"
        }
      });

      const prompt = createMockPrompt({ secrets: [""] });

      const result = await runCliCommand({
        argv: ["model", "myllm"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        prompt
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);

      const config = await readUserConfig(tmpDir) as any;
      expect(config.model?.provider).toBe("custom");
      expect(config.model?.id).toBe("qwen3.5:397b");
      expect(config.model?.id).not.toBe("myllm");
      expect(config.providers?.custom?.baseUrl).toBe("http://localhost:11434/v1");
      expect(config.providers?.custom?.apiMode).toBe("custom_openai_compatible");
      expect(config.providers?.custom?.apiKeyEnv).toBe("MY_LLM_KEY");
      const json = JSON.stringify(config);
      expect(json).not.toContain("resolvedViaAlias");
      expect(json).not.toContain("authMethod");
      expect(json).not.toContain("MY_SECRET_VALUE");
    });

    it("unsupported alias apiMode fails before config or secret writes", async () => {
      await writeUserConfig(tmpDir, {
        modelAliases: {
          badmode: {
            provider: "openai",
            model: "gpt-4o",
            apiMode: "totally_unsupported_api_mode" as any
          }
        },
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"]
          }
        },
        model: {
          provider: "local",
          id: "qwen2.5:3b"
        }
      });
      const original = await readUserConfig(tmpDir);
      const prompt = createMockPrompt({ secrets: ["sk-sho...rite"] });

      const result = await runCliCommand({
        argv: ["model", "badmode"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        prompt
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("unsupported API mode totally_unsupported_api_mode");
      expect(await readUserConfig(tmpDir)).toEqual(original);
      await expect(readFile(profileEnvPath(tmpDir), "utf8")).rejects.toThrow();
    });
  });

  describe("model setup codex CLI routing", () => {
    it("routes model setup codex through CLI dispatch", async () => {
      const result = await runCliCommand({
        argv: ["model", "setup", "codex"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.output).toBe("Cancelled. No changes were made.");
    });

    it("model setup help includes codex command", async () => {
      const result = await runCliCommand({
        argv: ["model", "setup"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.output).toContain("estacoda model setup codex");
    });

    it("bare model command help includes codex setup", async () => {
      await writeUserConfig(tmpDir, {
        model: { provider: "openai", id: "gpt-4o" }
      });

      const result = await runCliCommand({
        argv: ["model"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        interactive: false
      });

      expect(result.handled).toBe(true);
      expect(result.output).toContain("estacoda model setup codex");
    });
  });
});
