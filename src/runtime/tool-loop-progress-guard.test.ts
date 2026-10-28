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
  it("credits new research sources under a checkpoint but ignores reordered sources, clocks, cache reuse and empty searches", async () => {
    const checkpoint=new ExecutionCheckpointController({sessionId:"s",profileId:"p"});
    await checkpoint.ensure({originTurnId:"t",originalObjective:"Research and save report",qualificationReasons:["external_multi_step"],intentLabels:["research"],requiredOperations:["mutation","verification"],connectorIds:[],completionFloor:"mutation_with_verification"});
    const guard=new ToolLoopProgressGuard({research:true,checkpointReader:checkpoint,noProgressNudgeIteration:3,maxNoProgressIterations:6});
    const search=(urls:string[],query="battery")=>execution({tool:{...execution().tool,name:"web.search"},input:{query},executionEffect:{kind:"read"},result:{ok:true,content:"results",metadata:{results:urls.map(url=>({url}))}}});
    const a="https://example.org/a", b="https://example.org/b";
    const failed=execution({tool:{...execution().tool,name:"delegate_task"},result:{ok:false,content:"Invalid scope"}});
    for(let i=0;i<5;i++) expect(guard.observe([failed]).shouldStop).toBe(false);
    expect(guard.observe([search([a,b])])).toMatchObject({materialProgress:true,noProgressIterations:0,shouldStop:false});
    expect(guard.observe([search([b,a],"rephrased")]).materialProgress).toBe(false);
    expect(guard.observe([search([])]).materialProgress).toBe(false);
    expect(guard.observe([{...search(["https://example.org/c"]),readReuseOf:"old"}]).materialProgress).toBe(false);
    expect(guard.observe([search(["https://example.org/c"])])).toMatchObject({materialProgress:true,noProgressIterations:0});
    for(let i=0;i<6;i++) expect(guard.observe([failed]).shouldStop).toBe(i===5);
    expect(checkpoint.current()?.progressRevision).toBe(0);
  });

  it("does not let unrelated new URLs reset a pending completion repair", () => {
    const guard = new ToolLoopProgressGuard({ research: true, noProgressNudgeIteration: 2, maxNoProgressIterations: 3 });
    for (let i = 0; i < 3; i++) {
      const search = execution({ tool: { ...execution().tool, name: "web.search" }, result: { ok: true, content: "New URL", metadata: { results: [{ url: `https://example.org/unrelated-${i}` }] } } });
      expect(guard.observe([search], true)).toMatchObject({ materialProgress: false, shouldStop: i === 2 });
    }
  });

  it("credits new extracted evidence during completion repair but still stops repeated reads", () => {
    const guard = new ToolLoopProgressGuard({ research: true, noProgressNudgeIteration: 2, maxNoProgressIterations: 3 });
    const read = execution({ tool: { ...execution().tool, name: "web.extract" }, result: { ok: true, content: "Observed primary passage", metadata: { url: "https://example.org/source", content: "Observed primary passage" } } });
    expect(guard.observe([read], true).materialProgress).toBe(true);
    for (let i = 0; i < 3; i++) expect(guard.observe([read], true)).toMatchObject({ materialProgress: false, shouldStop: i === 2 });
  });

  it("does not credit reused web observations even when feedback labels change", async () => {
    const guard = new ToolLoopProgressGuard({ noProgressNudgeIteration: 3, maxNoProgressIterations: 6 });
    const read = execution({ tool: { ...execution().tool, name: "web.extract" }, executionEffect: { kind: "read" } });
    expect(guard.observe([read]).materialProgress).toBe(true);
    expect(guard.observe([{ ...read, readReuseOf: "call-1", result: { ok: true, content: "Prior observation with new receipt label" } }]).materialProgress).toBe(false);
  });
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


it("does not count duplicate capability requests as material progress", () => {
  const guard = new ToolLoopProgressGuard({ noProgressNudgeIteration: 2, maxNoProgressIterations: 3 });
  const request = execution({ tool: { ...execution().tool, name: "capability.request" }, result: { ok: true, content: "already exposed", metadata: { requests: [{ status: "already_exposed" }] } } });
  expect(guard.observe([request]).materialProgress).toBe(false);
  expect(guard.observe([{ ...request, input: { reason: "different text" } }]).materialProgress).toBe(false);
});


