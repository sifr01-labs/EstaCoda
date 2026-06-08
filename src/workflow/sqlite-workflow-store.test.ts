import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { SQLiteWorkflowStore } from "./sqlite-workflow-store.js";
import type { WorkflowRun, WorkflowEvent, WorkflowStep } from "./types.js";

describe("SQLiteWorkflowStore", () => {
  let tmpDir: string;
  let sessionDb: SQLiteSessionDB;
  let store: SQLiteWorkflowStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "estacoda-workflow-test-"));
    sessionDb = new SQLiteSessionDB({ path: join(tmpDir, "sessions.sqlite") });
    store = new SQLiteWorkflowStore({ db: sessionDb.db });
  });

  afterEach(() => {
    sessionDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the workflow schema without legacy flow tables or indexes", () => {
    const tables = new Set(
      sessionDb.db
        .query<{ name: string }>("select name from sqlite_master where type = 'table'")
        .all()
        .map((row) => row.name)
    );
    const indexes = new Set(
      sessionDb.db
        .query<{ name: string }>("select name from sqlite_master where type = 'index'")
        .all()
        .map((row) => row.name)
    );

    for (const table of LEGACY_WORKFLOW_TABLES) {
      expect(tables.has(table), `${table} should not exist`).toBe(false);
    }
    for (const table of WORKFLOW_TABLES) {
      expect(tables.has(table), `${table} should exist`).toBe(true);
    }
    for (const index of LEGACY_WORKFLOW_INDEXES) {
      expect(indexes.has(index), `${index} should not exist`).toBe(false);
    }
    for (const index of WORKFLOW_INDEXES) {
      expect(indexes.has(index), `${index} should exist`).toBe(true);
    }
  });

  it("commits atomic transitions through the internal SQLite adapter", async () => {
    await store.atomicTransition("flow-1", async (tx) => {
      await tx.createWorkflowRun(makeFlow("flow-1"));
      await tx.createWorkflowStep(makeStep("step-1", "flow-1"));
      await tx.appendWorkflowEvent(makeEvent("event-1", "flow-1", "step-1"));
    });

    await expect(store.getWorkflowRun("flow-1")).resolves.toMatchObject({ id: "flow-1" });
    await expect(store.getWorkflowStep("step-1")).resolves.toMatchObject({ id: "step-1" });
    await expect(store.listWorkflowEvents("flow-1")).resolves.toHaveLength(1);
  });

  it("rolls back failed atomic transitions through the internal SQLite adapter", async () => {
    await expect(
      store.atomicTransition("flow-2", async (tx) => {
        await tx.createWorkflowRun(makeFlow("flow-2"));
        await tx.createWorkflowStep(makeStep("step-2", "flow-2"));
        throw new Error("simulated failure");
      })
    ).rejects.toThrow("simulated failure");

    await expect(store.getWorkflowRun("flow-2")).resolves.toBeNull();
    await expect(store.getWorkflowStep("step-2")).resolves.toBeNull();
  });
});

function makeFlow(id: string): WorkflowRun {
  return {
    id,
    sessionId: "session-1",
    status: "pending",
    intent: {
      nativeIntent: "general",
      labels: ["test"],
      confidence: 1,
      suggestedToolsets: [],
      suggestedSkills: [],
      confirmationRequired: false,
      evidence: [],
      rationale: "test"
    },
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    checkpointCount: 0,
    stepCount: 0,
    retryCount: 0,
    metadata: {}
  };
}

function makeStep(id: string, flowId: string): WorkflowStep {
  return {
    id,
    flowId,
    index: 0,
    status: "pending",
    name: "test step",
    description: "test step",
    toolPlans: [],
    executions: [],
    retryPolicy: {
      maxAttempts: 1,
      backoffMs: 0,
      backoffMultiplier: 1,
      retryableFailureClasses: [],
      nonRetryableFailureClasses: [],
      requireIdempotent: true
    },
    retryCount: 0,
    maxRetries: 1,
    idempotent: false,
    safeToRetry: false,
    failurePolicy: {
      defaultAction: "stop",
      stopOnNonRetryable: true,
      allowSkipIfSkippable: false
    },
    attemptNumber: 1,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z"
  };
}

function makeEvent(id: string, flowId: string, stepId: string): WorkflowEvent {
  return {
    id,
    flowId,
    stepId,
    kind: "flow-created",
    data: { test: true },
    timestamp: "2030-01-01T00:00:00.000Z"
  };
}

const LEGACY_WORKFLOW_TABLES = [
  "flows",
  "flow_steps",
  "flow_events",
  "operator_events",
  "approval_gates",
  "checkpoints",
  "flow_locks",
  "flow_processes",
  "flow_artifacts",
  "flow_run_links",
  "compact_summaries"
];

const WORKFLOW_TABLES = [
  "workflow_runs",
  "workflow_steps",
  "workflow_events",
  "workflow_operator_events",
  "workflow_approval_gates",
  "workflow_checkpoints",
  "workflow_locks",
  "workflow_processes",
  "workflow_artifacts",
  "workflow_agent_run_links",
  "workflow_event_summaries"
];

const LEGACY_WORKFLOW_INDEXES = [
  "idx_flows_session",
  "idx_flows_status",
  "idx_flow_steps_flow",
  "idx_flow_steps_status",
  "idx_flow_events_flow",
  "idx_flow_events_step",
  "idx_operator_events_flow",
  "idx_checkpoints_flow",
  "idx_approval_gates_flow",
  "idx_approval_gates_step",
  "idx_flow_processes_flow",
  "idx_flow_locks_expires",
  "idx_compact_summaries_flow"
];

const WORKFLOW_INDEXES = [
  "idx_workflow_runs_session",
  "idx_workflow_runs_status",
  "idx_workflow_steps_flow",
  "idx_workflow_steps_status",
  "idx_workflow_events_flow",
  "idx_workflow_events_step",
  "idx_workflow_operator_events_flow",
  "idx_workflow_checkpoints_flow",
  "idx_workflow_approval_gates_flow",
  "idx_workflow_approval_gates_step",
  "idx_workflow_processes_flow",
  "idx_workflow_locks_expires",
  "idx_workflow_event_summaries_flow"
];
