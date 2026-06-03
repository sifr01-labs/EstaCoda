import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import {
  createManagedEnvironment,
  resolvePythonBinary,
  type PythonEnvironmentOptions
} from "./manager.js";
import {
  FasterWhisperWorkerClient,
  type FasterWhisperWorker,
  type FasterWhisperWorkerRequest,
  type FasterWhisperWorkerResponse
} from "../tools/stt-local-whisper.js";

export type ManagedFasterWhisperWorkerOptions = PythonEnvironmentOptions & {
  stt: LoadedRuntimeConfig["stt"];
  defaultHfHome: string;
};

export class ManagedFasterWhisperWorker implements FasterWhisperWorker {
  readonly #options: ManagedFasterWhisperWorkerOptions;
  #client: FasterWhisperWorkerClient | undefined;
  #starting: Promise<FasterWhisperWorkerClient | FasterWhisperWorkerResponse> | undefined;

  constructor(options: ManagedFasterWhisperWorkerOptions) {
    this.#options = options;
  }

  async transcribe(request: Omit<FasterWhisperWorkerRequest, "type">): Promise<FasterWhisperWorkerResponse> {
    const client = await this.#ensureClient();
    if (isWorkerResponse(client)) {
      return client;
    }
    return await client.transcribe(request);
  }

  async dispose(): Promise<void> {
    await this.#client?.dispose();
    this.#client = undefined;
  }

  async #ensureClient(): Promise<FasterWhisperWorkerClient | FasterWhisperWorkerResponse> {
    if (this.#client !== undefined) {
      return this.#client;
    }
    if (this.#starting !== undefined) {
      return await this.#starting;
    }
    this.#starting = this.#createClient().finally(() => {
      this.#starting = undefined;
    });
    return await this.#starting;
  }

  async #createClient(): Promise<FasterWhisperWorkerClient | FasterWhisperWorkerResponse> {
    const pythonBinaryOverride = this.#options.stt.local?.pythonBinary;
    let pythonBinary: string;
    if (pythonBinaryOverride !== undefined && pythonBinaryOverride.trim().length > 0) {
      pythonBinary = resolvePythonBinary({
        stateRoot: this.#options.stateRoot,
        configOverride: pythonBinaryOverride
      });
    } else {
      const envResult = await createManagedEnvironment({ stateRoot: this.#options.stateRoot });
      if (!envResult.ok) {
        return unavailableResponse(envResult.reason);
      }
      pythonBinary = envResult.pythonBinary;
    }

    const persistentHfHome = this.#options.stt.local?.fasterWhisper?.hfHome ?? this.#options.defaultHfHome;
    this.#client = new FasterWhisperWorkerClient({
      pythonBinary,
      queueDepth: this.#options.stt.local?.fasterWhisper?.queueDepth ?? 1,
      timeoutMs: this.#options.stt.local?.fasterWhisper?.timeoutMs ?? 300_000,
      env: {
        HF_HOME: persistentHfHome,
        TRANSFORMERS_CACHE: process.env.TRANSFORMERS_CACHE ?? persistentHfHome
      }
    });
    return this.#client;
  }
}

function unavailableResponse(reason: string): FasterWhisperWorkerResponse {
  return {
    ok: false,
    content: [
      "Local faster-whisper STT is unavailable because EstaCoda could not create its managed Python environment.",
      reason,
      "",
      "EstaCoda can still run; only local faster-whisper transcription is unavailable.",
      "Run `estacoda voice setup --stt-provider local` after installing Python venv support, or configure `--python-binary` to a Python with faster-whisper available."
    ].join("\n"),
    metadata: { provider: "local", reason: "managed-python-env-unavailable" }
  };
}

function isWorkerResponse(value: FasterWhisperWorkerClient | FasterWhisperWorkerResponse): value is FasterWhisperWorkerResponse {
  return typeof (value as FasterWhisperWorkerResponse).ok === "boolean";
}
