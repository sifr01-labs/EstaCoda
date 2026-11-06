import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { recoverableDraft } from "./recoverable-draft.js";
const call = (riskClass: string, decision = "allow", sideEffectState?: string) => ({ riskClass, decision, result: { ok: true },
  ...(sideEffectState ? { settlement: { sideEffectState, dispatchState: "finished" } } : {}) }) as ToolExecutionRecord;
describe("unaccepted draft disclosure", () => {
  it("retains qualified findings from settled exploration and removes reasoning and credentials", () => {
    const draft = recoverableDraft('<think>private reasoning</think>Observed tests passed. API_KEY=sk-test123456789012345678901234567890. Broader checks did not run.',
      [call("read-only-local"), call("workspace-write", "allow", "confirmed")]);
    expect(draft).toContain("Broader checks did not run");
    expect(draft).not.toContain("private reasoning"); expect(draft).not.toContain("sk-test123456789012345678901234567890");
  });
  it.each([call("credential-access"), call("external-side-effect"), call("workspace-write")])("withholds privileged output and missing execution receipts", execution => {
    expect(recoverableDraft("draft", [call("read-only-local"), execution])).toBeUndefined();
  });
  it("preserves sanitized local diagnostics without resolving uncertain effects", () => {
    const execution = call("workspace-write", "allow", "possible");
    expect(recoverableDraft("Observed source finding.", [call("read-only-local"), execution])).toContain("local execution effects remain uncertain");
    expect(execution.settlement?.sideEffectState).toBe("possible");
    execution.settlement!.dispatchState = "started";
    expect(recoverableDraft("draft", [execution])).toBeUndefined();
  });
  it("does not disclose denied-only work, but preserves unrelated allowed observations", () => {
    expect(recoverableDraft("draft", [call("read-only-local", "deny")])).toBeUndefined();
    expect(recoverableDraft("draft", [call("read-only-local", "deny"), call("read-only-local")])).toBe("draft");
  });
});
