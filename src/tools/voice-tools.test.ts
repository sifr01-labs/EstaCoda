import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { EDGE_TTS_CAPABILITY_ID, requireRegisteredPythonCapabilitySpec } from "../python-env/capability-registry.js";
import { resolveManagedPythonCapabilityPaths } from "../python-env/capability-paths.js";
import { writeManagedPythonCapabilityManifest } from "../python-env/manifest.js";
import { fingerprintManagedPythonCapabilitySpec } from "../python-env/spec-hash.js";
import type { EdgeTtsRunInput } from "./tts-providers.js";
import {
  checkSttProviderStatus,
  checkTtsProviderStatus,
  checkTtsProviderStatusWithCapabilities,
  createVoiceTools,
  synthesizeSpeechToEphemeralArtifact,
  type VoiceFetchLike
} from "./voice-tools.js";

function artifactStore(): ArtifactStore {
  let counter = 0;
  return new ArtifactStore({ id: () => `artifact-${++counter}` });
}

async function createRoots(): Promise<{ workspaceRoot: string; audioCacheRoot: string; outsideRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "estacoda-voice-test-"));
  const workspaceRoot = join(root, "workspace");
  const audioCacheRoot = join(root, "audio-cache");
  const outsideRoot = join(root, "outside");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(audioCacheRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  return { workspaceRoot, audioCacheRoot, outsideRoot };
}

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createVerifiedEdgeCapabilityState(): Promise<{ stateRoot: string; tempRoot: string }> {
  const stateRoot = await createTempDir("estacoda-voice-edge-state-");
  const tempRoot = await createTempDir("estacoda-voice-edge-temp-");
  const paths = resolveManagedPythonCapabilityPaths({
    stateRoot,
    capabilityId: EDGE_TTS_CAPABILITY_ID
  });
  await mkdir(dirname(paths.pythonPath), { recursive: true });
  await writeFile(paths.pythonPath, "", "utf8");
  const spec = requireRegisteredPythonCapabilitySpec(EDGE_TTS_CAPABILITY_ID);
  await writeManagedPythonCapabilityManifest({
    stateRoot,
    capabilityId: EDGE_TTS_CAPABILITY_ID
  }, {
    id: EDGE_TTS_CAPABILITY_ID,
    version: spec.version,
    specHash: fingerprintManagedPythonCapabilitySpec(spec),
    installedPackages: [...spec.packages],
    installedGroups: [],
    pythonPath: paths.pythonPath,
    envPath: paths.envPath,
    createdAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:00:00.000Z",
    verifiedAt: "2026-06-23T00:00:01.000Z",
    status: "verified"
  });
  return { stateRoot, tempRoot };
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

function fakeOpenAiSpeechFetch(bytes = Buffer.from("audio")): VoiceFetchLike {
  return async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => JSON.stringify({ text: "transcript" })
  });
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("voice tool readiness", () => {
  it("advertises edge TTS as available when enabled", async () => {
    const roots = await createRoots();
    const tts: LoadedRuntimeConfig["tts"] = { provider: "edge", speed: 1, enabled: true };
    const tools = createVoiceTools({
      ...roots,
      artifactStore: artifactStore(),
      tts,
      stt: { provider: "local", enabled: true, local: { command: "printf transcript" } }
    });

    const speak = tools.find((tool) => tool.name === "voice.speak");
    expect(speak?.isAvailable()).toBe(true);
    expect(checkTtsProviderStatus("edge", tts)).toEqual({ ready: true });
  });

  it("reports Edge TTS as not ready when its managed Python capability is missing", async () => {
    const stateRoot = await createTempDir("estacoda-voice-edge-missing-status-");
    const tts: LoadedRuntimeConfig["tts"] = { provider: "edge", speed: 1, enabled: true };
    const paths = resolveManagedPythonCapabilityPaths({
      stateRoot,
      capabilityId: EDGE_TTS_CAPABILITY_ID
    });

    const status = await checkTtsProviderStatusWithCapabilities("edge", tts, { pythonStateRoot: stateRoot });

    expect(status.ready).toBe(false);
    if (!status.ready) {
      expect(status.reason).toContain("Edge TTS managed Python capability is not ready.");
      expect(status.reason).toContain("estacoda python-env setup edge-tts --yes");
      expect(status.reason).toContain("estacoda python-env verify edge-tts");
    }
    await expect(stat(paths.envPath)).rejects.toThrow();
  });

  it("reports Edge TTS as ready when its managed Python capability is verified", async () => {
    const edgeState = await createVerifiedEdgeCapabilityState();
    const tts: LoadedRuntimeConfig["tts"] = { provider: "edge", speed: 1, enabled: true };

    await expect(checkTtsProviderStatusWithCapabilities("edge", tts, {
      pythonStateRoot: edgeState.stateRoot
    })).resolves.toEqual({ ready: true });
  });

  it("keeps non-Edge TTS readiness behavior independent from managed Python capability checks", async () => {
    const tts: LoadedRuntimeConfig["tts"] = {
      provider: "openai",
      speed: 1,
      enabled: true,
      openai: { apiKeyEnv: "VOICE_TOOLS_OPENAI_KEY" }
    };

    await withEnv({ VOICE_TOOLS_OPENAI_KEY: "present" }, async () => {
      await expect(checkTtsProviderStatusWithCapabilities("openai", tts, {
        pythonStateRoot: "/missing"
      })).resolves.toEqual({ ready: true });
    });
  });

  it("classifies edge TTS as an external side effect", async () => {
    const roots = await createRoots();
    const tools = createVoiceTools({
      ...roots,
      artifactStore: artifactStore(),
      tts: { provider: "edge", speed: 1, enabled: true },
      stt: { provider: "local", enabled: true, local: { command: "printf transcript" } }
    });

    const speak = tools.find((tool) => tool.name === "voice.speak");
    expect(speak?.riskClass).toBe("external-side-effect");
  });

  it("advertises OpenAI TTS only when a key is present", async () => {
    await withEnv({ VOICE_TOOLS_OPENAI_KEY: "sk-test", OPENAI_API_KEY: undefined }, async () => {
      const roots = await createRoots();
      const tts: LoadedRuntimeConfig["tts"] = {
        provider: "openai",
        enabled: true,
        speed: 1,
        openai: { apiKeyEnv: "VOICE_TOOLS_OPENAI_KEY" }
      };
      const tools = createVoiceTools({
        ...roots,
        artifactStore: artifactStore(),
        tts,
        fetch: fakeOpenAiSpeechFetch()
      });

      const speak = tools.find((tool) => tool.name === "voice.speak");
      expect(speak?.isAvailable()).toBe(true);
      expect(checkTtsProviderStatus("openai", tts)).toEqual({ ready: true });
    });
  });

  it("does not treat OPENAI_API_KEY as an OpenAI audio fallback for custom env names", async () => {
    await withEnv({
      CUSTOM_OPENAI_AUDIO_KEY: undefined,
      VOICE_TOOLS_OPENAI_KEY: undefined,
      OPENAI_API_KEY: "sk-global"
    }, async () => {
      const tts: LoadedRuntimeConfig["tts"] = {
        provider: "openai",
        enabled: true,
        speed: 1,
        openai: { apiKeyEnv: "CUSTOM_OPENAI_AUDIO_KEY" }
      };

      expect(checkTtsProviderStatus("openai", tts)).toEqual({
        ready: false,
        reason: "Missing CUSTOM_OPENAI_AUDIO_KEY or VOICE_TOOLS_OPENAI_KEY"
      });
    });
  });

  it("advertises Stage 1 hosted TTS providers when their key is present", async () => {
    await withEnv({
      ELEVENLABS_API_KEY: "eleven-key",
      MINIMAX_API_KEY: "minimax-key",
      GEMINI_API_KEY: "gemini-key",
      XAI_API_KEY: "xai-key"
    }, async () => {
      expect(checkTtsProviderStatus("elevenlabs", {
        provider: "elevenlabs",
        enabled: true,
        speed: 1,
        elevenlabs: { apiKeyEnv: "ELEVENLABS_API_KEY" }
      })).toEqual({ ready: true });
      expect(checkTtsProviderStatus("minimax", {
        provider: "minimax",
        enabled: true,
        speed: 1,
        minimax: { apiKeyEnv: "MINIMAX_API_KEY" }
      })).toEqual({ ready: true });
      expect(checkTtsProviderStatus("gemini", {
        provider: "gemini",
        enabled: true,
        speed: 1,
        gemini: { apiKeyEnv: "GEMINI_API_KEY" }
      })).toEqual({ ready: true });
      expect(checkTtsProviderStatus("xai", {
        provider: "xai",
        enabled: true,
        speed: 1,
        xai: { apiKeyEnv: "XAI_API_KEY" }
      })).toEqual({ ready: true });
    });
  });

  it("keeps unimplemented TTS providers unavailable", () => {
    expect(checkTtsProviderStatus("mistral", { provider: "mistral", enabled: true, speed: 1 })).toEqual({
      ready: false,
      reason: "mistral TTS is not implemented in v0.1.0 Stage 1"
    });
    expect(checkTtsProviderStatus("neutts", { provider: "neutts", enabled: true, speed: 1 })).toEqual({
      ready: false,
      reason: "neutts TTS is not implemented in v0.1.0 Stage 1"
    });
  });

  it("returns disabled reasons for TTS and STT readiness", () => {
    expect(checkTtsProviderStatus("openai", { provider: "openai", enabled: false, speed: 1 })).toEqual({
      ready: false,
      reason: "TTS disabled"
    });
    expect(checkSttProviderStatus("local", { provider: "local", enabled: false })).toEqual({
      ready: false,
      reason: "STT disabled"
    });
  });

  it("does not advertise local STT without a command in Stage 0", async () => {
    await withEnv({ ESTACODA_LOCAL_STT_COMMAND: undefined }, async () => {
      const roots = await createRoots();
      const stt: LoadedRuntimeConfig["stt"] = { provider: "local", enabled: true };
      const tools = createVoiceTools({
        ...roots,
        artifactStore: artifactStore(),
        tts: { provider: "edge", enabled: true, speed: 1 },
        stt
      });

      const transcribe = tools.find((tool) => tool.name === "voice.transcribe");
      expect(transcribe?.isAvailable()).toBe(false);
      expect(checkSttProviderStatus("local", stt)).toEqual({
        ready: false,
        reason: "Local STT command not configured"
      });
    });
  });

  it("advertises local STT when a command is configured", async () => {
    const roots = await createRoots();
    const stt: LoadedRuntimeConfig["stt"] = {
      provider: "local",
      enabled: true,
      local: { command: "printf transcript" }
    };
    const tools = createVoiceTools({
      ...roots,
      artifactStore: artifactStore(),
      stt
    });

    const transcribe = tools.find((tool) => tool.name === "voice.transcribe");
    expect(transcribe?.isAvailable()).toBe(true);
    expect(checkSttProviderStatus("local", stt)).toEqual({ ready: true });
  });
});

