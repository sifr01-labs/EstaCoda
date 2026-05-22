import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { runCliCommand } from "./cli.js";
import {
  cliVoiceModeStatePath,
  detectCliVoiceRecorder,
  playCliTtsResponse,
  readCliVoiceMode,
  recordAndTranscribeCliVoice
} from "./voice-mode.js";

describe("CLI voice mode", () => {
  it("records audio under profile temp and transcribes it with a mocked recorder", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-cli-voice-"));
    const profilePaths = resolveProfileStateHome({ homeDir, profileId: "default" });
    const config = await loadRuntimeConfig({ workspaceRoot: homeDir, homeDir, profileId: "default" });
    config.stt = {
      ...config.stt,
      provider: "local",
      local: { command: "mock-stt" }
    };
    const recorder = {
      record: vi.fn(async ({ outputPath }: { outputPath: string }) => {
        await writeFile(outputPath, "wav");
        return { ok: true as const };
      })
    };
    const transcriber = vi.fn(async ({ path }: { path: string }) => {
      expect((await readFile(path, "utf8"))).toBe("wav");
      return { ok: true as const, text: "hello from the microphone", model: "mock-stt" };
    });

    const result = await recordAndTranscribeCliVoice({
      config,
      profilePaths,
      recorder,
      transcriber,
      id: () => "turn-1",
      envOptions: {
        platform: "darwin",
        commandExists: async (command) => command === "sox"
      }
    });

    expect(result).toMatchObject({
      ok: true,
      transcript: "hello from the microphone",
      model: "mock-stt"
    });
    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(transcriber).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(resolve(result.audioPath).startsWith(resolve(profilePaths.tempPath))).toBe(true);
      expect(result.audioPath).toContain("/audio/cli-voice/");
      await expect(stat(result.audioPath)).resolves.toMatchObject({ size: 3 });
    }
  });

  it("reports SSH microphone capture as unavailable", async () => {
    const result = await detectCliVoiceRecorder({
      env: { SSH_TTY: "/dev/pts/1" },
      platform: "linux",
      commandExists: async () => true
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("SSH")
    });
  });

  it("skips optional playback cleanly when no local player is available", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-cli-voice-playback-"));
    const profilePaths = resolveProfileStateHome({ homeDir, profileId: "default" });
    const config = await loadRuntimeConfig({ workspaceRoot: homeDir, homeDir, profileId: "default" });

    const result = await playCliTtsResponse({
      text: "hello",
      config,
      profilePaths,
      commandExists: async () => false
    });

    expect(result).toEqual({ ok: true, played: false, reason: "no-local-audio-player" });
  });

  it("parses estacoda voice mode on/off/tts/status and persists profile-local state", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-cli-voice-command-"));
    const workspaceRoot = homeDir;
    const voiceModeEnv = {
      platform: "linux" as const,
      commandExists: async () => false
    };

    const on = await runCliCommand({ argv: ["voice", "mode", "on"], workspaceRoot, homeDir, voiceModeEnv });
    expect(on.exitCode).toBe(0);
    expect(on.output).toContain("CLI voice mode: on.");
    const profilePaths = resolveProfileStateHome({ homeDir, profileId: "default" });
    expect(await readCliVoiceMode(profilePaths)).toBe("on");

    const tts = await runCliCommand({ argv: ["voice", "mode", "tts"], workspaceRoot, homeDir, voiceModeEnv });
    expect(tts.exitCode).toBe(0);
    expect(await readCliVoiceMode(profilePaths)).toBe("tts");

    const status = await runCliCommand({ argv: ["voice", "mode", "status"], workspaceRoot, homeDir, voiceModeEnv });
    expect(status.exitCode).toBe(0);
    expect(status.output).toContain("EstaCoda CLI voice mode");
    expect(status.output).toContain("Mode: tts");
    expect(status.output).toContain(cliVoiceModeStatePath(profilePaths));

    const off = await runCliCommand({ argv: ["voice", "mode", "off"], workspaceRoot, homeDir, voiceModeEnv });
    expect(off.exitCode).toBe(0);
    expect(await readCliVoiceMode(profilePaths)).toBe("off");
  });
});
