import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { LoadedRuntimeConfig, SttProvider, TtsProvider } from "../config/runtime-config.js";
import type { RegisteredTool, SessionToolProvider } from "../contracts/tool.js";
import type { FasterWhisperWorkerClient } from "./stt-local-whisper.js";
import {
  checkSttProviderStatus as checkSttProviderStatusFromDispatch,
  computeSttRiskClass,
  transcribeSpeech
} from "./stt-providers.js";
import { getTtsTextCap, synthesizeSpeech } from "./tts-providers.js";

export type VoiceFetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

export type VoiceToolOptions = {
  audioCacheRoot: string;
  artifactStore: ArtifactStore;
  workspaceRoot?: string;
  allowedRoots?: string[];
  tts?: LoadedRuntimeConfig["tts"];
  stt?: LoadedRuntimeConfig["stt"];
  fetch?: VoiceFetchLike;
  id?: () => string;
  localWhisper?: FasterWhisperWorkerClient;
  tempRoot?: string;
};

export type VoiceProviderStatus =
  | { ready: true }
  | { ready: false; reason: string };

export function checkTtsProviderStatus(
  provider: TtsProvider,
  config: LoadedRuntimeConfig["tts"]
): VoiceProviderStatus {
  if (config.enabled === false) {
    return { ready: false, reason: "TTS disabled" };
  }

  const apiKeyEnv = ttsApiKeyEnv(provider, config);
  if (apiKeyEnv !== undefined) {
    const apiKey = process.env[apiKeyEnv] ??
      (provider === "openai" && apiKeyEnv === "VOICE_TOOLS_OPENAI_KEY" ? process.env.OPENAI_API_KEY : undefined);
    if (apiKey === undefined || apiKey.length === 0) {
      return {
        ready: false,
        reason: `Missing ${apiKeyEnv}${provider === "openai" && apiKeyEnv === "VOICE_TOOLS_OPENAI_KEY" ? " or OPENAI_API_KEY" : ""}`
      };
    }
    return { ready: true };
  }

  return { ready: false, reason: `${provider} TTS is not implemented in v0.1.0 Stage 1` };
}

export function checkSttProviderStatus(
  provider: SttProvider,
  config: LoadedRuntimeConfig["stt"]
): VoiceProviderStatus {
  return checkSttProviderStatusFromDispatch(provider, config);
}