describe("ephemeral auto-TTS helper", () => {
  it("creates an ephemeral voice delivery artifact without recording durable artifacts", async () => {
    await withEnv({ VOICE_TOOLS_OPENAI_KEY: "sk-test", OPENAI_API_KEY: undefined }, async () => {
      const roots = await createRoots();
      const result = await synthesizeSpeechToEphemeralArtifact({
        text: "hello",
        tempRoot: roots.audioCacheRoot,
        tts: {
          provider: "openai",
          enabled: true,
          speed: 1,
          openai: { apiKeyEnv: "VOICE_TOOLS_OPENAI_KEY", model: "tts-test", voice: "alloy" }
        },
        fetch: fakeOpenAiSpeechFetch(),
        id: () => "auto-1"
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.artifact).toMatchObject({
          id: "auto-tts-auto-1",
          kind: "audio",
          mimeType: "audio/mpeg",
          metadata: {
            provider: "openai",
            model: "tts-test",
            voice: "alloy",
            format: "audio/mpeg",
            deliveryHint: "voice",
            ephemeral: true
          }
        });
        expect(await readFile(result.artifact.localPath ?? result.artifact.path)).toEqual(Buffer.from("audio"));
      }
    });
  });

  it("creates an ephemeral voice delivery artifact with edge TTS", async () => {
    const roots = await createRoots();
    const edgeState = await createVerifiedEdgeCapabilityState();
    const runner = vi.fn(async (input: EdgeTtsRunInput) => {
      await writeFile(input.outputPath, Buffer.from("edge-audio"));
      return { ok: true as const, outputPath: input.outputPath, mimeType: "audio/mpeg" };
    });
    const result = await synthesizeSpeechToEphemeralArtifact({
      text: "hello",
      tempRoot: roots.audioCacheRoot,
      pythonStateRoot: edgeState.stateRoot,
      tts: {
        provider: "edge",
        enabled: true,
        speed: 1,
        edge: { voice: "en-US-AriaNeural" }
      },
      edgeTtsRunner: runner,
      id: () => "edge-auto-1"
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact).toMatchObject({
        id: "auto-tts-edge-auto-1",
        kind: "audio",
        mimeType: "audio/mpeg",
        metadata: {
          provider: "edge",
          model: "edge",
          voice: "en-US-AriaNeural",
          format: "audio/mpeg",
          deliveryHint: "voice",
          ephemeral: true
        }
      });
      expect(await readFile(result.artifact.localPath ?? result.artifact.path)).toEqual(Buffer.from("edge-audio"));
    }
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      text: "hello",
      voice: "en-US-AriaNeural",
      rate: "+0%"
    }));
  });
});

