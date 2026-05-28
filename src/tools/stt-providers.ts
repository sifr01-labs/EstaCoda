import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { LoadedRuntimeConfig, SttProvider } from "../config/runtime-config.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import { validateAudioInput } from "./audio-validation.js";
import { formatMissingOpenAiAudioCredential, resolveOpenAiAudioCredential } from "./audio-credentials.js";
import type { FasterWhisperWorkerClient, FasterWhisperPreset } from "./stt-local-whisper.js";
import type { VoiceFetchLike } from "./voice-tools.js";

export type SpeechTranscriptionResult =
  | {
      ok: true;
      text: string;
      model: string;
      language?: string;
      duration?: number;
      words?: unknown;
      channels?: unknown;
      metadata?: Record<string, unknown>;
    }
  | { ok: false; content: string; metadata?: Record<string, unknown> };

export type SpeechTranscriptionInput = {
  path: string;
  language?: string;
  prompt?: string;
  model?: string;
  stt: LoadedRuntimeConfig["stt"];
  fetch?: VoiceFetchLike;
  signal?: AbortSignal;
  localWhisper?: FasterWhisperWorkerClient;
  audioCacheRoot?: string;
  tempRoot?: string;
  gateway?: boolean;
  fasterWhisperDefaultHfHome?: string;
};

export type SttRiskResult =
  | { available: true; riskClass: ToolRiskClass; reason?: string }
  | { available: false; riskClass: "unavailable"; reason: string };

export function checkSttProviderStatus(
  provider: SttProvider,
  config: LoadedRuntimeConfig["stt"]
): { ready: true } | { ready: false; reason: string } {
  if (config.enabled === false) {
    return { ready: false, reason: "STT disabled" };
  }
  if (provider === "openai" || provider === "groq" || provider === "xai") {
    const apiKeyEnv = sttApiKeyEnv(provider, config);
    if (provider === "openai") {
      const credential = resolveOpenAiAudioCredential(apiKeyEnv);
      if (!credential.ok) {
        return {
          ready: false,
          reason: `Missing ${formatMissingOpenAiAudioCredential(credential.missingApiKeyEnvs)}`
        };
      }
      return { ready: true };
    }
    const apiKey = process.env[apiKeyEnv];
    if (apiKey === undefined || apiKey.length === 0) {
      return {
        ready: false,
        reason: `Missing ${apiKeyEnv}`
      };
    }
    return { ready: true };
  }
  if (provider === "local") {
    if (isFasterWhisperConfig(config)) {
      return { ready: true };
    }
    const command = config.local?.command ?? process.env.HERMES_LOCAL_STT_COMMAND;
    if (command === undefined || command.trim().length === 0) {
      return { ready: false, reason: "Local STT command not configured" };
    }
    return { ready: true };
  }
  return { ready: false, reason: `${provider} STT is not implemented in v0.1.0 Stage 2` };
}

export function computeSttRiskClass(input: {
  stt: LoadedRuntimeConfig["stt"];
  path?: string;
  gateway?: boolean;
  ffmpegAvailable?: boolean;
  fasterWhisperModelCached?: boolean;
  fasterWhisperDefaultHfHome?: string;
}): SttRiskResult {
  if (input.stt.enabled === false) {
    return { available: false, riskClass: "unavailable", reason: "STT disabled" };
  }
  if (input.stt.provider !== "local") {
    return { available: true, riskClass: "external-side-effect" };
  }
  if (isFasterWhisperConfig(input.stt)) {
    const cached = input.fasterWhisperModelCached ??
      isFasterWhisperModelCached(input.stt, undefined, input.fasterWhisperDefaultHfHome);
    if (cached) {
      return { available: true, riskClass: "workspace-write" };
    }
    if (fasterWhisperDownloadAllowed(input.stt, input.gateway)) {
      return { available: true, riskClass: "external-side-effect" };
    }
    return { available: false, riskClass: "unavailable", reason: "faster-whisper model download is not allowed" };
  }
  if (input.path !== undefined && shouldNormalizeForLocalCommand(input.path, input.stt)) {
    return {
      available: true,
      riskClass: input.ffmpegAvailable === false ? "read-only-local" : "workspace-write"
    };
  }
  return { available: true, riskClass: "read-only-local" };
}

