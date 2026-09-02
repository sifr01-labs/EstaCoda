import { describe, expect, it } from "vitest";
import type { ForegroundExecutionCheckpoint } from "../contracts/execution-checkpoint.js";
import type { SessionEvent } from "../contracts/session.js";
import {
  checkpointEvent,
  executionCheckpointCarryForwardEvent,
  hydratableExecutionCheckpoint
} from "./execution-checkpoint-state.js";

describe("execution checkpoint state", () => {
  it("hydrates only a coherent monotonic revision chain", () => {
    const first = checkpoint();
    const second = { ...first, revision: 2, status: "retryable" as const };
    const stale = { ...first, status: "completed" as const };
    const events: SessionEvent[] = [
      checkpointEvent("created", first),
      checkpointEvent("attempt_settled", second),
      checkpointEvent("attempt_settled", stale)
    ];

    expect(hydratableExecutionCheckpoint({
      events,
      sessionId: "session-1",
      profileId: "profile-1"
    })).toMatchObject({ revision: 2, status: "retryable" });
  });

  it("rejects malformed, oversized, sensitive, and cross-profile persisted state", () => {
    const unsafe = {
      ...checkpoint(),
      originalObjective: "Import with password=hunter2",
      credential: "must-not-survive"
    };
    const oversized = {
      ...checkpoint(),
      originalObjective: "x".repeat(2_001)
    };
    const crossProfile = {
      ...checkpoint(),
      profileId: "other-profile"
    };
    const events = [unsafe, oversized, crossProfile].map((value) => ({
      kind: "execution-checkpoint-updated" as const,
      transition: "created" as const,
      checkpoint: value as ForegroundExecutionCheckpoint
    }));

    expect(hydratableExecutionCheckpoint({
      events,
      sessionId: "session-1",
      profileId: "profile-1"
    })).toBeUndefined();
    expect(JSON.stringify(events)).toContain("must-not-survive");
  });

  it("carries only non-terminal state into a compacted child session", () => {
    const carried = executionCheckpointCarryForwardEvent({
      events: [checkpointEvent("created", checkpoint())],
      sourceSessionId: "session-1",
      sessionId: "session-child",
      profileId: "profile-1"
    });

    expect(carried).toMatchObject({
      transition: "carried_forward",
      checkpoint: {
        id: "checkpoint:1",
        sessionId: "session-child",
        revision: 1,
        status: "active"
      }
    });
    expect(executionCheckpointCarryForwardEvent({
      events: [checkpointEvent("attempt_settled", { ...checkpoint(), status: "completed" })],
      sourceSessionId: "session-1",
      sessionId: "session-child",
      profileId: "profile-1"
    })).toBeUndefined();
  });

  it("does not hydrate completed state without a receipt-derived completed outcome", () => {
    const active = checkpoint();
    const forgedCompletion = { ...active, revision: 2, progressRevision: 1, status: "completed" as const };
    const withoutReceipt = hydratableExecutionCheckpoint({
      events: [
        checkpointEvent("created", active),
        checkpointEvent("attempt_settled", forgedCompletion)
      ],
      sessionId: "session-1",
      profileId: "profile-1"
    });
    const withReceipt = hydratableExecutionCheckpoint({
      events: [
        checkpointEvent("created", active),
        {
          kind: "execution-evidence-recorded",
          toolCallId: "mutation-1",
          tool: "mcp.postman.updateCollection",
          status: "success",
          riskClass: "external-side-effect",
          executionEffect: {
            kind: "mutation",
            connector: { kind: "mcp", id: "postman" }
          }
        },
        {
          kind: "execution-evidence-recorded",
          toolCallId: "verify-1",
          tool: "mcp.postman.getCollection",
          status: "success",
          riskClass: "read-only-network",
          executionEffect: {
            kind: "verification",
            verifies: ["mcp.postman.updateCollection"],
            connector: { kind: "mcp", id: "postman" }
          },
          verifiedMutation: {
            toolCallId: "mutation-1",
            tool: "mcp.postman.updateCollection"
          }
        },
        {
          kind: "execution-final-outcome-recorded",
          status: "completed",
          terminationCause: "normal",
          completionFloor: "mutation_with_verification"
        },
        checkpointEvent("attempt_settled", forgedCompletion)
      ],
      sessionId: "session-1",
      profileId: "profile-1"
    });

    expect(withoutReceipt).toMatchObject({ revision: 1, status: "active" });
    expect(withReceipt).toMatchObject({ revision: 2, status: "completed" });
  });

  it("rejects incoherent transitions and fabricated semantic progress", () => {
    const active = checkpoint();
    const forgedProgress = {
      ...active,
      revision: 2,
      progressRevision: 1,
      status: "retryable" as const
    };
    const forgedCancellation = {
      ...active,
      revision: 2,
      status: "cancelled" as const
    };

    expect(hydratableExecutionCheckpoint({
      events: [checkpointEvent("created", active), checkpointEvent("attempt_settled", forgedProgress)],
      sessionId: "session-1",
      profileId: "profile-1"
    })).toMatchObject({ revision: 1, progressRevision: 0, status: "active" });
    expect(hydratableExecutionCheckpoint({
      events: [checkpointEvent("created", active), checkpointEvent("blocked", forgedCancellation)],
      sessionId: "session-1",
      profileId: "profile-1"
    })).toMatchObject({ revision: 1, status: "active" });
  });

  it("does not allow creation, correction, or artifact transitions to smuggle journal state", () => {
    const active = checkpoint();
    const fact = {
      kind: "workspace_id" as const,
      value: "workspace-1",
      sourceTool: "mcp.postman.getWorkspaces",
      connectorId: "postman",
      observedAt: "2030-01-01T00:00:00.000Z"
    };
    const operation = {
      id: "operation:1",
      connectorId: "postman",
      operation: "mcp.postman.importSpec",
      destinationId: "workspace-1",
      operationRevision: 1,
      status: "planned" as const,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z"
    };
    const forgedCreation = { ...active, safeFacts: [fact] };
    const forgedCorrection = {
      ...active,
      revision: 2,
      latestUserCorrection: "Use another workspace.",
      operations: [operation]
    };
    const forgedArtifact = {
      ...active,
      revision: 2,
      progressRevision: 1,
      artifactReferences: [{ id: "artifact-1", sha256: "a".repeat(64) }],
      safeFacts: [fact]
    };

    expect(hydratableExecutionCheckpoint({
      events: [checkpointEvent("created", forgedCreation)],
      sessionId: "session-1",
      profileId: "profile-1"
    })).toBeUndefined();
    expect(hydratableExecutionCheckpoint({
      events: [checkpointEvent("created", active), checkpointEvent("corrected", forgedCorrection)],
      sessionId: "session-1",
      profileId: "profile-1"
    })).toMatchObject({ revision: 1, safeFacts: [], operations: [] });
    expect(hydratableExecutionCheckpoint({
      events: [checkpointEvent("created", active), checkpointEvent("artifact_attached", forgedArtifact)],
      sessionId: "session-1",
      profileId: "profile-1"
    })).toMatchObject({ revision: 1, artifactReferences: [], safeFacts: [] });
  });

  it("hydrates a coherent artifact attachment but rejects replacement or fabricated progress", () => {
    const active = checkpoint();
    const attached = {
      ...active,
      revision: 2,
      progressRevision: 1,
      artifactReferences: [{ id: "artifact-1", sha256: "a".repeat(64) }]
    };
    const replaced = {
      ...attached,
      revision: 3,
      progressRevision: 2,
      artifactReferences: [{ id: "artifact-2", sha256: "b".repeat(64) }]
    };

    expect(hydratableExecutionCheckpoint({
      events: [checkpointEvent("created", active), checkpointEvent("artifact_attached", attached)],
      sessionId: "session-1",
      profileId: "profile-1"
    })).toMatchObject({ revision: 2, progressRevision: 1, artifactReferences: [{ id: "artifact-1" }] });
    expect(hydratableExecutionCheckpoint({
      events: [
        checkpointEvent("created", active),
        checkpointEvent("artifact_attached", attached),
        checkpointEvent("artifact_attached", replaced)
      ],
      sessionId: "session-1",
      profileId: "profile-1"
    })).toMatchObject({ revision: 2, artifactReferences: [{ id: "artifact-1" }] });
  });
});

function checkpoint(): ForegroundExecutionCheckpoint {
  return {
    version: 1,
    id: "checkpoint:1",
    sessionId: "session-1",
    profileId: "profile-1",
    originTurnId: "turn-1",
    revision: 1,
    progressRevision: 0,
    originalObjective: "Import and verify APIs in Postman",
    status: "active",
    qualificationReasons: ["cross_system"],
    selectedSkillName: "api-integration",
    taskClass: "general",
    intentLabels: ["api.integration"],
    requiredOperations: ["read", "mutation", "verification"],
    connectorIds: ["postman"],
    artifactReferences: [],
    safeFacts: [],
    operations: [],
    completionFloor: "mutation_with_verification",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z"
  };
}
