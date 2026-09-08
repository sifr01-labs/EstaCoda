export type CdpFetchLike = (url: string, init?: {
  method?: string;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export type CdpWebSocketEvent = {
  data?: unknown;
};

export type CdpWebSocketLike = {
  readonly readyState?: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: CdpWebSocketEvent) => void, options?: {
    once?: boolean;
  }): void;
};

export type CdpWebSocketFactory = (url: string) => CdpWebSocketLike;

export const CDP_REQUEST_TIMEOUT_MS = 15_000;

export type CdpSendOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export async function connectCdp(input: {
  webSocketUrl: string;
  webSocketFactory: CdpWebSocketFactory | undefined;
  requestTimeoutMs?: number;
}): Promise<CdpClient> {
  const factory = input.webSocketFactory ?? ((url) => {
    if (typeof WebSocket === "undefined") {
      throw new Error("WebSocket is not available in this runtime.");
    }

    return new WebSocket(url) as unknown as CdpWebSocketLike;
  });
  const socket = factory(input.webSocketUrl);

  await new Promise<void>((resolve, reject) => {
    if (socket.readyState === 1) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => reject(new Error("Timed out while connecting to CDP WebSocket.")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, {
      once: true
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("CDP WebSocket connection failed."));
    }, {
      once: true
    });
  });

  return new CdpClient(socket, { requestTimeoutMs: input.requestTimeoutMs });
}

export class CdpClient {
  #nextId = 1;
  #pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  #eventWaiters = new Map<string, Array<() => void>>();
  readonly #requestTimeoutMs: number;

  constructor(
    private readonly socket: CdpWebSocketLike,
    options: { requestTimeoutMs?: number } = {}
  ) {
    this.#requestTimeoutMs = normalizeTimeoutMs(options.requestTimeoutMs, CDP_REQUEST_TIMEOUT_MS);
    this.socket.addEventListener("message", (event) => {
      this.#handleMessage(event.data);
    });
    this.socket.addEventListener("close", () => {
      this.#rejectAll(new Error("CDP WebSocket closed."));
    });
    this.socket.addEventListener("error", () => {
      this.#rejectAll(new Error("CDP WebSocket errored."));
    });
  }

  send(method: string, params?: Record<string, unknown>, options: CdpSendOptions = {}): Promise<unknown> {
    const id = this.#nextId++;
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs, this.#requestTimeoutMs);

    if (options.signal?.aborted === true) {
      return Promise.reject(cdpAbortError(method));
    }

    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        this.#pending.delete(id);
        pending.reject(cdpAbortError(method));
      };
      const cleanup = () => {
        if (timeout !== undefined) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const pending = {
        resolve: (value: unknown) => {
          cleanup();
          resolve(value);
        },
        reject: (error: Error) => {
          cleanup();
          reject(error);
        }
      };
      this.#pending.set(id, pending);
      timeout = setTimeout(() => {
        this.#pending.delete(id);
        pending.reject(new Error(`Timed out waiting for CDP command ${method}.`));
      }, timeoutMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted === true) {
        onAbort();
        return;
      }
      try {
        this.socket.send(JSON.stringify({
          id,
          method,
          params
        }));
      } catch (error) {
        this.#pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error("CDP WebSocket send failed."));
      }
    });
  }

  waitFor(method: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      const waiter = () => {
        clearTimeout(timeout);
        resolve();
      };
      const waiters = this.#eventWaiters.get(method) ?? [];

      waiters.push(waiter);
      this.#eventWaiters.set(method, waiters);
    });
  }

  close(): void {
    this.socket.close();
  }

  #handleMessage(raw: unknown): void {
    const text = typeof raw === "string" ? raw : raw instanceof ArrayBuffer ? new TextDecoder().decode(raw) : String(raw ?? "");

    if (text.length === 0) {
      return;
    }

    const message = JSON.parse(text) as {
      id?: number;
      method?: string;
      result?: unknown;
      error?: {
        message?: string;
      };
    };

    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);

      if (pending === undefined) {
        return;
      }

      this.#pending.delete(message.id);

      if (message.error !== undefined) {
        pending.reject(new Error(message.error.message ?? "CDP command failed."));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (message.method !== undefined) {
      const waiters = this.#eventWaiters.get(message.method) ?? [];

      this.#eventWaiters.delete(message.method);

      for (const waiter of waiters) {
        waiter();
      }
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }

    this.#pending.clear();
  }
}

function normalizeTimeoutMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function cdpAbortError(method: string): Error {
  const error = new Error(`CDP command ${method} was cancelled.`);
  error.name = "AbortError";
  return error;
}