export function isGatewayFasterWhisperDownloadDenied(
  config: LoadedRuntimeConfig["stt"],
  model?: string,
  defaultHfHome?: string
): boolean {
  return config.provider === "local" &&
    isFasterWhisperConfig(config) &&
    !isFasterWhisperModelCached(config, model, defaultHfHome) &&
    !fasterWhisperDownloadAllowed(config, true);
}

export async function transcribeSpeech(input: SpeechTranscriptionInput): Promise<SpeechTranscriptionResult> {
  const status = checkSttProviderStatus(input.stt.provider, input.stt);
  if (!status.ready) {
    return {
      ok: false,
      content: `STT provider unavailable: ${status.reason}`,
      metadata: { provider: input.stt.provider, reason: status.reason }
    };
  }
  const audioValidation = await validateAudioInput(input.path);
  if (!audioValidation.ok) {
    return audioValidation;
  }
  const risk = computeSttRiskClass({
    stt: input.stt,
    path: input.path,
    gateway: input.gateway,
    fasterWhisperDefaultHfHome: input.fasterWhisperDefaultHfHome
  });
  if (!risk.available) {
    return {
      ok: false,
      content: risk.reason,
      metadata: { provider: input.stt.provider, riskClass: risk.riskClass }
    };
  }

  switch (input.stt.provider) {
    case "local":
      return isFasterWhisperConfig(input.stt)
        ? await transcribeWithFasterWhisper(input)
        : await transcribeWithLocalCommand(input);
    case "openai":
    case "groq":
      return await transcribeOpenAiCompatible(input, input.stt.provider);
    case "xai":
      return await transcribeXai(input);
    case "mistral":
      return {
        ok: false,
        content: "STT execution for mistral is not enabled yet.",
        metadata: { provider: "mistral" }
      };
  }
}

export function sttApiKeyEnv(provider: SttProvider, config: LoadedRuntimeConfig["stt"]): string {
  switch (provider) {
    case "openai":
      return config.openai?.apiKeyEnv ?? "VOICE_TOOLS_OPENAI_KEY";
    case "groq":
      return config.groq?.apiKeyEnv ?? "GROQ_API_KEY";
    case "xai":
      return config.xai?.apiKeyEnv ?? "XAI_API_KEY";
    case "mistral":
      return config.mistral?.apiKeyEnv ?? "MISTRAL_API_KEY";
    case "local":
      return "";
  }
}

async function transcribeOpenAiCompatible(
  input: SpeechTranscriptionInput,
  provider: "openai" | "groq"
): Promise<SpeechTranscriptionResult> {
  const config = provider === "openai" ? input.stt.openai : input.stt.groq;
  const apiKeyEnv = sttApiKeyEnv(provider, input.stt);
  const credential = provider === "openai" ? resolveOpenAiAudioCredential(apiKeyEnv) : undefined;
  const apiKey = credential?.ok === true ? credential.apiKey : process.env[apiKeyEnv];
  if (credential?.ok === false) {
    return missingKey(provider, credential.configuredApiKeyEnv, credential.missingApiKeyEnvs);
  }
  if (apiKey === undefined || apiKey.length === 0) {
    return missingKey(provider, apiKeyEnv);
  }

  const bytes = await readFile(input.path);
  const model = input.model ?? config?.model ?? (provider === "openai" ? "whisper-1" : "whisper-large-v3");
  const form = new FormData();
  form.append("model", model);
  form.append("response_format", "json");
  if (input.language !== undefined && input.language.length > 0) {
    form.append("language", input.language);
  }
  if (input.prompt !== undefined && input.prompt.length > 0) {
    form.append("prompt", input.prompt);
  }
  form.append("file", new Blob([bytes]), basename(input.path));

  const baseUrl = provider === "openai" ? "https://api.openai.com/v1" : "https://api.groq.com/openai/v1";
  const response = await (input.fetch ?? globalVoiceFetch)(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal: input.signal
  });
  return await parseHostedResponse(response, provider, model, input.language);
}

