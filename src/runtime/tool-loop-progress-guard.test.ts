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

async function discoveryGuard(existingExecutions: ToolExecutionRecord[] = []): Promise<ToolLoopProgressGuard> {
  const checkpoint = new ExecutionCheckpointController({ sessionId: "session-1", profileId: "profile-1" });
  await checkpoint.ensure({
    originTurnId: "turn-1", originalObjective: "Import selected API products",
    qualificationReasons: ["external_multi_step"], intentLabels: ["api.integration"],
    requiredOperations: ["mutation", "verification"], connectorIds: ["postman"], completionFloor: "mutation_with_verification"
  });
  return new ToolLoopProgressGuard({ checkpointReader: checkpoint, existingExecutions,
    noProgressNudgeIteration: 3, maxNoProgressIterations: 6 });
}

function browserDiscovery(text: string, observationId = 1): ToolExecutionRecord {
  return execution({
    tool: { ...execution().tool, name: "browser.snapshot", toolsets: ["browser"] }, input: {},
    executionEffect: { kind: "read" },
    result: { ok: true, content: text, metadata: { snapshot: {
      sessionId: "session-1:main", url: "https://example.com/apps", text,
      identity: { documentEpoch: 3, actionRevision: 8, observationId },
      observedAt: `2030-01-01T00:00:0${observationId}.000Z`,
      tab: { ref: "@t1", url: "https://example.com/apps", controlled: true },
      regions: [{ ref: `@r${observationId}`, text, links: [], actionRefs: [], hitTestable: true }]
    } } }
  });
}

