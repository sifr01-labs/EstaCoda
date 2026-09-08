import { describe, expect, it, vi } from "vitest";
import type { ExecutionCheckpointLifecycleEvent } from "../contracts/execution-checkpoint.js";
import type { ExecutionFinalOutcome } from "../contracts/execution-plan.js";
import { hydratableExecutionCheckpoint } from "../session/execution-checkpoint-state.js";
import { ExecutionCheckpointController, ExecutionCheckpointConflictError } from "./execution-checkpoint-controller.js";

const now = "2030-01-01T00:00:00.000Z";

describe("ExecutionCheckpointController", () => {
  it("persists a bounded runtime-owned checkpoint and redacts its objective", async () => {
    const events: unknown[] = [];
    const controller = new ExecutionCheckpointController({
      sessionId: "session-1",
      profileId: "profile-1",
      now: () => now,
      createId: () => "checkpoint:1",
      record: async (event) => { events.push(event); }
    });

    const checkpoint = await controller.ensure(creation({
      originalObjective: "Import APIs with password=hunter2 and OTP 123456 into Postman"
    }));

    expect(checkpoint).toMatchObject({
      id: "checkpoint:1",
      revision: 1,
      progressRevision: 0,
      status: "active",
      originalObjective: "Import APIs with password=[REDACTED] and OTP [REDACTED] into Postman"
    });
    expect(events).toEqual([expect.objectContaining({
      kind: "execution-checkpoint-updated",
      transition: "created"
    })]);
  });

  it("bounds long objectives instead of dropping checkpoint creation", async () => {
    const controller = target();
    const checkpoint = await controller.ensure(creation({ originalObjective: `Import ${"API ".repeat(800)}` }));

    expect(checkpoint.originalObjective.length).toBeLessThanOrEqual(2_000);
    expect(checkpoint.status).toBe("active");
  });

  it("keeps incomplete and provider-failed work retryable and closes only a matching completed outcome", async () => {
    const controller = target();
    const created = await controller.ensure(creation());
    const failed = await controller.settleAttempt(created.revision, {
      outcome: outcome("failed", "provider_failed"),
      providerFailureClass: "rate-limit"
    });
    const partial = await controller.settleAttempt(failed!.revision, {
      outcome: outcome("partially_completed", "budget_exhausted")
    });
    const mismatched = await controller.settleAttempt(partial!.revision, {
      outcome: { ...outcome("completed", "normal"), completionFloor: "read" }
    });
    const completed = await controller.settleAttempt(mismatched!.revision, {
      outcome: outcome("completed", "normal")
    });

    expect(failed).toMatchObject({ status: "retryable", lastProviderFailureClass: "rate-limit" });
    expect(partial).toMatchObject({ status: "retryable", progressRevision: 0 });
    expect(mismatched).toMatchObject({ status: "blocked", progressRevision: 0 });
    expect(completed).toMatchObject({ status: "completed", progressRevision: 1 });
  });

  it("attaches a bounded artifact reference as semantic progress without exposing a path", async () => {
    const controller = target();
    const created = await controller.ensure(creation());
    const attached = await controller.attachArtifact(created.revision, {
      id: "artifact-1",
      sha256: "a".repeat(64)
    });
    const duplicate = await controller.attachArtifact(attached!.revision, {
      id: "artifact-1",
      sha256: "a".repeat(64)
    });

    expect(attached).toMatchObject({
      revision: 2,
      progressRevision: 1,
      artifactReferences: [{ id: "artifact-1", sha256: "a".repeat(64) }]
    });
    expect(duplicate).toEqual(attached);
    expect(JSON.stringify(attached)).not.toContain("/");
  });

  it("reclaims only redundant artifact facts from a full checkpoint before retaining the environment", async () => {
    const events: ExecutionCheckpointLifecycleEvent[] = [];
    const controller = new ExecutionCheckpointController({ sessionId: "session-1", profileId: "profile-1",
      now: () => now, record: async (event) => { events.push(event); } });
    await controller.ensure(creation());
    for (let i = 0; i < 8; i++) {
      await controller.retainFacts(controller.current()!.revision, [
        { kind: "artifact_id", value: `artifact-${i}`, sourceTool: "browser.download", observedAt: now },
        { kind: "artifact_hash", value: i.toString(16).repeat(64), sourceTool: "browser.download", observedAt: now },
        { kind: "specification_id", value: `spec-${i}`, sourceTool: "mcp.catalog.createSpec", connectorId: "catalog", observedAt: now }
      ]);
    }
    expect(controller.current()!.safeFacts).toHaveLength(24);
    for (let i = 0; i < 8; i++) await controller.attachArtifact(controller.current()!.revision,
      { id: `artifact-${i}`, sha256: i.toString(16).repeat(64) });
    await controller.retainFacts(controller.current()!.revision, [
      { kind: "environment_id", value: "environment-1", sourceTool: "mcp.catalog.createEnvironment", connectorId: "catalog", observedAt: now }
    ]);
    expect(controller.current()!.safeFacts).toHaveLength(9);
    expect(controller.current()!.safeFacts.filter((fact) => fact.kind === "specification_id")).toHaveLength(8);
    expect(controller.current()!.artifactReferences).toHaveLength(8);
    expect(hydratableExecutionCheckpoint({ events, sessionId: "session-1", profileId: "profile-1" }))
      .toEqual(controller.current());
  });

  it("hydrates reviewed facts and a coherent external-operation lifecycle", async () => {
    const events: ExecutionCheckpointLifecycleEvent[] = [];
    let tick = 0;
    const controller = new ExecutionCheckpointController({
      sessionId: "session-1",
      profileId: "profile-1",
      now: () => new Date(Date.parse(now) + tick++ * 1_000).toISOString(),
      createId: () => "checkpoint:1",
      record: async (event) => { events.push(event); }
    });
    const created = await controller.ensure(creation());
    const facts = await controller.retainFacts(created.revision, [
      { kind: "workspace_id", value: "workspace-1", sourceTool: "mcp.postman.getWorkspaces", connectorId: "postman", observedAt: now },
      { kind: "collection_id", value: "collection-1", sourceTool: "mcp.postman.getCollection", connectorId: "postman", observedAt: now }
    ]);
    const coordinates = {
      connectorId: "postman",
      operation: "mcp.postman.importSpec",
      destinationId: "workspace-1",
      subjectId: "loans-v2",
      artifactHash: "a".repeat(64),
      operationRevision: 1
    };
    const planned = await controller.planOperation(facts!.revision, coordinates);
    const operationId = planned!.operations[0]!.id;
    const dispatched = await controller.dispatchOperation(planned!.revision, operationId);
    const settled = await controller.settleOperation(dispatched!.revision, operationId, "settled");
    const verified = await controller.verifyOperation(settled!.revision, operationId, "present");

    expect(verified).toMatchObject({
      revision: 6,
      progressRevision: 3,
      safeFacts: [
        { kind: "workspace_id", value: "workspace-1" },
        { kind: "collection_id", value: "collection-1" }
      ],
      operations: [{ status: "verified", destinationId: "workspace-1", subjectId: "loans-v2" }]
    });
    expect(events.map((event) => event.transition)).toEqual([
      "created", "facts_retained", "operation_planned", "operation_dispatched", "operation_settled", "operation_verified"
    ]);
    expect(hydratableExecutionCheckpoint({
      events,
      sessionId: "session-1",
      profileId: "profile-1"
    })).toEqual(verified);
  });

  it("persists only safe authentication recovery stages and counts semantic advancement", async () => {
    const events: ExecutionCheckpointLifecycleEvent[] = [];
    const controller = new ExecutionCheckpointController({
      sessionId: "session-1",
      profileId: "profile-1",
      now: () => now,
      createId: () => "checkpoint:1",
      record: async (event) => { events.push(event); }
    });
    const created = await controller.ensure(creation());
    const credentials = await controller.updateAuthenticationRecoveryStage(
      created.revision,
      "credentials_submitted"
    );
    const challenge = await controller.updateAuthenticationRecoveryStage(
      credentials!.revision,
      "challenge_required"
    );
    const repeated = await controller.updateAuthenticationRecoveryStage(
      challenge!.revision,
      "challenge_required"
    );
    const submitted = await controller.updateAuthenticationRecoveryStage(
      repeated!.revision,
      "challenge_submitted"
    );
    const verified = await controller.updateAuthenticationRecoveryStage(submitted!.revision, undefined);

    expect(verified).toMatchObject({ revision: 5, progressRevision: 4 });
    expect(verified).not.toHaveProperty("authenticationRecoveryStage");
    expect(events.map((event) => event.transition)).toEqual([
      "created",
      "authentication_stage_updated",
      "authentication_stage_updated",
      "authentication_stage_updated",
      "authentication_stage_updated"
    ]);
    expect(hydratableExecutionCheckpoint({
      events,
      sessionId: "session-1",
      profileId: "profile-1"
    })).toEqual(verified);
    expect(JSON.stringify(events)).not.toMatch(/otp|credential.*value|password/iu);
  });

  it("rejects secret-looking facts and semantic coordinates instead of persisting them", async () => {
    const events: ExecutionCheckpointLifecycleEvent[] = [];
    const controller = new ExecutionCheckpointController({
      sessionId: "session-1",
      profileId: "profile-1",
      now: () => now,
      createId: () => "checkpoint:1",
      record: async (event) => { events.push(event); }
    });
    const created = await controller.ensure(creation());

    await expect(controller.retainFacts(created.revision, [{
      kind: "workspace_id",
      value: "api_key=sk-secret-1234567890",
      sourceTool: "mcp.postman.getWorkspaces",
      observedAt: now
    }])).rejects.toThrow("safeFacts.value is invalid");
    await expect(controller.planOperation(created.revision, {
      connectorId: "postman",
      operation: "mcp.postman.importSpec",
      destinationId: "password=hunter2",
      operationRevision: 1
    })).rejects.toThrow("sensitive content");

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("sk-secret");
    expect(JSON.stringify(events)).not.toContain("hunter2");
  });

  it("serializes writes and rejects a stale expected revision", async () => {
    const releaseFirst = deferred<void>();
    let writes = 0;
    const controller = new ExecutionCheckpointController({
      sessionId: "session-1",
      profileId: "profile-1",
      now: () => now,
      createId: () => "checkpoint:1",
      record: async () => {
        writes += 1;
        if (writes === 2) await releaseFirst.promise;
      }
    });
    const created = await controller.ensure(creation());
    const first = controller.settleAttempt(created.revision, {
      outcome: outcome("failed", "provider_failed")
    });
    const stale = controller.settleAttempt(created.revision, {
      outcome: outcome("completed", "normal")
    });
    releaseFirst.resolve();

    await expect(first).resolves.toMatchObject({ revision: 2, status: "retryable" });
    await expect(stale).rejects.toBeInstanceOf(ExecutionCheckpointConflictError);
    expect(controller.current()).toMatchObject({ revision: 2, status: "retryable" });
  });

  it("distinguishes explicit cancellation from supersession", async () => {
    const cancelled = target();
    await cancelled.ensure(creation());
    await expect(cancelled.prepareForTurn("cancel")).resolves.toMatchObject({
      disposition: "cancelled",
      checkpoint: { status: "cancelled" }
    });
    expect(cancelled.current()).toMatchObject({ status: "cancelled", lastTerminationCause: "cancelled" });

    const superseded = target();
    await superseded.ensure(creation());
    await expect(superseded.prepareForTurn("Forget that. Check this repository for a bug."))
      .resolves.toMatchObject({ disposition: "superseded", checkpoint: { status: "superseded" } });
    expect(superseded.current()).toMatchObject({ status: "superseded" });

    const terminalRevision = superseded.current()!.revision;
    await superseded.block(terminalRevision, { kind: "external_state", summary: "Late blocker" });
    expect(superseded.current()).toMatchObject({ status: "superseded", revision: terminalRevision });

    const acknowledgedReplacement = target();
    await acknowledgedReplacement.ensure(creation());
    await expect(acknowledgedReplacement.prepareForTurn("Okay, now explain the weather forecast."))
      .resolves.toMatchObject({ disposition: "superseded" });

    const slashReplacement = target();
    await slashReplacement.ensure(creation());
    await expect(slashReplacement.prepareForTurn("/review inspect this repository"))
      .resolves.toMatchObject({ disposition: "superseded" });
  });

  it("records an in-mission correction without superseding the checkpoint", async () => {
    const controller = target();
    await controller.ensure(creation());

    await expect(controller.prepareForTurn("Please use the other Postman workspace instead."))
      .resolves.toMatchObject({ disposition: "correction", checkpoint: { status: "active" } });

    expect(controller.current()).toMatchObject({
      revision: 2,
      progressRevision: 0,
      status: "active",
      latestUserCorrection: "Please use the other Postman workspace instead."
    });

    const arabic = target();
    await arabic.ensure(creation());
    await arabic.prepareForTurn("استخدم مساحة العمل الأخرى بدلاً من الحالية.");
    expect(arabic.current()).toMatchObject({ status: "active", revision: 2 });
  });

  it("classifies acknowledgement and blocker-response turns as checkpoint continuations", async () => {
    const controller = target();
    const checkpoint = await controller.ensure(creation());

    await expect(controller.prepareForTurn("try again")).resolves.toEqual({
      disposition: "continuation",
      checkpoint
    });
    await expect(controller.prepareForTurn("Okay can you pick u where we lefto ff/"))
      .resolves.toEqual({ disposition: "continuation", checkpoint });
    expect(controller.current()).toEqual(checkpoint);

    const waiting = await controller.settleAttempt(checkpoint.revision, {
      outcome: outcome("failed", "user_input_required")
    });
    await expect(controller.prepareForTurn("I entered the code."))
      .resolves.toMatchObject({ disposition: "continuation", checkpoint: { status: "awaiting_user" } });
    await expect(controller.prepareForTurn("Please continue; I entered the code."))
      .resolves.toMatchObject({ disposition: "continuation", checkpoint: { status: "awaiting_user" } });
    expect(controller.current()?.revision).toBe(waiting?.revision);
  });

  it("keeps connector recovery questions attached without superseding or correcting the saved task", async () => {
    const controller = target();
    const checkpoint = await controller.ensure(creation());
    await controller.block(checkpoint.revision, { kind: "missing_capability", summary: "Connector unavailable" });
    const saved = controller.current();
    await expect(controller.prepareForTurn("ok")).resolves.toMatchObject({ disposition: "continuation" });
    for (const text of ["why?", "Explain why the connector is unavailable", "How should we change the connection?", "لماذا؟", "اشرح لماذا الموصل غير متاح"]) {
      await expect(controller.prepareForTurn(text)).resolves.toMatchObject({ disposition: "recovery" });
      expect(controller.current()).toEqual(saved);
    }
    await expect(controller.prepareForTurn("Explain what a rain jacket is?")).resolves.toMatchObject({ disposition: "superseded" });
  });

  it("does not allow a model-facing Plan update to mutate checkpoint state", async () => {
    const controller = target();
    const checkpoint = await controller.ensure(creation());
    const exposed = controller.current()!;
    exposed.status = "completed";
    exposed.connectorIds.push("untrusted");

    expect(controller.current()).toEqual(checkpoint);
  });
});

function target(): ExecutionCheckpointController {
  return new ExecutionCheckpointController({
    sessionId: "session-1",
    profileId: "profile-1",
    now: () => now,
    createId: () => "checkpoint:1",
    record: async () => undefined
  });
}

function creation(overrides: Partial<Parameters<ExecutionCheckpointController["ensure"]>[0]> = {}) {
  return {
    originTurnId: "turn-1",
    originalObjective: "Import and verify the API in Postman",
    qualificationReasons: ["cross_system" as const, "verified_mutation" as const],
    selectedSkillName: "api-integration",
    taskClass: "general" as const,
    intentLabels: ["api.integration"],
    requiredOperations: ["read" as const, "mutation" as const, "verification" as const],
    connectorIds: ["postman"],
    completionFloor: "mutation_with_verification" as const,
    ...overrides
  };
}

function outcome(
  status: ExecutionFinalOutcome["status"],
  terminationCause: ExecutionFinalOutcome["terminationCause"]
): ExecutionFinalOutcome {
  return {
    status,
    terminationCause,
    completionFloor: "mutation_with_verification",
    confirmedActions: [],
    uncertainActions: []
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}