export function createVoiceTools(options: VoiceToolOptions): readonly RegisteredTool[] {
  const tts = options.tts ?? defaultTts();
  const stt = options.stt ?? defaultStt();
  const ttsStatus = checkTtsProviderStatus(tts.provider, tts);
  const sttStatus = checkSttProviderStatus(stt.provider, stt);
  const roots = [options.workspaceRoot, options.audioCacheRoot, ...(options.allowedRoots ?? [])]
    .filter((root): root is string => root !== undefined && root.length > 0);

  return [
    {
      name: "voice.speak",
      description: "Generate speech audio from text using the configured TTS provider and record it as an audio artifact.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          voice: { type: "string" },
          model: { type: "string" },
          format: { type: "string" }
        },
        required: ["text"]
      },
      riskClass: tts.provider === "edge" || tts.provider === "neutts" || tts.provider === "kittentts"
        ? "workspace-write"
        : "external-side-effect",
      toolsets: ["media", "core"],
      progressLabel: "generating speech",
      maxResultSizeChars: 4000,
      isAvailable: () => ttsStatus.ready,
      run: async (input: { text?: string; voice?: string; model?: string; format?: string }, context) => {
        const text = input.text?.trim();
        if (text === undefined || text.length === 0) {
          return { ok: false, content: "voice.speak requires text." };
        }
        const status = checkTtsProviderStatus(tts.provider, tts);
        if (!status.ready) {
          return {
            ok: false,
            content: `voice.speak unavailable: ${status.reason}`,
            metadata: { provider: tts.provider, reason: status.reason }
          };
        }
        const cap = getTtsTextCap({ provider: tts.provider, tts, model: input.model });
        if (cap !== undefined && text.length > cap) {
          return {
            ok: false,
            content: `Text exceeds provider max of ${cap} characters.`,
            metadata: { provider: tts.provider, maxChars: cap, textChars: text.length }
          };
        }

        const result = await synthesizeSpeech({
          text,
          voice: input.voice,
          model: input.model,
          format: input.format,
          tts,
          fetch: options.fetch,
          signal: context?.signal
        });
        if (!result.ok) {
          return result;
        }

        await mkdir(options.audioCacheRoot, { recursive: true });
        const fileName = `${safeId(options.id?.() ?? randomUUID())}.${extensionForMime(result.mimeType)}`;
        const filePath = join(options.audioCacheRoot, fileName);
        await writeFile(filePath, result.bytes);
        const fileStat = await stat(filePath);
        const artifact = options.artifactStore.record({
          path: filePath,
          kind: "audio",
          bytes: fileStat.size,
          mimeType: result.mimeType,
          summary: `Speech generated from ${text.length} characters.`,
          metadata: {
            provider: tts.provider,
            model: result.model,
            voice: result.voice,
            format: result.mimeType
          }
        });

        return {
          ok: true,
          content: [
            `Generated speech: ${artifact.path}`,
            `Provider: ${tts.provider}`,
            `Model: ${result.model}`,
            `Voice: ${result.voice}`,
            `MIME: ${result.mimeType}`,
            `Artifact: ${artifact.id}`
          ].join("\n"),
          metadata: artifact
        };
      }
    },
    {
      name: "voice.transcribe",
      description: "Transcribe an audio file using the configured STT provider and record the transcript as an artifact.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          language: { type: "string" },
          prompt: { type: "string" },
          model: { type: "string" }
        },
        required: ["path"]
      },
      riskClass: sttRiskClass(stt),
      toolsets: ["media", "research"],
      progressLabel: "transcribing audio",
      maxResultSizeChars: 8000,
      isAvailable: () => sttStatus.ready,
      run: async (input: { path?: string; language?: string; prompt?: string; model?: string }, context) => {
        const status = checkSttProviderStatus(stt.provider, stt);
        if (!status.ready) {
          return {
            ok: false,
            content: `voice.transcribe unavailable: ${status.reason}`,
            metadata: { provider: stt.provider, reason: status.reason }
          };
        }
        const path = await resolveAllowedPath(roots, input.path);
        if (!path.ok) {
          return path;
        }

        const result = await transcribeAudioFile({
          path: path.path,
          language: input.language,
          prompt: input.prompt,
          model: input.model,
          stt,
          fetch: options.fetch,
          localWhisper: options.localWhisper,
          audioCacheRoot: options.audioCacheRoot,
          tempRoot: options.tempRoot ?? options.audioCacheRoot,
          signal: context?.signal
        });
        if (!result.ok) {
          return result;
        }

        const transcriptDir = join(options.audioCacheRoot, "transcripts");
        await mkdir(transcriptDir, { recursive: true });
        const fileName = `${safeId(options.id?.() ?? randomUUID())}.txt`;
        const transcriptPath = join(transcriptDir, fileName);
        await writeFile(transcriptPath, result.text);
        const transcriptStat = await stat(transcriptPath);
        const artifact = options.artifactStore.record({
          path: transcriptPath,
          kind: "data",
          bytes: transcriptStat.size,
          mimeType: "text/plain",
          summary: truncateSummary(`Transcript generated from ${basename(path.path)}.`),
          metadata: {
            provider: stt.provider,
            model: result.model,
            language: result.language,
            source: path.path
          }
        });

        return {
          ok: true,
          content: [
            `Transcript: ${result.text}`,
            `Provider: ${stt.provider}`,
            `Model: ${result.model}`,
            result.language === undefined ? undefined : `Language: ${result.language}`,
            `Transcript artifact: ${artifact.id}`,
            `Transcript path: ${artifact.path}`
          ].filter((line) => line !== undefined).join("\n"),
          metadata: artifact
        };
      }
    }
  ];
}

export const voiceToolProvider: SessionToolProvider = {
  name: "voice",
  kind: "session",
  createTools(ctx) {
    return createVoiceTools({
      audioCacheRoot: requireProviderDependency("voice", "audioCacheRoot", ctx.audioCacheRoot),
      artifactStore: requireProviderDependency("voice", "artifactStore", ctx.artifactStore),
      workspaceRoot: ctx.workspaceRoot,
      allowedRoots: [requireProviderDependency("voice", "channelMediaRoot", ctx.channelMediaRoot)],
      tts: ctx.tts,
      stt: ctx.stt,
      fetch: ctx.voiceFetch,
      localWhisper: ctx.localWhisper,
      tempRoot: ctx.audioCacheRoot
    });
  }
};