describe("voice tool text caps", () => {
  const hostedProviders = [
    {
      provider: "openai" as const,
      env: { VOICE_TOOLS_OPENAI_KEY: "openai-key", OPENAI_API_KEY: undefined },
      tts: {
        provider: "openai" as const,
        enabled: true,
        speed: 1,
        openai: { apiKeyEnv: "VOICE_TOOLS_OPENAI_KEY" }
      },
      cap: 4096
    },
    {
      provider: "elevenlabs" as const,
      env: { ELEVENLABS_API_KEY: "eleven-key" },
      tts: {
        provider: "elevenlabs" as const,
        enabled: true,
        speed: 1,
        elevenlabs: { apiKeyEnv: "ELEVENLABS_API_KEY", modelId: "eleven_turbo_v2_5" }
      },
      cap: 2000
    },
    {
      provider: "minimax" as const,
      env: { MINIMAX_API_KEY: "minimax-key" },
      tts: {
        provider: "minimax" as const,
        enabled: true,
        speed: 1,
        minimax: { apiKeyEnv: "MINIMAX_API_KEY" }
      },
      cap: 4096
    },
    {
      provider: "gemini" as const,
      env: { GEMINI_API_KEY: "gemini-key" },
      tts: {
        provider: "gemini" as const,
        enabled: true,
        speed: 1,
        gemini: { apiKeyEnv: "GEMINI_API_KEY" }
      },
      cap: 4096
    },
    {
      provider: "xai" as const,
      env: { XAI_API_KEY: "xai-key" },
      tts: {
        provider: "xai" as const,
        enabled: true,
        speed: 1,
        xai: { apiKeyEnv: "XAI_API_KEY" }
      },
      cap: 4096
    }
  ];

  for (const { provider, env, tts, cap } of hostedProviders) {
    it(`rejects oversized input for ${provider}`, async () => {
      await withEnv(env, async () => {
        const roots = await createRoots();
        const speak = createVoiceTools({
          ...roots,
          artifactStore: artifactStore(),
          tts,
          fetch: async () => {
            throw new Error("fetch should not be called for oversized TTS input");
          }
        }).find((tool) => tool.name === "voice.speak");

        const result = await speak!.run({ text: "x".repeat(cap + 1) });
        expect(result.ok).toBe(false);
        expect(result.content).toBe(`Text exceeds provider max of ${cap} characters.`);
      });
    });
  }
});

