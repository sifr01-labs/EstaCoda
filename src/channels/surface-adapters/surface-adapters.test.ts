import { describe, it, expect } from "vitest";
import {
  buildStatusViewModel,
  buildAssistantResponseViewModel,
  buildActivityTimelineViewModel,
  timelineEvent,
} from "../../ui/view-models/builders.js";
import { PlainLogSurfaceAdapter } from "./plain-log-surface-adapter.js";
import { TelegramSurfaceAdapter } from "./telegram-surface-adapter.js";
import { DiscordSurfaceAdapter } from "./discord-surface-adapter.js";
import { EmailSurfaceAdapter } from "./email-surface-adapter.js";
import { WhatsAppSurfaceAdapter } from "./whatsapp-surface-adapter.js";
import { renderChannelAssistantResponse } from "./channel-assistant-response.js";
import { ChannelToolActivityRenderer } from "./channel-tool-activity.js";
import { renderPlainProgressLabel, plainActivityLabel } from "./channel-progress-label.js";
import type { SurfaceAdapter } from "../../contracts/surface-adapter.js";
import type { RuntimeEvent } from "../../contracts/runtime-event.js";

function assertNoAnsi(text: string): void {
  expect(text).not.toMatch(/\x1b\[/);
}

function assertNoEmoji(text: string): void {
  const emojiRegex =
    /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1F004}-\u{1F0CF}]|[\u{1F018}-\u{1F270}]|[\u{238C}]|[\u{2B06}-\u{2B07}]|[\u{2B1C}-\u{2B1D}]|[\u{2B50}]|[\u{2B55}]|[\u{2328}]|[\u{23CF}]|[\u{24C2}]|[\u{25A0}-\u{25FF}]|[\u{2600}-\u{26FF}]|[\u{2702}]|[\u{2705}]|[\u{2708}-\u{270D}]|[\u{2728}]|[\u{274C}]|[\u{274E}]|[\u{2753}-\u{2755}]|[\u{2795}-\u{2797}]|[\u{27A1}]|[\u{27B0}]|[\u{27BF}]|[\u{2934}-\u{2935}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|[\u{2B50}]|[\u{2B55}]|[\u{3030}]|[\u{303D}]|[\u{3297}]|[\u{3299}]|[\u{FE0F}]|[\u{200D}]|[\u{20E3}]/gu;
  expect(text.replace(emojiRegex, "")).toBe(text);
}

function hasEmoji(text: string): boolean {
  const emojiRegex =
    /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1F004}-\u{1F0CF}]|[\u{1F018}-\u{1F270}]|[\u{238C}]|[\u{2B06}-\u{2B07}]|[\u{2B1C}-\u{2B1D}]|[\u{2B50}]|[\u{2B55}]|[\u{2328}]|[\u{23CF}]|[\u{24C2}]|[\u{25A0}-\u{25FF}]|[\u{2600}-\u{26FF}]|[\u{2702}]|[\u{2705}]|[\u{2708}-\u{270D}]|[\u{2728}]|[\u{274C}]|[\u{274E}]|[\u{2753}-\u{2755}]|[\u{2795}-\u{2797}]|[\u{27A1}]|[\u{27B0}]|[\u{27BF}]|[\u{2934}-\u{2935}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|[\u{2B50}]|[\u{2B55}]|[\u{3030}]|[\u{303D}]|[\u{3297}]|[\u{3299}]|[\u{FE0F}]|[\u{200D}]|[\u{20E3}]/gu;
  return emojiRegex.test(text);
}

