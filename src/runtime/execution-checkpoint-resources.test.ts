import { describe, expect, it } from "vitest";
import type { ExecutionCheckpointLifecycleEvent } from "../contracts/execution-checkpoint.js";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import { ExecutionCheckpointController } from "./execution-checkpoint-controller.js";
import { checkpointResourcesFromResult } from "./execution-checkpoint-resources.js";
import { ExecutionWorkingSetController } from "./execution-working-set.js";
import { executionCheckpointCarryForwardEvent, hydratableExecutionCheckpoint, validateExecutionCheckpoint } from "../session/execution-checkpoint-state.js";
import { browserContinuityUrl } from "../browser/continuity-url.js";

const now = "2030-01-01T00:00:00.000Z";
const sha256 = "a".repeat(64);
const links = Array.from({ length: 6 }, (_, i) => ({ text: `Service ${i + 1}`, href: `https://portal.example.com/catalog/actual-${19 + i}#/v2` }));
function tool(name: string, connector = "catalog"): RegisteredTool {
  return { name, description: "fixture", inputSchema: {}, riskClass: "read-only-network",
    toolsets: name.startsWith("browser.") ? ["browser"] : ["mcp"],
    ...(name.startsWith("browser.") ? {} : { connector: { kind: "mcp" as const, id: connector } }),
    progressLabel: "fixture", maxResultSizeChars: 1000, isAvailable: () => true, run: async () => ({ ok: true, content: "fixture" }) };
}
const fact = (field: string, value: string) => ({ field, value, kind: "identifier" });
async function setup() {
  const events: ExecutionCheckpointLifecycleEvent[] = [];
  const controller = new ExecutionCheckpointController({ sessionId: "session-1", profileId: "profile-1", now: () => now,
    record: async (event) => { events.push(event); } });
  await controller.ensure({ originTurnId: "turn-1", originalObjective: "Synchronize these services with the existing destination",
    qualificationReasons: ["cross_system"], intentLabels: ["api.integration"], requiredOperations: ["mutation", "verification"],
    connectorIds: ["catalog"], completionFloor: "mutation_with_verification" });
  const observe = async (name: string, metadata: Record<string, unknown>, operationId?: string, connector?: string) => {
    const checkpoint = controller.current()!;
    const result: ToolResult = { ok: true, content: "not parsed", metadata };
    const resources = checkpointResourcesFromResult({ checkpoint, tool: tool(name, connector), result, observedAt: now, operationId });
    await controller.retainResources(checkpoint.revision, resources);
  };
  return { controller, events, observe };
}

