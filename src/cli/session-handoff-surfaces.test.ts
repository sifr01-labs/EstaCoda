import { describe, it, expect } from "vitest";
import { resolveTokens } from "../theme/token-resolver.js";
import type { TerminalCapabilities } from "../contracts/ui.js";
import type { ViewModel } from "../contracts/view-model.js";
import type { SessionRecord } from "../contracts/session.js";
import { StandardRenderer } from "../ui/renderers/standard-renderer.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import { buildPickerViewModel } from "../ui/view-models/builders.js";
import {
  buildSessionsHelpViewModel,
  buildSessionsListViewModel,
  buildSessionShowViewModel,
  buildSessionCurrentViewModel,
  buildSessionAttachViewModel,
  buildSessionDetachViewModel,
  buildSessionNotFoundViewModel,
  buildNoActiveSessionViewModel,
  buildInvalidSurfaceViewModel,
  buildSessionUsageErrorViewModel,
} from "./session-view-models.js";
import {
  buildHandoffHelpViewModel,
  buildHandoffTelegramViewModel,
  buildHandoffListViewModel,
  buildNoActiveSessionForHandoffViewModel,
} from "./handoff-view-models.js";

// ──────────────────────────────────────
// Rendering context factories
// ──────────────────────────────────────

function fullCaps(): TerminalCapabilities {
  return {
    isTTY: true,
    supportsColor: true,
    supportsTrueColor: true,
    supportsUnicode: true,
    supportsEmoji: true,
    terminalWidth: 120,
    isDumb: false,
    isCI: false,
    supportsAnimation: true,
  };
}

function noColorCaps(): TerminalCapabilities {
  return { ...fullCaps(), supportsColor: false, supportsTrueColor: false };
}

function noUnicodeCaps(): TerminalCapabilities {
  return { ...fullCaps(), supportsUnicode: false, supportsEmoji: false };
}

function narrowCaps(): TerminalCapabilities {
  return { ...fullCaps(), terminalWidth: 40 };
}

function standardDarkRenderer() {
  const tokens = resolveTokens("standard", "dark", "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: fullCaps() });
}

function standardLightRenderer() {
  const tokens = resolveTokens("standard", "light", "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: fullCaps() });
}

function noColorRenderer() {
  const tokens = resolveTokens("standard", "dark", "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: noColorCaps() });
}

function noUnicodeRenderer() {
  const tokens = resolveTokens("standard", "dark", "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: noUnicodeCaps() });
}

function narrowRenderer() {
  const tokens = resolveTokens("standard", "dark", "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: narrowCaps() });
}

function plainRenderer() {
  return { render: renderPlain };
}

function snapshotContexts() {
  return [
    { name: "plain", renderer: plainRenderer() },
    { name: "standard dark", renderer: standardDarkRenderer() },
    { name: "standard light", renderer: standardLightRenderer() },
    { name: "no color", renderer: noColorRenderer() },
    { name: "no Unicode", renderer: noUnicodeRenderer() },
    { name: "narrow width", renderer: narrowRenderer() },
  ];
}

function snapshotOutput(output: string): string {
  return output.split("\n").map((line) => line.trimEnd()).join("\n");
}

// ──────────────────────────────────────
// Fake data factories
// ──────────────────────────────────────

function fakeSessionRecord(overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    id: "sess-1",
    profileId: "default",
    title: "Test Session",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-02T00:00:00Z",
    ...overrides,
  };
}

// ──────────────────────────────────────
// Session snapshot tests
// ──────────────────────────────────────

describe("Session surfaces — help", () => {
  const vm = buildSessionsHelpViewModel();
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`sessions-help-${ctx.name}`);
    });
  }
});

describe("Session surfaces — list", () => {
  const vm = buildSessionsListViewModel({
    sessions: [
      { id: "sess-1", title: "Test Session", updatedAt: "2024-01-02T00:00:00Z", attachments: ["telegram:chat-1"] },
      { id: "sess-2", title: undefined, updatedAt: undefined, attachments: [] },
    ],
  });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`sessions-list-${ctx.name}`);
    });
  }
});

describe("Session surfaces — picker", () => {
  const vm = buildPickerViewModel({
    title: "Choose a session",
    columns: [
      { key: "number", header: "#", alignment: "right" },
      { key: "session", header: "Session" },
    ],
    options: [
      {
        id: "session-1",
        label: "Implement session picker",
        cells: { number: "1", session: "Implement session picker" },
        description: "Started 2026-08-04 08:15 UTC  ·  Last active 2026-08-04 09:45 UTC  ·  Via CLI",
        selected: true,
      },
      {
        id: "session-2",
        label: "Telegram deployment review",
        cells: { number: "2", session: "Telegram deployment review" },
        description: "Started 2026-08-03 12:00 UTC  ·  Last active 2026-08-03 13:30 UTC  ·  Via Telegram",
      },
    ],
    descriptionVisibility: "selected",
    instruction: "↑↓ navigate  ·  ENTER open  ·  CTRL+C exit",
  });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`sessions-picker-${ctx.name}`);
    });
  }
});

