import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runCliCommand } from "./cli.js";
import { resolveProfileStateHome } from "../config/profile-home.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-media-secret-test-"));
}

async function writeProfileConfig(homeDir: string, config: unknown): Promise<void> {
  const configPath = resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config));
}

async function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) {
    previous.set(key, process.env[key]);
    const value = updates[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("media capability setup does not render raw secrets", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("image setup with --api-key writes .env and outputs only safe path references", async () => {
    const rawKey = "sk-image-gen-secret-8888";
    const result = await runCliCommand({
      argv: ["image", "setup", "--provider", "fal", "--api-key", rawKey],
      workspaceRoot: tempDir,
      homeDir: tempDir,
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain(rawKey);
    expect(result.output).toContain("Secret store:");
    expect(result.output).toContain(".estacoda");
    expect(result.output).toContain("FAL_KEY");
  });

  it("voice setup with --tts-api-key writes .env and outputs only safe path references", async () => {
    const rawKey = "sk-tts-secret-7777";
    const result = await runCliCommand({
      argv: ["voice", "setup", "--tts-provider", "openai", "--tts-api-key", rawKey],
      workspaceRoot: tempDir,
      homeDir: tempDir,
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain(rawKey);
    expect(result.output).toContain("Secret store:");
    expect(result.output).toContain(".estacoda");
    expect(result.output).toContain("VOICE_TOOLS_OPENAI_KEY");
  });

  it("voice setup with --stt-api-key writes .env and outputs only safe path references", async () => {
    const rawKey = "sk-stt-secret-6666";
    const result = await runCliCommand({
      argv: ["voice", "setup", "--stt-provider", "groq", "--stt-api-key", rawKey],
      workspaceRoot: tempDir,
      homeDir: tempDir,
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain(rawKey);
    expect(result.output).toContain("Secret store:");
    expect(result.output).toContain(".estacoda");
    expect(result.output).toContain("GROQ_API_KEY");
  });

  it("voice setup/status supports xAI STT without exposing raw secrets", async () => {
    const rawKey = "xai-stt-secret-5555";
    const setup = await runCliCommand({
      argv: ["voice", "setup", "--stt-provider", "xai", "--stt-api-key", rawKey],
      workspaceRoot: tempDir,
      homeDir: tempDir,
    });
    expect(setup.exitCode).toBe(0);
    expect(setup.output).not.toContain(rawKey);
    expect(setup.output).toContain("XAI_API_KEY");

    await withEnv({ XAI_API_KEY: "present" }, async () => {
      const status = await runCliCommand({
        argv: ["voice", "status"],
        workspaceRoot: tempDir,
        homeDir: tempDir,
      });
      expect(status.output).toContain("STT provider: xai");
      expect(status.output).toContain("STT readiness: ready");
      expect(status.output).toContain("STT API key: XAI_API_KEY");
    });
  });

  it("voice status reports provider readiness", async () => {
    await withEnv({ VOICE_TOOLS_OPENAI_KEY: undefined, OPENAI_API_KEY: undefined, ESTACODA_LOCAL_STT_COMMAND: undefined }, async () => {
      const result = await runCliCommand({
        argv: ["voice", "status"],
        workspaceRoot: tempDir,
        homeDir: tempDir,
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("TTS provider: openai");
      expect(result.output).toContain("TTS readiness: not ready (Missing VOICE_TOOLS_OPENAI_KEY or OPENAI_API_KEY)");
      expect(result.output).toContain("STT readiness: ready");
      expect(result.output).toContain("Auto-TTS replies: disabled");
    });
  });

  it("voice status and settings show managed faster-whisper local STT", async () => {
    await writeProfileConfig(tempDir, {
      stt: {
        provider: "local",
        local: {
          engine: "faster-whisper",
          fasterWhisper: {
            enabled: true,
            model: "small"
          }
        }
      }
    });

    const status = await runCliCommand({
      argv: ["voice", "status"],
      workspaceRoot: tempDir,
      homeDir: tempDir,
    });
    expect(status.output).toContain("STT: local faster-whisper, model small");
    expect(status.output).toContain("STT Python: managed: EstaCoda Python environment");
    expect(status.output).toContain("STT model: small");

    const settings = await runCliCommand({
      argv: ["settings"],
      workspaceRoot: tempDir,
      homeDir: tempDir,
    });
    expect(settings.output).toContain("STT local faster-whisper, model small");
    expect(settings.output).toContain("Voice STT Python: managed: EstaCoda Python environment");
  });

  it("voice status shows custom Python for local faster-whisper", async () => {
    await writeProfileConfig(tempDir, {
      stt: {
        provider: "local",
        local: {
          engine: "faster-whisper",
          pythonBinary: "/x/python",
          fasterWhisper: {
            enabled: true,
            model: "base"
          }
        }
      }
    });

    const status = await runCliCommand({
      argv: ["voice", "status"],
      workspaceRoot: tempDir,
      homeDir: tempDir,
    });

    expect(status.output).toContain("STT: local faster-whisper, model base");
    expect(status.output).toContain("STT Python: custom: /x/python");
  });

  it("voice status does not describe command-mode or cloud STT as managed faster-whisper", async () => {
    await writeProfileConfig(tempDir, {
      stt: {
        provider: "local",
        local: {
          engine: "command",
          command: "mock-stt",
          model: "command-model"
        }
      }
    });

    const commandStatus = await runCliCommand({
      argv: ["voice", "status"],
      workspaceRoot: tempDir,
      homeDir: tempDir,
    });
    expect(commandStatus.output).toContain("STT: local command, model command-model");
    expect(commandStatus.output).not.toContain("STT: local faster-whisper");
    expect(commandStatus.output).not.toContain("STT Python: managed");

    await writeProfileConfig(tempDir, {
      stt: {
        provider: "openai",
        openai: {
          apiKeyEnv: "VOICE_TOOLS_OPENAI_KEY"
        }
      }
    });

    const cloudStatus = await runCliCommand({
      argv: ["voice", "status"],
      workspaceRoot: tempDir,
      homeDir: tempDir,
    });
    expect(cloudStatus.output).toContain("STT: openai, model whisper-1");
    expect(cloudStatus.output).not.toContain("STT Python:");
    expect(cloudStatus.output).not.toContain("managed: EstaCoda Python environment");
  });
});
