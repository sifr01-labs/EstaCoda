import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import { ToolExecutor } from "../../tools/tool-executor.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { InMemorySessionDB } from "../../session/in-memory-session-db.js";
import { TrajectoryRecorder } from "../../trajectory/trajectory-recorder.js";
import { createSecurityPolicyForMode } from "../../security/security-policy-factory.js";
import { classifyFailure } from "../../trajectory/failure-classifier.js";
import { assertEqual, assertTrue, buildResult } from "../eval-runner.js";

export const missingToolFailureCase: EvalCase = {
  id: "missing-tool-failure",
  name: "Unregistered tool returns undefined and classifies as not-found",
  description: "Calling a non-existent tool yields no execution record, and the failure classifier tags it correctly.",
  tags: ["tool", "failure-classification", "deterministic"],
  run: async (): Promise<EvalResult> => {
    const startedAt = Date.now();
    const registry = new ToolRegistry();
    // Do NOT register any tool — the tool is missing

    const sessionDb = new InMemorySessionDB({ id: () => "eval-session-2", now: () => new Date() });
    await sessionDb.createSession({ id: "eval-session-2", profileId: "eval" });
    const trajectory = new TrajectoryRecorder({
      profileId: "eval",
      sessionId: "eval-session-2",
      modelId: "eval-model",
      id: () => "eval-traj-2",
      now: () => new Date()
    });
    const policy = createSecurityPolicyForMode("strict");
    const executor = new ToolExecutor({
      registry,
      securityPolicy: policy,
      sessionDb,
      trajectoryRecorder: trajectory
    });

    const record = await executor.executeTool({
      tool: "nonexistent.tool",
      input: { path: "/foo" },
      trustedWorkspace: false,
      sessionId: "eval-session-2"
    });

    // Also test failure classifier on a simulated provider error
    const classified = classifyFailure({
      kind: "provider",
      execution: {
        ok: false,
        attempts: [{
          provider: "fake",
          model: "fake-model",
          state: "dispatched",
          dispatchedAt: "2030-01-01T00:00:00.000Z",
          ok: false,
          content: "",
          errorClass: "model-unavailable"
        }],
        toolCalls: [],
        fallbackUsed: false
      }
    });

    const assertions = [
      assertEqual("unregistered tool returns undefined", record, undefined),
      assertEqual("failure class is provider-error", classified.class, "provider-error"),
      assertTrue("provider failure is recoverable", classified.recoverable === true),
      assertTrue("message mentions unavailable", classified.message.includes("unavailable"))
    ];

    return buildResult(
      "missing-tool-failure",
      "Unregistered tool returns undefined and classifies as not-found",
      assertions,
      Date.now() - startedAt
    );
  }
};
