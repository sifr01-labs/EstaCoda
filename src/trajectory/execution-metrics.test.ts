import { it, expect } from "vitest";
import { TrajectoryRecorder } from "./trajectory-recorder.js";
it("counts dispatched attempts once, preserves unknown usage and emits bounded content-free metrics", () => {
  const r = new TrajectoryRecorder({ profileId: "p", sessionId: "s", modelId: "m" });
  r.bindExecution({ definitionRevision: "a".repeat(64), authorityRevision: "b".repeat(64) });
  r.record("provider-completion", { attempts: [{ state: "preflight" }, { state: "dispatched", usage: { totalTokens: 12 } }, { state: "dispatched" }], usage: { totalTokens: 12 }, private: "secret" });
  r.record("tool-approval-requested", { tool: "test" }); r.record("tool-gated", { decision: "deny" });
  r.record("tool-result", { result: { ok: false, content: "secret" } });
  r.complete({ success: true, summary: "secret" });
  const s = r.snapshot();
  expect(s.executionMetrics).toMatchObject({ providerDispatches: 2, reportedTokens: 12, usageReports: 1, approvalRequests: 1, deniedTools: 1, failedTools: 1, completedTurns: 1 });
  expect(JSON.stringify(s.executionMetrics)).not.toContain("secret");
  s.executionReferences!.authorityRevision = "changed";
  r.bindExecution({ definitionRevision: "/private/path", authorityRevision: "secret" });
  expect(r.snapshot().executionReferences!.authorityRevision).toBe("b".repeat(64));
  r.record("provider-completion", { attempts: [{ state: "dispatched", usage: { totalTokens: Number.POSITIVE_INFINITY } }, { state: "dispatched", usage: { totalTokens: 1e15 } }] });
  expect(r.snapshot().executionMetrics!.reportedTokens).toBe(1e9);
  expect(r.compress().evaluationSignals.executionMetrics).toBeDefined();
});