// ──────────────────────────────────────────────────
describe("PlainLogSurfaceAdapter", () => {
  const adapter = new PlainLogSurfaceAdapter();

  it("has correct capabilities", () => {
    expect(adapter.kind).toBe("plain-log");
    expect(adapter.capabilities.supportsEmoji).toBe(false);
    expect(adapter.capabilities.supportsAnsi).toBe(false);
    expect(adapter.capabilities.supportsHtml).toBe(false);
    expect(adapter.capabilities.supportsMarkdown).toBe(false);
  });

  it("renders plain log output from ViewModel", () => {
    const vm = buildStatusViewModel({
      agentName: "EstaCoda",
      model: { provider: "openrouter", id: "claude-sonnet-4" },
      securityMode: "open",
      skillCount: 5,
      toolCount: 10,
      mcpActive: 1,
      mcpTotal: 2,
    });
    const out = adapter.render(vm);
    expect(out).toContain("EstaCoda is ready");
    assertNoAnsi(out);
    assertNoEmoji(out);
  });

  it("renders channel-safe tool activity summary without emoji", () => {
    const event: RuntimeEvent = { kind: "tool-start", tool: "terminal.run" };
    const out = adapter.renderToolActivity(event);
    expect(out).toContain("Run Command");
    expect(out).not.toContain("terminal.run");
    expect(out).toContain("[>]");
    assertNoEmoji(out);
    assertNoAnsi(out);
  });

  it("renders channel-safe tool result without emoji", () => {
    const event: RuntimeEvent = {
      kind: "tool-result",
      tool: "web.extract",
      ok: true,
      chars: 1500,
      sentChars: 900,
      truncated: false,
    };
    const out = adapter.renderToolActivity(event);
    expect(out).toContain("[OK]");
    expect(out).toContain("1.5k captured");
    assertNoEmoji(out);
    assertNoAnsi(out);
  });

  it("renders failed tool activity with ASCII marker", () => {
    const event: RuntimeEvent = {
      kind: "tool-result",
      tool: "terminal.run",
      ok: false,
    };
    const out = adapter.renderToolActivity(event);
    expect(out).toContain("[X]");
    expect(out).toContain("failed");
    assertNoEmoji(out);
  });

  it("renders progress label without emoji", () => {
    const event: RuntimeEvent = { kind: "agent-start", sessionId: "s1", input: "hello" };
    const out = adapter.renderProgressLabel(event);
    expect(out).toBe("Thinking");
    assertNoEmoji(out);
  });

  it("hides provider attempts and renders serving transitions without emoji", () => {
    expect(adapter.renderProgressLabel({
      kind: "provider-attempt",
      provider: "openrouter",
      model: "k2",
      fallback: false,
    })).toBe("");
    expect(adapter.renderProgressLabel({
      kind: "provider-attempt",
      provider: "openrouter",
      model: "deepseek-v4-pro",
      fallback: true,
    })).toBe("");
    expect(adapter.renderProgressLabel({
      kind: "provider-serving-transition",
      transition: "fallback-active",
      provider: "openrouter",
      model: "deepseek-v4-pro",
    })).toBe("Using fallback · deepseek-v4-pro");
    expect(adapter.renderProgressLabel({
      kind: "provider-serving-transition",
      transition: "primary-recovered",
      provider: "openrouter",
      model: "k2",
    })).toBe("Primary model available again · k2");
  });

  it("renders assistant response without ANSI or emoji", () => {
    const out = adapter.renderAssistantResponse("EstaCoda", "Hello world", {
      matchedSkills: ["web-search"],
      progress: ["start", "done"],
    });
    expect(out).toContain("EstaCoda:");
    expect(out).toContain("Hello world");
    expect(out).toContain("skills: web-search");
    expect(out).toContain("progress: start -> done");
    assertNoAnsi(out);
    assertNoEmoji(out);
  });
});

// ──────────────────────────────────────────────────
describe("TelegramSurfaceAdapter", () => {
  const adapter = new TelegramSurfaceAdapter();

  it("has correct capabilities", () => {
    expect(adapter.kind).toBe("telegram");
    expect(adapter.capabilities.supportsEmoji).toBe(true);
    expect(adapter.capabilities.supportsAnsi).toBe(false);
    expect(adapter.capabilities.supportsHtml).toBe(true);
    expect(adapter.capabilities.supportsMarkdown).toBe(false);
  });

  it("renders tool activity with emoji", () => {
    const event: RuntimeEvent = { kind: "tool-start", tool: "terminal.run" };
    const out = adapter.renderToolActivity(event);
    expect(out).toContain("Run Command");
    expect(hasEmoji(out)).toBe(true);
  });

  it("renders progress label with emoji", () => {
    const event: RuntimeEvent = { kind: "agent-start", sessionId: "s1", input: "hello" };
    const out = adapter.renderProgressLabel(event);
    expect(out).toContain("Thinking");
    expect(hasEmoji(out)).toBe(true);
  });

  it("produces output compatible with Telegram HTML formatting path", () => {
    const vm = buildStatusViewModel({
      agentName: "EstaCoda",
      model: { provider: "openrouter", id: "claude-sonnet-4" },
      securityMode: "open",
      skillCount: 5,
      toolCount: 10,
      mcpActive: 1,
      mcpTotal: 2,
    });
    const out = adapter.render(vm);
    assertNoAnsi(out);
  });
});

