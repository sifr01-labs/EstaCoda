import { describe, expect, it, vi } from "vitest";
import {
  MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH,
  MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH
} from "../contracts/delegation.js";
import type { DurableDelegationService } from "../delegation/durable-delegation-service.js";
import { createDelegationTools, delegationToolProvider } from "./delegation-tools.js";

describe("createDelegationTools", () => {
  it("advertises immediate durable Task creation with the established input shape", () => {
    const [tool] = tools(vi.fn());

    expect(tool?.description).toContain("Returns a Task handle immediately");
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        task: { type: "string" },
        tasks: { oneOf: expect.any(Array) },
        allowedToolsets: { type: "array" },
        allowedTools: { type: "array" },
        role: { enum: ["leaf", "orchestrator"] },
        modelOverride: { required: ["model"] },
        synthesis: { required: ["objective"] }
      }
    });
  });

  it("forwards an explicit synthesis objective as a fixed terminal Step request", async () => {
    const create = vi.fn(() => ({
      ...handle("task-synthesis", 3),
      workerStepIds: ["step-a", "step-b"],
      synthesisStepId: "step-synthesis",
      primaryResultStepId: "step-synthesis"
    }));
    const [tool] = tools(create);
    const result = await tool!.run({
      tasks: [{ task: "A" }, { task: "B" }],
      synthesis: {
        objective: "Compare A and B.",
        modelOverride: { model: "synth-model" }
      }
    }, { toolCallId: "provider-call-synthesis" });

    expect(result.content).toContain("Synthesis Step: step-synthesis");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      synthesis: { objective: "Compare A and B.", modelOverride: { model: "synth-model" } }
    }));
  });

  it("creates one durable Step and returns the Task handle without waiting", async () => {
    const create = vi.fn(() => handle("task-1", 1));
    const [tool] = tools(create);

    const result = await tool!.run({
      task: "Inspect the module",
      context: "Focus on security.",
      allowedToolsets: ["files"],
      role: "leaf",
      modelOverride: { provider: " local ", model: " child-model " }
    }, { toolCallId: "provider-call-1" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Created durable Task task-1");
    expect(create).toHaveBeenCalledWith({
      toolCallId: "provider-call-1",
      trustedWorkspace: true,
      tasks: [{
        task: "Inspect the module",
        context: "Focus on security.",
        allowedToolsets: ["files"],
        allowedTools: undefined,
        role: "leaf",
        modelOverride: { provider: "local", model: "child-model" }
      }]
    });
  });

  it("normalizes a batch and forwards JSON recovery metadata", async () => {
    const create = vi.fn(() => handle("task-batch", 2));
    const [tool] = tools(create);
    const result = await tool!.run({
      tasks: JSON.stringify([{ task: "A" }, { task: "B", role: "orchestrator" }]),
      allowedToolsets: ["files"]
    }, { toolCallId: "provider-call-2" });

    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: "provider-call-2",
      recoveredTasksFromJsonString: true,
      tasks: [
        expect.objectContaining({ task: "A", role: "leaf", allowedToolsets: ["files"] }),
        expect.objectContaining({ task: "B", role: "orchestrator", allowedToolsets: ["files"] })
      ]
    }));
  });

  it("requires provider call identity before creating persistent work", async () => {
    const create = vi.fn();
    const [tool] = tools(create);
    const result = await tool!.run({ task: "Do work" });

    expect(result).toMatchObject({
      ok: false,
      metadata: { reason: "validation-error", code: "missing-tool-call-id" }
    });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "missing-task"],
    [{ tasks: [] }, "empty-tasks"],
    [{ tasks: "not-json" }, "invalid-json-string"],
    [{ tasks: [{ task: "" }] }, "empty-task-string"],
    [{ tasks: [{ task: "A", role: "invalid" }] }, "invalid-task-object"],
    [{ task: "A", synthesis: {} }, "invalid-synthesis"],
    [{ task: "A", synthesis: { objective: "S", extra: true } }, "invalid-synthesis"],
    [{ modelOverride: { model: "x".repeat(MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH + 1) }, task: "A" }, "invalid-model-override"],
    [{ modelOverride: { model: "m", provider: "x".repeat(MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH + 1) }, task: "A" }, "invalid-model-override"]
  ])("rejects malformed input %#", async (input, code) => {
    const create = vi.fn();
    const [tool] = tools(create);
    const result = await tool!.run(input, { toolCallId: "call" });
    expect(result).toMatchObject({ ok: false, metadata: { code } });
    expect(create).not.toHaveBeenCalled();
  });

  it("omits delegate_task when durable Task persistence is unavailable", () => {
    expect(delegationToolProvider.createTools({
      workspaceRoot: "/workspace",
      profileId: "alpha",
      sessionId: "session",
      currentSessionId: () => "session"
    })).toEqual([]);
  });
});

function tools(create: ReturnType<typeof vi.fn>) {
  return createDelegationTools({
    service: { create } as unknown as DurableDelegationService,
    trustedWorkspace: () => true
  });
}

function handle(taskId: string, stepCount: number) {
  return {
    taskId,
    status: "queued" as const,
    stepCount,
    childTask: false,
    idempotentReplay: false
  };
}
