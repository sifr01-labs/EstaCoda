import { describe, it, expect } from "vitest";
import { buildAdapterCapability, BASE_CAPABILITIES } from "./adapter-capability.js";

describe("buildAdapterCapability", () => {
  it("returns live_proven base for telegram", () => {
    const cap = buildAdapterCapability({
      kind: "telegram",
      config: { enabled: true },
    });
    expect(cap.kind).toBe("telegram");
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
    expect(cap.missingConfig).toBeUndefined();
  });

  it("marks configured=false when missing config is present", () => {
    const cap = buildAdapterCapability({
      kind: "discord",
      config: { enabled: true },
      missing: ["DISCORD_BOT_TOKEN"],
    });
    expect(cap.enabled).toBe(true);
    expect(cap.configured).toBe(false);
    expect(cap.missingConfig).toEqual(["DISCORD_BOT_TOKEN"]);
  });

  it("marks configured=false when disabled", () => {
    const cap = buildAdapterCapability({
      kind: "email",
      config: { enabled: false },
    });
    expect(cap.enabled).toBe(false);
    expect(cap.configured).toBe(false);
  });

  it("treats empty missing array as no missing config", () => {
    const cap = buildAdapterCapability({
      kind: "whatsapp",
      config: { enabled: true, experimental: true },
      missing: [],
    });
    expect(cap.configured).toBe(true);
    expect(cap.missingConfig).toBeUndefined();
  });

  it("returns whatsapp as experimental", () => {
    const cap = buildAdapterCapability({
      kind: "whatsapp",
      config: { enabled: true, experimental: true },
    });
    expect(cap.experimental).toBe(true);
    expect(cap.implementationStatus).toBe("present_not_live_proven");
  });

  it("whatsapp experimental gate closed → not configured", () => {
    const cap = buildAdapterCapability({
      kind: "whatsapp",
      config: { enabled: true, experimental: false },
      missing: [],
    });
    expect(cap.configured).toBe(false);
  });

  it("whatsapp experimental gate open + missing config → not configured", () => {
    const cap = buildAdapterCapability({
      kind: "whatsapp",
      config: { enabled: true, experimental: true },
      missing: ["AUTH_DIR"],
    });
    expect(cap.configured).toBe(false);
  });

  it("whatsapp experimental gate open + no missing config → configured", () => {
    const cap = buildAdapterCapability({
      kind: "whatsapp",
      config: { enabled: true, experimental: true },
      missing: [],
    });
    expect(cap.configured).toBe(true);
  });

  it("telegram enabled + no missing config → configured (not affected by experimental)", () => {
    const cap = buildAdapterCapability({
      kind: "telegram",
      config: { enabled: true },
      missing: [],
    });
    expect(cap.configured).toBe(true);
    expect(cap.experimental).toBe(false);
  });

  it("returns discord with correct static traits", () => {
    const cap = buildAdapterCapability({
      kind: "discord",
      config: { enabled: true },
    });
    expect(cap.inboundMode).toBe("websocket");
    expect(cap.supportsAttachments).toBe(false);
    expect(cap.supportsThreads).toBe(false);
    expect(cap.supportsApprovals).toBe(true);
  });

  it("returns email with thread support", () => {
    const cap = buildAdapterCapability({
      kind: "email",
      config: { enabled: true },
    });
    expect(cap.supportsThreads).toBe(true);
    expect(cap.supportsAttachments).toBe(false);
  });

  it("discord ready only when enabled and botTokenEnv is set", () => {
    const capReady = buildAdapterCapability({
      kind: "discord",
      config: { enabled: true, botTokenEnv: "DISCORD_BOT_TOKEN" },
      missing: [],
    });
    expect(capReady.enabled).toBe(true);
    expect(capReady.configured).toBe(true);

    const capMissing = buildAdapterCapability({
      kind: "discord",
      config: { enabled: true },
      missing: ["botTokenEnv"],
    });
    expect(capMissing.enabled).toBe(true);
    expect(capMissing.configured).toBe(false);
    expect(capMissing.missingConfig).toEqual(["botTokenEnv"]);

    const capDisabled = buildAdapterCapability({
      kind: "discord",
      config: { enabled: false, botTokenEnv: "DISCORD_BOT_TOKEN" },
    });
    expect(capDisabled.enabled).toBe(false);
    expect(capDisabled.configured).toBe(false);
  });

  it("email ready only when enabled and required config is present", () => {
    const capReady = buildAdapterCapability({
      kind: "email",
      config: { enabled: true, imapHost: "imap.example.com", smtpHost: "smtp.example.com", username: "user", passwordEnv: "PASS", ownAddress: "bot@example.com" },
      missing: [],
    });
    expect(capReady.enabled).toBe(true);
    expect(capReady.configured).toBe(true);

    const capMissing = buildAdapterCapability({
      kind: "email",
      config: { enabled: true },
      missing: ["imapHost", "smtpHost"],
    });
    expect(capMissing.enabled).toBe(true);
    expect(capMissing.configured).toBe(false);
    expect(capMissing.missingConfig).toEqual(["imapHost", "smtpHost"]);
  });

  it("whatsapp ready only when enabled and experimental is true", () => {
    const capReady = buildAdapterCapability({
      kind: "whatsapp",
      config: { enabled: true, experimental: true },
      missing: [],
    });
    expect(capReady.enabled).toBe(true);
    expect(capReady.configured).toBe(true);

    const capMissing = buildAdapterCapability({
      kind: "whatsapp",
      config: { enabled: true, experimental: false },
      missing: ["experimental"],
    });
    expect(capMissing.enabled).toBe(true);
    expect(capMissing.configured).toBe(false);
    expect(capMissing.missingConfig).toEqual(["experimental"]);
  });
});
