import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type FasterWhisperPreset =
  | "tiny"
  | "base"
  | "small"
  | "medium"
  | "large-v1"
  | "large-v2"
  | "large-v3";

export type FasterWhisperWorkerRequest = {
  type: "probe" | "status" | "shutdown" | "transcribe";
  path?: string;
  model?: FasterWhisperPreset;
  device?: string;
  computeType?: string;
  language?: string;
  allowDownload?: boolean;
  hfHome?: string;
};

export type FasterWhisperWorkerResponse = {
  protocolVersion?: number;
  id?: string;
  ok: boolean;
  content?: string;
  text?: string;
  model?: string;
  language?: string;
  metadata?: Record<string, unknown>;
};

export type FasterWhisperWorker = {
  transcribe(request: Omit<FasterWhisperWorkerRequest, "type">): Promise<FasterWhisperWorkerResponse>;
  dispose?(): Promise<void>;
};

export type FasterWhisperClientOptions = {
  pythonBinary?: string;
  workerPath?: string;
  cwd?: string;
  queueDepth?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  killProcess?: (pid: number, signal: NodeJS.Signals) => boolean;
};

type PendingRequest = {
  id: string;
  request: FasterWhisperWorkerRequest;
  timeout?: ReturnType<typeof setTimeout>;
  resolve: (response: FasterWhisperWorkerResponse) => void;
};

export class FasterWhisperWorkerClient {
  readonly #pythonBinary: string;
  readonly #workerPath: string;
  readonly #cwd: string | undefined;
  readonly #queueDepth: number;
  readonly #timeoutMs: number;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #killProcess: (pid: number, signal: NodeJS.Signals) => boolean;
  #child: ChildProcessWithoutNullStreams | undefined;
  #starting: Promise<void> | undefined;
  #disposed = false;
  #unavailableReason: string | undefined;
  #nextId = 1;
  #active: PendingRequest | undefined;
  #queue: PendingRequest[] = [];
  #unexpectedExitCount = 0;

