import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { VoiceFetchLike } from "./voice-tools.js";
import {
  checkSttProviderStatus,
  computeSttRiskClass,
  isGatewayFasterWhisperDownloadDenied,
  isFasterWhisperConfig,
  transcribeSpeech
} from "./stt-providers.js";

type CapturedRequest = {
  url: string;
  init?: Parameters<VoiceFetchLike>[1];
};

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

function response(text: string, ok = true, status = 200): Awaited<ReturnType<VoiceFetchLike>> {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => text
  };
}

function captureFetch(result: Awaited<ReturnType<VoiceFetchLike>>): { fetch: VoiceFetchLike; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return result;
    }
  };
}

async function audioFile(extension = "wav"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-stt-provider-test-"));
  const path = join(dir, `voice.${extension}`);
  await writeFile(path, "audio");
  return path;
}

describe("hosted STT provider dispatch", () => {
  it("resolves OpenAI STT keys with direct-env audio precedence", async () => {
    await withEnv({
      CUSTOM_OPENAI_STT_KEY: "configured-key",
      VOICE_TOOLS_OPENAI_KEY: "voice-key",
      OPENAI_API_KEY: "openai-key"
    }, async () => {
      const path = await audioFile();
      const captured = captureFetch(response(JSON.stringify({ text: "openai transcript" })));
      const result = await transcribeSpeech({
        path,
        stt: {
          provider: "openai",
          enabled: true,
          openai: { apiKeyEnv: "CUSTOM_OPENAI_STT_KEY" }
        },
        fetch: captured.fetch
      });

      expect(result.ok).toBe(true);
      expect(captured.requests[0]?.init?.headers).toEqual({ authorization: "Bearer configured-key" });
    });
  });

  it("does not fall back to OPENAI_API_KEY for a missing custom OpenAI STT env", async () => {
    await withEnv({
      CUSTOM_OPENAI_STT_KEY: undefined,
      VOICE_TOOLS_OPENAI_KEY: undefined,
      OPENAI_API_KEY: "openai-key"
    }, async () => {
      expect(checkSttProviderStatus("openai", {
        provider: "openai",
        enabled: true,
        openai: { apiKeyEnv: "CUSTOM_OPENAI_STT_KEY" }
      })).toEqual({
        ready: false,
        reason: "Missing CUSTOM_OPENAI_STT_KEY or VOICE_TOOLS_OPENAI_KEY"
      });
    });
  });

  it("allows OPENAI_API_KEY fallback only for the default OpenAI audio key", async () => {
    await withEnv({
      VOICE_TOOLS_OPENAI_KEY: undefined,
      OPENAI_API_KEY: "openai-key"
    }, async () => {
      const path = await audioFile();
      const captured = captureFetch(response(JSON.stringify({ text: "openai transcript" })));
      const result = await transcribeSpeech({
        path,
        stt: {
          provider: "openai",
          enabled: true,
          openai: { apiKeyEnv: "VOICE_TOOLS_OPENAI_KEY" }
        },
        fetch: captured.fetch
      });

      expect(result.ok).toBe(true);
      expect(captured.requests[0]?.init?.headers).toEqual({ authorization: "Bearer openai-key" });
    });
  });

  it("sends xAI native multipart STT requests and preserves optional metadata", async () => {
    await withEnv({ XAI_API_KEY: "xai-key" }, async () => {
      const path = await audioFile();
      const captured = captureFetch(response(JSON.stringify({
        text: "xai transcript",
        duration: 1.5,
        language: "en",
        words: [{ word: "xai" }],
        channels: [{ index: 0 }]
      })));

      const result = await transcribeSpeech({
        path,
        stt: {
          provider: "xai",
          enabled: true,
          xai: {
            baseUrl: "https://api.x.ai/v1",
            apiKeyEnv: "XAI_API_KEY",
            language: "en",
            format: "json",
            diarize: true,
            keyterms: ["EstaCoda"],
            fillerWords: true
          }
        },
        fetch: captured.fetch
      });

      expect(result.ok).toBe(true);
      expect(result.ok && result.text).toBe("xai transcript");
      expect(result.ok && result.duration).toBe(1.5);
      expect(result.ok && result.words).toEqual([{ word: "xai" }]);
      expect(result.ok && result.channels).toEqual([{ index: 0 }]);
      expect(captured.requests[0]?.url).toBe("https://api.x.ai/v1/stt");
      expect(captured.requests[0]?.init?.headers).toEqual({ authorization: "Bearer xai-key" });
      const entries = [...(captured.requests[0]?.init?.body as FormData).entries()];
      expect(entries.map(([key]) => key).at(-1)).toBe("file");
      expect(entries.map(([key]) => key)).toEqual(expect.arrayContaining(["language", "format", "diarize", "keyterms", "filler_words", "file"]));
    });
  });

  it("keeps OpenAI and Groq STT compatible with their existing transcription endpoint", async () => {
    await withEnv({ VOICE_TOOLS_OPENAI_KEY: "openai-key", GROQ_API_KEY: "groq-key" }, async () => {
      const path = await audioFile();
      const openai = captureFetch(response(JSON.stringify({ text: "openai transcript" })));
      const groq = captureFetch(response(JSON.stringify({ text: "groq transcript" })));

      expect(await transcribeSpeech({
        path,
        stt: { provider: "openai", enabled: true, openai: { apiKeyEnv: "VOICE_TOOLS_OPENAI_KEY" } },
        fetch: openai.fetch
      })).toMatchObject({ ok: true, text: "openai transcript", model: "whisper-1" });
      expect(await transcribeSpeech({
        path,
        stt: { provider: "groq", enabled: true, groq: { apiKeyEnv: "GROQ_API_KEY" } },
        fetch: groq.fetch
      })).toMatchObject({ ok: true, text: "groq transcript", model: "whisper-large-v3" });
      expect(openai.requests[0]?.url).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect(groq.requests[0]?.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    });
  });

  it("marks xAI STT ready only when its configured env key exists", async () => {
    await withEnv({ XAI_API_KEY: undefined }, async () => {
      expect(checkSttProviderStatus("xai", { provider: "xai", enabled: true, xai: { apiKeyEnv: "XAI_API_KEY" } })).toEqual({
        ready: false,
        reason: "Missing XAI_API_KEY"
      });
    });
    await withEnv({ XAI_API_KEY: "xai-key" }, async () => {
      expect(checkSttProviderStatus("xai", { provider: "xai", enabled: true, xai: { apiKeyEnv: "XAI_API_KEY" } })).toEqual({ ready: true });
    });
  });

  it("fails structurally on empty and invalid hosted STT responses", async () => {
    await withEnv({ VOICE_TOOLS_OPENAI_KEY: "openai-key", OPENAI_API_KEY: undefined }, async () => {
      const path = await audioFile();
      const empty = await transcribeSpeech({
        path,
        stt: { provider: "openai", enabled: true, openai: { apiKeyEnv: "VOICE_TOOLS_OPENAI_KEY" } },
        fetch: captureFetch(response(JSON.stringify({ text: "   " }))).fetch
      });
      expect(empty).toMatchObject({
        ok: false,
        metadata: { provider: "openai", reason: "empty-transcript" }
      });

      const invalid = await transcribeSpeech({
        path,
        stt: { provider: "openai", enabled: true, openai: { apiKeyEnv: "VOICE_TOOLS_OPENAI_KEY" } },
        fetch: captureFetch(response(JSON.stringify({ model: "whisper-1" }))).fetch
      });
      expect(invalid).toMatchObject({
        ok: false,
        metadata: { provider: "openai", reason: "invalid-transcript-response" }
      });
    });
  });
});

describe("local command STT", () => {
  it("prefers stdout transcripts", async () => {
    const path = await audioFile();
    const result = await transcribeSpeech({
      path,
      stt: { provider: "local", enabled: true, local: { command: "printf stdout-transcript" } }
    });

    expect(result).toMatchObject({ ok: true, text: "stdout-transcript" });
  });

  it("reads .txt files from output_dir when stdout is empty", async () => {
    const path = await audioFile();
    const result = await transcribeSpeech({
      path,
      stt: {
        provider: "local",
        enabled: true,
        local: { command: "printf output-dir-transcript > {output_dir}/transcript.txt" }
      }
    });

    expect(result).toMatchObject({ ok: true, text: "output-dir-transcript" });
  });

  it("normalizes non-WAV input with ffmpeg when available", async () => {
    const path = await audioFile("ogg");
    const dir = await mkdtemp(join(tmpdir(), "estacoda-ffmpeg-test-"));
    const logPath = join(dir, "ffmpeg.log");
    const ffmpeg = join(dir, "ffmpeg");
    await writeFile(ffmpeg, `#!/usr/bin/env bash\nif [ "$1" = "-version" ]; then exit 0; fi\necho "$@" >> ${JSON.stringify(logPath)}\ntouch "\${!#}"\n`, "utf8");
    await chmod(ffmpeg, 0o755);

    const result = await transcribeSpeech({
      path,
      tempRoot: dir,
      stt: {
        provider: "local",
        enabled: true,
        local: { command: "printf normalized:{input_path}", ffmpegPath: ffmpeg }
      }
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.text).toContain(".wav");
    expect(await readFile(logPath, "utf8")).toContain(path);
  });

  it("reports empty local command output as stdout or output_dir .txt failure", async () => {
    const path = await audioFile();
    const result = await transcribeSpeech({
      path,
      stt: { provider: "local", enabled: true, local: { command: "true" } }
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.content).toContain("stdout or in .txt files under output_dir");
  });
});

describe("STT risk classification", () => {
  const localCommand: LoadedRuntimeConfig["stt"] = {
    provider: "local",
    enabled: true,
    local: { command: "printf transcript", normalizeWithFfmpeg: false }
  };

  it("detects faster-whisper mode while command mode wins explicitly", () => {
    expect(isFasterWhisperConfig({
      provider: "local",
      enabled: true,
      local: { engine: "faster-whisper" }
    })).toBe(true);
    expect(isFasterWhisperConfig({
      provider: "local",
      enabled: true,
      local: { fasterWhisper: { enabled: true } }
    })).toBe(true);
    expect(isFasterWhisperConfig({
      provider: "local",
      enabled: true,
      local: {
        engine: "command",
        fasterWhisper: { enabled: true }
      }
    })).toBe(false);
  });

  it("matches the Stage 2 risk-class matrix", () => {
    expect(computeSttRiskClass({ stt: localCommand, path: "/tmp/a.wav" })).toEqual({
      available: true,
      riskClass: "read-only-local"
    });
    expect(computeSttRiskClass({
      stt: { ...localCommand, local: { command: "printf transcript", normalizeWithFfmpeg: true } },
      path: "/tmp/a.ogg",
      ffmpegAvailable: true
    })).toEqual({ available: true, riskClass: "workspace-write" });
    expect(computeSttRiskClass({
      stt: {
        provider: "local",
        enabled: true,
        local: { engine: "faster-whisper", fasterWhisper: { enabled: true, modelCached: true } }
      }
    })).toEqual({ available: true, riskClass: "workspace-write" });
    expect(computeSttRiskClass({
      stt: {
        provider: "local",
        enabled: true,
        local: { engine: "faster-whisper", fasterWhisper: { enabled: true, allowModelDownload: true } }
      }
    })).toEqual({ available: true, riskClass: "external-side-effect" });
    expect(computeSttRiskClass({
      stt: {
        provider: "local",
        enabled: true,
        local: { engine: "faster-whisper", fasterWhisper: { enabled: true } }
      },
      gateway: true
    })).toEqual({
      available: false,
      riskClass: "unavailable",
      reason: "faster-whisper model download is not allowed"
    });
  });

  it("requires a managed faster-whisper worker before dispatch", async () => {
    const path = await audioFile();
    const result = await transcribeSpeech({
      path,
      stt: {
        provider: "local",
        enabled: true,
        local: { engine: "faster-whisper", fasterWhisper: { enabled: true, modelCached: true } }
      }
    });

    expect(result).toMatchObject({
      ok: false,
      metadata: { reason: "managed-worker-required" }
    });
  });

  it("checks the selected faster-whisper model cache instead of only hfHome/hub", async () => {
    const hfHome = await mkdtemp(join(tmpdir(), "estacoda-fw-cache-"));
    await mkdir(join(hfHome, "hub"), { recursive: true });
    const stt: LoadedRuntimeConfig["stt"] = {
      provider: "local",
      enabled: true,
      local: {
        engine: "faster-whisper",
        fasterWhisper: { enabled: true, hfHome, model: "small" }
      }
    };

    expect(isGatewayFasterWhisperDownloadDenied(stt)).toBe(true);

    await mkdir(join(hfHome, "hub", "models--Systran--faster-whisper-small"), { recursive: true });
    expect(isGatewayFasterWhisperDownloadDenied(stt)).toBe(false);
  });

  it("checks the default managed Hugging Face cache when hfHome is not configured", async () => {
    const defaultHfHome = await mkdtemp(join(tmpdir(), "estacoda-fw-default-cache-"));
    await mkdir(join(defaultHfHome, "hub", "models--Systran--faster-whisper-base"), { recursive: true });
    const stt: LoadedRuntimeConfig["stt"] = {
      provider: "local",
      enabled: true,
      local: {
        engine: "faster-whisper",
        model: "base",
        fasterWhisper: { enabled: true }
      }
    };

    expect(isGatewayFasterWhisperDownloadDenied(stt, undefined, defaultHfHome)).toBe(false);
  });
});
