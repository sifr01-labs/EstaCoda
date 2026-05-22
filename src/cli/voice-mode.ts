import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { ProfileStatePaths } from "../config/profile-home.js";
import {
  checkSttProviderStatus,
  checkTtsProviderStatus,
  synthesizeSpeechToEphemeralArtifact,
  transcribeAudioFile,
  type VoiceFetchLike
} from "../tools/voice-tools.js";

export type CliVoiceMode = "off" | "on" | "tts";

export type CliVoiceModeState = {
  mode: CliVoiceMode;
};

export type CliRecorderSelection =
  | {
      ok: true;
      kind: "termux" | "sox" | "arecord" | "rec";
      command: string;
      args(outputPath: string, durationSeconds: number): string[];
    }
  | { ok: false; reason: string };

export type CliVoiceEnvironmentOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  commandExists?: (command: string) => Promise<boolean>;
  probeCommand?: (command: string, args: readonly string[]) => Promise<boolean>;
};

export type CliVoiceRecorder = {
  record(input: {
    outputPath: string;
    durationSeconds: number;
    selection: Extract<CliRecorderSelection, { ok: true }>;
    signal?: AbortSignal;
  }): Promise<{ ok: true } | { ok: false; content: string }>;
};

export type CliVoiceTranscriber = (input: {
  path: string;
  config: LoadedRuntimeConfig;
  profilePaths: ProfileStatePaths;
  signal?: AbortSignal;
}) => Promise<{ ok: true; text: string; model?: string; language?: string } | { ok: false; content: string }>;

export type CliVoiceCaptureResult =
  | { ok: true; transcript: string; audioPath: string; model?: string; language?: string }
  | { ok: false; content: string; metadata?: Record<string, unknown> };

export type CliVoicePlaybackResult =
  | { ok: true; played: true; player: string }
  | { ok: true; played: false; reason: string }
  | { ok: false; content: string };

export function cliVoiceModeStatePath(profilePaths: ProfileStatePaths): string {
  return join(profilePaths.profileRoot, "cli-voice-mode.json");
}

