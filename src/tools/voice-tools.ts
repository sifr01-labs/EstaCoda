import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { RegisteredTool, SessionToolProvider } from "../contracts/tool.js";

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
};

export function createVoiceTools(options: VoiceToolOptions): readonly RegisteredTool[] {
  const tts = options.tts ?? defaultTts();
  const stt = options.stt ?? defaultStt();
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
      isAvailable: () => true,
      run: async (input: { text?: string; voice?: string; model?: string; format?: string }, context) => {
        const text = input.text?.trim();
        if (text === undefined || text.length === 0) {
          return { ok: false, content: "voice.speak requires text." };
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
      riskClass: stt.provider === "local" ? "read-only-local" : "external-side-effect",
      toolsets: ["media", "research"],
      progressLabel: "transcribing audio",
      maxResultSizeChars: 8000,
      isAvailable: () => true,
      run: async (input: { path?: string; language?: string; prompt?: string; model?: string }, context) => {
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
      fetch: ctx.voiceFetch
    });
  }
};

function requireProviderDependency<T>(provider: string, dependency: string, value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError(`${provider}ToolProvider requires ${dependency}.`);
  }
  return value;
}

async function synthesizeSpeech(input: {
  text: string;
  voice?: string;
  model?: string;
  format?: string;
  tts: LoadedRuntimeConfig["tts"];
  fetch?: VoiceFetchLike;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; bytes: Buffer; mimeType: string; model: string; voice: string }
  | { ok: false; content: string; metadata?: Record<string, unknown> }
> {
  if (input.tts.provider !== "openai") {
    return {
      ok: false,
      content: [
        `TTS execution for ${input.tts.provider} is not enabled yet.`,
        "Configured providers are visible through estacoda voice status.",
        "This first execution pass supports OpenAI-compatible TTS."
      ].join("\n"),
      metadata: {
        provider: input.tts.provider
      }
    };
  }

  const apiKeyEnv = input.tts.openai?.apiKeyEnv ?? "VOICE_TOOLS_OPENAI_KEY";
  const apiKey = process.env[apiKeyEnv] ?? (apiKeyEnv === "VOICE_TOOLS_OPENAI_KEY" ? process.env.OPENAI_API_KEY : undefined);
  if (apiKey === undefined || apiKey.length === 0) {
    return {
      ok: false,
      content: `Missing TTS API key. Export ${apiKeyEnv}${apiKeyEnv === "VOICE_TOOLS_OPENAI_KEY" ? " or OPENAI_API_KEY" : ""}.`,
      metadata: {
        provider: "openai",
        apiKeyEnv
      }
    };
  }

  const model = input.model ?? input.tts.openai?.model ?? "gpt-4o-mini-tts";
  const voice = input.voice ?? input.tts.openai?.voice ?? "alloy";
  const responseFormat = normalizeAudioFormat(input.format);
  const baseUrl = (input.tts.openai?.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await (input.fetch ?? globalVoiceFetch)(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      voice,
      input: input.text,
      response_format: responseFormat,
      speed: input.tts.openai?.speed ?? input.tts.speed
    }),
    signal: input.signal
  });

  if (!response.ok) {
    return {
      ok: false,
      content: `TTS request failed: ${response.status} ${response.statusText}\n${await response.text()}`,
      metadata: {
        provider: "openai",
        model,
        voice
      }
    };
  }

  return {
    ok: true,
    bytes: Buffer.from(await response.arrayBuffer()),
    mimeType: mimeForAudioFormat(responseFormat),
    model,
    voice
  };
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
  signal?: AbortSignal;
}): Promise<
  | { ok: true; text: string; model: string; language?: string }
  | { ok: false; content: string; metadata?: Record<string, unknown> }
