import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import { SQLiteSessionDB } from "../../session/sqlite-session-db.js";
import { SQLiteWorkflowStore } from "../../workflow/sqlite-workflow-store.js";
import { assertTrue, assertEqual, buildResult } from "../eval-runner.js";
import { rmSync } from "node:fs";

export const taskflowMigrationCase: EvalCase = {
  id: "taskflow-migration",
  name: "schema migration creates workflow tables and sets version",
  description: "SQLiteSessionDB introduces schema_version and workflow persistence tables on first open.",
  tags: ["taskflow", "migration", "deterministic"],
  run: async (): Promise<EvalResult> => {
    const startedAt = Date.now();
    const dbPath = `/tmp/estacoda-eval-migration-${Date.now()}.db`;
    const assertions = [];

    try {
      // Fresh DB
      const sessionDb = new SQLiteSessionDB({ path: dbPath });

      // schema_version should include all workflow persistence migrations.
      const versionRow = sessionDb.db
        .query<{ version: number | null }>("select max(version) as version from schema_version")
        .get();
      assertions.push(assertEqual("schema_version is 6", versionRow?.version, 6));

      const tables = sessionDb.db
        .query<{ name: string }>("select name from sqlite_master where type='table'")
        .all()
        .map((r) => r.name);
      for (const table of LEGACY_WORKFLOW_TABLES) {
        assertions.push(assertTrue(`${table} table absent`, !tables.includes(table)));
      }
      for (const table of WORKFLOW_TABLES) {
        assertions.push(assertTrue(`${table} table exists`, tables.includes(table)));
      }

      const indexes = sessionDb.db
        .query<{ name: string }>("select name from sqlite_master where type='index'")
        .all()
        .map((r) => r.name);
      for (const index of LEGACY_WORKFLOW_INDEXES) {
        assertions.push(assertTrue(`${index} absent`, !indexes.includes(index)));
      }
      for (const index of WORKFLOW_INDEXES) {
        assertions.push(assertTrue(`${index} exists`, indexes.includes(index)));
      }

      // Store can write and read a workflow run.
      const store = new SQLiteWorkflowStore({ db: sessionDb.db });
      const flow = makeTestFlow("flow-1");
      await store.createWorkflowRun(flow);
      const retrieved = await store.getWorkflowRun("flow-1");
      assertions.push(assertTrue("flow round-trip", retrieved !== null));
      assertions.push(assertEqual("flow sessionId", retrieved?.sessionId, flow.sessionId));
      assertions.push(assertEqual("flow status", retrieved?.status, flow.status));

      sessionDb.close();
    } finally {
      try { rmSync(dbPath); } catch { /* ignore */ }
    }

    return buildResult("taskflow-migration", "schema migration creates workflow tables and sets version", assertions, Date.now() - startedAt);
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