function requireProviderDependency<T>(provider: string, dependency: string, value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError(`${provider}ToolProvider requires ${dependency}.`);
  }
  return value;
}

async function globalVoiceFetch(url: string, init?: Parameters<VoiceFetchLike>[1]): ReturnType<VoiceFetchLike> {
  const response = await fetch(url, init as RequestInit);
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    arrayBuffer: async () => await response.arrayBuffer(),
    text: async () => await response.text()
  };
}

export async function transcribeAudioFile(input: {
  path: string;
  language?: string;
  prompt?: string;
  model?: string;
  stt: LoadedRuntimeConfig["stt"];
  fetch?: VoiceFetchLike;
  localWhisper?: FasterWhisperWorkerClient;
  audioCacheRoot?: string;
  tempRoot?: string;
  gateway?: boolean;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; text: string; model: string; language?: string; duration?: number; words?: unknown; channels?: unknown; metadata?: Record<string, unknown> }
  | { ok: false; content: string; metadata?: Record<string, unknown> }
> {
  return await transcribeSpeech(input);
}

type ResolvedPath =
  | { ok: true; content: ""; path: string }
  | { ok: false; content: string; metadata?: Record<string, unknown> };

export async function resolveAllowedPath(roots: string[], path: string | undefined): Promise<ResolvedPath> {
  if (typeof path !== "string" || path.length === 0) {
    return errorResult("path must be a non-empty string");
  }

  let lastError = "path is outside the trusted workspace";
  for (const root of roots.length === 0 ? [process.cwd()] : roots) {
    try {
      const canonicalRoot = await realpath(resolve(root));
      const absolute = resolve(canonicalRoot, path);
      const canonicalPath = await realpath(absolute);
      const rel = relative(canonicalRoot, canonicalPath);
      if (rel === "" || (!rel.startsWith("..") && rel !== ".." && !rel.startsWith(`..${"/"}`))) {
        return { ok: true, content: "", path: canonicalPath };
      }
      lastError = `path is outside allowed root ${canonicalRoot}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return errorResult(lastError);
}

function errorResult(message: string): { ok: false; content: string; metadata: { reason: string } } {
  return {
    ok: false,
    content: message,
    metadata: {
      reason: message
    }
  };
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case "audio/ogg":
      return "ogg";
    case "audio/aac":
      return "aac";
    case "audio/flac":
      return "flac";
    case "audio/wav":
      return "wav";
    case "audio/L16":
      return "pcm";
    default:
      return "mp3";
  }
}

function ttsApiKeyEnv(provider: TtsProvider, config: LoadedRuntimeConfig["tts"]): string | undefined {
  switch (provider) {
    case "openai":
      return config.openai?.apiKeyEnv ?? "VOICE_TOOLS_OPENAI_KEY";
    case "elevenlabs":
      return config.elevenlabs?.apiKeyEnv ?? "ELEVENLABS_API_KEY";
    case "minimax":
      return config.minimax?.apiKeyEnv ?? "MINIMAX_API_KEY";
    case "gemini":
      return config.gemini?.apiKeyEnv ?? "GEMINI_API_KEY";
    case "xai":
      return config.xai?.apiKeyEnv ?? "XAI_API_KEY";
    case "edge":
    case "mistral":
    case "neutts":
    case "kittentts":
      return undefined;
  }
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "speech";
}

function truncateSummary(value: string, maxChars = 240): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function defaultTts(): LoadedRuntimeConfig["tts"] {
  return {
    provider: "openai",
    speed: 1,
    openai: {
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      baseUrl: "https://api.openai.com/v1",
      speed: 1,
      apiKeyEnv: "VOICE_TOOLS_OPENAI_KEY"
    }
  };
}

function defaultStt(): LoadedRuntimeConfig["stt"] {
  return {
    provider: "local"
  };
}

function sttRiskClass(stt: LoadedRuntimeConfig["stt"]) {
  const risk = computeSttRiskClass({ stt });
  return risk.available ? risk.riskClass : "read-only-local";
}
