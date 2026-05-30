import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
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
import { resolveHomeDir } from "../config/home-dir.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import {
  HookRegistry,
  type GatewayHookEventName,
  type GatewayHookPayloadByName,
  sanitizeHookError,
} from "../gateway/hook-registry.js";

function emitDeliveryHook<N extends GatewayHookEventName>(
  hookRegistry: HookRegistry | undefined,
  name: N,
  payload: GatewayHookPayloadByName[N],
): void {
  try {
    const p = hookRegistry?.emit(name, payload);
    if (p) {
      p.catch(() => {});
    }
  } catch {
    // ignore sync throws from HookRegistry internals
  }
}

export type DeliveryTarget =
  | { kind: "origin"; originalSessionKey: ChannelSessionKey }
  | { kind: "local"; path?: string }
  | { kind: "silent" }
  | { kind: "channel"; platform: ChannelKind; chatId?: string; threadId?: string; address?: string };

export type DeliveryRouterOptions = {
  homeDir?: string;
  deliveryRoot?: string;
  deliveryErrorLogPath?: string;
  maxOutputChars?: number;
  now?: () => Date;
  hookRegistry?: HookRegistry;
};

export type DeliveryErrorRecord = {
  timestamp: string;
  target: string;
  error: string;
  retryCount: number;
};

export class DeliveryRouter {
  readonly #adapters = new Map<ChannelKind, ChannelAdapter>();
  readonly #homeDir: string;
  readonly #deliveryRoot: string;
  readonly #deliveryErrorLogPath: string;
  readonly #maxOutputChars: number | undefined;
  readonly #now: () => Date;
  #surfaceAdapter?: SurfaceAdapter;
  #hookRegistry?: HookRegistry;

  constructor(options: DeliveryRouterOptions = {}) {
    this.#homeDir = resolveHomeDir(options.homeDir);
    this.#deliveryRoot = options.deliveryRoot ?? join(this.#homeDir, ".estacoda", "delivery");
    this.#deliveryErrorLogPath = options.deliveryErrorLogPath ?? join(this.#homeDir, ".estacoda", "gateway", "delivery-errors.jsonl");
    this.#maxOutputChars = options.maxOutputChars;
    this.#now = options.now ?? (() => new Date());
    this.#hookRegistry = options.hookRegistry;
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
        const meta = await this.#deliverSingleText(target, text, options);
        results.set(targetKey, { success: true });
        emitDeliveryHook(this.#hookRegistry, "delivery:success", {
          kind: "text",
          target: this.#sanitizeHookTarget(target),
          platform: target.kind === "channel" ? target.platform : target.kind === "origin" ? target.originalSessionKey.platform : undefined,
          truncated: meta.truncated,
          overflowSaved: meta.overflowSaved,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.set(targetKey, { success: false, error: message });
        await this.#recordDeliveryError(targetKey, message);
        const { errorClass, errorMessage } = sanitizeHookError(err);
        emitDeliveryHook(this.#hookRegistry, "delivery:error", {
          kind: "text",
          target: this.#sanitizeHookTarget(target),
          platform: target.kind === "channel" ? target.platform : target.kind === "origin" ? target.originalSessionKey.platform : undefined,
          errorClass,
          errorMessage,
        });
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
  ): Promise<{ truncated?: boolean; overflowSaved?: boolean }> {
    if (target.kind === "silent") {
      return {};
    }

    if (target.kind === "local") {
      const path = target.path ?? join(this.#deliveryRoot, `${this.#now().toISOString()}.md`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf-8");
      return {};
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
      return {};
    }

    if (!adapter?.delivery) {
      throw new Error(`No delivery adapter available for ${sessionKey.platform}`);
    }

    const capped = await this.#applyLegacyOutputCap(text, sessionKey.platform);
    await adapter.delivery.sendText(sessionKey, capped.text, options);

    return {
      truncated: capped.wasTruncated || undefined,
      overflowSaved: capped.overflowSaved || undefined,
    };
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
      emitDeliveryHook(this.#hookRegistry, "delivery:success", {
        kind: "progress",
        target: this.#sanitizeHookTarget(target),
        platform: target.kind === "channel" ? target.platform : target.kind === "origin" ? target.originalSessionKey.platform : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.#recordDeliveryError(this.#targetToString(target), `progress: ${message}`);
      const { errorClass, errorMessage } = sanitizeHookError(err);
      emitDeliveryHook(this.#hookRegistry, "delivery:error", {
        kind: "progress",
        target: this.#sanitizeHookTarget(target),
        platform: target.kind === "channel" ? target.platform : target.kind === "origin" ? target.originalSessionKey.platform : undefined,
        errorClass,
        errorMessage,
      });
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
      emitDeliveryHook(this.#hookRegistry, "delivery:success", {
        kind: "artifact",
        target: this.#sanitizeHookTarget(target),
        platform: target.kind === "channel" ? target.platform : target.kind === "origin" ? target.originalSessionKey.platform : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.#recordDeliveryError(this.#targetToString(target), `artifact: ${message}`);
      const { errorClass, errorMessage } = sanitizeHookError(err);
      emitDeliveryHook(this.#hookRegistry, "delivery:error", {
        kind: "artifact",
        target: this.#sanitizeHookTarget(target),
        platform: target.kind === "channel" ? target.platform : target.kind === "origin" ? target.originalSessionKey.platform : undefined,
        errorClass,
        errorMessage,
      });
    }
  }

  async #applyLegacyOutputCap(
    text: string,
    platform: ChannelKind
  ): Promise<{ text: string; wasTruncated: boolean; overflowSaved?: boolean }> {
    if (this.#maxOutputChars === undefined || text.length <= this.#maxOutputChars) {
      return { text, wasTruncated: false };
    }

    const truncated = text.slice(0, this.#maxOutputChars) + "\n\n[Output truncated. Full response saved to disk.]";
    const timestamp = this.#now().toISOString().replaceAll(":", "-");
    const safePlatform = this.#safeFilenamePart(platform);
    const hash = createHash("sha256")
      .update(`${platform}\0${timestamp}\0${text.length}\0${text.slice(0, 1024)}`)
      .digest("hex")
      .slice(0, 12);
    const fullPath = join(this.#deliveryRoot, "truncated", `${timestamp}_${safePlatform}_${hash}.md`);

    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, text, "utf-8");

    return { text: truncated, wasTruncated: true, overflowSaved: true };
  }

  #safeFilenamePart(value: string): string {
    const sanitized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    return sanitized.length > 0 ? sanitized : "channel";
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

  #sanitizeHookTarget(target: DeliveryTarget): string {
    if (target.kind === "origin") return "origin";
    if (target.kind === "local") return "local";
    if (target.kind === "silent") return "silent";
    // channel target: hash the raw target string
    const raw = this.#targetToString(target);
    return `${target.platform}:${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
  }

  async #recordDeliveryError(target: string, error: string): Promise<void> {
    const record: DeliveryErrorRecord = {
      timestamp: this.#now().toISOString(),
      target,
      error,
      retryCount: 0
    };

    const path = this.#deliveryErrorLogPath;
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
    const path = this.#deliveryErrorLogPath;
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
