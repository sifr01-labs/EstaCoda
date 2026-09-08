import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChannelMessage } from "../contracts/channel.js";

const DEFAULT_RETENTION_MS = 10 * 60 * 1000;
const MAX_CAPTURED_MESSAGES = 256;

type ReplayState = {
  version: 1;
  captures: Array<{ key: string; expiresAt: string }>;
};

/** Persists only hashed Telegram delivery identity, never message text or secret metadata. */
export class TelegramSecureInputReplayStore {
  readonly #path: string;
  readonly #now: () => Date;
  readonly #retentionMs: number;
  readonly #captures = new Map<string, number>();
  #loaded = false;
  #mutation = Promise.resolve();

  constructor(options: { path: string; now?: () => Date; retentionMs?: number }) {
    this.#path = options.path;
    this.#now = options.now ?? (() => new Date());
    this.#retentionMs = Math.max(1, Math.trunc(options.retentionMs ?? DEFAULT_RETENTION_MS));
  }

  async has(message: ChannelMessage): Promise<boolean> {
    await this.#load();
    this.#prune();
    return this.#captures.has(replayKey(message));
  }

  async record(message: ChannelMessage): Promise<void> {
    const mutation = this.#mutation.then(async () => {
      await this.#load();
      this.#prune();
      this.#captures.set(replayKey(message), this.#now().getTime() + this.#retentionMs);
      while (this.#captures.size > MAX_CAPTURED_MESSAGES) {
        const oldest = [...this.#captures.entries()].sort((left, right) => left[1] - right[1])[0];
        if (oldest === undefined) break;
        this.#captures.delete(oldest[0]);
      }
      await this.#persist();
    });
    this.#mutation = mutation.catch(() => undefined);
    await mutation;
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    let parsed: ReplayState | undefined;
    try {
      parsed = JSON.parse(await readFile(this.#path, "utf8")) as ReplayState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.captures)) return;
    for (const capture of parsed.captures.slice(0, MAX_CAPTURED_MESSAGES)) {
      const expiresAt = Date.parse(capture.expiresAt);
      if (/^[a-f0-9]{64}$/u.test(capture.key) && Number.isFinite(expiresAt)) {
        this.#captures.set(capture.key, expiresAt);
      }
    }
    this.#prune();
  }

  #prune(): void {
    const now = this.#now().getTime();
    for (const [key, expiresAt] of this.#captures) {
      if (expiresAt <= now) this.#captures.delete(key);
    }
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const tempPath = `${this.#path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const state: ReplayState = {
      version: 1,
      captures: [...this.#captures.entries()].map(([key, expiresAt]) => ({
        key,
        expiresAt: new Date(expiresAt).toISOString()
      }))
    };
    await writeFile(tempPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.#path);
  }
}

function replayKey(message: ChannelMessage): string {
  return createHash("sha256").update(JSON.stringify([
    message.channel,
    message.sessionKey.accountId ?? "",
    message.sessionKey.chatId,
    message.sender.id,
    message.id
  ])).digest("hex");
}