describe("voice tool execution boundaries", () => {
  it("rejects transcription paths outside allowed roots", async () => {
    const roots = await createRoots();
    const outsideAudio = join(roots.outsideRoot, "voice.wav");
    await writeFile(outsideAudio, "audio");
    const transcribe = createVoiceTools({
      ...roots,
      artifactStore: artifactStore(),
      stt: { provider: "local", enabled: true, local: { command: "printf transcript" } }
    }).find((tool) => tool.name === "voice.transcribe");

    const result = await transcribe!.run({ path: outsideAudio });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("outside");
  });

  it("accepts transcription paths inside the workspace root", async () => {
    const roots = await createRoots();
    const audio = join(roots.workspaceRoot, "voice.wav");
    await writeFile(audio, "audio");
    const store = artifactStore();
    const transcribe = createVoiceTools({
      ...roots,
      artifactStore: store,
      stt: { provider: "local", enabled: true, local: { command: "printf transcript" } }
    }).find((tool) => tool.name === "voice.transcribe");

    const result = await transcribe!.run({ path: audio });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Transcript: transcript");
    expect(store.list()).toHaveLength(1);
  });

  it("accepts transcription paths inside the audio cache root", async () => {
    const roots = await createRoots();
    const audio = join(roots.audioCacheRoot, "voice.wav");
    await writeFile(audio, "audio");
    const store = artifactStore();
    const transcribe = createVoiceTools({
      ...roots,
      artifactStore: store,
      stt: { provider: "local", enabled: true, local: { command: "printf transcript" } }
    }).find((tool) => tool.name === "voice.transcribe");

    const result = await transcribe!.run({ path: audio });
    expect(result.ok).toBe(true);
    expect(store.list()).toHaveLength(1);
  });

  it("records OpenAI speech output as an audio artifact", async () => {
    await withEnv({ VOICE_TOOLS_OPENAI_KEY: "sk-test", OPENAI_API_KEY: undefined }, async () => {
      const roots = await createRoots();
      const store = artifactStore();
      const speak = createVoiceTools({
        ...roots,
        artifactStore: store,
        tts: {
          provider: "openai",
          enabled: true,
          speed: 1,
          openai: { apiKeyEnv: "VOICE_TOOLS_OPENAI_KEY", model: "gpt-4o-mini-tts", voice: "alloy" }
        },
        fetch: fakeOpenAiSpeechFetch(Buffer.from("speech-bytes")),
        id: () => "speech-id"
      }).find((tool) => tool.name === "voice.speak");

      const result = await speak!.run({ text: "hello" });
      expect(result.ok).toBe(true);
      expect(result.content).toContain("Provider: openai");
      const artifact = store.list()[0];
      expect(artifact.kind).toBe("audio");
      expect(artifact.mimeType).toBe("audio/mpeg");
      expect(await readFile(artifact.localPath!, "utf8")).toBe("speech-bytes");
    });
  });

  it("passes managed Python state and temp root into Edge voice.speak synthesis", async () => {
    const roots = await createRoots();
    const edgeState = await createVerifiedEdgeCapabilityState();
    const store = artifactStore();
    const runner = vi.fn(async (input: EdgeTtsRunInput) => {
      await writeFile(input.outputPath, Buffer.from("edge-speech"));
      return { ok: true as const, outputPath: input.outputPath, mimeType: "audio/mpeg" };
    });
    const speak = createVoiceTools({
      ...roots,
      artifactStore: store,
      tts: {
        provider: "edge",
        enabled: true,
        speed: 1.25,
        edge: { voice: "en-US-AriaNeural" }
      },
      pythonStateRoot: edgeState.stateRoot,
      tempRoot: edgeState.tempRoot,
      edgeTtsRunner: runner,
      id: () => "edge-speech-id"
    }).find((tool) => tool.name === "voice.speak");

    const result = await speak!.run({ text: "hello" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Provider: edge");
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      rate: "+25%",
      outputPath: expect.stringContaining(edgeState.tempRoot)
    }));
    const artifact = store.list()[0];
    expect(artifact.mimeType).toBe("audio/mpeg");
    expect(await readFile(artifact.localPath!, "utf8")).toBe("edge-speech");
  });
});