it.each(["research", "report", "code", "multi", "alternative"])("counts file versions and matching readbacks once while checkpoint progress lags (%s)", async mode => {
  const research = mode === "research";
  const checkpoint = new ExecutionCheckpointController({ sessionId: "session-1", profileId: "profile-1" });
  await checkpoint.ensure({ originTurnId: "turn-1", originalObjective: "Research and save report.md",
    qualificationReasons: ["research_request"], intentLabels: [], requiredOperations: ["mutation", "verification"],
    connectorIds: [], completionFloor: "mutation_with_verification",
    requestRequirements: mode === "code" ? undefined : { skillReferences: [], issues: [], research: { domain: "general", fresh: true }, fileOutput: { path: "report.md", format: "markdown", ...(mode === "alternative" ? { alternativePaths: ["alternative.md"] } : {}), ...(mode === "multi" ? { additionalFiles: [{ path: "second.md", format: "markdown" as const }] } : {}) } } });
  const guard = new ToolLoopProgressGuard({ research, checkpointReader: checkpoint, noProgressNudgeIteration: 2, maxNoProgressIterations: 6 });
  const file = (name: string, digest: string, path = mode === "multi" ? "second.md" : mode === "alternative" ? "alternative.md" : "report.md") => execution({
    tool: { ...execution().tool, name, toolsets: ["files"] }, input: { path },
    executionEffect: { kind: name === "file.read" ? "read" : "mutation" },
    result: { ok: true, content: "report", metadata: { path, contentSha256: digest.repeat(64), materialized: true, completeFileRead: true, changed: true } }
  });
  if (mode !== "code") expect(guard.observe([file("file.write", "a", "unrelated.md")]).materialProgress).toBe(false);
  expect(guard.observe([file("file.write", "a")]).progressKinds).toContain("target-mutation");
  expect(guard.observe([file("file.write", "a")]).materialProgress).toBe(false);
  expect(guard.observe([file("file.read", "b")]).materialProgress).toBe(false);
  expect(guard.observe([file("file.read", "a")]).progressKinds).toContain("verification");
  expect(guard.observe([file("file.read", "a")]).materialProgress).toBe(false);
  expect(guard.observe([{ ...file("file.write", "c"), result: { ok: true, content: "Unchanged", metadata: { path: "report.md", contentSha256: "c".repeat(64), changed: false } } }]).materialProgress).toBe(false);
  expect(guard.observe([file("file.write", "b")]).progressKinds).toContain("target-mutation");
  expect(guard.observe([file("file.read", "b")]).progressKinds).toContain("verification");
  expect(guard.observe([{ ...file("file.write", "c"), decision: "deny" }]).materialProgress).toBe(false);
});


it("credits unique queued recovery receipts, never failures, denial, reuse or changed prose", async () => {
  const guard = await discoveryGuard();
  const request = (id: string, status = "queued") => execution({
    tool: { ...execution().tool, name: "capability.request" },
    result: { ok: true, content: "Request recorded", metadata: { requests: [{ id, status }] } }
  });
  expect(guard.observe([request("tool:file.read")]).materialProgress).toBe(true);
  expect(guard.observe([{ ...request("tool:file.read"), input: { reason: "new wording" } }]).materialProgress).toBe(false);
  expect(guard.observe([request("tool:file.write", "already_exposed")]).materialProgress).toBe(false);
  expect(guard.observe([{ ...request("tool:file.write"), decision: "deny" }]).materialProgress).toBe(false);
  expect(guard.observe([{ ...request("tool:file.write"), readReuseOf: "old" }]).materialProgress).toBe(false);
  expect(guard.observe([request("tool:file.write")]).materialProgress).toBe(true);
  const seeded = await discoveryGuard([request("tool:file.read")]);
  expect(seeded.observe([request("tool:file.read")]).materialProgress).toBe(false);
});

it("credits accepted result page coverage once and only for the bound source task", async () => {
  const checkpoint = new ExecutionCheckpointController({ sessionId: "s", profileId: "p" });
  await checkpoint.ensure({ originTurnId: "t", originalObjective: "Save the existing report",
    qualificationReasons: ["research_request"], intentLabels: [], requiredOperations: ["mutation", "verification"],
    connectorIds: [], completionFloor: "mutation_with_verification",
    requestRequirements: { skillReferences: [], issues: [], sourceTaskId: "task_source", fileOutput: { path: "report.md", format: "markdown" } } });
  const page = (offset: number, end: number, overrides = {}) => execution({
    tool: { ...execution().tool, name: "task.result.read" }, executionEffect: { kind: "read" },
    result: { ok: true, content: "Accepted report text", metadata: {
      taskId: "task_source", resultId: "result", contentHash: `sha256:${"a".repeat(64)}`,
      disposition: "accepted", offset, nextOffset: end, totalChars: 1000, ...overrides
    } }
  });
  const options = { checkpointReader: checkpoint, noProgressNudgeIteration: 2, maxNoProgressIterations: 6 };
  const guard = new ToolLoopProgressGuard(options);
  expect(guard.observe([page(0, 100)]).materialProgress).toBe(true);
  expect(guard.observe([page(0, 50)]).materialProgress).toBe(false);
  expect(guard.observe([page(50, 100)]).materialProgress).toBe(false);
  expect(guard.observe([page(100, 200, { disposition: "draft" })]).materialProgress).toBe(false);
  expect(guard.observe([page(100, 200, { taskId: "other" })]).materialProgress).toBe(false);
  expect(guard.observe([page(100, 200, { contentHash: "invalid" })]).materialProgress).toBe(false);
  expect(guard.observe([page(100, 200)]).materialProgress).toBe(true);
  const seeded = new ToolLoopProgressGuard({ ...options, existingExecutions: [page(0, 200)] });
  expect(seeded.observe([page(100, 200)]).materialProgress).toBe(false);
  expect(seeded.observe([page(200, 1000, { nextOffset: undefined })]).materialProgress).toBe(true);
});


