import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCliCommand } from "./cli.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-media-secret-test-"));
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
    await withEnv({ VOICE_TOOLS_OPENAI_KEY: undefined, OPENAI_API_KEY: undefined, HERMES_LOCAL_STT_COMMAND: undefined }, async () => {
      const result = await runCliCommand({
        argv: ["voice", "status"],
        workspaceRoot: tempDir,
        homeDir: tempDir,
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("TTS provider: openai");
      expect(result.output).toContain("TTS readiness: not ready (Missing VOICE_TOOLS_OPENAI_KEY or OPENAI_API_KEY)");
      expect(result.output).toContain("STT readiness: not ready (Local STT command not configured)");
      expect(result.output).toContain("Auto-TTS replies: disabled");
    });
  });
});
