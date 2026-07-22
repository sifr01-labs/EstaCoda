import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import {
  createDelegationAssistantPreviewRelay,
  createDelegationProgressRelay,
  delegationTaskDisplayLabel
} from "./progress-relay.js";

describe("createDelegationProgressRelay", () => {
  it("forwards selected child events with subagent identity", async () => {
    const events: RuntimeEvent[] = [];
    const relay = createDelegationProgressRelay({
      metadata: metadata(),
      parentOnEvent: (event) => {
        events.push(event);
      }
    });

    await relay({
      kind: "tool-start",
      tool: "file.read",
      targetSummary: "secret path",
      displayPreview: "\x1b[31msrc/app.ts?token=supersecret\x1b[0m\u202E",
      activityId: "\x1b[32mread-1\x1b[0m"
    });
    await relay({ kind: "provider-result", provider: "local", model: "test", ok: true, fallback: false, willFallback: false });

    expect(events).toEqual([
      {
        kind: "delegation-progress",
        ...metadata(),
        childEvent: {
          kind: "tool-start",
          tool: "file.read",
          activityId: "read-1",
          displayPreview: "src/app.ts?token=[redacted]"
        }
      },
      {
        kind: "delegation-progress",
        ...metadata(),
        childEvent: {
          kind: "provider-result",
          provider: "local",
          model: "test",
          ok: true,
          fallback: false,
          willFallback: false,
          errorClass: undefined,
          finishReason: undefined,
          incompleteReason: undefined
        }
      }
    ]);
    expect(JSON.stringify(events)).not.toContain("secret path");
  });

  it("does not relay raw prompts, provider tokens, or provider tool-call arguments", async () => {
    const events: RuntimeEvent[] = [];
    const relay = createDelegationProgressRelay({
      metadata: metadata(),
      parentOnEvent: (event) => {
        events.push(event);
      }
    });

    await relay({ kind: "agent-start", sessionId: "child", input: "full prompt api_key=secret" });
    await relay({ kind: "agent-final", text: "private child final answer" });
    await relay({ kind: "provider-token", provider: "local", model: "test", text: "raw-token" });
    await relay({ kind: "provider-tool-call", provider: "local", model: "test", argumentsText: "{\"token\":\"secret\"}" });

    expect(JSON.stringify(events)).not.toContain("api_key=secret");
    expect(JSON.stringify(events)).not.toContain("raw-token");
    expect(JSON.stringify(events)).not.toContain("argumentsText");
    expect(JSON.stringify(events)).not.toContain("private child final answer");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "delegation-progress",
      childEvent: {
        kind: "agent-start",
        sessionId: "child"
      }
    });
    expect(events[1]).toMatchObject({
      kind: "delegation-progress",
      childEvent: {
        kind: "agent-final",
        ok: true
      }
    });
  });

  it("throttles repeated noisy events", async () => {
    let now = 1_000;
    const events: RuntimeEvent[] = [];
    const relay = createDelegationProgressRelay({
      metadata: metadata(),
      throttleMs: 500,
      now: () => now,
      parentOnEvent: (event) => {
        events.push(event);
      }
    });

    await relay({ kind: "tool-start", tool: "file.read" });
    now += 100;
    await relay({ kind: "tool-start", tool: "file.read" });
    now += 500;
    await relay({ kind: "tool-start", tool: "file.read" });

    expect(events).toHaveLength(2);
  });

  it("does not throttle distinct tool activities with the same tool name", async () => {
    const events: RuntimeEvent[] = [];
    const relay = createDelegationProgressRelay({
      metadata: metadata(),
      throttleMs: 500,
      now: () => 1_000,
      parentOnEvent: (event) => {
        events.push(event);
      }
    });

    await relay({ kind: "tool-start", tool: "file.read", activityId: "read-1" });
    await relay({ kind: "tool-start", tool: "file.read", activityId: "read-2" });

    expect(events).toHaveLength(2);
  });

  it("builds bounded redacted task labels without terminal controls", () => {
    const label = delegationTaskDisplayLabel(
      "\x1b[31mInspect to\x1b[32mken=supersecret\x1b[0m\u202E and continue ".repeat(12)
    );

    expect(label.length).toBeLessThanOrEqual(96);
    expect(label).toContain("token=[redacted]");
    expect(label).not.toContain("supersecret");
    expect(label).not.toContain("\x1b");
    expect(label).not.toContain("\u202E");
  });

  it("normalizes display metadata at the relay boundary", async () => {
    const events: RuntimeEvent[] = [];
    const relay = createDelegationProgressRelay({
      metadata: {
        ...metadata(),
        taskIndex: 99,
        batchTaskCount: 100,
        taskLabel: "\x1b[31mInspect token=supersecret\x1b[0m\u202E"
      },
      parentOnEvent: (event) => {
        events.push(event);
      }
    });

    await relay({ kind: "agent-start", sessionId: "child", input: "private child prompt" });

    expect(events[0]).toMatchObject({
      kind: "delegation-progress",
      taskIndex: 9,
      batchTaskCount: 10,
      taskLabel: "Inspect token=[redacted]"
    });
  });

  it("relays bounded redacted visible assistant previews at the configured cadence", async () => {
    let now = 1_000;
    const events: RuntimeEvent[] = [];
    const relay = createDelegationAssistantPreviewRelay({
      metadata: {
        ...metadata(),
        taskId: "task-1",
        stepId: "step-1",
        attemptId: "attempt-1"
      },
      throttleMs: 1_000,
      now: () => now,
      parentOnEvent: (event) => {
        events.push(event);
      }
    });

    relay.push("\x1b[31mChecking password: hunter2\x1b[0m");
    now += 100;
    relay.push(" and continuing");
    now += 1_000;
    relay.push(" with the safe answer ".repeat(20));
    await relay.flush();

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "delegation-progress",
      taskId: "task-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      childEvent: { kind: "assistant-preview", preview: "Checking password: [REDACTED]" }
    });
    const finalPreview = (events[1] as Extract<RuntimeEvent, { kind: "delegation-progress" }>).childEvent.preview;
    expect(finalPreview?.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(events)).not.toContain("hunter2");
    expect(JSON.stringify(events)).not.toContain("\x1b");
  });
});

function metadata() {
  return {
    subagentId: "child",
    childSessionId: "child",
    parentSessionId: "parent",
    role: "leaf" as const,
    depth: 1,
    taskIndex: 2,
    batchId: "batch",
    taskLabel: "Inspect delegation",
    batchTaskCount: 3
  };
}