  constructor(options: FasterWhisperClientOptions = {}) {
    this.#pythonBinary = options.pythonBinary ?? "python3";
    this.#workerPath = options.workerPath ?? defaultFasterWhisperWorkerPath();
    this.#cwd = options.cwd;
    this.#queueDepth = options.queueDepth ?? 1;
    this.#timeoutMs = options.timeoutMs ?? 300_000;
    this.#env = options.env;
    this.#killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  }

  async probe(): Promise<FasterWhisperWorkerResponse> {
    return await this.request({ type: "probe" });
  }

  async status(): Promise<FasterWhisperWorkerResponse> {
    return await this.request({ type: "status" });
  }

  async transcribe(request: Omit<FasterWhisperWorkerRequest, "type">): Promise<FasterWhisperWorkerResponse> {
    const first = await this.request({ ...request, type: "transcribe" });
    if (!isCudaOrDeviceFailure(first)) {
      return first;
    }
    return await this.request({
      ...request,
      type: "transcribe",
      device: "cpu",
      computeType: "int8"
    });
  }

  async shutdown(): Promise<void> {
    this.#cancelAll({
      ok: false,
      content: "faster-whisper worker shutdown",
      metadata: { reason: "worker-shutdown" }
    });
    this.#killWorker("SIGTERM");
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#cancelAll({
      ok: false,
      content: "faster-whisper worker disposed",
      metadata: { reason: "worker-disposed" }
    });
    this.#killWorker("SIGTERM");
  }

  async request(request: FasterWhisperWorkerRequest): Promise<FasterWhisperWorkerResponse> {
    if (this.#disposed && request.type !== "shutdown") {
      return { ok: false, content: "faster-whisper worker is disposed" };
    }
    if (this.#unavailableReason !== undefined && request.type !== "shutdown") {
      return {
        ok: false,
        content: `worker-unavailable: ${this.#unavailableReason}`,
        metadata: { reason: "worker-unavailable" }
      };
    }
    if (this.#active !== undefined || this.#queue.length > 0) {
      const queued = this.#queue.length + (this.#active === undefined ? 0 : 1);
      if (queued >= this.#queueDepth) {
        return {
          ok: false,
          content: `faster-whisper queue is full (${this.#queueDepth})`,
          metadata: { queueDepth: this.#queueDepth }
        };
      }
    }

    return await new Promise((resolve) => {
      const pending: PendingRequest = {
        id: String(this.#nextId++),
        request,
        resolve
      };
      this.#queue.push(pending);
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#active !== undefined) {
      return;
    }
    const next = this.#queue.shift();
    if (next === undefined) {
      return;
    }
    this.#active = next;
    const started = await this.#ensureStarted();
    if (!started.ok) {
      this.#finishActive(started);
      return;
    }

    next.timeout = setTimeout(() => {
      this.#markUnavailable({
        ok: false,
        content: `faster-whisper request timed out after ${this.#timeoutMs}ms`,
        metadata: { reason: "worker-unavailable", timeoutMs: this.#timeoutMs }
      });
      this.#killWorker("SIGKILL");
    }, this.#timeoutMs);

    this.#child!.stdin.write(`${JSON.stringify({
      protocolVersion: 1,
      id: next.id,
      ...next.request
    })}\n`);
  }

  async #ensureStarted(): Promise<{ ok: true } | { ok: false; content: string; metadata?: Record<string, unknown> }> {
    if (this.#child !== undefined) {
      return { ok: true };
    }
    if (this.#starting !== undefined) {
      await this.#starting;
      return this.#child === undefined
        ? { ok: false, content: "faster-whisper worker failed to start" }
        : { ok: true };
    }

    this.#starting = new Promise<void>((resolve) => {
      const child = spawn(this.#pythonBinary, [this.#workerPath], {
        cwd: this.#cwd,
        env: this.#env === undefined ? process.env : { ...process.env, ...this.#env },
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.#child = child;
      child.stderr.setEncoding("utf8");
      child.on("error", (error) => {
        this.#child = undefined;
        this.#finishActive({
          ok: false,
          content: `Failed to start faster-whisper worker: ${error.message}`
        });
        resolve();
      });
      child.on("exit", () => {
        this.#handleUnexpectedExit();
      });
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => this.#handleLine(line));
      resolve();
    }).finally(() => {
      this.#starting = undefined;
    });
    await this.#starting;
    return this.#child === undefined
      ? { ok: false, content: "faster-whisper worker failed to start" }
      : { ok: true };
  }

  #handleLine(line: string): void {
    let parsed: FasterWhisperWorkerResponse;
    try {
      parsed = JSON.parse(line) as FasterWhisperWorkerResponse;
    } catch (error) {
      this.#finishActive({
        ok: false,
        content: `Invalid faster-whisper worker JSON: ${error instanceof Error ? error.message : String(error)}`
      });
      return;
    }
    if (parsed.protocolVersion !== 1) {
      this.#finishActive({
        ok: false,
        content: `faster-whisper protocol mismatch: ${parsed.protocolVersion ?? "missing"}`,
        metadata: { protocolVersion: parsed.protocolVersion }
      });
      return;
    }
    this.#finishActive(parsed);
  }

  #handleUnexpectedExit(): void {
    this.#child = undefined;
    if (this.#disposed || this.#unavailableReason !== undefined) {
      return;
    }
    this.#unexpectedExitCount += 1;
    const active = this.#active;
    if (this.#unexpectedExitCount <= 1) {
      if (active !== undefined) {
        if (active.timeout !== undefined) {
          clearTimeout(active.timeout);
        }
        this.#active = undefined;
        this.#queue.unshift(active);
        void this.#drain();
      }
      return;
    }
    this.#markUnavailable({
      ok: false,
      content: "worker-unavailable: faster-whisper worker exited unexpectedly and restart was already used",
      metadata: { reason: "worker-unavailable" }
    });
  }

  #finishActive(response: FasterWhisperWorkerResponse): void {
    const active = this.#active;
    if (active === undefined) {
      return;
    }
    if (active.timeout !== undefined) {
      clearTimeout(active.timeout);
    }
    this.#active = undefined;
    active.resolve(response);
    void this.#drain();
  }

  #markUnavailable(response: FasterWhisperWorkerResponse): void {
    this.#unavailableReason = (response.content ?? "faster-whisper worker unavailable").replace(/^worker-unavailable:\s*/u, "");
    this.#cancelAll(response);
  }

  #cancelAll(response: FasterWhisperWorkerResponse): void {
    const active = this.#active;
    if (active !== undefined) {
      if (active.timeout !== undefined) {
        clearTimeout(active.timeout);
      }
      this.#active = undefined;
      active.resolve(response);
    }
    const queued = this.#queue.splice(0);
    for (const pending of queued) {
      if (pending.timeout !== undefined) {
        clearTimeout(pending.timeout);
      }
      pending.resolve(response);
    }
  }

  #killWorker(signal: NodeJS.Signals): void {
    const child = this.#child;
    this.#child = undefined;
    if (child === undefined || child.pid === undefined) {
      return;
    }
    if (process.platform !== "win32") {
      try {
        this.#killProcess(-child.pid, signal);
        return;
      } catch {
        // Fall through to the direct child as a best-effort fallback.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // Best-effort cleanup only; callers already receive stable cancellation.
    }
  }
}

export function defaultFasterWhisperWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../workers/faster-whisper/faster-whisper-worker.py");
}

function isCudaOrDeviceFailure(response: FasterWhisperWorkerResponse): boolean {
  if (response.ok) {
    return false;
  }
  const errorType = typeof response.metadata?.errorType === "string" ? response.metadata.errorType : "";
  const content = `${response.content ?? ""} ${errorType}`.toLowerCase();
  return content.includes("cuda") || content.includes("device");
}
