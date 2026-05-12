import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import { SQLiteSessionDB } from "../../session/sqlite-session-db.js";
import { SQLiteTaskFlowStore } from "../../taskflow/sqlite-taskflow-store.js";
import type { FlowEvent, OperatorEvent, Flow, FlowStep } from "../../taskflow/types.js";
import { assertTrue, assertEqual, buildResult } from "../eval-runner.js";
import { rmSync } from "node:fs";

export const taskflowAtomicityCase: EvalCase = {
  id: "taskflow-atomicity",
  name: "SQLiteTaskFlowStore atomic transitions and round-trip integrity",
  description: "Atomic transition writes flow+step+events in one transaction; rollback on error.",
  tags: ["taskflow", "atomicity", "sqlite", "deterministic"],
  run: async (): Promise<EvalResult> => {
    const startedAt = Date.now();
    const dbPath = `/tmp/estacoda-eval-atomicity-${Date.now()}.db`;
    const assertions = [];

    try {
      const sessionDb = new SQLiteSessionDB({ path: dbPath });
      const store = new SQLiteTaskFlowStore({ db: sessionDb.db });

      // Atomic transition: create flow + step + event together
      await store.atomicTransition("flow-1", async (tx) => {
        await tx.createFlow(makeTestFlow("flow-1"));
        await tx.createStep(makeTestStep("step-1", "flow-1", 0));
        await tx.appendFlowEvent(makeTestEvent("evt-1", "flow-1", "step-1", "flow-created"));
        return "committed";
      });

      const flow = await store.getFlow("flow-1");
      const step = await store.getStep("step-1");
      const events = await store.listFlowEvents("flow-1");

      assertions.push(assertTrue("flow exists after atomic transition", flow !== null));
      assertions.push(assertTrue("step exists after atomic transition", step !== null));
      assertions.push(assertEqual("events count after atomic transition", events.length, 1));

      // Atomic transition with error should roll back
      let threw = false;
      try {
        await store.atomicTransition("flow-2", async (tx) => {
          await tx.createFlow(makeTestFlow("flow-2"));
          await tx.createStep(makeTestStep("step-2", "flow-2", 0));
          throw new Error("simulated failure");
        });
      } catch {
        threw = true;
      }
      assertions.push(assertTrue("atomic transition throws on error", threw));

      // The adapter-backed transaction should roll back completely, so flow-2 should not exist.
      const flow2 = await store.getFlow("flow-2");
      assertions.push(assertTrue("flow rolled back on atomic failure", flow2 === null));

      // Step update round-trip
      if (step) {
        const updatedStep = { ...step, status: "running" as const, startedAt: "2024-01-01T00:01:00.000Z", updatedAt: "2024-01-01T00:01:00.000Z" };
        await store.updateStep(updatedStep);
        const reloaded = await store.getStep("step-1");
        assertions.push(assertEqual("step status updated", reloaded?.status, "running"));
        assertions.push(assertEqual("step startedAt updated", reloaded?.startedAt, "2024-01-01T00:01:00.000Z"));
      }

      // Operator event
      await store.appendOperatorEvent(makeTestOpEvent("op-1", "flow-1", "step-1", "operator-paused"));
      const opEvents = await store.listOperatorEvents("flow-1");
      assertions.push(assertEqual("operator event appended", opEvents.length, 1));

      // Lock lifecycle
      const acquired = await store.acquireLock("flow-1", "worker-1", 5000);
      assertions.push(assertTrue("lock acquired", acquired));
      const lock = await store.getLock("flow-1");
      assertions.push(assertEqual("lock owner", lock?.ownerId, "worker-1"));
      await store.releaseLock("flow-1", "worker-1");
      const afterRelease = await store.getLock("flow-1");
      assertions.push(assertTrue("lock released", afterRelease === null));

      // Checkpoint
      await store.createCheckpoint(makeTestCheckpoint("cp-1", "flow-1"));
      const cp = await store.getCheckpoint("cp-1");
      assertions.push(assertTrue("checkpoint round-trip", cp !== null));
      assertions.push(assertEqual("checkpoint flowId", cp?.flowId, "flow-1"));

      sessionDb.close();
    } finally {
      try { rmSync(dbPath); } catch { /* ignore */ }
    }

    return buildResult("taskflow-atomicity", "SQLiteTaskFlowStore atomic transitions and round-trip integrity", assertions, Date.now() - startedAt);
  }
};

function makeTestFlow(id: string) {
  return {
    id,
    sessionId: "session-1",
    status: "pending" as const,
    intent: {
      nativeIntent: "general" as const,
      labels: ["test"],
      confidence: 1,
      suggestedToolsets: [],
      suggestedSkills: [],
      confirmationRequired: false,
      evidence: [],
      rationale: "test"
    },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    checkpointCount: 0,
    stepCount: 0,
    retryCount: 0,
    metadata: {}
  };
}

function makeTestStep(id: string, flowId: string, index: number) {
  return {
    id,
    flowId,
    index,
    status: "pending" as const,
    name: `step-${index}`,
    description: "test step",
    toolPlans: [],
    executions: [],
    retryPolicy: { maxAttempts: 1, backoffMs: 0, backoffMultiplier: 1, retryableFailureClasses: [], nonRetryableFailureClasses: [], requireIdempotent: true },
    retryCount: 0,
    maxRetries: 1,
    idempotent: false,
    safeToRetry: false,
    failurePolicy: { defaultAction: "stop" as const, stopOnNonRetryable: true, allowSkipIfSkippable: false },
    attemptNumber: 1,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z"
  };
}

function makeTestEvent(id: string, flowId: string, stepId: string, kind: string) {
  return { id, flowId, stepId, kind: kind as FlowEvent["kind"], data: { test: true }, timestamp: "2024-01-01T00:00:00.000Z" };
}

function makeTestOpEvent(id: string, flowId: string, stepId: string, kind: string) {
  return { id, flowId, stepId, kind: kind as OperatorEvent["kind"], operator: "test", command: "/pause", effect: "paused", previousState: "running" as Flow["status"] | FlowStep["status"], newState: "paused" as Flow["status"] | FlowStep["status"], timestamp: "2024-01-01T00:00:00.000Z" };
}

function makeTestCheckpoint(id: string, flowId: string) {
  return {
    id,
    flowId,
    name: "test-cp",
    snapshot: {
      flowState: "pending" as const,
      stepStates: {},
      pendingApprovals: [],
      waitReasons: {},
      operatorEvents: [],
      retryCounts: {}
    },
    createdAt: "2024-01-01T00:00:00.000Z",
    createdBy: "test"
  };
}