it('retains scoped speech once without leaving an ephemeral record pointing at the moved capture',async()=>{await withEnv({VOICE_TOOLS_OPENAI_KEY:'sk-test',OPENAI_API_KEY:undefined},async()=>{const root=await createTempDir('ec-speech-retention-'),store=new ArtifactStore({storageRoot:join(root,'artifacts')}),persist=vi.fn(async()=>{}),bytes=Buffer.from('ID3fixture-audio');const speak=createVoiceTools({audioCacheRoot:join(root,'audio'),artifactStore:store,profileId:'p',currentSessionId:()=> 's',persistSessionArtifact:persist,tts:{provider:'openai',enabled:true,speed:1,openai:{apiKeyEnv:'VOICE_TOOLS_OPENAI_KEY',model:'gpt-4o-mini-tts',voice:'alloy'}},fetch:fakeOpenAiSpeechFetch(bytes)}).find(t=>t.name==='voice.speak')!;expect((await speak.run({text:'hello'})).ok).toBe(true);expect(persist).toHaveBeenCalledTimes(1);expect(store.list()).toHaveLength(0);const retained=store.list({sessionId:'s',profileId:'p'});expect(retained).toHaveLength(1);expect(await readFile(retained[0]!.localPath!)).toEqual(bytes);});});
