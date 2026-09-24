import { createHash } from "node:crypto";
import type { ToolResult, WebReadReuse } from "../contracts/tool.js";

const MAX_ENTRIES = 16;
const MAX_BYTES = 256_000;
const MAX_AGE_MS = 60_000;
/** Executor-owned, turn-local public-read observations. Never persisted. */
export class TurnWebReadCache {
  #epoch = 0;
  #configurationRevision = 0;
  #scope = "";
  #bytes = 0;
  readonly #entries = new Map<string, { result: ToolResult; callId: string; at: number; bytes: number }>();
  // Clearing observations must not erase provenance on an already-returned
  // result whose executor is still asynchronously persisting its receipt.
  readonly #receipts = new WeakMap<ToolResult, string>();
  constructor(private readonly now: () => number = Date.now) {}

  clear(): void {
    this.#epoch++;
    this.#entries.clear();
    this.#bytes = 0;
    this.#scope = "";
  }

  provenance(result: ToolResult): string | undefined { return this.#receipts.get(result); }

  bind(scope: string, callId: string): WebReadReuse {
    const turnEpoch = this.#epoch;
    return { configure: (generation) => {
      const combined = `${scope}:${generation}`;
      // A call from an ended turn may not re-enter the new turn's cache.
      if (turnEpoch !== this.#epoch) return { get: () => undefined, put: () => {}, forget: () => {} };
      if (combined !== this.#scope) {
        this.#entries.clear();
        this.#bytes = 0;
        this.#scope = combined;
        this.#configurationRevision++;
      }
      const revision = this.#configurationRevision;
      const current = () => turnEpoch === this.#epoch && this.#scope === combined && revision === this.#configurationRevision;
      const forget = (key: string) => {
        if (!current()) return;
        const old = this.#entries.get(key);
        if (old) this.#bytes -= old.bytes;
        this.#entries.delete(key);
      };
      return {
        get: (key) => {
          if (!current()) return undefined;
          const entry = this.#entries.get(key);
          if (!entry || this.now() < entry.at || this.now() - entry.at >= MAX_AGE_MS) return undefined;
          const result = structuredClone(entry.result);
          result.content = `Prior observation reused from ${entry.callId}; no new network retrieval.\n${result.content}`;
          result.metadata = {
            ...result.metadata, webReadReuse: true, sourceToolCallId: entry.callId,
            _estacoda_context_summary: `Prior web.extract observation reused from ${entry.callId}; no new network retrieval.`
          };
          this.#receipts.set(result, entry.callId);
          return result;
        },
        forget,
        put: (key, result) => {
          if (!current() || !result.ok) return;
          const bytes = Buffer.byteLength(JSON.stringify(result));
          if (bytes > MAX_BYTES) return;
          forget(key);
          while (this.#entries.size >= MAX_ENTRIES || this.#bytes + bytes > MAX_BYTES) {
            const oldest = this.#entries.keys().next().value;
            if (oldest === undefined) break;
            forget(oldest);
          }
          this.#entries.set(key, { result: structuredClone(result), callId, at: this.now(), bytes });
          this.#bytes += bytes;
        }
      };
    } };
  }
}

export function webReadFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
