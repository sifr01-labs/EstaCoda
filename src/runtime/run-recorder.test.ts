import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { RunRecorder } from "./run-recorder.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "estacoda-run-recorder-"));
  tempDirs.push(dir);
  return dir;
}

describe("RunRecorder", () => {
  it("persists the trajectory before saving a classified failure", async () => {
    const db = new SQLiteSessionDB({ path: join(makeTempDir(), "sessions.sqlite") });

    try {
      const session = await db.createSession({ id: "session-1", profileId: "default" });
      let idCounter = 0;
      const trajectoryRecorder = new TrajectoryRecorder({
        profileId: "default",
        sessionId: session.id,
        modelId: "test-model",
        id: () => `id-${++idCounter}`
      });
      trajectoryRecorder.record("user-input", { text: "please fetch a page" });

      const runRecorder = new RunRecorder({
        sessionDb: db,
        sessionId: session.id,
        trajectoryRecorder,
        trajectoryStore: db,
        profileId: "default"
      });

      await expect(runRecorder.recordClassifiedFailure({
        kind: "generic",
        error: new Error("fetch failed"),
        message: "fetch failed"
      }, "tool-execution")).resolves.toBeUndefined();

      const failures = await db.listFailuresForSession(session.id);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        sessionId: session.id,
        trajectoryId: trajectoryRecorder.trajectoryId,
        class: "unknown",
        message: "fetch failed"
      });

      const trajectory = await db.loadTrajectory(trajectoryRecorder.trajectoryId);
      expect(trajectory).toMatchObject({
        id: trajectoryRecorder.trajectoryId,
        sessionId: session.id,
        profileId: "default",
        modelId: "test-model"
      });
      expect(trajectory?.events.map((event) => event.kind)).toContain("user-input");
    } finally {
      db.close();
    }
  });
});
