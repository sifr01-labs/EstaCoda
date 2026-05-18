import { describe, it, expect, vi } from "vitest";
import { TelegramAdapter, updateToChannelMessage } from "./telegram-adapter.js";
import { buildAdapterCapability } from "./adapter-capability.js";
import { AdapterRegistry } from "./adapter-registry.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { renderApprovalActions } from "./approval-actions.js";

describe("TelegramAdapter", () => {
  it("getCapabilities exists and returns correct kind", () => {
    const adapter = new TelegramAdapter({ botToken: "test-token" });
    expect(typeof adapter.getCapabilities).toBe("function");
    const cap = adapter.getCapabilities!();
    expect(cap.kind).toBe("telegram");
  });

  it("getCapabilities returns live_proven traits", () => {
    const adapter = new TelegramAdapter({ botToken: "test-token", enabled: true });
    const cap = adapter.getCapabilities!();
    expect(cap.enabled).toBe(true);
    expect(cap.configured).toBe(true);
    expect(cap.inboundMode).toBe("polling");
    expect(cap.outboundMode).toBe("push");
    expect(cap.supportsAttachments).toBe(true);
    expect(cap.supportsThreads).toBe(true);
    expect(cap.supportsApprovals).toBe(true);
    expect(cap.supportsProgressStreaming).toBe(true);
    expect(cap.experimental).toBe(false);
    expect(cap.implementationStatus).toBe("live_proven");
  });

  it("getCapabilities reflects missing config", () => {
    const adapter = new TelegramAdapter({
      botToken: "test-token",
      enabled: true,
      missing: ["BOT_TOKEN_ENV"],
    });
    const cap = adapter.getCapabilities!();
    expect(cap.enabled).toBe(true);
    expect(cap.configured).toBe(false);
    expect(cap.missingConfig).toEqual(["BOT_TOKEN_ENV"]);
  });

  it("getCapabilities delegates to shared builder", () => {
    const adapter = new TelegramAdapter({
      botToken: "test-token",
      enabled: false,
      defaultChatId: "123",
      missing: ["BOT_TOKEN_ENV"],
    });
    const cap = adapter.getCapabilities!();
    const expected = buildAdapterCapability({
      kind: "telegram",
      config: {
        enabled: false,
        defaultChatId: "123",
      },
      missing: ["BOT_TOKEN_ENV"],
    });
    expect(cap).toEqual(expected);
  });

  it("getCapabilities matches registry output for same normalized config", () => {
    const channels = {
      telegram: {
        enabled: true,
        ready: false,
        botTokenEnv: "BOT_TOKEN",
        missing: ["BOT_TOKEN_ENV"],
      },
      discord: { enabled: false, ready: false },
      email: { enabled: false, ready: false },
      whatsapp: { enabled: false, ready: false, experimental: false },
    } as unknown as LoadedRuntimeConfig["channels"];

    const adapter = new TelegramAdapter({
      botToken: "test-token",
      enabled: true,
      missing: ["BOT_TOKEN_ENV"],
    });

    const registry = new AdapterRegistry(channels);
    expect(adapter.getCapabilities!()).toEqual(registry.get("telegram"));
  });

  it("renders generic actions as Telegram inline keyboard buttons", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } })
      };
    });
    const adapter = new TelegramAdapter({ botToken: "test-token", fetch });
    const actions = renderApprovalActions("gateway-approval-1");

    await adapter.delivery.sendText({ platform: "telegram", chatId: "123" }, "approve?", { actions });

    expect(bodies[0]?.reply_markup).toEqual({
      inline_keyboard: actions.map((row) =>
        row.map((action) => ({
          text: action.label,
          callback_data: action.value
        }))
      )
    });
    expect(JSON.stringify(bodies[0]?.reply_markup)).not.toContain("rm -rf");
  });

  it("turns callback query data into ChannelMessage text", () => {
    const value = renderApprovalActions("gateway-approval-1")[0][0].value;
    const message = updateToChannelMessage({
      update_id: 42,
      callback_query: {
        id: "callback-1",
        data: value,
        from: {
          id: "user-1",
          first_name: "Ada",
          username: "ada"
        },
        message: {
          message_id: 7,
          date: 1700000000,
          chat: {
            id: "chat-1",
            type: "private"
          }
        }
      }
    });

    expect(message?.text).toBe(value);
    expect(message?.sender.id).toBe("user-1");
    expect(message?.sessionKey).toMatchObject({
      platform: "telegram",
      chatId: "chat-1",
      userId: "user-1",
      chatType: "dm"
    });
  });
});