async function transcribeXai(input: SpeechTranscriptionInput): Promise<SpeechTranscriptionResult> {
  const config = input.stt.xai;
  const apiKeyEnv = sttApiKeyEnv("xai", input.stt);
  const apiKey = process.env[apiKeyEnv];
  if (apiKey === undefined || apiKey.length === 0) {
    return missingKey("xai", apiKeyEnv);
  }
  const model = input.model ?? "xai-stt";
  const form = new FormData();
  if (input.language !== undefined && input.language.length > 0) {
    form.append("language", input.language);
  } else if (config?.language !== undefined && config.language.length > 0) {
    form.append("language", config.language);
  }
  form.append("format", config?.format ?? "json");
  if (config?.diarize !== undefined) {
    form.append("diarize", String(config.diarize));
  }
  for (const keyterm of config?.keyterms ?? []) {
    form.append("keyterms", keyterm);
  }
  if (config?.fillerWords !== undefined) {
    form.append("filler_words", String(config.fillerWords));
  }
  const file = await readFile(input.path);
  form.append("file", new Blob([file]), basename(input.path));
  const baseUrl = (config?.baseUrl ?? "https://api.x.ai/v1").replace(/\/+$/u, "");
  const response = await (input.fetch ?? globalVoiceFetch)(`${baseUrl}/stt`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal: input.signal
  });
  const parsed = await parseHostedResponse(response, "xai", model, input.language);
  if (!parsed.ok) {
    return parsed;
  }
  return parsed;
}

async function parseHostedResponse(
  response: Awaited<ReturnType<VoiceFetchLike>>,
  provider: string,
  model: string,
  fallbackLanguage?: string
): Promise<SpeechTranscriptionResult> {
  const raw = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      content: `STT request failed: ${response.status} ${response.statusText}\n${truncateForMetadata(raw)}`,
      metadata: { provider, model, status: response.status, reason: "stt-request-failed" }
    };
  }
  const parsed = tryJson(raw);
  const text = typeof parsed?.text === "string"
    ? parsed.text
    : (parsed === undefined ? raw : undefined);
  if (text === undefined) {
    return {
      ok: false,
      content: `${provider} STT response did not include transcript text.`,
      metadata: { provider, model, reason: "invalid-transcript-response" }
    };
  }
  const validText = validateTranscriptText(text, { provider, model });
  if (!validText.ok) {
    return validText;
  }
  return {
    ok: true,
    text: validText.text,
    model: typeof parsed?.model === "string" ? parsed.model : model,
    language: typeof parsed?.language === "string" ? parsed.language : fallbackLanguage,
    duration: typeof parsed?.duration === "number" ? parsed.duration : undefined,
    words: parsed?.words,
    channels: parsed?.channels,
    metadata: {
      provider,
      duration: parsed?.duration,
      words: parsed?.words,
      channels: parsed?.channels
    }
  };
}

async function transcribeWithFasterWhisper(input: SpeechTranscriptionInput): Promise<SpeechTranscriptionResult> {
  const local = input.stt.local?.fasterWhisper;
  const client = input.localWhisper;
  if (client === undefined) {
    return {
      ok: false,
      content: "faster-whisper STT requires a runtime-owned worker resource.",
      metadata: { provider: "local", reason: "managed-worker-required" }
    };
  }
  const model = preset(input.model ?? local?.model ?? input.stt.local?.model ?? "base");
  const response = await client.transcribe({
    path: input.path,
    model,
    device: local?.device ?? "auto",
    computeType: local?.computeType ?? "default",
    language: input.language,
    allowDownload: fasterWhisperDownloadAllowed(input.stt, input.gateway),
    hfHome: local?.hfHome
  });
  if (!response.ok) {
    return {
      ok: false,
      content: response.content ?? "faster-whisper transcription failed",
      metadata: response.metadata
    };
  }
  const validText = validateTranscriptText(response.text ?? "", { provider: "local", model });
  if (!validText.ok) {
    return validText;
  }
  return {
    ok: true,
    text: validText.text,
    model: response.model ?? model,
    language: response.language ?? input.language,
    duration: typeof response.metadata?.duration === "number" ? response.metadata.duration : undefined,
    words: response.metadata?.words,
    metadata: response.metadata
  };
}

