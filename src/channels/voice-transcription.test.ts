import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChannelMessage } from "../contracts/channel.js";
import { injectVoiceTranscripts } from "./voice-transcription.js";
import { VoiceStateManager } from "../gateway/voice-state.js";

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "message-1",
    channel: "telegram",
    sessionKey: { platform: "telegram", chatId: "chat-1" },
    text: "",
    sender: { id: "sender-1" },
    receivedAt: "2026-05-22T00:00:00.000Z",
    ...overrides
  };
}

async function createRoots(): Promise<{ mediaRoot: string; audioRoot: string; outsideRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "estacoda-channel-voice-test-"));
  const mediaRoot = join(root, "channel-media");
  const audioRoot = join(root, "audio-cache");
  const outsideRoot = join(root, "outside");
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(audioRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  return { mediaRoot, audioRoot, outsideRoot };
}

describe("injectVoiceTranscripts", () => {
  it("leaves messages without ready audio attachments untouched", async () => {
    const input = message({
      text: "hello",
      attachments: [
        { id: "file-1", kind: "file", status: "ready", localPath: "/tmp/file.txt" },
        { id: "voice-1", kind: "voice", status: "download-failed", localPath: "/tmp/voice.ogg" }
      ]
    });

    const result = await injectVoiceTranscripts(input, {
      stt: { provider: "local", enabled: true, local: { command: "printf transcript" } }
    });

    expect(result).toBe(input);
  });

  it("rejects attachment paths outside allowed media and audio roots", async () => {
    const roots = await createRoots();
    const outsideAudio = join(roots.outsideRoot, "voice.ogg");
    await writeFile(outsideAudio, "audio");

    const result = await injectVoiceTranscripts(message({
      attachments: [
        { id: "voice-1", kind: "voice", status: "ready", localPath: outsideAudio, originalName: "voice.ogg" }
      ]
    }), {
      stt: { provider: "local", enabled: true, local: { command: "printf transcript" } },
      allowedRoots: [roots.mediaRoot, roots.audioRoot]
    });

    expect(result.text).toContain("[Voice transcript unavailable for voice.ogg]");
    expect(result.text).toContain("outside");
    expect(result.metadata?.voiceTranscription).toEqual({ injected: true, count: 1 });
  });

  it("formats transcript text and removes the original audio attachment from model context", async () => {
    const roots = await createRoots();
    const audio = join(roots.mediaRoot, "voice.ogg");
    await writeFile(audio, "audio");

    const result = await injectVoiceTranscripts(message({
      text: "Please summarize this.",
      attachments: [
        { id: "file-1", kind: "file", status: "ready", localPath: join(roots.mediaRoot, "file.txt") },
        { id: "voice-1", kind: "audio", status: "ready", localPath: audio, originalName: "voice.ogg" }
      ]
    }), {
      stt: { provider: "local", enabled: true, local: { command: "printf transcript" } },
      allowedRoots: [roots.mediaRoot, roots.audioRoot]
    });

    expect(result.text).toBe("Please summarize this.\n\n[Voice message transcript]\ntranscript");
    expect(result.attachments?.map((attachment) => attachment.id)).toEqual(["file-1"]);
    expect(result.metadata?.voiceTranscription).toMatchObject({
      injected: true,
      count: 1,
      transcripts: [
        expect.objectContaining({
          attachmentId: "voice-1",
          text: "transcript",
          hash: expect.any(String),
          timestamp: expect.any(String)
        })
      ]
    });
  });

  it("continues with unavailable transcript notes when STT execution fails", async () => {
    const roots = await createRoots();
    const audio = join(roots.audioRoot, "voice.ogg");
    await writeFile(audio, "audio");

    const result = await injectVoiceTranscripts(message({
      attachments: [
        { id: "voice-1", kind: "voice", status: "ready", localPath: audio }
      ]
    }), {
      stt: { provider: "local", enabled: true },
      allowedRoots: [roots.mediaRoot, roots.audioRoot]
    });

    expect(result.text).toContain("[Voice transcript unavailable for voice-1]");
    expect(result.text).toContain("Local STT command not configured");
    expect(result.metadata?.voiceTranscription).toEqual({ injected: true, count: 1 });
  });

  it("denies gateway faster-whisper first-run downloads before worker startup", async () => {
    const roots = await createRoots();
    const audio = join(roots.mediaRoot, "voice.ogg");
    await writeFile(audio, "audio");
    const events: unknown[] = [];

    const result = await injectVoiceTranscripts(message({
      attachments: [
        { id: "voice-1", kind: "voice", status: "ready", localPath: audio, bytes: 5 }
      ]
    }), {
      stt: {
        provider: "local",
        enabled: true,
        local: { engine: "faster-whisper", fasterWhisper: { enabled: true, modelCached: false } }
      },
      allowedRoots: [roots.mediaRoot, roots.audioRoot],
      audit: (event) => {
        events.push(event);
      }
    });

    expect(result.text).toContain("first-run model downloads are disabled");
    expect(events).toEqual([
      expect.objectContaining({
        outcome: "deny",
        provider: "local",
        attachment: expect.objectContaining({ id: "voice-1", pathHash: expect.any(String) })
      })
    ]);
    expect(JSON.stringify(events)).not.toContain(audio);
  });

  it("denies faster-whisper when no runtime-owned worker is available", async () => {
    const roots = await createRoots();
    const audio = join(roots.mediaRoot, "voice.ogg");
    await writeFile(audio, "audio");

    const result = await injectVoiceTranscripts(message({
      attachments: [
        { id: "voice-1", kind: "voice", status: "ready", localPath: audio }
      ]
    }), {
      stt: {
        provider: "local",
        enabled: true,
        local: { engine: "faster-whisper", fasterWhisper: { enabled: true, modelCached: true } }
      },
      allowedRoots: [roots.mediaRoot, roots.audioRoot]
    });

    expect(result.text).toContain("requires a runtime-owned worker resource");
  });

  it("uses the runtime-owned faster-whisper worker when provided", async () => {
    const roots = await createRoots();
    const audio = join(roots.mediaRoot, "voice.ogg");
    await writeFile(audio, "audio");
    const transcribe = vi.fn(async () => ({ ok: true, text: "managed transcript", model: "base" }));

    const result = await injectVoiceTranscripts(message({
      attachments: [
        { id: "voice-1", kind: "voice", status: "ready", localPath: audio, originalName: "voice.ogg" }
      ]
    }), {
      stt: {
        provider: "local",
        enabled: true,
        local: { engine: "faster-whisper", fasterWhisper: { enabled: true, modelCached: true } }
      },
      allowedRoots: [roots.mediaRoot, roots.audioRoot],
      localWhisper: { transcribe } as any
    });

    expect(result.text).toContain("[Voice message transcript]\nmanaged transcript");
    expect(result.attachments).toEqual([]);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("suppresses duplicate successful transcripts for the same chat", async () => {
    const roots = await createRoots();
    const audioOne = join(roots.mediaRoot, "voice-1.ogg");
    const audioTwo = join(roots.mediaRoot, "voice-2.ogg");
    await writeFile(audioOne, "audio");
    await writeFile(audioTwo, "audio");
    const stateDir = await mkdtemp(join(tmpdir(), "estacoda-voice-dedupe-"));
    const voiceStateManager = new VoiceStateManager({ path: join(stateDir, "gateway", "voice-mode.json") });

    const first = await injectVoiceTranscripts(message({
      attachments: [
        { id: "voice-1", kind: "voice", status: "ready", localPath: audioOne }
      ]
    }), {
      stt: { provider: "local", enabled: true, local: { command: "printf 'Please summarize this deployment plan.'" } },
      allowedRoots: [roots.mediaRoot, roots.audioRoot],
      voiceStateManager
    });
    const second = await injectVoiceTranscripts(message({
      text: "next",
      attachments: [
        { id: "voice-2", kind: "voice", status: "ready", localPath: audioTwo }
      ]
    }), {
      stt: { provider: "local", enabled: true, local: { command: "printf 'please summarize this deployment plan'" } },
      allowedRoots: [roots.mediaRoot, roots.audioRoot],
      voiceStateManager
    });

    expect(first.text).toContain("[Voice message transcript]");
    expect(second.text).toBe("next");
    expect(second.attachments).toEqual([]);
    expect(second.metadata?.voiceTranscription).toEqual({ injected: true, count: 0 });
  });

  it("applies duplicate suppression to Discord voice-channel transcripts", async () => {
    const roots = await createRoots();
    const audioOne = join(roots.mediaRoot, "discord-voice-1.wav");
    const audioTwo = join(roots.mediaRoot, "discord-voice-2.wav");
    await writeFile(audioOne, "audio");
    await writeFile(audioTwo, "audio");
    const stateDir = await mkdtemp(join(tmpdir(), "estacoda-voice-dedupe-discord-"));
    const voiceStateManager = new VoiceStateManager({ path: join(stateDir, "gateway", "voice-mode.json") });
    const base = message({
      channel: "discord",
      sessionKey: { platform: "discord", chatId: "discord-chat-1", accountId: "guild-1", userId: "user-1" },
      metadata: { guildId: "guild-1", channelId: "discord-chat-1", voiceChannel: true }
    });

    const first = await injectVoiceTranscripts({
      ...base,
      attachments: [{ id: "voice-1", kind: "voice", status: "ready", localPath: audioOne }]
    }, {
      stt: { provider: "local", enabled: true, local: { command: "printf 'Please summarize this deployment plan.'" } },
      allowedRoots: [roots.mediaRoot, roots.audioRoot],
      voiceStateManager
    });
    const second = await injectVoiceTranscripts({
      ...base,
      id: "message-2",
      attachments: [{ id: "voice-2", kind: "voice", status: "ready", localPath: audioTwo }]
    }, {
      stt: { provider: "local", enabled: true, local: { command: "printf 'please summarize this deployment plan'" } },
      allowedRoots: [roots.mediaRoot, roots.audioRoot],
      voiceStateManager
    });

    expect(first.text).toContain("[Voice message transcript]");
    expect(second.text).toBe("");
    expect(second.attachments).toEqual([]);
    expect(second.metadata?.voiceTranscription).toEqual({ injected: true, count: 0 });
  });

  it("denies gateway faster-whisper when hfHome hub exists but the selected model is absent", async () => {
    const roots = await createRoots();
    const hfHome = await mkdtemp(join(tmpdir(), "estacoda-fw-gateway-cache-"));
    await mkdir(join(hfHome, "hub"), { recursive: true });
    const audio = join(roots.mediaRoot, "voice.ogg");
    await writeFile(audio, "audio");
    const transcribe = vi.fn(async () => ({ ok: true, text: "should not run", model: "small" }));

    const result = await injectVoiceTranscripts(message({
      attachments: [
        { id: "voice-1", kind: "voice", status: "ready", localPath: audio }
      ]
    }), {
      stt: {
        provider: "local",
        enabled: true,
        local: { engine: "faster-whisper", fasterWhisper: { enabled: true, hfHome, model: "small" } }
      },
      allowedRoots: [roots.mediaRoot, roots.audioRoot],
      localWhisper: { transcribe } as any
    });

    expect(result.text).toContain("first-run model downloads are disabled");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("uses the default managed Hugging Face cache before denying gateway downloads", async () => {
    const roots = await createRoots();
    const defaultHfHome = await mkdtemp(join(tmpdir(), "estacoda-fw-default-gateway-cache-"));
    await mkdir(join(defaultHfHome, "hub", "models--Systran--faster-whisper-base"), { recursive: true });
    const audio = join(roots.mediaRoot, "voice.ogg");
    await writeFile(audio, "audio");
    const transcribe = vi.fn(async () => ({ ok: true, text: "cached transcript", model: "base" }));

    const result = await injectVoiceTranscripts(message({
      attachments: [
        { id: "voice-1", kind: "voice", status: "ready", localPath: audio }
      ]
    }), {
      stt: {
        provider: "local",
        enabled: true,
        local: { engine: "faster-whisper", model: "base", fasterWhisper: { enabled: true } }
      },
      allowedRoots: [roots.mediaRoot, roots.audioRoot],
      fasterWhisperDefaultHfHome: defaultHfHome,
      localWhisper: { transcribe } as any
    });

    expect(result.text).toContain("[Voice message transcript]\ncached transcript");
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("audits validation failures before provider dispatch", async () => {
    const roots = await createRoots();
    const audio = join(roots.mediaRoot, "voice.txt");
    await writeFile(audio, "not audio");
    const events: unknown[] = [];

    const result = await injectVoiceTranscripts(message({
      attachments: [
        { id: "voice-1", kind: "voice", status: "ready", localPath: audio }
      ]
    }), {
      stt: { provider: "local", enabled: true, local: { command: "printf should-not-run" } },
      allowedRoots: [roots.mediaRoot, roots.audioRoot],
      audit: (event) => {
        events.push(event);
      }
    });

    expect(result.text).toContain("Audio file type is not supported");
    expect(events).toEqual([
      expect.objectContaining({ outcome: "deny", reason: expect.stringContaining("not supported") })
    ]);
  });
});
