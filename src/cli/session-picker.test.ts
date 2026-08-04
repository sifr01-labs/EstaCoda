import { describe, expect, it } from "vitest";
import type { SessionPresentation } from "../session/session-presentation.js";
import {
  buildSessionPickerPrompt,
  formatSessionOrigin,
  formatSessionTimestamp,
  noResumableSessionsMessage,
} from "./session-picker.js";

describe("session picker presentation", () => {
  it("builds a two-column picker with selected-row activity details", () => {
    const input = buildSessionPickerPrompt([
      presentation({
        id: "newer-session",
        description: "Implement session picker",
        createdAt: "2026-08-04T08:15:22.000Z",
        updatedAt: "2026-08-04T09:45:00.000Z",
        originSurface: "cli",
      }),
      presentation({
        id: "older-session",
        description: "Telegram deployment review",
        originSurface: "telegram",
      }),
    ]);

    expect(input.columns).toEqual([
      { key: "number", header: "#", align: "right" },
      { key: "session", header: "Session" },
    ]);
    expect(input.descriptionVisibility).toBe("selected");
    expect(input.visibleRows).toBe(10);
    expect(input.options).toEqual([
      expect.objectContaining({
        id: "newer-session",
        value: "newer-session",
        label: "Implement session picker",
        cells: { number: "1", session: "Implement session picker" },
        description: "Started 2026-08-04 08:15 UTC  ·  Last active 2026-08-04 09:45 UTC  ·  Via CLI",
      }),
      expect.objectContaining({
        id: "older-session",
        cells: { number: "2", session: "Telegram deployment review" },
        description: expect.stringContaining("Via Telegram"),
      }),
    ]);
  });

  it("localizes picker chrome while preserving technical surface labels", () => {
    const input = buildSessionPickerPrompt([
      presentation({ description: "مراجعة نشر Telegram", originSurface: "telegram" }),
    ], "ar");

    expect(input.title).toBe("اختر جلسة");
    expect(input.direction).toBe("rtl");
    expect(input.options[0]?.description).toContain("آخر نشاط");
    expect(input.options[0]?.description).toContain("Telegram");
    expect(noResumableSessionsMessage("ar")).toContain("لا توجد جلسات");
  });

  it("formats timestamps and known origins deterministically", () => {
    expect(formatSessionTimestamp("2026-08-04T12:34:56+03:00")).toBe("2026-08-04 09:34 UTC");
    expect(formatSessionTimestamp("not-a-date")).toBe("Unknown");
    expect(formatSessionOrigin("whatsapp")).toBe("WhatsApp");
    expect(formatSessionOrigin(undefined)).toBe("Unknown");
  });
});

function presentation(overrides: Partial<SessionPresentation> = {}): SessionPresentation {
  return {
    id: "session-1",
    profileId: "default",
    description: "Session description",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-02T11:30:00.000Z",
    originSurface: "cli",
    workspaceRoot: "/workspace",
    messageCount: 2,
    userMessageCount: 1,
    hasUserActivity: true,
    userFacingRoot: true,
    resumable: true,
    ...overrides,
  };
}
