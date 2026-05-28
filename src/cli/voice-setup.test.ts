import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { runCliCommand, type CliOptions } from "./cli.js";

const pythonEnvMock = vi.hoisted(() => ({
  checkManagedEnvironment: vi.fn(),
  createManagedEnvironment: vi.fn()
}));

vi.mock("../python-env/manager.js", () => ({
  checkManagedEnvironment: pythonEnvMock.checkManagedEnvironment,
  createManagedEnvironment: pythonEnvMock.createManagedEnvironment
}));

function profileConfigPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
}

async function writeProfileConfig(homeDir: string, config: unknown): Promise<void> {
  const path = profileConfigPath(homeDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config));
}

async function readProfileConfig(homeDir: string): Promise<any> {
  return JSON.parse(await readFile(profileConfigPath(homeDir), "utf8"));
}

async function runVoiceSetup(homeDir: string, argv: string[], overrides: Partial<CliOptions> = {}) {
  return await runCliCommand({
    argv: ["voice", "setup", ...argv],
    workspaceRoot: homeDir,
    homeDir,
    interactive: false,
    ...overrides
  });
}

describe("voice setup managed local STT", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "estacoda-voice-setup-"));
    await mkdir(join(homeDir, ".estacoda"), { recursive: true });
    pythonEnvMock.checkManagedEnvironment.mockReset();
    pythonEnvMock.createManagedEnvironment.mockReset();
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("rejects missing values for python and voice setup flags", async () => {
    await expect(runVoiceSetup(homeDir, ["--python-binary"])).rejects.toThrow("Missing value for --python-binary");
    await expect(runVoiceSetup(homeDir, ["--stt-provider", "--tts-provider", "openai"])).rejects.toThrow("Missing value for --stt-provider");
  });

  it("keeps TTS-only setup from patching STT or touching the managed environment", async () => {
    await writeProfileConfig(homeDir, {
      stt: {
        provider: "local",
        local: {
          engine: "command",
          command: "existing-stt-command"
        }
      }
    });

    const result = await runVoiceSetup(homeDir, ["--tts-provider", "edge"]);

    expect(result.exitCode).toBe(0);
    expect(pythonEnvMock.checkManagedEnvironment).not.toHaveBeenCalled();
    expect(pythonEnvMock.createManagedEnvironment).not.toHaveBeenCalled();
    expect((await readProfileConfig(homeDir)).stt).toEqual({
      provider: "local",
      local: {
        engine: "command",
        command: "existing-stt-command"
      }
    });
  });

  it("uses an already-ready managed Python environment without reinstalling", async () => {
    pythonEnvMock.checkManagedEnvironment.mockResolvedValue({
      kind: "ready",
      pythonBinary: "/state/python-env/bin/python"
    });

    const result = await runVoiceSetup(homeDir, ["--stt-provider", "local", "--stt-model", "small"]);

    expect(result.exitCode).toBe(0);
    expect(pythonEnvMock.checkManagedEnvironment).toHaveBeenCalledTimes(1);
    expect(pythonEnvMock.createManagedEnvironment).not.toHaveBeenCalled();
    expect((await readProfileConfig(homeDir)).stt.local).toMatchObject({
      model: "small",
      engine: "faster-whisper",
      pythonBinary: "/state/python-env/bin/python",
      fasterWhisper: {
        enabled: true,
        model: "small",
        allowModelDownload: true
      }
    });
  });

  it("creates a missing managed Python environment and writes the returned binary", async () => {
    pythonEnvMock.checkManagedEnvironment.mockResolvedValue({ kind: "missing" });
    pythonEnvMock.createManagedEnvironment.mockImplementation(async (_options, onProgress) => {
      onProgress?.("Creating managed Python environment...");
      onProgress?.("Installing faster-whisper==1.2.1...");
      onProgress?.("Managed Python environment ready.");
      return { ok: true, pythonBinary: "/state/python-env/bin/python" };
    });

    const result = await runVoiceSetup(homeDir, ["--stt-provider", "local"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Local STT setup will create EstaCoda's managed Python environment");
    expect(result.output).toContain("Installing faster-whisper==1.2.1...");
    expect(result.output).not.toContain("Collecting faster-whisper");
    expect((await readProfileConfig(homeDir)).stt.local.pythonBinary).toBe("/state/python-env/bin/python");
  });

  it("attempts creation for a corrupted managed Python environment", async () => {
    pythonEnvMock.checkManagedEnvironment.mockResolvedValue({ kind: "corrupted", reason: "import failed" });
    pythonEnvMock.createManagedEnvironment.mockResolvedValue({ ok: true, pythonBinary: "/state/python-env/bin/python" });

    const result = await runVoiceSetup(homeDir, ["--stt-provider", "local"]);

    expect(result.exitCode).toBe(0);
    expect(pythonEnvMock.createManagedEnvironment).toHaveBeenCalledTimes(1);
    expect((await readProfileConfig(homeDir)).stt.local.pythonBinary).toBe("/state/python-env/bin/python");
  });

  it("does not write local STT config when managed environment creation fails", async () => {
    await writeProfileConfig(homeDir, {});
    pythonEnvMock.checkManagedEnvironment.mockResolvedValue({ kind: "missing" });
    pythonEnvMock.createManagedEnvironment.mockResolvedValue({ ok: false, reason: "pip unavailable" });

    const result = await runVoiceSetup(homeDir, ["--stt-provider", "local"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Failed to set up local STT: pip unavailable");
    expect((await readProfileConfig(homeDir)).stt).toBeUndefined();
  });

  it("skips managed environment checks when a custom Python binary is provided", async () => {
    const result = await runVoiceSetup(homeDir, [
      "--stt-provider",
      "local",
      "--python-binary",
      "/x/python"
    ]);

    expect(result.exitCode).toBe(0);
    expect(pythonEnvMock.checkManagedEnvironment).not.toHaveBeenCalled();
    expect(pythonEnvMock.createManagedEnvironment).not.toHaveBeenCalled();
    expect((await readProfileConfig(homeDir)).stt.local.pythonBinary).toBe("/x/python");
  });

  it("prompts in interactive setup using the prompt function before creating the env", async () => {
    pythonEnvMock.checkManagedEnvironment.mockResolvedValue({ kind: "missing" });
    pythonEnvMock.createManagedEnvironment.mockResolvedValue({ ok: true, pythonBinary: "/state/python-env/bin/python" });
    const prompt = vi.fn(async () => "");

    const result = await runVoiceSetup(homeDir, ["--stt-provider", "local"], {
      interactive: true,
      prompt: Object.assign(prompt, { close: vi.fn() })
    });

    expect(result.exitCode).toBe(0);
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("Continue? [Y/n] "));
    expect(pythonEnvMock.createManagedEnvironment).toHaveBeenCalledTimes(1);
  });
});