async function transcribeWithLocalCommand(input: SpeechTranscriptionInput): Promise<SpeechTranscriptionResult> {
  const command = input.stt.local?.command;
  const model = input.model ?? input.stt.local?.model ?? "base";
  if (command === undefined || command.trim().length === 0) {
    return {
      ok: false,
      content: [
        "Local STT command is not configured.",
        "Set stt.local.command or HERMES_LOCAL_STT_COMMAND with placeholders like {input_path}, {output_dir}, {language}, and {model}."
      ].join("\n"),
      metadata: { provider: "local", model }
    };
  }

  const workingPath = await maybeNormalizeForLocalCommand(input);
  if (!workingPath.ok) {
    return workingPath;
  }
  const outputDir = await mkdtemp(join(input.tempRoot ?? tmpdir(), "estacoda-stt-"));
  const rendered = command
    .replaceAll("{input_path}", shellQuote(workingPath.path))
    .replaceAll("{output_dir}", shellQuote(outputDir))
    .replaceAll("{language}", shellQuote(input.language ?? ""))
    .replaceAll("{model}", shellQuote(model));
  const result = await runShellCommand(rendered, input.signal);
  if (!result.ok) {
    return { ok: false, content: `Local STT command failed: ${result.content}`, metadata: { provider: "local", model } };
  }

  let text = result.content.trim();
  if (text.length === 0) {
    text = await readTxtOutputs(outputDir);
  }
  if (text.length === 0) {
    return {
      ok: false,
      content: "Local STT command completed but produced no transcript text on stdout or in .txt files under output_dir.",
      metadata: { provider: "local", model, outputDir }
    };
  }
  return { ok: true, text, model, language: input.language };
}

async function maybeNormalizeForLocalCommand(
  input: SpeechTranscriptionInput
): Promise<{ ok: true; path: string } | Extract<SpeechTranscriptionResult, { ok: false }>> {
  if (!shouldNormalizeForLocalCommand(input.path, input.stt)) {
    return { ok: true, path: input.path };
  }
  const ffmpeg = input.stt.local?.ffmpegPath ?? "ffmpeg";
  const available = await commandAvailable(ffmpeg);
  if (!available) {
    return { ok: true, path: input.path };
  }
  const dir = await mkdtemp(join(input.tempRoot ?? input.audioCacheRoot ?? tmpdir(), "estacoda-stt-normalized-"));
  const wavPath = join(dir, `${basename(input.path, extname(input.path))}.wav`);
  const result = await runCommand(ffmpeg, ["-y", "-i", input.path, "-ac", "1", "-ar", "16000", wavPath], input.signal);
  if (!result.ok) {
    return {
      ok: false,
      content: `ffmpeg audio normalization failed: ${result.content}`,
      metadata: { provider: "local", normalized: false }
    };
  }
  return { ok: true, path: wavPath };
}

function shouldNormalizeForLocalCommand(path: string, stt: LoadedRuntimeConfig["stt"]): boolean {
  if (stt.local?.normalizeWithFfmpeg === false) {
    return false;
  }
  const ext = extname(path).toLowerCase();
  return ext !== ".wav" && ext !== ".aiff" && ext !== ".aif";
}

export function isFasterWhisperConfig(stt: LoadedRuntimeConfig["stt"]): boolean {
  if (stt.local?.engine === "command") return false;
  return stt.local?.engine === "faster-whisper" || stt.local?.fasterWhisper?.enabled === true;
}

