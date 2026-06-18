import { describe, expect, it } from "vitest";
import {
  gatewayLifecycleNotification,
  resolveGatewayLifecycleNotificationTargets,
  sendGatewayLifecycleNotification,
} from "./gateway-lifecycle-notifications.js";
import type { DeliveryTarget } from "./delivery-router.js";

describe("gatewayLifecycleNotification", () => {
  it("returns exact English shutdown restarting copy", () => {
    expect(gatewayLifecycleNotification({
      locale: "en",
      phase: "shutdown",
      state: "restarting"
    })).toBe("⚠️ EstaCoda: Gateway restarting — running tasks will stop. Send anything after restart to continue from the thread.");
  });

  it("returns exact English startup online copy", () => {
    expect(gatewayLifecycleNotification({
      locale: "en",
      phase: "startup",
      state: "online"
    })).toBe("🟢 EstaCoda: Gateway online — agent ready.");
  });

  it("returns exact Arabic shutdown restarting copy", () => {
    expect(gatewayLifecycleNotification({
      locale: "ar",
      phase: "shutdown",
      state: "restarting"
    })).toBe("⚠️ البوابة تُعاد تشغيلها — ستتوقف المهام الجارية. أرسل أي شيء بعد إعادة التشغيل للمتابعة من نفس المحادثة.");
  });

  it("returns exact Arabic startup online copy", () => {
    expect(gatewayLifecycleNotification({
      locale: "ar",
      phase: "startup",
      state: "online"
    })).toBe("🟢 البوابة متصلة — الوكيل جاهز.");
  });

  it("omits the EstaCoda prefix from Arabic copy", () => {
    expect(gatewayLifecycleNotification({
      locale: "ar",
      phase: "shutdown",
      state: "restarting"
    })).not.toContain("EstaCoda:");
    expect(gatewayLifecycleNotification({
      locale: "ar",
      phase: "startup",
      state: "online"
    })).not.toContain("EstaCoda:");
  });
});

describe("resolveGatewayLifecycleNotificationTargets", () => {
  it("uses only configured channel targets and excludes CLI/local targets", () => {
    const targets = resolveGatewayLifecycleNotificationTargets({
      channels: {
        telegram: { ready: true, defaultChatId: " 123 " },
        discord: { ready: true, allowedChannels: ["abc", "abc", " "] },
        email: { ready: true, homeAddress: "ops@example.test" },
        whatsapp: { ready: true, allowedUsers: ["u1"], allowedGroups: ["g1", "u1"] },
      }
    } as any);

    expect(targets).toEqual([
      { kind: "channel", platform: "telegram", chatId: "123" },
      { kind: "channel", platform: "discord", chatId: "abc" },
      { kind: "channel", platform: "email", address: "ops@example.test" },
      { kind: "channel", platform: "whatsapp", chatId: "u1" },
      { kind: "channel", platform: "whatsapp", chatId: "g1" },
    ]);
    expect(targets.every((target) => target.kind === "channel")).toBe(true);
    for (const target of targets) {
      expect(target).not.toHaveProperty("originalSessionKey");
      expect(target).not.toHaveProperty("path");
      expect(target.kind).not.toBe("origin");
      expect(target.kind).not.toBe("local");
      expect(target.kind).not.toBe("silent");
    }
  });

  it("does not infer targets from channels that are not ready", () => {
    expect(resolveGatewayLifecycleNotificationTargets({
      channels: {
        telegram: { ready: false, defaultChatId: "123" },
        discord: { ready: false, allowedChannels: ["abc"] },
        email: { ready: false, homeAddress: "ops@example.test" },
        whatsapp: { ready: false, allowedUsers: ["u1"], allowedGroups: ["g1"] },
      }
    } as any)).toEqual([]);
  });
});

describe("sendGatewayLifecycleNotification", () => {
  function config(overrides: Record<string, unknown> = {}) {
    return {
      gateway: { lifecycleNotifications: { enabled: true } },
      ui: { language: "en" },
      channels: {
        telegram: { ready: true, defaultChatId: "123" },
        discord: { ready: false },
        email: { ready: false },
        whatsapp: { ready: false },
      },
      ...overrides,
    } as any;
  }

  it("is inert when lifecycle notifications are disabled", async () => {
    let delivered = false;

    const summary = await sendGatewayLifecycleNotification({
      config: config({ gateway: { lifecycleNotifications: { enabled: false } } }),
      phase: "startup",
      state: "online",
      router: {
        deliverText: async () => {
          delivered = true;
          return new Map();
        },
      },
    });

    expect(summary).toEqual({ attempted: 0, delivered: 0, failed: 0 });
    expect(delivered).toBe(false);
  });

  it("delivers deterministic lifecycle copy to configured channel targets", async () => {
    let seenTargets: DeliveryTarget[] = [];
    let seenText = "";

    const summary = await sendGatewayLifecycleNotification({
      config: config(),
      phase: "startup",
      state: "online",
      router: {
        deliverText: async (targets, text) => {
          seenTargets = targets;
          seenText = text;
          return new Map([["telegram:123", { success: true }]]);
        },
      },
    });

    expect(seenTargets).toEqual([{ kind: "channel", platform: "telegram", chatId: "123" }]);
    expect(seenText).toBe("🟢 EstaCoda: Gateway online — agent ready.");
    expect(summary).toEqual({ attempted: 1, delivered: 1, failed: 0 });
  });

  it("delivers exact Arabic lifecycle copy when profile language is Arabic", async () => {
    let seenText = "";

    const summary = await sendGatewayLifecycleNotification({
      config: config({ ui: { language: "ar" } }),
      phase: "shutdown",
      state: "restarting",
      router: {
        deliverText: async (_targets, text) => {
          seenText = text;
          return new Map([["telegram:123", { success: true }]]);
        },
      },
    });

    expect(seenText).toBe("⚠️ البوابة تُعاد تشغيلها — ستتوقف المهام الجارية. أرسل أي شيء بعد إعادة التشغيل للمتابعة من نفس المحادثة.");
    expect(seenText).not.toContain("EstaCoda:");
    expect(summary).toEqual({ attempted: 1, delivered: 1, failed: 0 });
  });

  it("returns failed summary and warning when router delivery throws", async () => {
    const warnings: string[] = [];

    const summary = await sendGatewayLifecycleNotification({
      config: config(),
      phase: "shutdown",
      state: "restarting",
      logWarning: (message) => warnings.push(message),
      router: {
        deliverText: async () => {
          throw new Error("delivery unavailable");
        },
      },
    });

    expect(summary).toEqual({ attempted: 1, delivered: 0, failed: 1 });
    expect(warnings).toEqual(["Gateway lifecycle notification failed: delivery unavailable"]);
  });
});
