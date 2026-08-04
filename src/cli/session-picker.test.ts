import { describe, expect, it } from "vitest";
import type { SessionPresentation } from "../session/session-presentation.js";
import {
  buildSessionPickerPrompt,
  formatSessionOrigin,
  formatSessionTimestamp,
  noResumableSessionsMessage,
} from "./session-picker.js";

describe("session picker presentation", () => {
  it("builds a dedicated picker with session activity columns and narrow-row details", () => {
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

    expect(input.surface).toBe("sessionPicker");
    expect(input.columns).toEqual([
      { key: "number", header: "#", align: "right" },
      { key: "session", header: "Session" },
      { key: "started", header: "Started" },
      { key: "active", header: "Last active" },
      { key: "origin", header: "Via" },
    ]);
    expect(input.descriptionVisibility).toBe("selected");
    expect(input.visibleRows).toBe(10);
    expect(input.options).toEqual([
      expect.objectContaining({
        id: "newer-session",
        value: "newer-session",
        label: "Implement session picker",
        cells: expect.objectContaining({
          number: "1",
          session: "Implement session picker",
          origin: "CLI",
        }),
        description: expect.stringMatching(/^Started .+  ·  Last active .+  ·  Via CLI$/u),
      }),
      expect.objectContaining({
        id: "older-session",
        cells: expect.objectContaining({ number: "2", session: "Telegram deployment review", origin: "Telegram" }),
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
    expect(input.instruction).toContain("ESC");
    expect(noResumableSessionsMessage("ar")).toContain("لا توجد جلسات");
  });

  it("formats timestamps and known origins deterministically", () => {
    expect(formatSessionTimestamp("2026-08-04T12:34:56+03:00", "en", "UTC")).toBe("04 Aug 2026, 09:34");
    expect(formatSessionTimestamp("2026-08-04T12:34:56+03:00", "ar", "UTC")).toContain("أغسطس");
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