describe("terminal progress while a completion checkpoint is active", () => {
  function terminal(index: number, name = "terminal.run"): ToolExecutionRecord {
    return execution({
      tool: { ...execution().tool, name, riskClass: "workspace-write" },
      input: name === "execute_code" ? { code: `print(${index})` } : name === "terminal.inspect" ? { argv: ["cat", `diagnostic-${index}.txt`] }
        : { command: `cat diagnostic-${index}.txt`, timeoutMs: 1000 },
      riskClass: "workspace-write", executionEffect: { kind: "read" },
      result: { ok: true, content: `Observed diagnostic ${index}`, metadata: {
        ...(name === "execute_code" ? { exitCode: 0 } : { code: 0 }), signal: null, timedOut: false, cancelled: false
      } }
    });
  }

  it.each(["terminal.run", "terminal.inspect", "execute_code"])("credits distinct successful %s observations beyond the stop limit", async name => {
    const guard = await discoveryGuard();
    for (let index = 0; index < 8; index++) {
      expect(guard.observe([terminal(index, name)])).toMatchObject({
        materialProgress: true, noProgressIterations: 0, shouldStop: false,
        progressKinds: ["new-tool-result"]
      });
    }
    for (let index = 1; index <= 6; index++) {
      expect(guard.observe([terminal(7, name)])).toMatchObject({ materialProgress: false, shouldStop: index === 6 });
    }
  });

  it("ignores deadline, receipt and timestamp-only churn, including seeded calls", async () => {
    const prior = terminal(0);
    prior.result!.content = "Observed at 2030-01-01T00:00:00Z";
    const guard = await discoveryGuard([prior]);
    for (let index = 1; index <= 6; index++) {
      const repeated = terminal(0);
      repeated.input = { command: "cat diagnostic-0.txt", timeoutMs: 1000 + index };
      repeated.toolCallId = `new-receipt-${index}`;
      repeated.targetKey = `new-target-${index}`;
      repeated.result = { ...repeated.result!, content: `Observed at 2030-01-01T00:00:0${index}Z` };
      expect(guard.observe([repeated])).toMatchObject({ materialProgress: false, shouldStop: index === 6 });
    }
  });

  it("does not credit different commands with identical results", async () => {
    const guard = await discoveryGuard();
    expect(guard.observe([terminal(0)]).materialProgress).toBe(true);
    for (let index = 1; index <= 6; index++) {
      const repeated = terminal(index);
      repeated.result = terminal(0).result;
      expect(guard.observe([repeated])).toMatchObject({ materialProgress: false, shouldStop: index === 6 });
    }
  });

  it.each(["terminal.run", "execute_code"].flatMap(name => ["failed", "denied", "reused", "cached", "timeout", "cancelled", "signal", "nonzero", "missing-receipt", "completion-repair"].map(scenario => [name, scenario])))(
    "keeps %s %s activity bounded", async (name, scenario) => {
      const guard = await discoveryGuard();
      for (let index = 1; index <= 6; index++) {
        const record = terminal(index, name);
        if (scenario === "failed") record.result!.ok = false;
        if (scenario === "denied") record.decision = "deny";
        if (scenario === "reused") record.readReuseOf = "prior-call";
        if (scenario === "cached") record.result!.metadata!.mcpReadReuse = true;
        if (scenario === "timeout") record.result!.metadata!.timedOut = true;
        if (scenario === "cancelled") record.result!.metadata!.cancelled = true;
        if (scenario === "signal") record.result!.metadata!.signal = "SIGTERM";
        if (scenario === "nonzero") record.result!.metadata![name === "execute_code" ? "exitCode" : "code"] = 1;
        if (scenario === "missing-receipt") delete record.result!.metadata;
        expect(guard.observe([record], scenario === "completion-repair"))
          .toMatchObject({ materialProgress: false, shouldStop: index === 6 });
      }
    }
  );
});