// ──────────────────────────────────────────────────
describe("DiscordSurfaceAdapter", () => {
  const adapter = new DiscordSurfaceAdapter();

  it("has correct capabilities", () => {
    expect(adapter.kind).toBe("discord");
    expect(adapter.capabilities.supportsEmoji).toBe(true);
    expect(adapter.capabilities.supportsAnsi).toBe(false);
    expect(adapter.capabilities.supportsHtml).toBe(false);
    expect(adapter.capabilities.supportsMarkdown).toBe(true);
  });

  it("renders tool activity with emoji", () => {
    const event: RuntimeEvent = { kind: "tool-start", tool: "memory.add" };
    const out = adapter.renderToolActivity(event);
    expect(hasEmoji(out)).toBe(true);
  });
});

// ──────────────────────────────────────────────────
describe("EmailSurfaceAdapter", () => {
  const adapter = new EmailSurfaceAdapter();

  it("has correct capabilities", () => {
    expect(adapter.kind).toBe("email");
    expect(adapter.capabilities.supportsEmoji).toBe(false);
    expect(adapter.capabilities.supportsAnsi).toBe(false);
    expect(adapter.capabilities.supportsHtml).toBe(false);
    expect(adapter.capabilities.supportsMarkdown).toBe(false);
  });

  it("renders fallback text output without emoji", () => {
    const event: RuntimeEvent = { kind: "tool-start", tool: "file.read" };
    const out = adapter.renderToolActivity(event);
    assertNoEmoji(out);
    assertNoAnsi(out);
  });

  it("renders assistant response as plain text", () => {
    const out = adapter.renderAssistantResponse("EstaCoda", "Reply text");
    expect(out).toBe("EstaCoda:\nReply text");
    assertNoEmoji(out);
    assertNoAnsi(out);
  });
});

// ──────────────────────────────────────────────────
describe("WhatsAppSurfaceAdapter", () => {
  const adapter = new WhatsAppSurfaceAdapter();

  it("has correct capabilities", () => {
    expect(adapter.kind).toBe("whatsapp");
    expect(adapter.capabilities.supportsEmoji).toBe(true);
    expect(adapter.capabilities.supportsAnsi).toBe(false);
    expect(adapter.capabilities.supportsHtml).toBe(false);
    expect(adapter.capabilities.supportsMarkdown).toBe(true);
  });

  it("renders tool activity with emoji", () => {
    const event: RuntimeEvent = { kind: "tool-start", tool: "web.extract" };
    const out = adapter.renderToolActivity(event);
    expect(hasEmoji(out)).toBe(true);
  });
});

// ──────────────────────────────────────────────────
describe("ChannelToolActivityRenderer", () => {
  const renderer = new ChannelToolActivityRenderer({ tools: [] });

  it("renders start event with ASCII marker", () => {
    const event: RuntimeEvent = { kind: "tool-start", tool: "file.write" };
    const out = renderer.render(event);
    expect(out).toContain("[>]");
    expect(out).toContain("Write File");
    assertNoEmoji(out);
  });

  it("renders done event with ASCII marker", () => {
    const event: RuntimeEvent = {
      kind: "tool-result",
      tool: "file.write",
      ok: true,
    };
    const out = renderer.render(event);
    expect(out).toContain("[OK]");
    expect(out).toContain("done");
    assertNoEmoji(out);
  });

  it("renders target summaries without emoji", () => {
    const r = new ChannelToolActivityRenderer({ tools: [] });
    r.render({ kind: "tool-start", tool: "file.read", targetSummary: "src/app.ts" });
    const out = r.render({ kind: "tool-result", tool: "file.read", ok: true, targetSummary: "src/app.ts" });
    expect(out).toContain("src/app.ts");
    assertNoEmoji(out);
  });

  it("renders elapsed time", () => {
    let t = 0;
    const r = new ChannelToolActivityRenderer({ tools: [], now: () => t });
    const startEvent: RuntimeEvent = { kind: "tool-start", tool: "t" };
    r.render(startEvent);
    t = 5000;
    const resultEvent: RuntimeEvent = { kind: "tool-result", tool: "t", ok: true };
    const out = r.render(resultEvent);
    expect(out).toContain("5.0s");
  });
});

