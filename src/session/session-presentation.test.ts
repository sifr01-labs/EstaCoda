import { describe, expect, it } from "vitest";
import type { SessionRecord, SessionSummaryRecord } from "../contracts/session.js";
import {
  buildSessionPresentation,
  deriveSessionDescription,
  isPlaceholderSessionTitle,
  sanitizeSessionDescription,
  SESSION_DESCRIPTION_MAX_GRAPHEMES,
  withImmutableSessionOrigin,
} from "./session-presentation.js";

describe("session presentation", () => {
  it("derives a bounded, single-line, redacted description from the first user message", () => {
    const description = deriveSessionDescription(
      "EstaCoda session",
      "  Debug\nOPENAI_API_KEY=super-secret-value\u001b[31m then continue  "
    );

    expect(description).toBe("Debug OPENAI_API_KEY=[REDACTED] then continue");
    expect(description).not.toContain("super-secret-value");
    expect(description).not.toContain("\u001b");
  });

  it("preserves Arabic text while removing bidi overrides and bounding graphemes", () => {
    const arabic = sanitizeSessionDescription(`راجع إعداد Telegram\u202e ${"م".repeat(140)}`);

    expect(arabic).toContain("راجع إعداد Telegram");
    expect(arabic).not.toContain("\u202e");
    expect([...arabic].length).toBeLessThanOrEqual(SESSION_DESCRIPTION_MAX_GRAPHEMES);
    expect(arabic.endsWith("…")).toBe(true);
  });

  it("prefers meaningful titles and recognizes only known placeholders", () => {
    expect(deriveSessionDescription("Provider fallback investigation", "ignored message"))
      .toBe("Provider fallback investigation");
    expect(isPlaceholderSessionTitle(undefined)).toBe(true);
    expect(isPlaceholderSessionTitle(" EstaCoda session ")).toBe(true);
    expect(isPlaceholderSessionTitle("Named session")).toBe(false);
  });

  it("sets an origin once and never replaces it during a later handoff", () => {
    const created = withImmutableSessionOrigin({ workspaceRoot: "/workspace" }, "cli");
    const attached = withImmutableSessionOrigin(created, "telegram");

    expect(created).toEqual({ workspaceRoot: "/workspace", originSurface: "cli" });
    expect(attached).toBe(created);
    expect(attached?.originSurface).toBe("cli");
    expect(withImmutableSessionOrigin({ originSurface: "telegram\nspoof" }, "telegram"))
      .toEqual({ originSurface: "telegram" });
  });

  it("builds resumability and legacy origin/workspace fallbacks without mutating records", () => {
    const session = record({
      metadata: { workspaceDirectory: "/legacy/workspace" }
    });
    const summary: SessionSummaryRecord = {
      session,
      messageCount: 2,
      userMessageCount: 1,
      firstUserMessage: {
        id: "message-1",
        sessionId: session.id,
        role: "user",
        content: "Continue the Telegram setup",
        createdAt: "2030-01-01T00:00:01.000Z",
        channel: "telegram"
      }
    };

    expect(buildSessionPresentation(summary)).toMatchObject({
      description: "Continue the Telegram setup",
      originSurface: "telegram",
      workspaceRoot: "/legacy/workspace",
      hasUserActivity: true,
      userFacingRoot: true,
      resumable: true
    });
    expect(session.metadata).toEqual({ workspaceDirectory: "/legacy/workspace" });
  });

  it("marks internal, child, ended, and empty sessions as non-resumable", () => {
    const variants = [
      { session: record({ parentSessionId: "parent" }), userMessageCount: 1 },
      { session: record({ metadata: { kind: "task-operator-origin" } }), userMessageCount: 1 },
      { session: record({ endedAt: "2030-01-02T00:00:00.000Z" }), userMessageCount: 1 },
      { session: record(), userMessageCount: 0 },
    ];

    expect(variants.map(({ session, userMessageCount }) => buildSessionPresentation({
      session,
      messageCount: userMessageCount,
      userMessageCount,
    }).resumable)).toEqual([false, false, false, false]);
  });
});

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session-1",
    profileId: "profile",
    title: "EstaCoda session",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:02.000Z",
    ...overrides,
  };
}