describe("bounded process waits", () => {
  const poll = (i: number, overrides: Partial<ToolExecutionRecord> = {}) => execution({
    tool: { ...execution().tool, name: "process.logs" }, input: { id: "proc-1" }, toolCallId: `poll-${i}`,
    result: { ok: true, content: `fresh output ${i}`, metadata: { waitedMs: 30000, process: { id: "proc-1", status: "running" } } }, ...overrides
  });
  it("preserves the stuck counter during real waits but still stops immediate polling", async () => {
    const guard = await discoveryGuard();
    const immediate = (i: number) => poll(i, { result: { ok: true, content: `new log ${i}`, metadata: { waitedMs: 0, process: { id: "proc-1", status: "running" } } } });
    expect(guard.observe([immediate(0)]).noProgressIterations).toBe(1);
    for (let i = 1; i <= 8; i++) expect(guard.observe([poll(i)])).toMatchObject({ materialProgress: false, noProgressIterations: 1, shouldStop: false });
    for (let i = 1; i <= 5; i++) expect(guard.observe([immediate(10+i)])).toMatchObject({ noProgressIterations: i+1, shouldStop: i === 5 });
  });
  it("does not let reused waits or completion-repair polling suspend supervision", async () => {
    for (const mode of ["reuse", "same-call", "repair", "wrong-id"]) {
      const guard = await discoveryGuard();
      if (mode === "same-call") guard.observe([poll(0)]);
      for (let i = 0; i < 6; i++) {
        const record = mode === "reuse" ? poll(i, { readReuseOf: "old" }) : mode === "same-call" ? poll(0) : mode === "wrong-id" ? poll(i, { input: { id: "other" } }) : poll(i);
        expect(guard.observe([record], mode === "repair").shouldStop).toBe(i === 5);
      }
    }
  });
  it("credits an exit once, including failure, without accepting repeated exit snapshots", async () => {
    const guard = await discoveryGuard();
    const exited = poll(0, { result: { ok: true, content: "exited", metadata: { process: { id: "proc-1", status: "exited", exitCode: 7 } } } });
    expect(guard.observe([exited]).materialProgress).toBe(true);
    for (let i = 0; i < 6; i++) expect(guard.observe([{ ...exited, toolCallId: `exit-${i}` }]).shouldStop).toBe(i === 5);
    const seeded = await discoveryGuard([exited]);
    expect(seeded.observe([exited]).materialProgress).toBe(false);
  });
});


describe("diagnostic progress and per-stall warnings", () => {
  const guard = () => new ToolLoopProgressGuard({ noProgressNudgeIteration: 2, maxNoProgressIterations: 4 });
  const command = (content: string, code = 1, input = "check") => execution({
    tool: { ...execution().tool, name: "terminal.run" }, input: { command: input },
    executionEffect: { kind: "read" }, result: { ok: code === 0, content,
      metadata: { code, signal: null, timedOut: false, cancelled: false } }
  });
  it("keeps distinct failing diagnostics and changing results from the same command alive", async () => {
    for (const code of [0, 1]) {
      const g = guard();
      for (let i = 0; i < 8; i++) expect(g.observe([command(`module ${i}: diagnostic`, code)]))
        .toMatchObject({ materialProgress: true, shouldStop: false, noProgressIterations: 0 });
    }
  });
  it("still stops identical diagnostics even with changing command arguments", () => {
    const g = guard();
    expect(g.observe([command("same failure")]).materialProgress).toBe(true);
    for (let i = 1; i <= 4; i++) expect(g.observe([command("same failure", 1, `check ${i}`)]).shouldStop).toBe(i === 4);
  });
  it("warns again after recovery and bounds the second stall", () => {
    const g = guard();
    g.observe([command("first")]);
    g.observe([command("first")]);
    expect(g.observe([command("first")]).shouldNudge).toBe(true);
    expect(g.observe([command("new evidence")]).materialProgress).toBe(true);
    g.observe([command("new evidence")]);
    expect(g.observe([command("new evidence")]).shouldNudge).toBe(true);
    g.observe([command("new evidence")]);
    expect(g.observe([command("new evidence")]).shouldStop).toBe(true);
  });
  it("does not credit denied, cancelled, timed-out or running commands", () => {
    for (const patch of [{ decision: "deny" as const }, ...["cancelled", "timedOut", "running"].map(key => ({
      result: { ...command("x").result!, metadata: { code: 1, signal: null, [key]: true } }
    }))]) {
      const g = guard();
      for (let i = 0; i < 4; i++) expect(g.observe([{ ...command(`new ${i}`), ...patch }]).materialProgress).toBe(false);
    }
  });
  it("seeds failed observations so an existing failure is not novel again", () => {
    const g = new ToolLoopProgressGuard({ existingExecutions: [command("old")], noProgressNudgeIteration: 2, maxNoProgressIterations: 4 });
    expect(g.observe([command("old")]).materialProgress).toBe(false);
  });
});