describe("ToolLoopProgressGuard", () => {
  it("credits the discovery sequence before counting repeated failed extractions and cached reads", async () => {
    const guard = await discoveryGuard();
    const snapshot = browserDiscovery("Application products");
    const expanded = browserDiscovery("Product A Product B Product C Product D Product E Product F", 2);
    const environment = execution({ input: { environmentId: "env-1" },
      result: { ok: true, content: JSON.stringify({ environment: { id: "env-1", values: [] } }) } });
    const failure = execution({ tool: { ...snapshot.tool, name: "browser.extract" },
      input: { ref: "@r19", tabRef: "@t1", identity: { documentEpoch: 3, actionRevision: 8, observationId: 23 } },
      executionEffect: { kind: "read" },
      result: { ok: false, content: "Browser element ref not found: @r19", metadata: { actionDispatched: false } } });
    const batches = [
      [snapshot],
      [{ ...expanded, tool: { ...expanded.tool, name: "browser.click" }, input: { ref: "@e1" }, executionEffect: { kind: "mutation" as const } }],
      [expanded, execution({ input: { workspaceId: "workspace-1" }, result: { ok: true, content: "| ID | Name |\n| --- | --- |\n| col-1 | Product A |" } })],
      [execution({ input: { workspaceId: "workspace-1", type: "environments" }, result: { ok: true, content: '{"environments":[{"id":"env-1"}]}' } })],
      [failure, environment]
    ];
    for (const batch of batches) {
      expect(guard.observe(batch)).toMatchObject({ materialProgress: true, noProgressIterations: 0, shouldStop: false });
    }
    for (let iteration = 1; iteration <= 6; iteration++) {
      expect(guard.observe([
        failure,
        { ...environment, result: { ...environment.result!, metadata: { mcpReadReuse: true } } },
        execution({ tool: { ...execution().tool, name: "plan" }, input: { revision: iteration } })
      ])).toMatchObject({ materialProgress: false, noProgressIterations: iteration,
        shouldNudge: iteration === 3, shouldStop: iteration === 6 });
    }
  });

  it("ignores browser identity/ref/clock churn but credits a new same-input observation", async () => {
    const guard = await discoveryGuard();
    expect(guard.observe([browserDiscovery("Products")]).materialProgress).toBe(true);
    expect(guard.observe([browserDiscovery("Products", 2)]).materialProgress).toBe(false);
    expect(guard.observe([browserDiscovery("Products expanded with six links", 3)]).materialProgress).toBe(true);
    expect(guard.observe([browserDiscovery("Products", 4)]).materialProgress).toBe(false);
  });

  it("treats fresh pending connector reads as discovery, never as completed verification", async () => {
    const guard = await discoveryGuard();
    const mutation = execution({ tool: { ...execution().tool, name: "mcp.postman.createCollection" },
      executionEffect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } },
      result: { ok: true, content: "accepted" } });
    const pending = execution({ input: { taskId: "task-1" },
      executionEffect: { kind: "verification", connector: { kind: "mcp", id: "postman" }, verifies: [mutation.tool.name] },
      result: { ok: true, content: '{"status":"pending"}', metadata: { _estacoda_verification_evidence: false } } });
    expect(guard.observe([mutation]).progressKinds).toEqual(["target-mutation"]);
    expect(guard.observe([pending]).progressKinds).toEqual(["new-tool-result"]);
    expect(guard.observe([pending]).materialProgress).toBe(false);
    expect(guard.observe([{ ...pending, input: { taskId: "cache" }, result: {
      ok: true, content: "cached", metadata: { mcpReadReuse: true }
    } }]).materialProgress).toBe(false);
    expect(guard.observe([{ ...pending, input: { collectionId: "col-1" }, result: {
      ok: true, content: '{"id":"col-1"}', metadata: { _estacoda_verification_evidence: true }
    } }]).progressKinds).toEqual(["verification"]);
  });

  it("deduplicates extracted region content across transient target references", async () => {
    const guard = await discoveryGuard();
    const extract = (ref: string, text: string) => execution({
      tool: { ...execution().tool, name: "browser.extract", toolsets: ["browser"] },
      input: { regionRef: ref }, executionEffect: { kind: "read" },
      result: { ok: true, content: text, metadata: {
        sessionId: "session-1:main", tabRef: "@t1", text,
        target: { ref, kind: "region", identity: { documentEpoch: 3, actionRevision: 8, observationId: ref }, text },
        links: [{ text: "API", href: "https://example.com/api" }]
      } }
    });
    expect(guard.observe([extract("@r19", "Product APIs")]).materialProgress).toBe(true);
    expect(guard.observe([extract("@r20", "Product APIs")]).materialProgress).toBe(false);
    expect(guard.observe([extract("@r21", "More product APIs")]).materialProgress).toBe(true);
  });

  it("seeds discovery, rejects cached/failed reads and deduplicates equivalent result data", async () => {
    const prior = execution({ result: { ok: true, content: '{"id":"env-1","observedAt":"2030-01-01T00:00:00Z"}' } });
    const guard = await discoveryGuard([prior, browserDiscovery("Products")]);
    expect(guard.observe([browserDiscovery("Products", 2)]).materialProgress).toBe(false);
    expect(guard.observe([execution({ input: { scope: "changed" }, result: {
      ok: true, content: '{"observedAt":"2030-01-01T00:01:00Z", "id":"env-1"}'
    } })]).materialProgress).toBe(false);
    expect(guard.observe([execution({ input: { id: "cache" }, result: {
      ok: true, content: '{"id":"env-cache"}', metadata: { mcpReadReuse: true }
    } })]).materialProgress).toBe(false);
    expect(guard.observe([execution({ result: { ok: false, content: '{"id":"failed"}' } })]).materialProgress).toBe(false);
    expect(guard.observe([execution({ decision: "deny", result: { ok: true, content: '{"id":"denied"}' } })]).materialProgress).toBe(false);
    expect(guard.observe([execution({ input: { id: "new" }, result: { ok: true, content: '{"id":"env-new"}' } })]))
      .toMatchObject({ materialProgress: true, progressKinds: ["new-tool-result"], noProgressIterations: 0 });
  });

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
      result: { ok: true, content: "snapshot revision one" },
      executionEffect: { kind: "read" }
    })])).toMatchObject({ materialProgress: false, noProgressIterations: 1 });
    expect(guard.observe([execution({
      tool: { ...execution().tool, name: "browser.snapshot", toolsets: ["browser"] },
      input: {},
      result: { ok: true, content: "snapshot revision two" },
      executionEffect: { kind: "read" }
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
    })])).toMatchObject({ materialProgress: true, progressKinds: ["new-tool-result"], noProgressIterations: 0 });

    expect(guard.observe([execution({
      tool: { ...execution().tool, name: "mcp.postman.getSpec" },
      input: { specId: "different-spec" },
      toolCallId: "call-extra-verifier",
      executionEffect: {
        kind: "verification",
        verifies: ["mcp.postman.createSpec"],
        connector: { kind: "mcp", id: "postman" }
      },
      result: { ok: true, content: "specification exists" }
    })])).toMatchObject({ materialProgress: false, noProgressIterations: 1, shouldNudge: false });

    expect(guard.observe([execution({
      tool: { ...execution().tool, name: "browser.click", toolsets: ["browser"], riskClass: "external-side-effect" },
      input: { ref: "download" },
      toolCallId: "call-browser-mutation",
      riskClass: "external-side-effect",
      executionEffect: { kind: "mutation" },
      result: { ok: true, content: "clicked" }
    })])).toMatchObject({
      materialProgress: false,
      noProgressIterations: 2,
      shouldStop: false
    });
    expect(guard.observe([])).toMatchObject({
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
      result: { ok: true, content: "same browser state" },
      executionEffect: { kind: "read" }
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