> {
  if (input.stt.provider === "local") {
    return transcribeWithLocalCommand(input);
  }

  if (input.stt.provider !== "openai" && input.stt.provider !== "groq") {
    return {
      ok: false,
      content: [
        `STT execution for ${input.stt.provider} is not enabled yet.`,
        "This pass supports OpenAI-compatible hosted transcription providers: openai and groq.",
        "Configured providers are visible through estacoda voice status."
      ].join("\n"),
      metadata: {
        provider: input.stt.provider
      }
    };
  }

  const provider = input.stt.provider;
  const config = provider === "openai" ? input.stt.openai : input.stt.groq;
  const apiKeyEnv = config?.apiKeyEnv ?? (provider === "openai" ? "VOICE_TOOLS_OPENAI_KEY" : "GROQ_API_KEY");
  const apiKey = process.env[apiKeyEnv] ?? (provider === "openai" && apiKeyEnv === "VOICE_TOOLS_OPENAI_KEY" ? process.env.OPENAI_API_KEY : undefined);
  if (apiKey === undefined || apiKey.length === 0) {
    return {
      ok: false,
      content: `Missing STT API key. Export ${apiKeyEnv}${provider === "openai" && apiKeyEnv === "VOICE_TOOLS_OPENAI_KEY" ? " or OPENAI_API_KEY" : ""}.`,
      metadata: {
        provider,
        apiKeyEnv
      }
    };
  }

  const bytes = await readFile(input.path);
  const form = new FormData();
  form.set("file", new Blob([bytes]), basename(input.path));
  const model = input.model ?? config?.model ?? (provider === "openai" ? "whisper-1" : "whisper-large-v3");
  form.set("model", model);
  form.set("response_format", "json");
  if (input.language !== undefined && input.language.length > 0) {
    form.set("language", input.language);
  }
  if (input.prompt !== undefined && input.prompt.length > 0) {
    form.set("prompt", input.prompt);
  }

  const baseUrl = provider === "openai" ? "https://api.openai.com/v1" : "https://api.groq.com/openai/v1";
  const response = await (input.fetch ?? globalVoiceFetch)(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`
    },
    body: form,
    signal: input.signal
  });

  if (!response.ok) {
    return {
      ok: false,
      content: `STT request failed: ${response.status} ${response.statusText}\n${await response.text()}`,
      metadata: {
        provider,
        model
      }
    };
  }

  const raw = await response.text();
  const parsed = tryJson(raw);
  const text = typeof parsed?.text === "string" ? parsed.text : raw;
  return {
    ok: true,
    text,
    model,
    language: input.language
  };
}

async function transcribeWithLocalCommand(input: {
  path: string;
  language?: string;
  model?: string;
  stt: LoadedRuntimeConfig["stt"];
  signal?: AbortSignal;
}): Promise<
  | { ok: true; text: string; model: string; language?: string }
  | { ok: false; content: string; metadata?: Record<string, unknown> }
> {
  const command = input.stt.local?.command;
  const model = input.model ?? input.stt.local?.model ?? "base";
  if (command === undefined || command.trim().length === 0) {
    return {
      ok: false,
      content: [
        "Local STT command is not configured.",
        "Set stt.local.command or HERMES_LOCAL_STT_COMMAND with placeholders like {input_path}, {output_dir}, {language}, and {model}."
      ].join("\n"),
      metadata: {
        provider: "local",
        model
      }
    };
  }

  const outputDir = await mkdtemp(join(tmpdir(), "estacoda-stt-"));
  const rendered = command
    .replaceAll("{input_path}", shellQuote(input.path))
    .replaceAll("{output_dir}", shellQuote(outputDir))
    .replaceAll("{language}", shellQuote(input.language ?? ""))
    .replaceAll("{model}", shellQuote(model));
  const result = await runShellCommand(rendered, input.signal);
  if (!result.ok) {
    return {
      ok: false,
      content: `Local STT command failed: ${result.content}`,
      metadata: {
        provider: "local",
        model
      }
    };
  }

  const text = result.content.trim();
  if (text.length === 0) {
    return {
      ok: false,
      content: "Local STT command completed but produced no transcript text.",
      metadata: {
        provider: "local",
        model
      }
    };
  }

  return {
    ok: true,
    text,
    model,
    language: input.language
  };
}

function runShellCommand(command: string, signal?: AbortSignal): Promise<{ ok: true; content: string } | { ok: false; content: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolveResult({ ok: false, content: error.message });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolveResult({ ok: true, content: stdout });
        return;
      }
      resolveResult({ ok: false, content: stderr.trim() || `exit code ${code ?? "unknown"}` });
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

type ResolvedPath =
  | { ok: true; content: ""; path: string }
  | { ok: false; content: string; metadata?: Record<string, unknown> };

async function resolveAllowedPath(roots: string[], path: string | undefined): Promise<ResolvedPath> {
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

function tryJson(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeAudioFormat(value: string | undefined): "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm" {
  return value === "opus" || value === "aac" || value === "flac" || value === "wav" || value === "pcm" ? value : "mp3";
}

function mimeForAudioFormat(format: ReturnType<typeof normalizeAudioFormat>): string {
  switch (format) {
    case "opus":
      return "audio/ogg";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "wav":
      return "audio/wav";
    case "pcm":
      return "audio/L16";
    case "mp3":
      return "audio/mpeg";
  }
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

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "speech";
}

function truncateSummary(value: string, maxChars = 240): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function defaultTts(): LoadedRuntimeConfig["tts"] {
  return {
    provider: "edge",
    speed: 1
  };
}

function defaultStt(): LoadedRuntimeConfig["stt"] {
  return {
    provider: "local"
  };
}
