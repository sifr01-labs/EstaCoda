import { describe, it, expect } from "vitest";
import { resolveTokens } from "../theme/token-resolver.js";
import type { TerminalCapabilities } from "../contracts/ui.js";
import type { ViewModel } from "../contracts/view-model.js";
import { StandardRenderer } from "../ui/renderers/standard-renderer.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import {
  buildGatewayStatusViewModel,
  buildGatewayDiagnoseViewModel,
  buildChannelsListViewModel,
  buildChannelsStatusViewModel,
} from "./gateway-view-models.js";
import type {
  GatewayStatusData,
  GatewayDiagnoseData,
  ChannelsStatusData,
} from "./gateway-view-models.js";

// ─────────────────────────────────────────────────────────────
// Rendering context factories
// ─────────────────────────────────────────────────────────────

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
  return {
    ...fullCaps(),
    supportsColor: false,
    supportsTrueColor: false,
  };
}

function noUnicodeCaps(): TerminalCapabilities {
  return {
    ...fullCaps(),
    supportsUnicode: false,
    supportsEmoji: false,
  };
}

function narrowCaps(): TerminalCapabilities {
  return {
    ...fullCaps(),
    terminalWidth: 40,
  };
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

// ─────────────────────────────────────────────────────────────
// Snapshot helpers
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Fake data factories
// ─────────────────────────────────────────────────────────────

function fakeGatewayStatusData(): GatewayStatusData {
  return {
    channels: {
      telegram: { enabled: false, ready: false },
      discord: { enabled: false, ready: false },
      email: { enabled: false, ready: false },
      whatsapp: { enabled: false, ready: false, experimental: false },
    } as unknown as GatewayStatusData["channels"],
    cronJobs: [
      { status: "active", name: "test-job", nextRunAt: "2024-01-01T00:00:00Z" },
    ],
    recentCronFailures: [
      { jobId: "job-1", status: "failed", startedAt: "2024-01-01T00:00:00Z", failureMessage: "script exited 1" },
    ],
    recentDeliveryErrors: [
      { timestamp: "2024-01-01T00:00:00Z", target: "telegram:123", error: "No delivery adapter available for telegram", retryCount: 0 },
    ],
    surfacePointers: [
      { surfaceType: "telegram", surfaceId: "chat-1", record: { sessionId: "sess-1", attachedAt: "2024-01-01T00:00:00Z", homeDelivery: "local" } },
    ],
    approvalCount: 1,
    missingConfig: [
      { channel: "telegram", item: "BOT_TOKEN_ENV" },
    ],
  };
}

function fakeGatewayDiagnoseData(): GatewayDiagnoseData {
  return {
    telegram: {
      adapter: "telegram",
      enabled: true,
      ready: false,
      statusLabel: "configured, missing credentials",
      modelRoute: "unconfigured/smoke-model",
      contextWindowTokens: 0,
      securityLabel: "locked until allowlist or pairing is configured",
      allowedUserIds: [],
      allowedChatIds: [],
      groupSessionsPerUser: true,
      threadSessionsPerUser: false,
      sessionResetPolicy: "none",
      sessionIdleResetMinutes: undefined,
      botTokenEnv: undefined,
      botTokenPresent: false,
      defaultChatId: undefined,
      pollTimeoutSeconds: undefined,
      maxAttachmentBytes: undefined,
      missing: ["BOT_TOKEN_ENV"],
      pairingCode: undefined,
      pairingExpiresAt: undefined,
      processMode: "foreground process",
      logsLocation: "stdout/stderr",
      stateRoot: "/tmp/.estacoda",
      sessionDbPath: "/tmp/.estacoda/sessions.sqlite",
      mediaRoot: "/tmp/.estacoda/channel-media",
      approvalStorePath: "/tmp/.estacoda/channel-approvals.json",
      sessionContextPath: "/tmp/.estacoda/channel-sessions.json",
      configSources: [],
    },
    discord: { enabled: false, ready: false },
    email: { enabled: false, ready: false },
    whatsapp: {
      adapter: "whatsapp",
      enabled: false,
      experimental: false,
      ready: false,
      statusLabel: "baileys missing",
      authDir: "/tmp/.estacoda/whatsapp-auth",
      authDirWritable: false,
      baileysAvailable: false,
      allowedUsers: undefined,
      missing: ["@whiskeysockets/baileys"],
    },
    whatsappExperimental: false,
    cronJobs: [],
    jobsFileReadable: true,
    outputDirWritable: true,
    lockDirWritable: true,
  } as unknown as GatewayDiagnoseData;
}

function fakeChannelsStatusData(): ChannelsStatusData {
  return {
    channel: "telegram",
    telegram: {
      diag: fakeGatewayDiagnoseData().telegram,
      pointers: [
        { surfaceType: "telegram", surfaceId: "chat-1", record: { sessionId: "sess-1", attachedAt: "2024-01-01T00:00:00Z" } },
      ],
    },
  } as unknown as ChannelsStatusData;
}

// ─────────────────────────────────────────────────────────────
// Test suites
// ─────────────────────────────────────────────────────────────

describe("Gateway surfaces — status", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const vm = buildGatewayStatusViewModel(fakeGatewayStatusData());
      const output = ctx.renderer.render(vm);
      expect(output).toMatchSnapshot(`gateway-status-${ctx.name}`);
    });
  }
});

describe("Gateway surfaces — diagnose", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const vm = buildGatewayDiagnoseViewModel(fakeGatewayDiagnoseData());
      const output = ctx.renderer.render(vm);
      expect(output).toMatchSnapshot(`gateway-diagnose-${ctx.name}`);
    });
  }
});

describe("Gateway surfaces — channels list", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const vm = buildChannelsListViewModel({
        channels: fakeGatewayStatusData().channels,
      });
      const output = ctx.renderer.render(vm);
      expect(output).toMatchSnapshot(`channels-list-${ctx.name}`);
    });
  }
});

describe("Gateway surfaces — channels status", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const vm = buildChannelsStatusViewModel(fakeChannelsStatusData());
      const output = ctx.renderer.render(vm);
      expect(output).toMatchSnapshot(`channels-status-${ctx.name}`);
    });
  }
});

describe("Gateway surfaces — channels status unknown", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const vm = buildChannelsStatusViewModel({ channel: "unknown" });
      const output = ctx.renderer.render(vm);
      expect(output).toMatchSnapshot(`channels-status-unknown-${ctx.name}`);
    });
  }
});
