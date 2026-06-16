import { describe, it, expect } from "vitest";
import { resolveTokens } from "../theme/token-resolver.js";
import type { TerminalCapabilities } from "../contracts/ui.js";
import type { ViewModel } from "../contracts/view-model.js";
import type { CronJob } from "./cron-store.js";
import type { CronExecutionRecord } from "./cron-execution-store.js";
import { StandardRenderer } from "../ui/renderers/standard-renderer.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import {
  buildCronHelpViewModel,
  buildCronListViewModel,
  buildCronJobDetailViewModel,
  buildCronExecutionHistoryViewModel,
  buildCronActionViewModel,
  buildCronCreatedViewModel,
  buildCronNotFoundViewModel,
  buildCronUsageErrorViewModel,
  buildCronUnknownCommandViewModel,
} from "./cron-view-models.js";

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

// ─────────────────────────────────────────────────────────────
// Fake data factories
// ─────────────────────────────────────────────────────────────

function fakeCronJob(overrides?: Partial<CronJob>): CronJob {
  return {
    id: "cron-test-1",
    name: "Test job",
    prompt: "Do something useful",
    schedule: "1h",
    scheduleKind: "interval",
    skills: ["test-skill"],
    delivery: "local",
    status: "active",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    nextRunAt: "2024-01-01T01:00:00Z",
    lastRunAt: undefined,
    lastStatus: undefined,
    runCount: 3,
    repeat: undefined,
    runRequested: false,
    origin: undefined,
    ...overrides,
  };
}

function fakeCronExecution(overrides?: Partial<CronExecutionRecord>): CronExecutionRecord {
  return {
    id: "exec-1",
    jobId: "cron-test-1",
    sessionId: undefined,
    trajectoryId: undefined,
    scheduledAt: undefined,
    startedAt: "2024-01-01T00:00:00Z",
    completedAt: "2024-01-01T00:00:05Z",
    status: "success",
    outputSummary: undefined,
    deliveryResults: new Map(),
    failureClass: undefined,
    failureMessage: undefined,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Snapshot tests
// ─────────────────────────────────────────────────────────────

describe("Cron surfaces — help", () => {
  const vm = buildCronHelpViewModel({
    commands: [
      { name: "add", description: "Add a cron job" },
      { name: "list", description: "List cron jobs" },
      { name: "show", description: "Show job detail" },
    ],
  });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`cron-help-${ctx.name}`);
    });
  }
});

describe("Cron surfaces — list empty", () => {
  const vm = buildCronListViewModel({ jobs: [] });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`cron-list-empty-${ctx.name}`);
    });
  }
});

describe("Cron surfaces — list with jobs", () => {
  const vm = buildCronListViewModel({
    jobs: [
      fakeCronJob(),
      fakeCronJob({ id: "cron-test-2", name: "Another job", status: "paused", script: "script.js", skills: [] }),
    ],
  });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`cron-list-jobs-${ctx.name}`);
    });
  }
});

describe("Cron surfaces — job detail", () => {
  const vm = buildCronJobDetailViewModel({
    job: fakeCronJob(),
    executions: [
      fakeCronExecution(),
      fakeCronExecution({
        id: "exec-2",
        status: "failed",
        failureClass: "timeout",
        failureMessage: "Job exceeded 30s",
        deliveryResults: new Map([["telegram", { success: false, error: "network" }]]),
      }),
    ],
  });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`cron-job-detail-${ctx.name}`);
    });
  }
});

describe("Cron surfaces — current capability labels", () => {
  it("renders attached skills as labels without planned advanced controls", () => {
    const output = renderPlain(buildCronJobDetailViewModel({
      job: fakeCronJob({ skills: ["daily-reporting"] }),
      executions: [],
    }));

    expect(output).toContain("Skills: daily-reporting");
    expect(output).not.toContain("no-agent");
    expect(output).not.toContain("contextFrom");
    expect(output).not.toContain("Model override");
    expect(output).not.toContain("Enabled toolsets");
    expect(output).not.toContain("Workdir");
  });
});

describe("Cron surfaces — execution history", () => {
  const vm = buildCronExecutionHistoryViewModel({
    executions: [
      fakeCronExecution(),
      fakeCronExecution({ id: "exec-2", status: "failed", failureClass: "error" }),
    ],
    jobId: "cron-test-1",
  });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`cron-history-${ctx.name}`);
    });
  }
});

describe("Cron surfaces — execution history empty", () => {
  const vm = buildCronExecutionHistoryViewModel({ executions: [], jobId: "cron-test-1" });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`cron-history-empty-${ctx.name}`);
    });
  }
});

describe("Cron surfaces — action", () => {
  const vm = buildCronActionViewModel({ action: "Paused", job: fakeCronJob() });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`cron-action-${ctx.name}`);
    });
  }
});

describe("Cron surfaces — created", () => {
  const vm = buildCronCreatedViewModel({ job: fakeCronJob() });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`cron-created-${ctx.name}`);
    });
  }
});

describe("Cron surfaces — not found", () => {
  const vm = buildCronNotFoundViewModel({ id: "missing-id" });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`cron-not-found-${ctx.name}`);
    });
  }
});

describe("Cron surfaces — usage error", () => {
  const vm = buildCronUsageErrorViewModel({ message: "Usage: cron show <job-id>" });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`cron-usage-error-${ctx.name}`);
    });
  }
});

describe("Cron surfaces — unknown command", () => {
  const vm = buildCronUnknownCommandViewModel({ command: "fly" });
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`cron-unknown-${ctx.name}`);
    });
  }
});
