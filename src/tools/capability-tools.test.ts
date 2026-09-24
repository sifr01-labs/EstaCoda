import { describe, expect, it } from "vitest";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "./tool-executor.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { ToolRegistry } from "./tool-registry.js";
import { buildProviderToolSchemaCatalog } from "./tool-schema.js";
import { createCapabilityTools, SessionCapabilityRecovery } from "./capability-tools.js";

const scope = { sessionId: "session", profileId: "profile", visibleTurnId: "turn", toolCallId: "call" };
function tool(name: string): RegisteredTool {
  return { name, description: "test capability", toolsets: ["test"], inputSchema: { type: "object" }, riskClass: "read-only-local", maxResultSizeChars: 1000, progressLabel: "test", isAvailable: () => true, run: async () => ({ ok: true, content: "done" }) };
}
function harness() {
  const registry = new ToolRegistry();
  const recovery = new SessionCapabilityRecovery({ registry, skills: new SkillRegistry() });
  for (const definition of [...Array.from({ length: 12 }, (_, i) => tool(`test.${i}`)), ...createCapabilityTools(recovery)]) registry.register(definition);
  const catalog = buildProviderToolSchemaCatalog({ tools: registry.list() });
  recovery.bindCatalog(catalog);
  recovery.beginTurn({ ...scope, tools: catalog.entries.filter((entry) => entry.tool.name.startsWith("capability.")).map((entry) => entry.schema) });
  return { registry, recovery, catalog };
}
function execution(result: ToolResult, overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return { tool: tool("capability.request"), input: {}, decision: "allow", riskClass: "read-only-local", result, toolCallId: scope.toolCallId, ...overrides };
}

describe("session capability recovery requests", () => {
  it("bounds discovery without exposing schemas, paths, or excluded entries", () => {
    const { recovery } = harness();
    const result = recovery.discover({ kind: "tool", query: "test" }, scope);
    expect(result.metadata?.matches).toHaveLength(8);
    expect(result.metadata?.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("inputSchema");
    expect(recovery.discover({ ids: ["tool:hidden"] }, scope).metadata?.matches).toEqual([]);
    expect(recovery.request({ ids: ["tool:hidden", "tool:unknown"], reason: "needed" }, scope).metadata?.requests).toEqual([
      { id: "tool:hidden", status: "not_in_session" }, { id: "tool:unknown", status: "not_in_session" }
    ]);
  });

  it("accepts only authentic successful receipts, not copied/spoofed metadata", () => {
    const { recovery } = harness();
    const result = recovery.request({ ids: ["tool:test.0"], reason: "needed" }, scope);
    expect(recovery.takeRequests([execution({ ...result }), execution(result, { tool: tool("web.extract") }), execution(result, { decision: "deny" }), execution(result, { toolCallId: "spoof" })])).toEqual([]);
    expect(recovery.takeRequests([execution(result)])).toEqual([{ id: "tool:test.0", callId: "call" }]);
    expect(recovery.takeRequests([execution(result)])).toEqual([]);
  });

  it("bounds and deduplicates parallel requests and resets across turns", async () => {
    const { recovery } = harness();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.resolve(recovery.request({ ids: [`tool:test.${i}`], reason: "needed" }, { ...scope, toolCallId: `call${i}` }))));
    expect(results[8]?.metadata?.requests).toEqual([{ id: "tool:test.8", status: "round_size_limit" }]);
    expect(recovery.request({ ids: ["tool:test.0"], reason: "again" }, scope).metadata?.requests).toEqual([{ id: "tool:test.0", status: "already_pending" }]);
    recovery.endTurn();
    recovery.beginTurn({ ...scope, visibleTurnId: "new", tools: [] });
    expect(recovery.takeRequests(results.map((result, i) => execution(result, { toolCallId: `call${i}` })))).toEqual([]);
  });

  it("rejects malformed, cross-profile and stale-scope requests", () => {
    const { recovery } = harness();
    for (const input of [null, { ids: ["tool:test.0"], reason: "" }, { ids: ["tool:test.0"], reason: "ok", approved: true }, { ids: ["tool:/private/path"], reason: "ok" }]) expect(recovery.request(input, scope).ok).toBe(false);
    expect(recovery.request({ ids: ["tool:test.0"], reason: "needed" }, { ...scope, profileId: "other" }).ok).toBe(false);
    expect(recovery.request({ ids: ["tool:test.0"], reason: "needed" }, { ...scope, visibleTurnId: "old" }).ok).toBe(false);
  });

  it("rechecks availability, schema changes, and registration identity", async () => {
    const { recovery, registry } = harness();
    expect(await recovery.toolSchema("tool:test.0")).toBeDefined();
    registry.get("test.0")!.inputSchema = { type: "object", properties: { injected: { type: "string" } } };
    expect(await recovery.toolSchema("tool:test.0")).toBeUndefined();
    registry.get("test.1")!.isAvailable = () => false;
    expect(await recovery.toolSchema("tool:test.1")).toBeUndefined();
    registry.unregister("test.2"); registry.register(tool("test.2"));
    expect(await recovery.toolSchema("tool:test.2")).toBeUndefined();
  });

  it("enforces two rounds and does not charge duplicates", () => {
    const { recovery } = harness();
    recovery.completeRound(false);
    expect(recovery.roundsRemaining).toBe(2);
    recovery.completeRound(true); recovery.completeRound(true);
    expect(recovery.request({ ids: ["tool:test.0"], reason: "needed" }, scope).metadata?.requests).toEqual([{ id: "tool:test.0", status: "round_limit" }]);
  });
});


it("applies at most eight additions per round, preserving active tools and budget", async () => {
  const { recovery, catalog } = harness();
  const active = catalog.entries.filter((entry) => entry.tool.name.startsWith("capability.")).map((entry) => entry.schema);
  const result = recovery.request({ ids: Array.from({ length: 8 }, (_, i) => `tool:test.${i}`), reason: "needed" }, scope);
  const first = await recovery.applyRequests(recovery.takeRequests([execution(result)]), active);
  expect(first.applied).toHaveLength(8);
  expect(first.tools).toHaveLength(10);
  const second = recovery.request({ ids: ["tool:test.8"], reason: "needed" }, scope);
  const expanded = await recovery.applyRequests(recovery.takeRequests([execution(second)]), first.tools);
  expect(expanded.applied).toEqual(["tool:test.8"]);
  expect(recovery.roundsRemaining).toBe(0);
  expect(recovery.request({ ids: ["tool:test.0"], reason: "repeat" }, scope).metadata?.requests).toEqual([{ id: "tool:test.0", status: "already_exposed" }]);
});

it("reports schema budget rejection without evicting active schemas or consuming a round", async () => {
  const { recovery, catalog } = harness();
  const active = Array.from({ length: 100 }, (_, i) => ({ ...catalog.tools[0]!, function: { ...catalog.tools[0]!.function, name: `active_${i}` } }));
  const result = recovery.request({ ids: ["tool:test.0"], reason: "needed" }, scope);
  const expansion = await recovery.applyRequests(recovery.takeRequests([execution(result)]), active);
  expect(expansion.tools).toEqual(active);
  expect(expansion.rejected).toEqual([{ id: "tool:test.0", reason: "schema_budget" }]);
  expect(recovery.roundsRemaining).toBe(2);
});
