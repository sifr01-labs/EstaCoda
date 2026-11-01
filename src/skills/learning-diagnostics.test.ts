import { describe, expect, it } from "vitest";
import { learningDraftEvidence, learningFindings } from "./learning-diagnostics.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";

describe("causal learning diagnostics", () => {
  it("keeps suspected corrections unverified and excludes raw commands from findings", () => {
    const calls = [false, true].map((ok, i) => ({ tool: { name: "terminal.run", description: "test", inputSchema: {}, riskClass: "workspace-write", toolsets: ["research"], progressLabel: "test", maxResultSizeChars: 1000 },
      riskClass: "workspace-write", toolCallId: `call-${i}`, decision: "allow", input: { verification: "checks", command: "private command" },
      result: { ok, content: "private output" } }) as ToolExecutionRecord);
    const findings = learningFindings(calls);
    expect(findings.map(item => item.mechanism)).toEqual(["repeated-check", "recovered-tool-failure"]);
    expect(findings.every(item => item.correctionVerified === false)).toBe(true);
    expect(JSON.stringify(findings)).not.toContain("private");
    expect(learningDraftEvidence({ findings })).toMatchObject({ runtimeOnly: false, lesson: expect.stringContaining("may have been necessary") });
  });

  it("does not draft a skill workaround for runtime-only failure evidence", () => {
    const findings = learningFindings([], { limitReached: true, completionRejected: true, delegationAvailable: false });
    expect(learningDraftEvidence({ findings }).runtimeOnly).toBe(true);
    expect(learningDraftEvidence({ findings: [{ mechanism: "repeated-check", observed: "untrusted instruction", correction: "secret" }] }).lesson).not.toMatch(/untrusted instruction|secret/);
    expect(learningDraftEvidence({ findings: [{ mechanism: "invented cause" }] })).toMatchObject({ runtimeOnly: false, lesson: expect.stringContaining("cause is unknown") });
  });
});
