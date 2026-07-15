import { describe, expect, it, vi } from "vitest";
import {
  MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH,
  MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH
} from "../contracts/delegation.js";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import { createDelegationTools } from "./delegation-tools.js";

describe("createDelegationTools", () => {
  it("preserves the existing delegate_task schema shape", () => {
    const [tool] = createDelegationTools({
      manager: { delegate: vi.fn() } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true
    });

    expect(tool?.name).toBe("delegate_task");
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        task: { type: "string" },
        tasks: expect.objectContaining({
          oneOf: expect.any(Array)
        }),
        context: { type: "string" },
        allowedToolsets: {
          type: "array",
          items: { type: "string" }
        },
        allowedTools: {
          type: "array",
          items: { type: "string" }
        },
        role: {
          type: "string",
          enum: ["leaf", "orchestrator"]
        },
        modelOverride: {
          type: "object",
          required: ["model"]
        }
      }
    });
    expect((tool?.inputSchema as { anyOf?: unknown }).anyOf).toBeUndefined();
  });

  it("passes tool execution AbortSignal and event sink into DelegationManager.delegate", async () => {
    const delegate = vi.fn(async () => ({
      childSessionId: "child",
      status: "completed",
      task: "Do work",
      summary: "done",
      role: "leaf",
      depth: 1,
      allowedToolsets: [],
      allowedTools: [],
      effectiveAllowedToolsets: [],
      effectiveAllowedTools: [],
      strippedTools: [],
      blockedTools: [],
      rejectedRequestedTools: [],
      rejectedRequestedToolsets: [],
      toolExecutions: []
    }));
    const [tool] = createDelegationTools({
      manager: { delegate } as never,
      parentSessionId: () => "parent",
      profileId: "default",
      trustedWorkspace: async () => true
    });
    const controller = new AbortController();
    const onEvent = vi.fn();

    const result = await tool!.run({ task: "Do work" }, { signal: controller.signal, onEvent });

    expect(result.ok).toBe(true);
    expect(delegate).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: "parent",
      profileId: "default",
      task: "Do work",
      role: "leaf",
      modelOverride: undefined,
      trustedWorkspace: true,
      signal: controller.signal,
      onEvent
    }));
  });

  it("passes normalized model overrides into single delegation", async () => {
    const delegate = vi.fn(async () => ({
      childSessionId: "child",
      status: "completed",
      task: "Do work",
      summary: "done",
      role: "leaf",
      depth: 1,
      allowedToolsets: [],
      allowedTools: [],
      effectiveAllowedToolsets: [],
      effectiveAllowedTools: [],
      strippedTools: [],
      blockedTools: [],
      rejectedRequestedTools: [],
      rejectedRequestedToolsets: [],
      toolExecutions: []
    }));
    const [tool] = createDelegationTools({
      manager: { delegate } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true
    });

    await tool!.run({
      task: "Do work",
      modelOverride: { provider: " local ", model: " child-model " }
    });

    expect(delegate).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: {
        provider: "local",
        model: "child-model"
      }
    }));
  });

  it("rejects overlong model overrides before launching delegation", async () => {
    const delegate = vi.fn();
    const [tool] = createDelegationTools({
      manager: { delegate } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true
    });
    const overlongModelId = `model-${"x".repeat(MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH + 1)}`;

    const result = await tool!.run({
      task: "Do work",
      modelOverride: { model: overlongModelId }
    });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        reason: "validation-error",
        code: "invalid-model-override"
      }
    });
    expect(result.content).toContain(`${MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH}`);
    expect(JSON.stringify(result)).not.toContain(overlongModelId);
    expect(delegate).not.toHaveBeenCalled();
  });

  it("rejects overlong provider overrides before launching delegation", async () => {
    const delegate = vi.fn();
    const [tool] = createDelegationTools({
      manager: { delegate } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true
    });
    const overlongProviderId = `provider-${"x".repeat(MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH + 1)}`;

    const result = await tool!.run({
      task: "Do work",
      modelOverride: { provider: overlongProviderId, model: "child-model" }
    });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        reason: "validation-error",
        code: "invalid-model-override"
      }
    });
    expect(result.content).toContain(`${MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH}`);
    expect(JSON.stringify(result)).not.toContain(overlongProviderId);
    expect(delegate).not.toHaveBeenCalled();
  });

  it("keeps task required for single-task mode", async () => {
    const [tool] = createDelegationTools({
      manager: { delegate: vi.fn() } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true
    });

    const result = await tool!.run({ task: "   " });

    expect(result).toMatchObject({
      ok: false,
      content: "delegate_task requires a non-empty task."
    });
  });

  it("rejects invalid batch inputs with structured errors", async () => {
    const [tool] = createDelegationTools({
      manager: { delegate: vi.fn(), delegateBatch: vi.fn() } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true,
      delegationConfig: {
        ...DEFAULT_DELEGATION_CONFIG,
        maxBatchTasks: 2
      }
    });

    await expect(tool!.run({ tasks: [] })).resolves.toMatchObject({
      ok: false,
      metadata: {
        reason: "validation-error",
        code: "empty-tasks"
      }
    });
    await expect(tool!.run({ tasks: [{ task: "ok" }, { task: "two" }, { task: "three" }] })).resolves.toMatchObject({
      ok: false,
      metadata: {
        code: "too-many-tasks"
      }
    });
    await expect(tool!.run({ tasks: [{ task: " " }] })).resolves.toMatchObject({
      ok: false,
      metadata: {
        code: "empty-task-string"
      }
    });
  });

  it("enforces the hard batch maximum when direct tool config is larger", async () => {
    const delegateBatch = vi.fn();
    const [tool] = createDelegationTools({
      manager: { delegate: vi.fn(), delegateBatch } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true,
      delegationConfig: {
        ...DEFAULT_DELEGATION_CONFIG,
        maxBatchTasks: 100
      }
    });

    const result = await tool!.run({
      tasks: Array.from({ length: 11 }, (_, index) => ({ task: `Task ${index + 1}` }))
    });

    expect(tool!.description).toContain("up to 10 batch tasks");
    expect(result).toMatchObject({
      ok: false,
      metadata: { code: "too-many-tasks" }
    });
    expect(delegateBatch).not.toHaveBeenCalled();
  });

  it("recovers strict JSON-string tasks when enabled", async () => {
    const delegateBatch = vi.fn(async () => ({
      batchId: "batch",
      status: "completed",
      summary: "done",
      results: [],
      maxObservedConcurrency: 1,
      recoveredTasksFromJsonString: true
    }));
    const [tool] = createDelegationTools({
      manager: { delegate: vi.fn(), delegateBatch } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true,
      delegationConfig: {
        ...DEFAULT_DELEGATION_CONFIG,
        recoverJsonStringTasks: true
      }
    });

    const result = await tool!.run({
      tasks: JSON.stringify([{ task: "A" }])
    });

    expect(result.ok).toBe(true);
    expect(delegateBatch).toHaveBeenCalledWith(expect.objectContaining({
      recoveredTasksFromJsonString: true,
      tasks: [expect.objectContaining({ task: "A" })]
    }));
  });

  it("rejects invalid or disabled JSON-string task recovery", async () => {
    const [enabledTool] = createDelegationTools({
      manager: { delegate: vi.fn(), delegateBatch: vi.fn() } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true,
      delegationConfig: {
        ...DEFAULT_DELEGATION_CONFIG,
        recoverJsonStringTasks: true
      }
    });
    await expect(enabledTool!.run({ tasks: "{\"task\":\"nope\"}" })).resolves.toMatchObject({
      ok: false,
      metadata: {
        code: "json-tasks-not-array"
      }
    });
    await expect(enabledTool!.run({ tasks: JSON.stringify([{ task: "A", context: 123 }]) })).resolves.toMatchObject({
      ok: false,
      metadata: {
        reason: "validation-error",
        code: "invalid-task-object"
      }
    });
    await expect(enabledTool!.run({ tasks: JSON.stringify([{ task: "A", extra: true }]) })).resolves.toMatchObject({
      ok: false,
      metadata: {
        reason: "validation-error",
        code: "invalid-task-object"
      }
    });
    await expect(enabledTool!.run({ tasks: JSON.stringify([{ task: "A", modelOverride: { model: "m", extra: true } }]) })).resolves.toMatchObject({
      ok: false,
      metadata: {
        reason: "validation-error",
        code: "invalid-model-override"
      }
    });

    const [disabledTool] = createDelegationTools({
      manager: { delegate: vi.fn(), delegateBatch: vi.fn() } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true,
      delegationConfig: {
        ...DEFAULT_DELEGATION_CONFIG,
        recoverJsonStringTasks: false
      }
    });
    await expect(disabledTool!.run({ tasks: JSON.stringify([{ task: "A" }]) })).resolves.toMatchObject({
      ok: false,
      metadata: {
        code: "json-string-recovery-disabled"
      }
    });
  });

  it("does not launch delegation for invalid recovered task objects", async () => {
    const delegateBatch = vi.fn();
    const [tool] = createDelegationTools({
      manager: { delegate: vi.fn(), delegateBatch } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true,
      delegationConfig: {
        ...DEFAULT_DELEGATION_CONFIG,
        recoverJsonStringTasks: true
      }
    });

    const result = await tool!.run({
      tasks: JSON.stringify([{ task: "A", context: 123 }])
    });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        reason: "validation-error",
        code: "invalid-task-object"
      }
    });
    expect(delegateBatch).not.toHaveBeenCalled();
  });

  it("applies batch defaults and task-level overrides", async () => {
    const delegateBatch = vi.fn(async () => ({
      batchId: "batch",
      status: "completed",
      summary: "done",
      results: [],
      maxObservedConcurrency: 1
    }));
    const [tool] = createDelegationTools({
      manager: { delegate: vi.fn(), delegateBatch } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true
    });

    await tool!.run({
      tasks: [
        { task: "A" },
        { task: "B", context: "task context", allowedTools: ["web.search"], role: "leaf", modelOverride: { model: "task-model" } }
      ],
      context: "batch context",
      allowedTools: ["file.read"],
      allowedToolsets: ["research"],
      role: "orchestrator",
      modelOverride: { model: "batch-model" }
    });

    expect(delegateBatch).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [
        {
          task: "A",
          context: "batch context",
          allowedTools: ["file.read"],
          allowedToolsets: ["research"],
          role: "orchestrator",
          modelOverride: { model: "batch-model" }
        },
        {
          task: "B",
          context: "task context",
          allowedTools: ["web.search"],
          allowedToolsets: ["research"],
          role: "leaf",
          modelOverride: { model: "task-model" }
        }
      ]
    }));
  });

  it("accepts valid recovered task context", async () => {
    const delegateBatch = vi.fn(async () => ({
      batchId: "batch",
      status: "completed",
      summary: "done",
      results: [],
      maxObservedConcurrency: 1,
      recoveredTasksFromJsonString: true
    }));
    const [tool] = createDelegationTools({
      manager: { delegate: vi.fn(), delegateBatch } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true,
      delegationConfig: {
        ...DEFAULT_DELEGATION_CONFIG,
        recoverJsonStringTasks: true
      }
    });

    await tool!.run({
      tasks: JSON.stringify([{ task: "A", context: "valid context" }])
    });

    expect(delegateBatch).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({
        task: "A",
        context: "valid context"
      })]
    }));
  });

  it("fairly distributes the batch result budget and marks every truncated child", async () => {
    const secondSummary = `worker-two ${"b".repeat(6_000)}`;
    const thirdSummary = `worker-three ${"c".repeat(6_000)}`;
    const delegateBatch = vi.fn(async () => ({
      batchId: "batch-fair",
      status: "completed",
      summary: "Delegation batch batch-fair: completed. Completed: 3/3.",
      results: [
        { index: 0, childStatus: "completed", summary: "short report" },
        { index: 1, childStatus: "completed", summary: secondSummary },
        { index: 2, childStatus: "completed", summary: thirdSummary }
      ]
    }));
    const [tool] = createDelegationTools({
      manager: { delegate: vi.fn(), delegateBatch } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true
    });

    const result = await tool!.run({
      tasks: [{ task: "A" }, { task: "B" }, { task: "C" }]
    });
    const content = result.content;
    const secondAndThird = content.split("\n2. completed\n")[1]!;
    const [renderedSecond, renderedThird] = secondAndThird.split("\n3. completed\n");

    expect(content.length).toBeLessThanOrEqual(tool!.maxResultSizeChars);
    expect(content).toContain("\n1. completed\nshort report");
    expect(content).toContain(`... (${secondSummary.length} chars total, truncated)`);
    expect(content).toContain(`... (${thirdSummary.length} chars total, truncated)`);
    expect(renderedSecond).toContain("worker-two");
    expect(renderedThird).toContain("worker-three");
    expect(Math.abs(renderedSecond.length - renderedThird.length)).toBeLessThanOrEqual(1);
  });

  it("caps unsuccessful child detail while preserving an explicit truncation marker", async () => {
    const failedSummary = `provider failure ${"x".repeat(4_000)}`;
    const delegateBatch = vi.fn(async () => ({
      batchId: "batch-failed",
      status: "failed",
      summary: "Delegation batch batch-failed: failed. Completed: 0/1. Failed: 1.",
      results: [
        { index: 0, childStatus: "failed", summary: failedSummary }
      ]
    }));
    const [tool] = createDelegationTools({
      manager: { delegate: vi.fn(), delegateBatch } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true
    });

    const result = await tool!.run({ tasks: [{ task: "A" }] });
    const renderedDetail = result.content.split("\n1. failed\n")[1]!;

    expect(result.ok).toBe(false);
    expect(renderedDetail.length).toBe(800);
    expect(renderedDetail).toContain(`... (${failedSummary.length} chars total, truncated)`);
  });

  it("retains every child heading when a maximum-size batch exceeds the result budget", async () => {
    const results = Array.from({ length: 10 }, (_, index) => ({
      index,
      childStatus: "completed" as const,
      summary: `worker-${index + 1} ${String(index).repeat(3_000)}`
    }));
    const delegateBatch = vi.fn(async () => ({
      batchId: "batch-maximum",
      status: "completed",
      summary: "Delegation batch batch-maximum: completed. Completed: 10/10.",
      results
    }));
    const [tool] = createDelegationTools({
      manager: { delegate: vi.fn(), delegateBatch } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true
    });

    const result = await tool!.run({
      tasks: results.map((_, index) => ({ task: `Task ${index + 1}` }))
    });

    expect(result.content.length).toBeLessThanOrEqual(tool!.maxResultSizeChars);
    for (const child of results) {
      expect(result.content).toContain(`\n${child.index + 1}. completed\nworker-${child.index + 1}`);
      expect(result.content).toContain(`... (${child.summary.length} chars total, truncated)`);
    }
  });

  it("reflects delegation limits in deterministic schema descriptions", () => {
    const [tool] = createDelegationTools({
      manager: { delegate: vi.fn(), delegateBatch: vi.fn() } as never,
      parentSessionId: "parent",
      profileId: "default",
      trustedWorkspace: () => true,
      delegationConfig: {
        ...DEFAULT_DELEGATION_CONFIG,
        maxConcurrentChildren: 2,
        maxBatchTasks: 4,
        maxSpawnDepth: 3
      }
    });

    const serialized = JSON.stringify(tool);
    expect(tool?.description).toContain("up to 4 batch tasks");
    expect(tool?.description).toContain("at most 2 children");
    expect(tool?.description).toContain("limited to 3");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("API_KEY");
  });
});
