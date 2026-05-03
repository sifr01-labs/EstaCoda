import { randomUUID } from "node:crypto";
import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import { InMemorySessionDB } from "../../session/in-memory-session-db.js";
import { TrajectoryRecorder } from "../../trajectory/trajectory-recorder.js";
import { RunRecorder } from "../../runtime/run-recorder.js";
import { assertEqual, buildResult } from "../eval-runner.js";

export const userCorrectionRecordingCase: EvalCase = {
  id: "user-correction-recording",
  name: "recordUserCorrection writes user-correction event",
  description: "RunRecorder.recordUserCorrection writes to session DB and trajectory",
  tags: ["trajectory", "session", "evolution"],
  run: async (): Promise<EvalResult> => {
    const startedAt = Date.now();
    const db = new InMemorySessionDB();
    const session = await db.createSession({ id: randomUUID(), profileId: "test" });
    const trajectoryRecorder = new TrajectoryRecorder({
      profileId: "test",
      sessionId: session.id,
      modelId: "test-model"
    });
    const runRecorder = new RunRecorder({
      sessionDb: db,
      sessionId: session.id,
      profileId: "test",
      trajectoryRecorder
    });

    await runRecorder.recordUserCorrection({
      skillName: "test-skill",
      correctionText: "Use bun test instead of jest",
      reason: "Project uses bun"
    });

    const events = await db.listEvents(session.id);
    const correctionEvents = events.filter((e) => e.kind === "user-correction");
    const event = correctionEvents[0] as {
      kind: "user-correction";
      correctionText: string;
      skillName?: string;
      reason?: string;
    } | undefined;

    const trajectoryEvents = trajectoryRecorder.snapshot().events;
    const trajCorrection = trajectoryEvents.filter((e) => e.kind === "user-correction");

    const assertions = [
      assertEqual("session event count", correctionEvents.length, 1),
      assertEqual("event correctionText", event?.correctionText, "Use bun test instead of jest"),
      assertEqual("event skillName", event?.skillName, "test-skill"),
      assertEqual("event reason", event?.reason, "Project uses bun"),
      assertEqual("trajectory event count", trajCorrection.length, 1)
    ];

    return buildResult(
      "user-correction-recording",
      "recordUserCorrection writes user-correction event",
      assertions,
      Date.now() - startedAt
    );
  }
};
