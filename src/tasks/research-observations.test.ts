import { describe, it, expect } from "vitest";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { researchObservationResult, parseResearchObservations, isResearchObservationResult, RESEARCH_OBSERVATIONS_MIME } from "./research-observations.js";

function call(name: string, content: string, metadata: Record<string, unknown> = {}): ToolExecutionRecord {
  return { tool: { name }, toolCallId: name, riskClass: "read-only-local", decision: "allow",
    input: { path: "src/policy.ts" }, result: { ok: true, content, metadata } } as unknown as ToolExecutionRecord;
}
function packet(calls: ToolExecutionRecord[]) { return parseResearchObservations(String(researchObservationResult(calls)[0]?.content)); }

describe("runtime source observations", () => {
  it("preserves source excerpts separately from a settled failed check without marking it passing", () => {
    const failed = { ...call("terminal.run", "113 tests passed; policy failed to load: missing zod", { code: 1, signal: null, timedOut: false, cancelled: false }),
      input: { command: "vitest run", verification: "prototype-checks" }, riskClass: "workspace-write" as const,
      settlement: { dispatchState: "finished", sideEffectState: "confirmed" }, result: { ok: false, content: "113 tests passed; policy failed to load: missing zod", metadata: { code: 1, signal: null, timedOut: false, cancelled: false } } } as unknown as ToolExecutionRecord;
    const result = packet([call("file.read", "export function authorize() {}"), failed])!;
    expect(result.observations.map(o => o.reference)).toEqual(["src/policy.ts", "check:prototype-checks"]);
    expect(result.observations[1]?.exitCode).toBe(1);
    expect(result.unresolvedChecks).toEqual(["prototype-checks"]);
    expect(result.notice).toContain("not instructions");
  });
  it("excludes denied, failed, private-path and uncertain reads and preserves snippet limitations", () => {
    const denied = { ...call("file.read", "denied bytes"), decision: "deny" as const };
    const failed = { ...call("file.read", "failed bytes"), result: { ok: false, content: "failed bytes" } };
    const privatePath = { ...call("file.read", "private bytes"), input: { path: "/private/secret" } };
    const search = { ...call("web.search", "", { results: [{ url: "https://example.com", title: "Title", snippet: "Only a snippet" }] }), riskClass: "read-only-network" as const };
    const result = packet([denied, failed, privatePath, search])!;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ reference: "https://example.com/", tool: "web.search" });
  });
  it("sanitizes before bounding, retains extents, and never copies worker claims", () => {
    const result = packet([call("file.read", `password: hunter2\n${"content ".repeat(1000)}`)])!;
    expect(result.observations[0]?.excerpt).not.toContain("hunter2");
    expect(result.observations[0]?.truncated).toBe(true);
    expect(result.observations[0]?.excerpt.length).toBeLessThanOrEqual(2400);
    expect(packet(Array.from({ length: 36 }, () => call("file.read", "source")))?.omittedObservations).toBe(4);
  });
  it("does not recognize model artifacts or ordinary model JSON as host observations", () => {
    for (const [kind, mimeType] of [["artifact", RESEARCH_OBSERVATIONS_MIME], ["json", "application/json"]]) {
      expect(isResearchObservationResult({ status: "available", disposition: "diagnostic", kind, mimeType } as never)).toBe(false);
    }
  });
});
