import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { TrajectoryRecorder } from "./trajectory-recorder.js";
import { executionObservations } from "./execution-observations.js";
it("retains bounded trajectory observations across database reopen without a schema change", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-observations-")), path = join(root, "sessions.sqlite");
  let db = new SQLiteSessionDB({ path });
  try {
    const session = await db.createSession({ id: "session", profileId: "default", title: "Observations" });
    const recorder = new TrajectoryRecorder({ profileId: "default", sessionId: session.id, modelId: "test" });
    recorder.bindExecution({ definitionRevision: "a".repeat(64), authorityRevision: "b".repeat(64) });
    recorder.record("tool-gated", { decision: "ask" });
    const trajectory = recorder.complete({ success: true, summary: "complete" });
    await db.saveTrajectory(trajectory); db.close(); db = new SQLiteSessionDB({ path });
    const loaded = (await db.loadTrajectory(trajectory.id))!;
    expect(loaded.executionMetrics).toEqual(trajectory.executionMetrics);
    expect(loaded.executionReferences).toEqual(trajectory.executionReferences);
    await db.saveTrajectory(loaded);
    expect((await db.loadTrajectory(trajectory.id))!.events.filter((event) => event.kind === "execution-observations")).toHaveLength(1);
    expect(executionObservations({ executionReferences: { definitionRevision: "/private/path", authorityRevision: "secret" }, executionMetrics: { version: 1, elapsedMs: Infinity } })).toEqual({});
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
