import { describe, expect, it } from "vitest";
import { stringWidth } from "../screen/stringWidth.js";
import {
  ActiveWorkRuntimeEventMapper,
  applyActiveWorkRuntimeEvent,
  createActiveWorkRuntimeState,
  formatPlainDelegationProgressEvent,
  normalizeActiveWorkRuntimeEventId,
} from "./activeWorkRuntimeMapper.js";
import { formatActiveWorkSummary, getActiveWorkSurfaceDesiredHeight, renderActiveWorkSurface } from "./activeWorkSurface.js";

describe("active work runtime mapper", () => {
  it("maps runtime tool starts directly into localized active-work events", () => {
    const mapper = new ActiveWorkRuntimeEventMapper({ locale: "ar" });

    expect(mapper.build({
      kind: "tool-start",
      tool: "file.read",
      targetSummary: "src/main.ts",
      activityId: "read-1",
    })).toMatchObject({
      id: "read-1",
      toolName: "file.read",
      displayLabel: "قراءة ملف",
      status: "running",
      summary: "preparing",
      target: "src/main.ts",
      detailsRef: "read-1",
    });
  });

  it("maps paired runtime tool results with elapsed time and result metadata", () => {
    let now = 1_000;
    const mapper = new ActiveWorkRuntimeEventMapper({ now: () => now });

    mapper.build({
      kind: "tool-start",
      tool: "file.write",
      targetSummary: "src/app.ts",
      activityId: "write-1",
    });
    now = 2_800;

    expect(mapper.build({
      kind: "tool-result",
      tool: "file.write",
      ok: true,
      targetSummary: "src/app.ts",
      activityId: "write-1",
      fileChangePreview: {
        kind: "fileChangePreview",
        path: "src/app.ts",
        changeType: "modified",
        hunks: [],
      },
    })).toMatchObject({
      id: "write-1",
      toolName: "file.write",
      displayLabel: "Write File",
      status: "done",
      summary: "read",
      target: "src/app.ts",
      durationMs: 1800,
      detailsRef: "write-1",
      fileChangeInspected: true,
    });
  });

  it("maps gated and failed runtime tool results without old rail view models", () => {
    const mapper = new ActiveWorkRuntimeEventMapper();

    expect(mapper.build({
      kind: "tool-result",
      tool: "terminal.run",
      decision: "ask",
      riskClass: "workspace-write",
      targetSummary: "pnpm run build",
    })).toMatchObject({
      toolName: "terminal.run",
      status: "gated",
      summary: "gated",
      target: "pnpm run build",
      riskClass: "workspace-write",
    });

    expect(mapper.build({
      kind: "tool-result",
      tool: "terminal.run",
      ok: false,
      targetSummary: "pnpm run test",
    })).toMatchObject({
      toolName: "terminal.run",
      status: "failed",
      summary: "failed",
      target: "pnpm run test",
    });
  });

  it("prefers display previews over security target summaries", () => {
    const mapper = new ActiveWorkRuntimeEventMapper();

    expect(mapper.build({
      kind: "tool-start",
      tool: "terminal.run",
      targetSummary: "cd app && export CI=true && pnpm test && echo done",
      displayPreview: "pnpm test",
    })).toMatchObject({
      toolName: "terminal.run",
      displayLabel: "Run Command",
      target: "pnpm test",
    });
  });

  it("maps bounded delegation progress into one stable subagent row", () => {
    let now = 1_000;
    const mapper = new ActiveWorkRuntimeEventMapper({ now: () => now });
    let state = createActiveWorkRuntimeState();
    const metadata = {
      kind: "delegation-progress" as const,
      subagentId: "subagent-1",
      childSessionId: "child-session-1",
      parentSessionId: "parent-session",
      role: "leaf" as const,
      depth: 1,
      taskIndex: 1,
      batchId: "batch-1",
      taskLabel: "Inspect delegation",
      batchTaskCount: 3,
    };

    state = applyActiveWorkRuntimeEvent(state, mapper.buildDelegationProgress({
      ...metadata,
      childEvent: { kind: "agent-start", sessionId: "child-session-1" },
    }));
    now = 2_000;
    state = applyActiveWorkRuntimeEvent(state, mapper.buildDelegationProgress({
      ...metadata,
      childEvent: {
        kind: "tool-start",
        tool: "file.read",
        activityId: "read-1",
        displayPreview: "src/delegation/progress-relay.ts"
      },
    }));
    now = 4_000;
    state = applyActiveWorkRuntimeEvent(state, mapper.buildDelegationProgress({
      ...metadata,
      childEvent: { kind: "agent-final", ok: true },
    }));
    expect(state.items[0]).toMatchObject({ status: "running", target: "finalizing" });
    now = 4_500;
    state = applyActiveWorkRuntimeEvent(state, mapper.buildDelegationProgress({
      ...metadata,
      childEvent: { kind: "delegation-result", status: "completed" },
    }));

    expect(state.items).toEqual([{
      id: "subagent:child-session-1",
      toolName: "delegate_task",
      displayLabel: "Worker 2",
      source: "subagent",
      groupId: "batch-1",
      taskIndex: 1,
      taskLabel: "Inspect delegation",
      batchTaskCount: 3,
      activityLog: [
        { id: "lifecycle:agent-start", label: "starting", status: "running" },
        {
          id: "tool:read-1",
          label: "Read File",
          detail: "src/delegation/progress-relay.ts",
          status: "running"
        },
        { id: "lifecycle:agent-final", label: "finalizing", status: "running" }
      ],
      delegationOutcome: "completed",
      status: "succeeded",
      summary: "completed",
      target: "completed",
      startedAtMs: 1_000,
      endedAtMs: 4_500,
      durationMs: 3_500,
      detailsRef: "child-session-1",
    }]);
  });

  it("coalesces child tool starts and results into one worker activity", () => {
    const mapper = new ActiveWorkRuntimeEventMapper();
    let state = createActiveWorkRuntimeState();
    const metadata = {
      kind: "delegation-progress" as const,
      subagentId: "subagent-1",
      childSessionId: "child-session-1",
      parentSessionId: "parent-session",
      role: "leaf" as const,
      depth: 1,
      taskIndex: 0,
      taskLabel: "Inspect delegation",
      batchTaskCount: 1
    };

    state = applyActiveWorkRuntimeEvent(state, mapper.buildDelegationProgress({
      ...metadata,
      childEvent: {
        kind: "tool-start",
        tool: "file.read",
        activityId: "read-1",
        displayPreview: "src/delegation/progress-relay.ts"
      }
    }));
    state = applyActiveWorkRuntimeEvent(state, mapper.buildDelegationProgress({
      ...metadata,
      childEvent: {
        kind: "tool-result",
        tool: "file.read",
        activityId: "read-1",
        displayPreview: "src/delegation/progress-relay.ts",
        ok: true
      }
    }));

    expect(state.items[0]?.activityLog).toEqual([{
      id: "tool:read-1",
      label: "Read File",
      detail: "src/delegation/progress-relay.ts",
      status: "succeeded"
    }]);
  });

  it("keeps only the six most recent worker activities", () => {
    const mapper = new ActiveWorkRuntimeEventMapper();
    let state = createActiveWorkRuntimeState();
    const metadata = {
      kind: "delegation-progress" as const,
      subagentId: "subagent-rolling",
      childSessionId: "child-rolling",
      parentSessionId: "parent-session",
      role: "leaf" as const,
      depth: 1,
      taskIndex: 0
    };

    for (let index = 0; index < 8; index += 1) {
      state = applyActiveWorkRuntimeEvent(state, mapper.buildDelegationProgress({
        ...metadata,
        childEvent: {
          kind: "tool-start",
          tool: "file.read",
          activityId: `read-${index}`,
          displayPreview: `src/file-${index}.ts`
        }
      }));
    }

    expect(state.items[0]?.activityLog).toHaveLength(6);
    expect(state.items[0]?.activityLog?.map((activity) => activity.id)).toEqual([
      "tool:read-2",
      "tool:read-3",
      "tool:read-4",
      "tool:read-5",
      "tool:read-6",
      "tool:read-7"
    ]);
  });

  it("marks terminal provider failures without exposing provider identity", () => {
    const mapper = new ActiveWorkRuntimeEventMapper();
    const event = mapper.buildDelegationProgress({
      kind: "delegation-progress",
      subagentId: "subagent-provider",
      childSessionId: "child-provider",
      parentSessionId: "parent-session",
      role: "leaf",
      depth: 1,
      taskIndex: 0,
      childEvent: {
        kind: "provider-result",
        provider: "private-provider",
        model: "private-model",
        ok: false,
        fallback: false,
        willFallback: false
      }
    });

    expect(event.activity).toEqual({
      id: "provider",
      label: "thinking",
      status: "failed"
    });
    expect(JSON.stringify(event)).not.toContain("private-provider");
    expect(JSON.stringify(event)).not.toContain("private-model");
  });

  it("keeps child tool failures non-terminal until the child itself settles", () => {
    let now = 5_000;
    const mapper = new ActiveWorkRuntimeEventMapper({ now: () => now });
    const metadata = {
      kind: "delegation-progress" as const,
      subagentId: "subagent-2",
      childSessionId: "child-session-2",
      parentSessionId: "parent-session",
      role: "orchestrator" as const,
      depth: 1,
    };

    mapper.buildDelegationProgress({
      ...metadata,
      childEvent: { kind: "agent-start", sessionId: "child-session-2" },
    });
    now = 5_750;

    expect(mapper.buildDelegationProgress({
      ...metadata,
      childEvent: { kind: "tool-result", tool: "file.read", ok: false },
    })).toMatchObject({
      id: "subagent:child-session-2",
      displayLabel: "Orchestrator",
      source: "subagent",
      groupId: "subagent-2",
      status: "running",
      target: "Read File",
    });

    now = 6_500;
    expect(mapper.buildDelegationProgress({
      ...metadata,
      childEvent: { kind: "agent-cancelled", reason: "sensitive internal reason" },
    })).toMatchObject({
      status: "running",
      summary: "cancelling",
      target: "cancelling",
    });

    now = 7_000;
    expect(mapper.buildDelegationProgress({
      ...metadata,
      childEvent: { kind: "delegation-result", status: "cancelled" },
    })).toMatchObject({
      status: "cancelled",
      summary: "cancelled",
      target: "cancelled",
      delegationOutcome: "cancelled",
      startedAtMs: 5_000,
      endedAtMs: 7_000,
      durationMs: 2_000,
    });
  });

  it("preserves blocked and failed delegation outcomes after generic status mapping", () => {
    let now = 8_000;
    const mapper = new ActiveWorkRuntimeEventMapper({ now: () => now });

    for (const [index, outcome] of (["blocked", "failed"] as const).entries()) {
      const metadata = {
        kind: "delegation-progress" as const,
        subagentId: `subagent-${outcome}`,
        childSessionId: `child-${outcome}`,
        parentSessionId: "parent-session",
        role: "leaf" as const,
        depth: 1,
        taskIndex: index,
      };
      mapper.buildDelegationProgress({
        ...metadata,
        childEvent: { kind: "agent-start", sessionId: metadata.childSessionId },
      });
      now += 500;
      const state = applyActiveWorkRuntimeEvent(
        createActiveWorkRuntimeState(),
        mapper.buildDelegationProgress({
          ...metadata,
          childEvent: { kind: "delegation-result", status: outcome },
        })
      );

      expect(state.items[0]).toMatchObject({
        status: "failed",
        delegationOutcome: outcome,
        startedAtMs: now - 500,
        endedAtMs: now,
        durationMs: 500,
      });
      now += 500;
    }
  });

  it("localizes delegated child labels without surfacing provider or cancellation details", () => {
    const mapper = new ActiveWorkRuntimeEventMapper({ locale: "ar" });
    const base = {
      kind: "delegation-progress" as const,
      subagentId: "subagent-secret",
      childSessionId: "child-secret",
      parentSessionId: "parent-secret",
      role: "leaf" as const,
      depth: 1,
      taskIndex: 0,
      batchId: "batch-secret",
    };

    const providerEvent = mapper.buildDelegationProgress({
      ...base,
      childEvent: {
        kind: "provider-attempt",
        provider: "private-provider",
        model: "private-model",
        fallback: false,
      },
    });
    const cancelledEvent = mapper.buildDelegationProgress({
      ...base,
      childEvent: { kind: "delegation-result", status: "cancelled", reason: "private cancellation detail" },
    });
    const visibleText = [
      providerEvent.displayLabel,
      providerEvent.summary,
      providerEvent.target,
      cancelledEvent.summary,
      cancelledEvent.target,
    ].join(" ");

    expect(providerEvent).toMatchObject({
      displayLabel: "عامل 1",
      status: "running",
      summary: "يفكر",
      target: "يفكر",
    });
    expect(mapper.build({
      kind: "tool-result",
      tool: "delegate_task",
      ok: true,
    }).target).toBe("1 ملغاة");
    expect(formatPlainDelegationProgressEvent({
      ...base,
      childEvent: { kind: "agent-start", sessionId: "child-secret" },
    }, "ar")).toBe("عامل 1: بدء العمل");
    expect(formatPlainDelegationProgressEvent({
      ...base,
      childEvent: { kind: "delegation-result", status: "timeout" },
    }, "ar")).toBe("عامل 1: انتهت المهلة");
    expect(visibleText).not.toContain("private-provider");
    expect(visibleText).not.toContain("private-model");
    expect(visibleText).not.toContain("private cancellation detail");
  });

  it("summarizes observed child outcomes on the parent delegation result", () => {
    const mapper = new ActiveWorkRuntimeEventMapper();
    const parentStart = mapper.build({
      kind: "tool-start",
      tool: "delegate_task",
      activityId: "delegate-1",
      targetSummary: "raw delegated task text",
    });
    const child = (childSessionId: string, taskIndex: number) => ({
      kind: "delegation-progress" as const,
      subagentId: childSessionId,
      childSessionId,
      parentSessionId: "parent-session",
      role: "leaf" as const,
      depth: 1,
      taskIndex,
      batchId: "batch-1",
    });

    mapper.buildDelegationProgress({
      ...child("child-1", 0),
      childEvent: { kind: "delegation-result", status: "completed" },
    });
    mapper.buildDelegationProgress({
      ...child("child-2", 1),
      childEvent: { kind: "delegation-result", status: "cancelled" },
    });
    mapper.buildDelegationProgress({
      ...child("child-3", 2),
      childEvent: { kind: "delegation-result", status: "timeout" },
    });
    mapper.buildDelegationProgress({
      ...child("child-4", 3),
      childEvent: { kind: "delegation-result", status: "failed" },
    });
    const parentResult = mapper.build({
      kind: "tool-result",
      tool: "delegate_task",
      activityId: "delegate-1",
      ok: true,
      targetSummary: "raw delegated task text",
    });

    expect(parentStart.target).toBe("starting subagents");
    expect(parentResult).toMatchObject({
      id: "delegate-1",
      status: "done",
      summary: "delegate",
      target: "1 completed · 1 cancelled · 1 timed out · 1 failed",
    });
    expect(JSON.stringify([parentStart, parentResult])).not.toContain("raw delegated task text");
  });

  it("keeps settlement monotonic when cancellation arrives after timeout", () => {
    const mapper = new ActiveWorkRuntimeEventMapper();
    const child = {
      kind: "delegation-progress" as const,
      subagentId: "child-timeout",
      childSessionId: "child-timeout",
      parentSessionId: "parent-session",
      role: "leaf" as const,
      depth: 1,
      taskIndex: 0,
    };
    mapper.build({ kind: "tool-start", tool: "delegate_task", activityId: "delegate-timeout" });
    mapper.buildDelegationProgress({
      ...child,
      childEvent: { kind: "agent-start", sessionId: "child-timeout" },
    });
    const timeout = mapper.buildDelegationProgress({
      ...child,
      childEvent: { kind: "delegation-result", status: "timeout" },
    });
    const lateCancellation = mapper.buildDelegationProgress({
      ...child,
      childEvent: { kind: "agent-cancelled", reason: "child-timeout" },
    });
    const parentResult = mapper.build({
      kind: "tool-result",
      tool: "delegate_task",
      activityId: "delegate-timeout",
      ok: false,
    });

    expect(lateCancellation).toEqual(timeout);
    expect(timeout).toMatchObject({
      delegationOutcome: "timeout",
      startedAtMs: expect.any(Number),
      endedAtMs: expect.any(Number),
    });
    expect(parentResult.target).toBe("1 timed out");
  });

  it("normalizes runtime event identity for active work and tool trails", () => {
    expect(normalizeActiveWorkRuntimeEventId({
      id: " read-1 ",
      toolName: "read_file",
      status: "running",
      target: "src/app.ts",
    })).toBe("read-1");
    expect(normalizeActiveWorkRuntimeEventId({
      toolName: " read_file ",
      status: "running",
      target: "src/app.ts",
    })).toBe("read_file\0src/app.ts");
  });

  it("keeps the active work model and default rendering uncapped", () => {
    let state = createActiveWorkRuntimeState();
    for (let index = 0; index < 12; index += 1) {
      state = applyActiveWorkRuntimeEvent(state, {
        id: `tool-${index}`,
        toolName: "read_file",
        status: index < 2 ? "running" : "done",
        summary: "completed",
        target: `src/file-${index}.ts`,
        durationMs: index * 1000,
      });
    }

    expect(state.items).toHaveLength(12);

    const lines = renderActiveWorkSurface(state, { width: 80 });
    expect(lines).toHaveLength(getActiveWorkSurfaceDesiredHeight(state));
    expect(lines.join("\n")).toContain("Running tools");
    expect(lines.join("\n")).toContain("src/file-11.ts");
    expect(lines.join("\n")).not.toContain("more completed this turn");
    expect(lines.every((line) => stringWidth(line) <= 80)).toBe(true);
  });

  it("upserts paired start/result events and preserves file-change inspection metadata", () => {
    let state = createActiveWorkRuntimeState();

    state = applyActiveWorkRuntimeEvent(state, {
      id: "write-1",
      toolName: "write_file",
      status: "running",
      summary: "preparing",
      target: "src/app.ts",
    });
    state = applyActiveWorkRuntimeEvent(state, {
      id: "write-1",
      toolName: "write_file",
      status: "done",
      summary: "write_file",
      target: "src/app.ts",
      durationMs: 1800,
      fileChangeInspected: true,
    });

    expect(state.items).toEqual([
      expect.objectContaining({
        id: "write-1",
        toolName: "write_file",
        status: "succeeded",
        target: "src/app.ts",
        durationMs: 1800,
        fileChangeInspected: true,
      }),
    ]);
    expect(formatActiveWorkSummary(state)).toBe(
      "1 completed · 0 active · 0 failed · Worked for 00:01"
    );
  });

  it("preserves raw tool names while carrying localized display labels", () => {
    const state = applyActiveWorkRuntimeEvent(createActiveWorkRuntimeState(), {
      id: "read-1",
      toolName: "file.read",
      displayLabel: "قراءة ملف",
      status: "running",
      target: "src/app.ts",
    });

    expect(state.items[0]).toMatchObject({
      id: "read-1",
      toolName: "file.read",
      displayLabel: "قراءة ملف",
      status: "running",
      target: "src/app.ts",
    });

    const rendered = renderActiveWorkSurface(state, { width: 80, height: 4, locale: "ar" }).join("\n");
    expect(rendered).toContain("قراءة ملف");
    expect(rendered).not.toContain("file.read");
  });

  it("formats collapsed summaries from uncapped mapped live events", () => {
    let state = createActiveWorkRuntimeState();
    state = applyActiveWorkRuntimeEvent(state, { id: "run", toolName: "read_file", status: "running" });
    state = applyActiveWorkRuntimeEvent(state, { id: "queue", toolName: "rg", status: "pending" });
    state = applyActiveWorkRuntimeEvent(state, { id: "approval", toolName: "shell", status: "gated" });
    for (let index = 0; index < 38; index += 1) {
      state = applyActiveWorkRuntimeEvent(state, {
        id: `done-${index}`,
        toolName: "read_file",
        status: "done",
        target: `src/done-${index}.ts`,
      });
    }
    state = applyActiveWorkRuntimeEvent(state, {
      id: "edit",
      toolName: "write_file",
      status: "done",
      target: "src/generated.ts",
      fileChangeInspected: true,
    });

    expect(state.items).toHaveLength(42);
    expect(formatActiveWorkSummary(state)).toBe(
      "39 completed · 3 active · 0 failed · Worked for 00:00"
    );
    const rendered = renderActiveWorkSurface(state, { width: 80 }).join("\n");
    expect(rendered).toContain("src/done-37.ts");
    expect(rendered).toContain("src/generated.ts");
    expect(rendered).not.toContain("more completed this turn");
  });

  it("maps queued, running, awaiting approval, and terminal statuses for active-work sorting", () => {
    let state = createActiveWorkRuntimeState();
    state = applyActiveWorkRuntimeEvent(state, { id: "done", toolName: "typecheck", status: "done" });
    state = applyActiveWorkRuntimeEvent(state, { id: "queued", toolName: "read_file", status: "pending" });
    state = applyActiveWorkRuntimeEvent(state, { id: "approval", toolName: "shell", status: "gated" });
    state = applyActiveWorkRuntimeEvent(state, { id: "running", toolName: "rg", status: "running" });
    state = applyActiveWorkRuntimeEvent(state, { id: "failed", toolName: "test", status: "failed" });
    state = applyActiveWorkRuntimeEvent(state, { id: "cancelled", toolName: "browser", status: "cancelled" });

    expect(state.items.map((item) => item.status)).toEqual([
      "succeeded",
      "queued",
      "awaitingApproval",
      "running",
      "failed",
      "cancelled",
    ]);

    const rendered = renderActiveWorkSurface(state, { width: 88, height: 8 }).join("\n");
    expect(rendered.indexOf("rg")).toBeLessThan(rendered.indexOf("read_file"));
    expect(rendered.indexOf("read_file")).toBeLessThan(rendered.indexOf("shell"));
    expect(rendered.indexOf("shell")).toBeLessThan(rendered.indexOf("typecheck"));
  });

  it("keeps technical tokens unchanged in Arabic renders", () => {
    const state = applyActiveWorkRuntimeEvent(createActiveWorkRuntimeState(), {
      id: "read-output",
      toolName: "read_file",
      status: "running",
      summary: "preparing",
      target: "src/ui/papyrus/screen/output.ts",
      durationMs: 3000,
    });

    const rendered = renderActiveWorkSurface(state, { width: 80, height: 5, locale: "ar" }).join("\n");
    expect(rendered).toContain("تنفيذ الأدوات");
    expect(rendered).toContain("read_file");
    expect(rendered).toContain("src/ui/papyrus/screen/output.ts");
    expect(rendered).toContain("3s");
    expect(rendered.split("\n").every((line) => stringWidth(line) <= 80)).toBe(true);
  });
});
