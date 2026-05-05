import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArtifactRecord } from "../contracts/artifact.js";
import type {
  ChannelAdapter,
  ChannelDelivery,
  ChannelKind,
  ChannelSessionKey,
  ChannelTextOptions
} from "../contracts/channel.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { SurfaceAdapter } from "../contracts/surface-adapter.js";
import type { ViewModel } from "../contracts/view-model.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";

export type DeliveryTarget =
  | { kind: "origin"; originalSessionKey: ChannelSessionKey }
  | { kind: "local"; path?: string }
  | { kind: "silent" }
  | { kind: "channel"; platform: ChannelKind; chatId?: string; threadId?: string; address?: string };

export type DeliveryRouterOptions = {
  homeDir?: string;
  maxOutputChars?: number;
  now?: () => Date;
};

export type DeliveryErrorRecord = {
  timestamp: string;
  target: string;
  error: string;
  retryCount: number;
};

const DEFAULT_MAX_OUTPUT = 4000;

export class DeliveryRouter {
  readonly #adapters = new Map<ChannelKind, ChannelAdapter>();
  readonly #homeDir: string;
  readonly #maxOutputChars: number;
  readonly #now: () => Date;
  #surfaceAdapter?: SurfaceAdapter;

  constructor(options: DeliveryRouterOptions = {}) {
    this.#homeDir = options.homeDir ?? process.env.HOME ?? process.cwd();
    this.#maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
    this.#now = options.now ?? (() => new Date());
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.#adapters.set(adapter.kind, adapter);
  }

  unregisterAdapter(kind: ChannelKind): void {
    this.#adapters.delete(kind);
  }

  setSurfaceAdapter(adapter: SurfaceAdapter | undefined): void {
    this.#surfaceAdapter = adapter;
  }

  get surfaceAdapter(): SurfaceAdapter | undefined {
    return this.#surfaceAdapter;
  }

  parseTarget(target: string, originalSessionKey: ChannelSessionKey): DeliveryTarget[] {
    const targets = target.split(",").map((t) => t.trim()).filter(Boolean);
    return targets.map((t) => this.#parseSingleTarget(t, originalSessionKey));
  }

  #parseSingleTarget(target: string, originalSessionKey: ChannelSessionKey): DeliveryTarget {
    const lower = target.toLowerCase();
    if (lower === "origin") {
      return { kind: "origin", originalSessionKey };
    }
    if (lower === "local") {
      return { kind: "local" };
    }
    if (lower === "silent" || lower.startsWith("[silent]")) {
      return { kind: "silent" };
    }

    const parts = target.split(":");
    const platform = parts[0] as ChannelKind;

    if (platform === "telegram") {
      return {
        kind: "channel",
        platform: "telegram",
        chatId: parts[1] ?? originalSessionKey.chatId,
        threadId: parts[2]
      };
    }
    if (platform === "discord") {
      return {
        kind: "channel",
        platform: "discord",
        chatId: parts[1] ?? originalSessionKey.chatId,
        threadId: parts[2]
      };
    }
    if (platform === "whatsapp") {
      return {
        kind: "channel",
        platform: "whatsapp",
        chatId: parts[1] ?? originalSessionKey.chatId
      };
    }
    if (platform === "email") {
      return {
        kind: "channel",
        platform: "email",
        address: parts[1]
      };
    }

    // Fallback: treat as origin if unrecognized
    return { kind: "origin", originalSessionKey };
  }