describe("Session surfaces — Arabic picker", () => {
  const vm = buildPickerViewModel({
    title: "اختر جلسة",
    columns: [
      { key: "number", header: "#", alignment: "right" },
      { key: "session", header: "الجلسة" },
    ],
    options: [{
      id: "session-ar",
      label: "مراجعة نشر Telegram",
      cells: { number: "1", session: "مراجعة نشر Telegram" },
      description: "بدأت 2026-08-04 08:15 UTC  ·  آخر نشاط 2026-08-04 09:45 UTC  ·  عبر Telegram",
      selected: true,
    }],
    descriptionVisibility: "selected",
    instruction: "↑↓ للتنقل  ·  ENTER للفتح  ·  CTRL+C للخروج",
    direction: "rtl",
  });

  it("renders mixed Arabic and technical text in plain mode", () => {
    expect(snapshotOutput(renderPlain(vm))).toMatchSnapshot("sessions-picker-arabic-plain");
  });

  it("renders mixed Arabic and technical text with theme tokens", () => {
    const renderer = new StandardRenderer({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      capabilities: fullCaps(),
      locale: "ar",
    });
    expect(snapshotOutput(renderer.render(vm))).toMatchSnapshot("sessions-picker-arabic-standard");
  });
});

describe("Session surfaces — show", () => {
  const vm = buildSessionShowViewModel({
    session: fakeSessionRecord(),
    messageCount: 5,
    pointers: [
      { surfaceType: "telegram", surfaceId: "chat-1", attachedAt: "2024-01-01T00:00:00Z" },
    ],
  });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`session-show-${ctx.name}`);
    });
  }
});

describe("Session surfaces — show no pointers", () => {
  const vm = buildSessionShowViewModel({
    session: fakeSessionRecord(),
    messageCount: 0,
    pointers: [],
  });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`session-show-no-pointers-${ctx.name}`);
    });
  }
});

describe("Session surfaces — current", () => {
  const vm = buildSessionCurrentViewModel({
    sessionId: "runtime-sess-1",
    pointers: [
      { surfaceType: "telegram", surfaceId: "chat-1", attachedAt: "2024-01-01T00:00:00Z" },
    ],
  });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`session-current-${ctx.name}`);
    });
  }
});

describe("Session surfaces — current no pointers", () => {
  const vm = buildSessionCurrentViewModel({
    sessionId: "runtime-sess-1",
    pointers: [],
  });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`session-current-no-pointers-${ctx.name}`);
    });
  }
});

describe("Session surfaces — attach", () => {
  const vm = buildSessionAttachViewModel({ surface: "telegram", surfaceId: "chat-1", sessionId: "sess-1" });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`session-attach-${ctx.name}`);
    });
  }
});

describe("Session surfaces — detach", () => {
  const vm = buildSessionDetachViewModel({ surface: "telegram", surfaceId: "chat-1" });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`session-detach-${ctx.name}`);
    });
  }
});

describe("Session surfaces — not found", () => {
  const vm = buildSessionNotFoundViewModel({ sessionId: "missing" });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`session-not-found-${ctx.name}`);
    });
  }
});

describe("Session surfaces — no active session", () => {
  const vm = buildNoActiveSessionViewModel({ message: "No active session in this shell." });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`session-no-active-${ctx.name}`);
    });
  }
});

describe("Session surfaces — invalid surface", () => {
  const vm = buildInvalidSurfaceViewModel({ surface: "invalid", validSurfaces: ["cli", "telegram", "discord"] });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`session-invalid-surface-${ctx.name}`);
    });
  }
});

describe("Session surfaces — usage error", () => {
  const vm = buildSessionUsageErrorViewModel({ message: "Usage: estacoda sessions show <session-id>" });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`session-usage-error-${ctx.name}`);
    });
  }
});

// ──────────────────────────────────────
// Handoff snapshot tests
// ──────────────────────────────────────

describe("Handoff surfaces — help", () => {
  const vm = buildHandoffHelpViewModel();
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`handoff-help-${ctx.name}`);
    });
  }
});

describe("Handoff surfaces — telegram", () => {
  const vm = buildHandoffTelegramViewModel({
    code: "ABC123",
    sessionId: "sess-1",
    expiresAt: "2024-01-01T00:10:00Z",
    ttlMinutes: 10,
  });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`handoff-telegram-${ctx.name}`);
    });
  }
});

describe("Handoff surfaces — list", () => {
  const vm = buildHandoffListViewModel({
    activeCodes: [
      {
        code: "ABC123",
        sessionId: "sess-1",
        surfaceType: "telegram",
        createdAt: "2024-01-01T00:00:00Z",
        expiresAt: "2024-01-01T00:10:00Z",
        redeemed: false,
      },
      {
        code: "DEF456",
        sessionId: "sess-2",
        surfaceType: "telegram",
        createdAt: "2024-01-01T00:00:00Z",
        expiresAt: "2024-01-01T00:10:00Z",
        redeemed: false,
      },
    ],
  });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`handoff-list-${ctx.name}`);
    });
  }
});

describe("Handoff surfaces — list empty", () => {
  const vm = buildHandoffListViewModel({ activeCodes: [] });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`handoff-list-empty-${ctx.name}`);
    });
  }
});

describe("Handoff surfaces — no active session", () => {
  const vm = buildNoActiveSessionForHandoffViewModel({
    message: "No active session. Start an interactive session first, then run: estacoda handoff telegram",
  });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`handoff-no-session-${ctx.name}`);
    });
  }
});
