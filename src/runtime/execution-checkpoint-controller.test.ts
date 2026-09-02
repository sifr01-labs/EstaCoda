import { describe, expect, it, vi } from "vitest";
import type { ExecutionFinalOutcome } from "../contracts/execution-plan.js";
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

    const waiting = await controller.settleAttempt(checkpoint.revision, {
      outcome: outcome("failed", "user_input_required")
    });
    await expect(controller.prepareForTurn("I entered the code."))
      .resolves.toMatchObject({ disposition: "continuation", checkpoint: { status: "awaiting_user" } });
    await expect(controller.prepareForTurn("Please continue; I entered the code."))
      .resolves.toMatchObject({ disposition: "continuation", checkpoint: { status: "awaiting_user" } });
    expect(controller.current()?.revision).toBe(waiting?.revision);
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
