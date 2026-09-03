import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { ForegroundExecutionCheckpoint } from "../contracts/execution-checkpoint.js";
import { ExecutionCheckpointController } from "./execution-checkpoint-controller.js";
import { ToolLoopProgressGuard } from "./tool-loop-progress-guard.js";

function execution(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    tool: {
      name: "mcp.postman.getCollection",
      description: "Read collection",
      inputSchema: {},
      riskClass: "read-only-network",
      toolsets: ["mcp"],
      progressLabel: "reading",
      maxResultSizeChars: 1_000
    },
    input: { collectionId: "collection-1" },
    decision: "allow",
    riskClass: "read-only-network",
    toolCallId: "call-1",
    executionEffect: { kind: "read", connector: { kind: "mcp", id: "postman" } },
    result: { ok: true, content: "collection state" },
    ...overrides
  };
}

describe("ToolLoopProgressGuard", () => {
  it("is inactive before substantive tool activity and does not depend on a plan", () => {
    const guard = new ToolLoopProgressGuard({
      noProgressNudgeIteration: 2,
      maxNoProgressIterations: 4
    });

    expect(guard.observe([])).toEqual({
      active: false,
      materialProgress: false,
      progressKinds: [],
      noProgressIterations: 0,
      shouldNudge: false,
      shouldStop: false
    });
  });

  it("counts new call/result pairs as progress and repeated calls as no progress", () => {
    const guard = new ToolLoopProgressGuard({
      noProgressNudgeIteration: 2,
      maxNoProgressIterations: 3
    });

    expect(guard.observe([execution()])).toMatchObject({
      active: true,
      materialProgress: true,
      progressKinds: ["new-tool-result"],
      noProgressIterations: 0
    });
    expect(guard.observe([execution({
      toolCallId: "call-2",
      result: { ok: true, content: "changing representation" }
    })])).toMatchObject({
      materialProgress: false,
      progressKinds: ["repeated-tool-call"],
      noProgressIterations: 1
    });
    expect(guard.observe([execution({ toolCallId: "call-3" })])).toMatchObject({
      noProgressIterations: 2,
      shouldNudge: true,
      shouldStop: false
    });
    expect(guard.observe([execution({ toolCallId: "call-4" })])).toMatchObject({
      noProgressIterations: 3,
      shouldNudge: false,
      shouldStop: true
    });
  });

  it("recognizes runtime mutation and verification effects without plan semantics", () => {
    const guard = new ToolLoopProgressGuard({
      noProgressNudgeIteration: 2,
      maxNoProgressIterations: 4
    });

    expect(guard.observe([execution({
      tool: { ...execution().tool, name: "mcp.postman.updateCollection", riskClass: "external-side-effect" },
      input: { collectionId: "collection-1", name: "Updated" },
      riskClass: "external-side-effect",
      executionEffect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } },
      result: { ok: true, content: "updated" }
    })])).toMatchObject({ materialProgress: true, progressKinds: ["target-mutation"] });

    expect(guard.observe([execution({
      tool: { ...execution().tool, name: "mcp.postman.verifyCollection" },
      input: { collectionId: "collection-1", expectedName: "Updated" },
      executionEffect: {
        kind: "verification",
        verifies: ["mcp.postman.updateCollection"],
        connector: { kind: "mcp", id: "postman" }
      },
      result: { ok: true, content: "verified" }
    })])).toMatchObject({ materialProgress: true, progressKinds: ["verification"] });
  });

  it("seeds prior foreground-turn executions to reject rediscovery", () => {
    const prior = execution();
    const guard = new ToolLoopProgressGuard({
      existingExecutions: [prior],
      noProgressNudgeIteration: 1,
      maxNoProgressIterations: 2
    });

    expect(guard.observe([execution({ toolCallId: "call-repeated" })])).toMatchObject({
      active: true,
      materialProgress: false,
      progressKinds: ["repeated-tool-call"],
      shouldNudge: true
    });
  });

  it("ignores plan and delegation housekeeping calls", () => {
    const guard = new ToolLoopProgressGuard({
      noProgressNudgeIteration: 1,
      maxNoProgressIterations: 2
    });
    const planCall = execution({ tool: { ...execution().tool, name: "plan" } });

    expect(guard.observe([planCall])).toMatchObject({ active: false, noProgressIterations: 0 });
  });

  it("uses checkpoint semantic progress instead of treating changing snapshots as progress", () => {
    let progressRevision = 0;
    const reader = {
      current: (): ForegroundExecutionCheckpoint => ({
        version: 1,
        id: "checkpoint:1",
        sessionId: "session-1",
        profileId: "profile-1",
        originTurnId: "turn-1",
        revision: progressRevision + 1,
        progressRevision,
        originalObjective: "Complete an external workflow",
        status: "active",
        qualificationReasons: ["external_multi_step"],
        intentLabels: ["browser-control"],
        requiredOperations: ["read", "mutation"],
        connectorIds: ["postman"],
        artifactReferences: [],
        safeFacts: [],
        operations: [],
        completionFloor: "mutation_with_verification",
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z"
      })
    };
    const guard = new ToolLoopProgressGuard({
      checkpointReader: reader,
      noProgressNudgeIteration: 2,
      maxNoProgressIterations: 3
    });

    expect(guard.observe([execution({
      tool: { ...execution().tool, name: "browser.snapshot", toolsets: ["browser"] },
      input: {},
      result: { ok: true, content: "snapshot revision one" }
    })])).toMatchObject({ materialProgress: false, noProgressIterations: 1 });
    expect(guard.observe([execution({
      tool: { ...execution().tool, name: "browser.snapshot", toolsets: ["browser"] },
      input: {},
      result: { ok: true, content: "snapshot revision two" }
    })])).toMatchObject({ materialProgress: false, noProgressIterations: 2, shouldNudge: true });

    progressRevision = 1;
    expect(guard.observe([])).toMatchObject({
      materialProgress: true,
      progressKinds: ["checkpoint-semantic-progress"],
      noProgressIterations: 0
    });
  });

  it("counts new connector mutations and their declared verifiers when checkpoint progress lags", () => {
    const reader = {
      current: (): ForegroundExecutionCheckpoint => ({
        version: 1,
        id: "checkpoint:connector-progress",
        sessionId: "session-1",
        profileId: "profile-1",
        originTurnId: "turn-1",
        revision: 1,
        progressRevision: 0,
        originalObjective: "Import an API specification",
        status: "active",
        qualificationReasons: ["external_multi_step"],
        intentLabels: ["api.integration"],
        requiredOperations: ["mutation", "verification"],
        connectorIds: ["postman"],
        artifactReferences: [],
        safeFacts: [],
        operations: [],
        completionFloor: "mutation_with_verification",
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z"
      })
    };
    const guard = new ToolLoopProgressGuard({
      checkpointReader: reader,
      noProgressNudgeIteration: 2,
      maxNoProgressIterations: 3
    });

    expect(guard.observe([execution({
      tool: { ...execution().tool, name: "mcp.postman.createSpec", riskClass: "external-side-effect" },
      input: { workspaceId: "workspace-1", artifact: "artifact-1" },
      riskClass: "external-side-effect",
      executionEffect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } },
      result: { ok: true, content: "created" }
    })])).toMatchObject({
      materialProgress: true,
      progressKinds: ["target-mutation"],
      noProgressIterations: 0
    });

    expect(guard.observe([execution({
      tool: { ...execution().tool, name: "mcp.postman.getSpec" },
      input: { specId: "spec-1" },
      toolCallId: "call-verify",
      executionEffect: {
        kind: "verification",
        verifies: ["mcp.postman.createSpec"],
        connector: { kind: "mcp", id: "postman" }
      },
      result: { ok: true, content: "specification exists" }
    })])).toMatchObject({
      materialProgress: true,
      progressKinds: ["verification"],
      noProgressIterations: 0
    });

    expect(guard.observe([execution({
      tool: { ...execution().tool, name: "mcp.other.getSpec" },
      input: { specId: "spec-1" },
      toolCallId: "call-wrong-connector",
      executionEffect: {
        kind: "verification",
        verifies: ["mcp.postman.createSpec"],
        connector: { kind: "mcp", id: "other" }
      },
      result: { ok: true, content: "unrelated result" }
    })])).toMatchObject({ materialProgress: false, noProgressIterations: 1 });

    expect(guard.observe([execution({
      tool: { ...execution().tool, name: "mcp.postman.getSpec" },
      input: { specId: "different-spec" },
      toolCallId: "call-extra-verifier",
      executionEffect: {
        kind: "verification",
        verifies: ["mcp.postman.createSpec"],
        connector: { kind: "mcp", id: "postman" }
      },
      result: { ok: true, content: "another specification exists" }
    })])).toMatchObject({ materialProgress: false, noProgressIterations: 2, shouldNudge: true });

    expect(guard.observe([execution({
      tool: { ...execution().tool, name: "browser.click", toolsets: ["browser"], riskClass: "external-side-effect" },
      input: { ref: "download" },
      toolCallId: "call-browser-mutation",
      riskClass: "external-side-effect",
      executionEffect: { kind: "mutation" },
      result: { ok: true, content: "clicked" }
    })])).toMatchObject({
      materialProgress: false,
      noProgressIterations: 3,
      shouldStop: true
    });
  });

  it("resets no-progress accounting when the checkpoint records a durable artifact", async () => {
    const checkpoint = new ExecutionCheckpointController({
      sessionId: "session-1",
      profileId: "profile-1",
      now: () => "2030-01-01T00:00:00.000Z",
      createId: () => "checkpoint:artifact"
    });
    await checkpoint.ensure({
      originTurnId: "turn-1",
      originalObjective: "Import an API specification",
      qualificationReasons: ["external_multi_step"],
      intentLabels: ["api.integration"],
      requiredOperations: ["artifact_relay", "mutation"],
      connectorIds: ["postman"],
      completionFloor: "mutation"
    });
    const guard = new ToolLoopProgressGuard({
      checkpointReader: checkpoint,
      noProgressNudgeIteration: 1,
      maxNoProgressIterations: 3
    });

    expect(guard.observe([execution({
      tool: { ...execution().tool, name: "browser.snapshot", toolsets: ["browser"] },
      input: {},
      result: { ok: true, content: "same browser state" }
    })])).toMatchObject({ materialProgress: false, noProgressIterations: 1, shouldNudge: true });

    const current = checkpoint.current()!;
    await checkpoint.attachArtifact(current.revision, {
      id: "artifact:swagger",
      sha256: "a".repeat(64)
    });

    expect(guard.observe([])).toMatchObject({
      materialProgress: true,
      progressKinds: ["checkpoint-semantic-progress"],
      noProgressIterations: 0
    });
  });
});