describe("plainActivityLabel", () => {
  it("returns English label without emoji", () => {
    const label = plainActivityLabel("en", "thinking");
    expect(label).toBe("Thinking");
    assertNoEmoji(label);
  });

  it("returns Arabic label without emoji", () => {
    const label = plainActivityLabel("ar", "done");
    expect(label).toBe("اكتمل");
    assertNoEmoji(label);
  });
});

// ──────────────────────────────────────────────────
describe("renderPlainProgressLabel", () => {
  it("returns Thinking for agent-start", () => {
    const event: RuntimeEvent = { kind: "agent-start", sessionId: "s1", input: "hello" };
    expect(renderPlainProgressLabel(event)).toBe("Thinking");
  });

  it("returns empty for provider-token", () => {
    const event: RuntimeEvent = { kind: "provider-token", provider: "x", model: "m", text: "t" };
    expect(renderPlainProgressLabel(event)).toBe("");
  });

  it("returns tool label for tool-start", () => {
    const event: RuntimeEvent = { kind: "tool-start", tool: "file.read" };
    expect(renderPlainProgressLabel(event)).toBe("Reading files");
  });
});

// ──────────────────────────────────────────────────
describe("renderChannelAssistantResponse", () => {
  it("strips ANSI from label and text", () => {
    const out = renderChannelAssistantResponse("\x1b[32mAgent\x1b[0m", "\x1b[1mHello\x1b[0m");
    expect(out).toContain("Agent:");
    expect(out).toContain("Hello");
    assertNoAnsi(out);
  });

  it("uses default label when label is empty", () => {
    const out = renderChannelAssistantResponse("", "text");
    expect(out).toContain("Assistant:");
  });

  it("includes matchedSkills when provided", () => {
    const out = renderChannelAssistantResponse("A", "B", { matchedSkills: ["s1", "s2"] });
    expect(out).toContain("skills: s1, s2");
  });

  it("includes progress when provided", () => {
    const out = renderChannelAssistantResponse("A", "B", { progress: ["p1", "p2", "p3"] });
    expect(out).toContain("progress: p1 -> p2 -> p3");
  });

  it("never leaks terminal-only frames", () => {
    const out = renderChannelAssistantResponse("EstaCoda", "Hello");
    expect(out).not.toContain("┌");
    expect(out).not.toContain("└");
    expect(out).not.toContain("──");
    expect(out).not.toContain("═");
  });
});

// ──────────────────────────────────────────────────
describe("Cross-adapter ANSI safety", () => {
  const adapters: SurfaceAdapter[] = [
    new PlainLogSurfaceAdapter(),
    new TelegramSurfaceAdapter(),
    new DiscordSurfaceAdapter(),
    new EmailSurfaceAdapter(),
    new WhatsAppSurfaceAdapter(),
  ];

  const vm = buildStatusViewModel({
    agentName: "EstaCoda",
    model: { provider: "openrouter", id: "claude-sonnet-4" },
    securityMode: "open",
    skillCount: 5,
    toolCount: 10,
    mcpActive: 1,
    mcpTotal: 2,
  });

  for (const adapter of adapters) {
    it(`${adapter.kind} render produces no ANSI`, () => {
      const out = adapter.render(vm);
      assertNoAnsi(out);
    });

    it(`${adapter.kind} renderAssistantResponse produces no ANSI`, () => {
      const out = adapter.renderAssistantResponse("Label", "Text");
      assertNoAnsi(out);
    });
  }
});

// ──────────────────────────────────────────────────
describe("Emoji behavior by channel", () => {
  it("emoji-capable adapters include emoji in tool activity", () => {
    const event: RuntimeEvent = { kind: "tool-start", tool: "memory.add" };
    const telegram = new TelegramSurfaceAdapter();
    const discord = new DiscordSurfaceAdapter();
    const whatsapp = new WhatsAppSurfaceAdapter();

    expect(hasEmoji(telegram.renderToolActivity(event))).toBe(true);
    expect(hasEmoji(discord.renderToolActivity(event))).toBe(true);
    expect(hasEmoji(whatsapp.renderToolActivity(event))).toBe(true);
  });

  it("non-emoji adapters never include emoji", () => {
    const event: RuntimeEvent = { kind: "tool-start", tool: "memory.add" };
    const plain = new PlainLogSurfaceAdapter();
    const email = new EmailSurfaceAdapter();

    assertNoEmoji(plain.renderToolActivity(event));
    assertNoEmoji(email.renderToolActivity(event));
  });
});
