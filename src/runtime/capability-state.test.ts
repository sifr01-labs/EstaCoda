import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { ProviderToolSchemaCatalog } from "../tools/tool-schema.js";
import { toolResultStats } from "./tool-plan-runner.js";
import { correctContradictedCapabilityClaim, projectCapabilityState, renderCapabilityState, researchRecoveryGuidance } from "./capability-state.js";
const catalog = { inventory: [{ name: "browser.status", availability: "available", schemaEligible: true },
  { name: "web.search", availability: "temporarily_unavailable", schemaEligible: true },
  { name: "file.write", availability: "available", schemaEligible: false }], entries: [], aliases: new Map([["browser_status", "browser.status"]]), tools: [] } as unknown as ProviderToolSchemaCatalog;
const exposed = [{ type: "function" as const, function: { name: "browser_status", description: "", parameters: {} } }];
function record(name = "browser.status", available = true): ToolExecutionRecord {
  return { tool: { name, description: name, inputSchema: {}, riskClass: "read-only-network", toolsets: ["core"], progressLabel: name, maxResultSizeChars: 1000 }, riskClass: "read-only-network", toolCallId: "owned", decision: "allow", result: { ok: true, content: "private body", metadata: { available, endpoint: "private endpoint" } } } as ToolExecutionRecord;
}
describe("current capability evidence", () => {
  it("marks only reviewed retrieval failures as recoverable channel activity", () => {
    const failure = { ...record("web.extract"), result: { ok: false, content: "fetch failed", metadata: { reason: "fetch-failed" } } };
    expect(toolResultStats(failure).recoverableReadFailure).toBe(true);
    expect(toolResultStats({ ...failure, decision: "deny" }).recoverableReadFailure).toBeUndefined();
    for (const reason of ["unsafe-url", "website-policy", "secret-in-url", "unknown"]) {
      expect(toolResultStats({ ...failure, result: { ...failure.result, metadata: { reason } } }).recoverableReadFailure).toBeUndefined();
    }
  });
  it("nudges repeated unproductive reads while preserving denials and productive investigation", () => {
    const failure = { ...record("web.extract"), result: { ok: false, content: "failed", metadata: { reason: "fetch-failed" } } };
    expect(researchRecoveryGuidance([failure])).toBeUndefined();
    expect(researchRecoveryGuidance([failure, failure])).toContain("capability.discover once");
    expect(researchRecoveryGuidance([failure, record("web.extract"), failure])).toContain("actual links");
    expect(researchRecoveryGuidance([failure, { ...failure, decision: "deny" }])).toBeUndefined();
    expect(researchRecoveryGuidance([failure, { ...failure, result: { ok: false, content: "blocked", metadata: { reason: "website-policy" } } }])).toBeUndefined();
    expect(researchRecoveryGuidance([failure, failure, record("web.extract")])).toBeUndefined();
    const state = projectCapabilityState({ catalog, exposed, executions: [failure] });
    expect(state.find(item => item.tool === "web.search")?.readiness).toBe("catalog_unavailable");
  });
  it("separates catalog readiness, exposure and action observations without copying sensitive results", () => {
    const state = projectCapabilityState({ catalog, exposed, executions: [record()], required: ["web.search", "file.write"] });
    expect(state).toEqual([
      { tool: "browser.status", exposure: "exposed", readiness: "observed_available", observation: "reported_available" },
      { tool: "web.search", exposure: "not_selected", readiness: "catalog_unavailable" },
      { tool: "file.write", exposure: "provider_restricted", readiness: "registered; execution readiness unverified" }
    ]);
    const rendered = renderCapabilityState(state)!;
    expect(rendered).toContain("Current tool observations supersede");
    expect(rendered).toContain("do not browse");
    expect(rendered).not.toContain("private");
  });
  it("uses the latest call, keeps denial distinct, and does not treat status success as availability", () => {
    expect(projectCapabilityState({ catalog, exposed, executions: [record(), record("browser.status", false)] })[0]).toMatchObject({ readiness: "observed_unavailable" });
    expect(projectCapabilityState({ catalog, exposed, executions: [{ ...record(), decision: "deny" }] })[0]).toMatchObject({ observation: "action_deny", readiness: "registered; execution readiness unverified" });
    expect(projectCapabilityState({ catalog, exposed: [], executions: [], required: ["not.in.session"] })).toEqual([]);
  });
  it.each(["I cannot browse.", "Browser tools are unavailable.", "لا أستطيع التصفح"])("corrects a direct contradicted claim: %s", (text) => {
    expect(correctContradictedCapabilityClaim(text, [record()], catalog)).toContain("current browser status reports an available backend");
  });
  it("preserves user preferences, scoped failures, newer denials and provider restrictions", () => {
    for (const text of ["Do not browse", "I cannot browse that private site.", '> "Browser tools are unavailable."']) expect(correctContradictedCapabilityClaim(text, [record()], catalog)).toBeUndefined();
    expect(correctContradictedCapabilityClaim("I cannot browse", [record(), { ...record("browser.navigate"), decision: "deny" }], catalog)).toBeUndefined();
    expect(correctContradictedCapabilityClaim("I cannot browse", [record("browser.status", false)], catalog)).toBeUndefined();
    expect(correctContradictedCapabilityClaim("I cannot browse", [{ ...record(), toolCallId: undefined }], catalog)).toBeUndefined();
    const restricted = { ...catalog, inventory: catalog.inventory.map((entry) => ({ ...entry, schemaEligible: false })) };
    expect(correctContradictedCapabilityClaim("I cannot browse", [record()], restricted)).toBeUndefined();
  });
});