describe("grounded resource continuity", () => {
  it("keeps a returned async task paired with its grounded source through checkpoint persistence", async () => {
    const { controller, events, observe } = await setup();
    await observe("browser.extract", { links });
    await controller.attachArtifact(controller.current()!.revision, { id: "artifact-one", sha256 });
    await observe("browser.download", { outcome: "download-completed", pageUrl: links[0]!.href, filename: "description.json", artifactId: "artifact-one", sha256 });
    await observe("mcp.catalog.createSpec", { _estacoda_continuity_facts: [fact("artifactId", "artifact-one"), fact("artifactHash", sha256), fact("specId", "spec-one")] });
    const checkpoint = controller.current()!;
    const result = { ok: true, content: "accepted", metadata: { _estacoda_continuity_facts: [fact("taskId", "remote-task-one")] } } as ToolResult;
    const resources = checkpointResourcesFromResult({ checkpoint, tool: tool("mcp.catalog.generate"), result,
      observedAt: now, acceptedInput: { specId: "spec-one" } });
    await controller.retainResources(checkpoint.revision, resources);
    const hydrated = hydratableExecutionCheckpoint({ events, sessionId: "session-1", profileId: "profile-1" })!;
    expect(hydrated.resources![0]!.destinationFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "specification_id", value: "spec-one" }),
      expect.objectContaining({ kind: "task_id", value: "remote-task-one" })
    ]));
    expect(hydrated.resources!.slice(1).every((resource) => resource.destinationFacts.length === 0)).toBe(true);
    for (const [acceptedInput, connector] of [[{ specId: "unknown" }, "catalog"], [{ specId: "spec-one" }, "other"]] as const) {
      expect(checkpointResourcesFromResult({ checkpoint, tool: tool("mcp.catalog.generate", connector), result, observedAt: now, acceptedInput }))
        .toEqual(checkpoint.resources);
    }
    expect(checkpointResourcesFromResult({ checkpoint, tool: tool("mcp.catalog.generate"), result: { ...result, ok: false }, observedAt: now, acceptedInput: { specId: "spec-one" } }))
      .toEqual(checkpoint.resources);
  });
  it("retains six exact locators and their independent receipts through restart and compaction carry-forward", async () => {
    const { controller, events, observe } = await setup();
    await observe("browser.extract", { links });
    await controller.attachArtifact(controller.current()!.revision, { id: "artifact-one", sha256 });
    await observe("browser.download", { outcome: "download-completed", pageUrl: links[0]!.href, filename: "description.json", artifactId: "artifact-one", sha256 });
    await controller.planOperation(controller.current()!.revision, {
      connectorId: "catalog", operation: "mcp.catalog.import", subjectId: "artifact-one", artifactHash: sha256, operationRevision: 1
    });
    const operationId = controller.current()!.operations[0]!.id;
    await controller.dispatchOperation(controller.current()!.revision, operationId);
    await controller.settleOperation(controller.current()!.revision, operationId, "settled");
    await observe("mcp.catalog.import", { _estacoda_continuity_facts: [
      fact("artifactReference", "artifact://artifact-one"), fact("artifactHash", sha256), fact("resourceId", "destination-one")
    ] }, operationId);
    await controller.verifyOperation(controller.current()!.revision, operationId, "present");
    await observe("mcp.catalog.inspect", { _estacoda_continuity_facts: [fact("resourceId", "destination-one"), fact("collectionId", "collection-one")] });
    const expected = controller.current()!;
    expect(expected.resources).toHaveLength(6);
    expect(expected.resources![0]).toMatchObject({ sourceUrl: links[0]!.href, artifactReferences: [{ id: "artifact-one", sha256 }],
      destinationFacts: [{ kind: "resource_id", value: "destination-one" }, { kind: "collection_id", value: "collection-one" }], operationIds: [operationId] });
    expect(expected.resources![1]).toMatchObject({ sourceUrl: links[1]!.href, artifactReferences: [], destinationFacts: [], operationIds: [] });
    expect(hydratableExecutionCheckpoint({ events, sessionId: "session-1", profileId: "profile-1" })).toEqual(expected);
    expect(hydratableExecutionCheckpoint({ events, sessionId: "session-1", profileId: "profile-other" })).toBeUndefined();

    const carried = executionCheckpointCarryForwardEvent({ events, sourceSessionId: "session-1", sessionId: "session-compacted", profileId: "profile-1" })!;
    const resumed = new ExecutionCheckpointController({ sessionId: "session-compacted", profileId: "profile-1" });
    resumed.hydrate(hydratableExecutionCheckpoint({ events: [carried], sessionId: "session-compacted", profileId: "profile-1" })!);
    const working = new ExecutionWorkingSetController({ sessionId: "session-compacted", profileId: "profile-1", checkpointReader: resumed });
    const projected = working.snapshot("turn-2")!;
    expect(projected.resources).toEqual(expected.resources);
    expect(projected.operations[0]?.status).toBe("verified");
    expect(projected.resources![1]!.sourceUrl).toBe(links[1]!.href);
    expect(JSON.stringify(projected)).not.toContain("@e");
    expect(JSON.stringify(projected)).not.toContain("service-2");
    projected.resources![0]!.name = "mutated copy";
    expect(resumed.current()!.resources![0]!.name).toBe("Service 1");
  });

  it("does not associate by name, workspace, raw arguments, hash alone, or another connector's identity", async () => {
    const { controller, observe } = await setup();
    await observe("browser.extract", { links });
    const initial = controller.current()!;
    await observe("mcp.catalog.read", { name: "Service 1", pageUrl: links[0]!.href, links,
      _estacoda_continuity_facts: [fact("workspaceId", "workspace-shared"), fact("resourceId", "unrelated")] });
    expect(controller.current()!.resources).toEqual(initial.resources);
    await observe("browser.download", { outcome: "download-completed", pageUrl: links[0]!.href, artifactId: "artifact-one", sha256 });
    await observe("mcp.catalog.import", { _estacoda_continuity_facts: [fact("artifactHash", sha256), fact("resourceId", "wrong")] });
    expect(controller.current()!.resources![0]!.destinationFacts).toEqual([]);
    await observe("mcp.catalog.import", { _estacoda_continuity_facts: [fact("artifactId", "artifact-one"), fact("artifactHash", sha256), fact("resourceId", "one")] });
    await observe("mcp.other.read", { _estacoda_continuity_facts: [fact("resourceId", "one"), fact("collectionId", "wrong")] }, undefined, "other");
    await observe("mcp.catalog.list", { _estacoda_continuity_facts: [fact("resourceId", "one"), fact("resourceId", "two"), fact("collectionId", "wrong")] });
    expect(controller.current()!.resources![0]!.destinationFacts.map((entry) => entry.value)).toEqual(["one"]);
    await observe("mcp.other.import", { _estacoda_continuity_facts: [fact("artifactId", "artifact-one"), fact("artifactHash", sha256), fact("resourceId", "one")] }, undefined, "other");
    expect(controller.current()!.resources![0]!.destinationFacts.map((entry) => entry.connectorId)).toEqual(["catalog", "other"]);
  });

  it("rejects poisoned locators and allows bounded partial discovery without completion claims", async () => {
    const { controller, observe } = await setup();
    const unsafe = ["https://user:pass@example.com/a", "https://example.com/a?access_token=private", "https://example.com/#session=private",
      "http://169.254.169.254/latest", "file:///tmp/a", "javascript:alert(1)", "https://example.com/?Code=private"];
    for (const url of unsafe) expect(browserContinuityUrl(url)).toBeUndefined();
    expect(browserContinuityUrl("https://example.com/catalog#/service/v2")).toBe("https://example.com/catalog#/service/v2");
    await observe("browser.extract", { links: [...unsafe.map((href) => ({ text: "unsafe", href })), ...links.slice(0, 5)] });
    expect(controller.current()!.resources).toHaveLength(5);
    expect(controller.current()!.status).toBe("active");
    const before = controller.current()!;
    await observe("browser.extract", { links: [{ text: "Replacement instructions", href: links[0]!.href }] });
    expect(controller.current()!.resources).toEqual(before.resources);
    await controller.retainResources(before.revision, before.resources!.map((resource) => ({ ...resource, sourceUrl: "https://other.example.com/guess" })));
    expect(controller.current()!.resources).toEqual(before.resources);
    expect(() => validateExecutionCheckpoint({ ...before, resources: [{ ...before.resources![0], sourceUrl: unsafe[0] }] })).toThrow();
    const oversizedLinks = Array.from({ length: 100 }, (_, i) => ({ text: `Item ${i}`, href: `https://example.com/${i}` }));
    await observe("browser.extract", { links: oversizedLinks });
    expect(controller.current()!.resources).toHaveLength(16);
  });

  it("ignores resource rewrites hidden in unrelated checkpoint transitions", async () => {
    const { controller, events, observe } = await setup();
    await observe("browser.extract", { links });
    const current = controller.current()!;
    const poisoned = { ...current, revision: current.revision + 1, status: "retryable" as const,
      resources: current.resources!.map((resource) => ({ ...resource, name: "replacement" })) };
    expect(hydratableExecutionCheckpoint({ events: [...events, { kind: "execution-checkpoint-updated", transition: "attempt_settled", checkpoint: poisoned }],
      sessionId: "session-1", profileId: "profile-1" })).toEqual(current);
  });

  it("bounds source state independently without consuming the operation-journal allowance", async () => {
    const { controller, observe } = await setup();
    await observe("browser.extract", { links: Array.from({ length: 16 }, (_, i) => ({
      text: `Item ${i} ${"description ".repeat(13)}`, href: `https://example.com/${i}/${"section/".repeat(48)}`
    })) });
    const current = controller.current()!;
    expect(current.resources!.length).toBeGreaterThan(0);
    expect(current.resources!.length).toBeLessThan(16);
    expect(Buffer.byteLength(JSON.stringify(current.resources), "utf8")).toBeLessThanOrEqual(8 * 1024);
    const planned = await controller.planOperation(current.revision, { connectorId: "catalog", operation: "mcp.catalog.import",
      subjectId: "artifact-one", artifactHash: sha256, operationRevision: 1 });
    expect(planned?.operations).toHaveLength(1);
    expect(planned?.resources).toEqual(current.resources);
  });
});