function fasterWhisperDownloadAllowed(stt: LoadedRuntimeConfig["stt"], gateway?: boolean): boolean {
  if (gateway === true && stt.local?.fasterWhisper?.gatewayAllowModelDownload !== true) {
    return false;
  }
  return stt.local?.fasterWhisper?.allowModelDownload === true ||
    stt.local?.fasterWhisper?.gatewayAllowModelDownload === true;
}

export function isFasterWhisperModelCached(
  stt: LoadedRuntimeConfig["stt"],
  model?: string,
  defaultHfHome?: string
): boolean {
  if (stt.local?.fasterWhisper?.modelCached === true) {
    return true;
  }
  const hfHome = stt.local?.fasterWhisper?.hfHome ?? defaultHfHome;
  if (hfHome === undefined || hfHome.length === 0) {
    return false;
  }
  const selectedModel = preset(model ?? stt.local?.fasterWhisper?.model ?? stt.local?.model ?? "base");
  return existsSync(join(hfHome, "hub", `models--Systran--faster-whisper-${selectedModel}`));
}

async function readTxtOutputs(outputDir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(outputDir);
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const entry of entries.sort()) {
    if (extname(entry).toLowerCase() !== ".txt") {
      continue;
    }
    const path = join(outputDir, entry);
    const fileStat = await stat(path).catch(() => undefined);
    if (fileStat?.isFile() !== true) {
      continue;
    }
    parts.push((await readFile(path, "utf8")).trim());
  }
  return parts.filter((part) => part.length > 0).join("\n");
}

function missingKey(provider: string, apiKeyEnv: string, fallbackEnvs: readonly string[] = [apiKeyEnv]): SpeechTranscriptionResult {
  return {
    ok: false,
    content: `Missing STT API key. Export ${formatMissingOpenAiAudioCredential(fallbackEnvs)}.`,
    metadata: { provider, apiKeyEnv }
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

function runShellCommand(command: string, signal?: AbortSignal): Promise<{ ok: true; content: string } | { ok: false; content: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { resolveResult({ ok: false, content: error.message }); });
    child.on("close", (code) => {
      if (code === 0) {
        resolveResult({ ok: true, content: stdout });
        return;
      }
      resolveResult({ ok: false, content: truncateForMetadata(stderr.trim() || `exit code ${code ?? "unknown"}`) });
    });
  });
}

function runCommand(command: string, args: string[], signal?: AbortSignal): Promise<{ ok: true; content: string } | { ok: false; content: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], signal });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { resolveResult({ ok: false, content: error.message }); });
    child.on("close", (code) => {
      if (code === 0) {
        resolveResult({ ok: true, content: "" });
        return;
      }
      resolveResult({ ok: false, content: truncateForMetadata(stderr.trim() || `exit code ${code ?? "unknown"}`) });
    });
  });
}

function commandAvailable(command: string): Promise<boolean> {
  return new Promise((resolveResult) => {
    const child = spawn(command, ["-version"], { stdio: "ignore" });
    child.on("error", () => { resolveResult(false); });
    child.on("close", (code) => { resolveResult(code === 0); });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function preset(value: string): FasterWhisperPreset {
  return ["tiny", "base", "small", "medium", "large-v1", "large-v2", "large-v3"].includes(value)
    ? value as FasterWhisperPreset
    : "base";
}

function tryJson(value: string): any {
  try {
    return JSON.parse(value) as any;
  } catch {
    return undefined;
  }
}

function validateTranscriptText(
  text: string,
  metadata: { provider: string; model: string }
): SpeechTranscriptionResult | { ok: true; text: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      content: `${metadata.provider} STT returned empty transcript.`,
      metadata: { provider: metadata.provider, model: metadata.model, reason: "empty-transcript" }
    };
  }
  return { ok: true, text: trimmed };
}

function truncateForMetadata(value: string, maxChars = 500): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}