export async function readCliVoiceMode(profilePaths: ProfileStatePaths): Promise<CliVoiceMode> {
  let content: string;
  try {
    content = await readFile(cliVoiceModeStatePath(profilePaths), "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return "off";
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(content) as Partial<CliVoiceModeState>;
    return isCliVoiceMode(parsed.mode) ? parsed.mode : "off";
  } catch {
    return "off";
  }
}

export async function writeCliVoiceMode(profilePaths: ProfileStatePaths, mode: CliVoiceMode): Promise<void> {
  const path = cliVoiceModeStatePath(profilePaths);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(profilePaths.profileRoot, { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify({ mode }, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function detectCliVoiceRecorder(options: CliVoiceEnvironmentOptions = {}): Promise<CliRecorderSelection> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const commandExists = options.commandExists ?? defaultCommandExists;
  const probeCommand = options.probeCommand ?? defaultProbeCommand;

  if (env.SSH_CONNECTION !== undefined || env.SSH_CLIENT !== undefined || env.SSH_TTY !== undefined) {
    return {
      ok: false,
      reason: "Local microphone unavailable in SSH sessions. Record locally and provide an audio file path instead."
    };
  }

  if (env.TERMUX_VERSION !== undefined || env.PREFIX?.includes("com.termux") === true) {
    if (await commandExists("termux-microphone-record")) {
      return {
        ok: true,
        kind: "termux",
        command: "termux-microphone-record",
        args: (outputPath, durationSeconds) => ["-f", outputPath, "-l", String(durationSeconds)]
      };
    }
    return { ok: false, reason: "Termux microphone recorder not found: termux-microphone-record." };
  }

  if (platform === "linux" && (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined)) {
    const pulseReady = await commandExists("pactl") && await probeCommand("pactl", ["list", "sources"]);
    if (!pulseReady) {
      return { ok: false, reason: "WSL microphone unavailable: PulseAudio source not found with pactl list sources." };
    }
  }

  if (platform === "darwin" || platform === "linux") {
    if (await commandExists("sox")) {
      return {
        ok: true,
        kind: "sox",
        command: "sox",
        args: (outputPath, durationSeconds) => ["-d", "-r", "16000", "-c", "1", "-b", "16", outputPath, "trim", "0", String(durationSeconds)]
      };
    }
    if (await commandExists("arecord")) {
      return {
        ok: true,
        kind: "arecord",
        command: "arecord",
        args: (outputPath, durationSeconds) => ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-d", String(durationSeconds), outputPath]
      };
    }
    if (await commandExists("arec")) {
      return {
        ok: true,
        kind: "arecord",
        command: "arec",
        args: (outputPath, durationSeconds) => ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-d", String(durationSeconds), outputPath]
      };
    }
    if (await commandExists("rec")) {
      return {
        ok: true,
        kind: "rec",
        command: "rec",
        args: (outputPath, durationSeconds) => ["-r", "16000", "-c", "1", "-b", "16", outputPath, "trim", "0", String(durationSeconds)]
      };
    }
  }

  return { ok: false, reason: "No supported local microphone recorder found. Install sox/rec, arecord, or termux-microphone-record." };
}

export async function recordAndTranscribeCliVoice(input: {
  config: LoadedRuntimeConfig;
  profilePaths: ProfileStatePaths;
  durationSeconds?: number;
  recorder?: CliVoiceRecorder;
  transcriber?: CliVoiceTranscriber;
  envOptions?: CliVoiceEnvironmentOptions;
  signal?: AbortSignal;
  id?: () => string;
}): Promise<CliVoiceCaptureResult> {
  const selection = await detectCliVoiceRecorder(input.envOptions);
  if (!selection.ok) {
    return { ok: false, content: selection.reason, metadata: { reason: "recorder-unavailable" } };
  }

  const status = checkSttProviderStatus(input.config.stt.provider, input.config.stt);
  if (!status.ready) {
    return { ok: false, content: `CLI voice transcription unavailable: ${status.reason}` };
  }

  const outputRoot = join(input.profilePaths.tempPath, "audio", "cli-voice");
  await mkdir(outputRoot, { recursive: true });
  const fileName = `${safeId(input.id?.() ?? `${Date.now()}`)}.wav`;
  const audioPath = join(outputRoot, fileName);
  const canonicalRoot = resolve(outputRoot);
  const canonicalOutput = resolve(audioPath);
  if (!canonicalOutput.startsWith(`${canonicalRoot}/`) && canonicalOutput !== canonicalRoot) {
    return { ok: false, content: "Recorder output escaped the profile audio temp root." };
  }

  const recorder = input.recorder ?? defaultCliVoiceRecorder;
  const recorded = await recorder.record({
    outputPath: audioPath,
    durationSeconds: input.durationSeconds ?? 10,
    selection,
    signal: input.signal
  });
  if (!recorded.ok) {
    return recorded;
  }

  const transcribe = input.transcriber ?? defaultCliVoiceTranscriber;
  const transcript = await transcribe({
    path: audioPath,
    config: input.config,
    profilePaths: input.profilePaths,
    signal: input.signal
  });
  if (!transcript.ok) {
    return transcript;
  }
  return {
    ok: true,
    transcript: transcript.text,
    audioPath,
    model: transcript.model,
    language: transcript.language
  };
}

export async function playCliTtsResponse(input: {
  text: string;
  config: LoadedRuntimeConfig;
  profilePaths: ProfileStatePaths;
  fetch?: VoiceFetchLike;
  commandExists?: (command: string) => Promise<boolean>;
  playCommand?: (command: string, args: readonly string[], signal?: AbortSignal) => Promise<{ ok: true } | { ok: false; content: string }>;
  signal?: AbortSignal;
  id?: () => string;
}): Promise<CliVoicePlaybackResult> {
  const text = input.text.trim();
  if (text.length === 0) {
    return { ok: true, played: false, reason: "empty-response" };
  }
  const player = await findLocalAudioPlayer(input.commandExists);
  if (player === undefined) {
    return { ok: true, played: false, reason: "no-local-audio-player" };
  }
  const status = checkTtsProviderStatus(input.config.tts.provider, input.config.tts);
  if (!status.ready) {
    return { ok: true, played: false, reason: status.reason };
  }

  const speech = await synthesizeSpeechToEphemeralArtifact({
    text,
    tts: input.config.tts,
    tempRoot: join(input.profilePaths.tempPath, "audio"),
    fetch: input.fetch,
    id: input.id,
    signal: input.signal
  });
  if (!speech.ok) {
    return { ok: false, content: speech.content };
  }

  const artifactPath = speech.artifact.localPath ?? speech.artifact.path;
  try {
    const played = await (input.playCommand ?? runCommand)(player.command, player.args(artifactPath), input.signal);
    if (!played.ok) {
      return played;
    }
    return { ok: true, played: true, player: player.command };
  } finally {
    await rm(artifactPath, { force: true }).catch(() => undefined);
  }
}

export async function renderCliVoiceModeStatus(input: {
  config: LoadedRuntimeConfig;
  profilePaths: ProfileStatePaths;
  envOptions?: CliVoiceEnvironmentOptions;
  commandExists?: (command: string) => Promise<boolean>;
}): Promise<string> {
  const mode = await readCliVoiceMode(input.profilePaths);
  const recorder = await detectCliVoiceRecorder(input.envOptions);
  const sttStatus = checkSttProviderStatus(input.config.stt.provider, input.config.stt);
  const player = await findLocalAudioPlayer(input.commandExists);
  return [
    "EstaCoda CLI voice mode",
    `Mode: ${mode}`,
    `Recorder: ${recorder.ok ? `${recorder.kind} (${recorder.command})` : `unavailable (${recorder.reason})`}`,
    `STT: ${sttStatus.ready ? "ready" : `not ready (${sttStatus.reason})`}`,
    `Playback: ${player === undefined ? "unavailable (no local audio player)" : `${player.command}`}`,
    `State: ${cliVoiceModeStatePath(input.profilePaths)}`,
    `Audio temp: ${join(input.profilePaths.tempPath, "audio", "cli-voice")}`
  ].join("\n");
}

export async function findLocalAudioPlayer(
  commandExists: (command: string) => Promise<boolean> = defaultCommandExists
): Promise<{ command: string; args(path: string): string[] } | undefined> {
  if (await commandExists("afplay")) {
    return { command: "afplay", args: (path) => [path] };
  }
  if (await commandExists("aplay")) {
    return { command: "aplay", args: (path) => [path] };
  }
  if (await commandExists("paplay")) {
    return { command: "paplay", args: (path) => [path] };
  }
  if (await commandExists("ffplay")) {
    return { command: "ffplay", args: (path) => ["-nodisp", "-autoexit", "-loglevel", "error", path] };
  }
  return undefined;
}

export const defaultCliVoiceRecorder: CliVoiceRecorder = {
  async record(input) {
    return await runCommand(input.selection.command, input.selection.args(input.outputPath, input.durationSeconds), input.signal);
  }
};

async function defaultCliVoiceTranscriber(input: Parameters<CliVoiceTranscriber>[0]): ReturnType<CliVoiceTranscriber> {
  const result = await transcribeAudioFile({
    path: input.path,
    stt: input.config.stt,
    audioCacheRoot: input.profilePaths.audioCachePath,
    tempRoot: join(input.profilePaths.tempPath, "audio"),
    signal: input.signal
  });
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    text: result.text,
    model: result.model,
    language: result.language
  };
}

async function defaultCommandExists(command: string): Promise<boolean> {
  const pathEnv = process.env.PATH ?? "";
  for (const entry of pathEnv.split(delimiter)) {
    if (entry.length === 0) continue;
    try {
      await access(join(entry, command), fsConstants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

async function defaultProbeCommand(command: string, args: readonly string[]): Promise<boolean> {
  const result = await runCommand(command, args, undefined, 5_000);
  return result.ok;
}

async function runCommand(
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
  timeoutMs = 30_000
): Promise<{ ok: true } | { ok: false; content: string }> {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "ignore", "pipe"],
      signal
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk).slice(0, 4_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, content: error.message });
    });
    child.on("close", (code, signalName) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise({ ok: true });
        return;
      }
      resolvePromise({
        ok: false,
        content: `Command ${command} failed${code === null ? "" : ` with exit ${code}`}${signalName === null ? "" : ` (${signalName})`}${stderr.length === 0 ? "" : `: ${stderr.trim()}`}`
      });
    });
  });
}

function isCliVoiceMode(value: unknown): value is CliVoiceMode {
  return value === "off" || value === "on" || value === "tts";
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "voice";
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
