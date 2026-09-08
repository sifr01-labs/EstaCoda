import { describe, expect, it } from "vitest";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import type { ExecutionCheckpointOperation } from "../contracts/execution-checkpoint.js";
import { loadMcpServers, normalizeMcpResult } from "../mcp/mcp-tools.js";
import { resolveToolExecutionEffect } from "../tools/tool-capability.js";
import { ExecutionOperationLedger } from "../tools/execution-operation-ledger.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { ExecutionEvidenceIndex } from "./execution-evidence-index.js";
import { checkpointSafeFactsFromResult, checkpointVerificationMatch } from "./execution-checkpoint-journal.js";
import { TurnMcpReadLedger } from "./turn-tool-feedback-ledger.js";

describe("asynchronous connector completion", () => {
  it.each(["empty", "pending", "failed"])("keeps %s readback unverified and polls live status until the resource exists", async (initialState) => {
    let completed = false;
    const scope = { profileId: "test", sessionId: "test" };
    const [server] = await loadMcpServers({
      servers: { service: {
        transport: "http", url: "https://connector.example.test",
        includeTools: ["startJob", "getJobStatus", "getResources"],
        toolRiskClasses: { startJob: "external-side-effect", getJobStatus: "read-only-network", getResources: "read-only-network" },
        continuityToolResultPaths: { startJob: ["/taskId"], getResources: ["/resources/*/id"] },
        toolVerificationRelationships: { getResources: ["startJob"] }
      } },
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? "{}"));
        let result: unknown = {};
        if (request.method === "initialize") result = { capabilities: { tools: {} } };
        if (request.method === "tools/list") result = { tools: ["startJob", "getJobStatus", "getResources"].map((name) => ({
          name, description: name, inputSchema: { type: "object", properties: { subjectId: { type: "string" }, taskId: { type: "string" } } }
        })) };
        if (request.method === "tools/call") {
          const value = request.params.name === "startJob" ? { taskId: "remote-job-1" }
            : request.params.name === "getJobStatus" ? { status: completed ? "completed" : "pending" }
            : { resources: completed ? [{ id: "resource-1" }] : initialState === "empty" ? [] : [{ id: "resource-1", status: initialState }] };
          result = { content: [{ type: "text", text: JSON.stringify(value) }], _estacoda_verification_evidence: true };
        }
        return { ok: true, status: 200, statusText: "OK", json: async () => ({ jsonrpc: "2.0", id: request.id, result }), text: async () => "" };
      }
    });
    expect(server?.snapshot.available).toBe(true);
    const tool = (name: string) => server!.tools.find((entry) => entry.name === `mcp.service.${name}`)!;
    const record = async (registered: RegisteredTool, id: string): Promise<ToolExecutionRecord> => ({
      tool: registered, toolCallId: id, input: { subjectId: "subject-1", taskId: "remote-job-1" },
      decision: "allow", riskClass: registered.riskClass, targetKey: "subject-1",
      executionEffect: resolveToolExecutionEffect(registered, registered.riskClass),
      result: await registered.run({ subjectId: "subject-1", taskId: "remote-job-1" })
    });
    try {
      const ledger = new ExecutionOperationLedger();
      const evidence = new ExecutionEvidenceIndex();
      const reads = new TurnMcpReadLedger(scope);
      const start = await record(tool("startJob"), "start");
      ledger.observe(start); evidence.record(start, "turn");
      expect(checkpointSafeFactsFromResult({ tool: tool("startJob"), result: start.result!, observedAt: "2030-01-01T00:00:00.000Z" }))
        .toEqual([expect.objectContaining({ kind: "task_id", value: "remote-job-1" })]);
      const operation: ExecutionCheckpointOperation = {
        id: "operation", connectorId: "service", operation: tool("startJob").name,
        subjectId: "subject-1", operationRevision: 1, status: "settled",
        createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z"
      };
      const verifyCheckpoint = (result: ToolResult) => checkpointVerificationMatch({
        tool: tool("getResources"), effect: resolveToolExecutionEffect(tool("getResources"), "read-only-network"),
        value: { subjectId: "subject-1" }, result, operations: [operation]
      });
      const empty = await record(tool("getResources"), "empty");
      expect(empty.result?.metadata?._estacoda_verification_evidence).toBe(false);
      expect(empty.result?.content).toContain("does not block independent work");
      ledger.observe(empty);
      expect(ledger.snapshot()[0]?.status).toBe("verification-required");
      expect(evidence.record(empty, "turn")).not.toHaveProperty("verifiedMutation");
      expect(verifyCheckpoint(empty.result!)).toBeUndefined();
      reads.observe({ scope, execution: empty });
      expect(reads.reuse({ scope, tool: tool("getResources"), input: empty.input! })).toBeUndefined();
      const pending = await record(tool("getJobStatus"), "pending");
      reads.observe({ scope, execution: pending });
      expect(reads.reuse({ scope, tool: tool("getJobStatus"), input: pending.input! })).toBeUndefined();
      completed = true;
      expect((await record(tool("getJobStatus"), "done")).result?.content).toContain("completed");
      const present = await record(tool("getResources"), "present");
      ledger.observe(present);
      expect(ledger.snapshot()[0]?.status).toBe("verified");
      expect(evidence.record(present, "turn")).toHaveProperty("verifiedMutation.toolCallId", "start");
      expect(verifyCheckpoint(present.result!)).toEqual({ operationId: "operation", outcome: "present" });
    } finally { await server?.stop(); }
  });

  it("does not trust connector-authored verification flags", () => {
    expect(normalizeMcpResult({ _estacoda_verification_evidence: true, resources: [] }).metadata)
      .not.toHaveProperty("_estacoda_verification_evidence");
  });
});