  async deliverText(
    targets: DeliveryTarget[],
    text: string,
    options?: ChannelTextOptions
  ): Promise<Map<string, { success: boolean; error?: string }>> {
    const results = new Map<string, { success: boolean; error?: string }>();

    for (const target of targets) {
      const targetKey = this.#targetToString(target);
      try {
        await this.#deliverSingleText(target, text, options);
        results.set(targetKey, { success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.set(targetKey, { success: false, error: message });
        await this.#recordDeliveryError(targetKey, message);
      }
    }

    return results;
  }

  async deliverViewModel(
    targets: DeliveryTarget[],
    viewModel: ViewModel,
    options?: ChannelTextOptions
  ): Promise<Map<string, { success: boolean; error?: string }>> {
    const text = this.#surfaceAdapter
      ? this.#surfaceAdapter.render(viewModel)
      : renderPlain(viewModel);
    return this.deliverText(targets, text, options);
  }

  async #deliverSingleText(
    target: DeliveryTarget,
    text: string,
    options?: ChannelTextOptions
  ): Promise<void> {
    if (target.kind === "silent") {
      return;
    }

    if (target.kind === "local") {
      const path = target.path ?? join(this.#homeDir, ".estacoda", "delivery", `${this.#now().toISOString()}.md`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf-8");
      return;
    }

    let sessionKey: ChannelSessionKey;
    let adapter: ChannelAdapter | undefined;

    if (target.kind === "origin") {
      sessionKey = target.originalSessionKey;
      adapter = this.#adapters.get(target.originalSessionKey.platform);
    } else if (target.kind === "channel") {
      sessionKey = {
        platform: target.platform,
        chatId: target.chatId ?? target.address ?? "unknown",
        threadId: target.threadId
      };
      adapter = this.#adapters.get(target.platform);
    } else {
      return;
    }

    if (!adapter?.delivery) {
      throw new Error(`No delivery adapter available for ${sessionKey.platform}`);
    }

    const truncated = this.#truncate(text, sessionKey.platform);
    await adapter.delivery.sendText(sessionKey, truncated.text, options);

    if (truncated.wasTruncated && truncated.fullPath) {
      // Full output already saved to disk during truncation
    }
  }

  async deliverProgress(
    target: DeliveryTarget,
    event: RuntimeEvent
  ): Promise<void> {
    if (target.kind === "silent" || target.kind === "local") {
      return;
    }

    let sessionKey: ChannelSessionKey;
    let adapter: ChannelAdapter | undefined;

    if (target.kind === "origin") {
      sessionKey = target.originalSessionKey;
      adapter = this.#adapters.get(target.originalSessionKey.platform);
    } else if (target.kind === "channel") {
      sessionKey = {
        platform: target.platform,
        chatId: target.chatId ?? target.address ?? "unknown",
        threadId: target.threadId
      };
      adapter = this.#adapters.get(target.platform);
    } else {
      return;
    }

    if (!adapter?.delivery?.sendProgress) {
      return;
    }

    try {
      await adapter.delivery.sendProgress(sessionKey, event);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.#recordDeliveryError(this.#targetToString(target), `progress: ${message}`);
    }
  }

  async deliverArtifact(
    target: DeliveryTarget,
    artifact: ArtifactRecord
  ): Promise<void> {
    if (target.kind === "silent" || target.kind === "local") {
      return;
    }

    let sessionKey: ChannelSessionKey;
    let adapter: ChannelAdapter | undefined;

    if (target.kind === "origin") {
      sessionKey = target.originalSessionKey;
      adapter = this.#adapters.get(target.originalSessionKey.platform);
    } else if (target.kind === "channel") {
      sessionKey = {
        platform: target.platform,
        chatId: target.chatId ?? target.address ?? "unknown",
        threadId: target.threadId
      };
      adapter = this.#adapters.get(target.platform);
    } else {
      return;
    }

    if (!adapter?.delivery?.sendArtifact) {
      return;
    }

    try {
      await adapter.delivery.sendArtifact(sessionKey, artifact);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.#recordDeliveryError(this.#targetToString(target), `artifact: ${message}`);
    }
  }

  #truncate(text: string, platform: ChannelKind): { text: string; wasTruncated: boolean; fullPath?: string } {
    if (text.length <= this.#maxOutputChars) {
      return { text, wasTruncated: false };
    }

    const truncated = text.slice(0, this.#maxOutputChars) + "\n\n[Output truncated. Full response saved to disk.]";
    const fullPath = join(this.#homeDir, ".estacoda", "delivery", "truncated", `${this.#now().toISOString()}_${platform}.md`);

    // Fire-and-forget save of full output
    mkdir(dirname(fullPath), { recursive: true })
      .then(() => writeFile(fullPath, text, "utf-8"))
      .catch(() => { /* ignore save errors */ });

    return { text: truncated, wasTruncated: true, fullPath };
  }

  #targetToString(target: DeliveryTarget): string {
    if (target.kind === "origin") return "origin";
    if (target.kind === "local") return "local";
    if (target.kind === "silent") return "silent";
    if (target.kind === "channel") {
      const parts = [target.platform, target.chatId, target.threadId].filter(Boolean);
      return parts.join(":");
    }
    return "unknown";
  }

  async #recordDeliveryError(target: string, error: string): Promise<void> {
    const record: DeliveryErrorRecord = {
      timestamp: this.#now().toISOString(),
      target,
      error,
      retryCount: 0
    };

    const path = join(this.#homeDir, ".estacoda", "gateway", "delivery-errors.jsonl");
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(record) + "\n", { flag: "a" });
    } catch {
      // ignore persistence errors
    }
  }

  getRegisteredPlatforms(): ChannelKind[] {
    return Array.from(this.#adapters.keys());
  }

  async getRecentErrors(limit = 20): Promise<DeliveryErrorRecord[]> {
    const path = join(this.#homeDir, ".estacoda", "gateway", "delivery-errors.jsonl");
    try {
      const content = await readFile(path, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      const records = lines
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line) as DeliveryErrorRecord;
          } catch {
            return undefined;
          }
        })
        .filter((r): r is DeliveryErrorRecord => r !== undefined);
      return records;
    } catch {
      return [];
    }
  }
}
