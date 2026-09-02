import { describe, expect, it } from "vitest";
import type { ExecutionCheckpointOperation } from "../contracts/execution-checkpoint.js";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import {
  checkpointOperationCoordinates,
  checkpointSafeFactsFromResult,
  checkpointVerificationMatch
} from "./execution-checkpoint-journal.js";

function tool(overrides: Partial<RegisteredTool> = {}): RegisteredTool {
  return {
    name: "mcp.postman.importSpec",
    description: "Import specification",
    inputSchema: { type: "object", properties: {} },
    riskClass: "external-side-effect",
    toolsets: ["mcp"],
    connector: { kind: "mcp", id: "postman" },
    progressLabel: "importing",
    maxResultSizeChars: 1_000,
    isAvailable: () => true,
    run: async (): Promise<ToolResult> => ({ ok: true, content: "done" }),
    ...overrides
  };
}

describe("execution checkpoint journal", () => {
  it("retains only fixed reviewed fact types and rejects secret-looking values", () => {
    const facts = checkpointSafeFactsFromResult({
      tool: tool({ name: "mcp.postman.getWorkspace" }),
      observedAt: "2030-01-01T00:00:00.000Z",
      result: {
        ok: true,
        content: "raw result",
        metadata: {
          _estacoda_continuity_facts: [
            { field: "workspaceId", value: "workspace-1", kind: "identifier" },
            { field: "productName", value: "Loans v2", kind: "label" },
            { field: "workspaceId", value: "api_key=sk-secret-1234567890", kind: "identifier" },
            { field: "unknownId", value: "unreviewed", kind: "identifier" }
          ]
        }
      }
    });

    expect(facts).toEqual([
      expect.objectContaining({ kind: "workspace_id", value: "workspace-1", connectorId: "postman" }),
      expect.objectContaining({ kind: "product_name", value: "Loans v2", connectorId: "postman" })
    ]);
  });

  it("does not derive durable operation identity from arbitrary tool arguments", () => {
    const input = {
      workspaceId: "workspace-1",
      collectionId: "collection-1",
      apiKey: "sk-secret-1234567890"
    };

    expect(checkpointOperationCoordinates({
      tool: tool(),
      effect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } },
      value: input
    })).toBeUndefined();
    expect(checkpointOperationCoordinates({
      tool: tool({ operationJournal: { identify: () => ({ destinationId: "password=hunter2" }) } }),
      effect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } },
      value: input
    })).toBeUndefined();
  });

  it("matches a verifier only to one pending operation with reviewed coordinates", () => {
    const operation: ExecutionCheckpointOperation = {
      id: "operation:1",
      connectorId: "postman",
      operation: "mcp.postman.importSpec",
      destinationId: "workspace-1",
      subjectId: "loans-v2",
      artifactHash: "a".repeat(64),
      operationRevision: 1,
      status: "uncertain",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:01.000Z"
    };
    const verifier = tool({
      name: "mcp.postman.getImportedSpec",
      riskClass: "read-only-network",
      capabilityMetadata: { verification: { verifies: [operation.operation] } },
      operationJournal: {
        identify: () => undefined,
        verify: () => ({
          destinationId: "workspace-1",
          subjectId: "loans-v2",
          artifactHash: "a".repeat(64),
          operationRevision: 1,
          outcome: "present"
        })
      }
    });

    expect(checkpointVerificationMatch({
      tool: verifier,
      effect: { kind: "verification", verifies: [operation.operation], connector: { kind: "mcp", id: "postman" } },
      value: {},
      result: { ok: true, content: "present" },
      operations: [operation]
    })).toEqual({ operationId: "operation:1", outcome: "present" });
    expect(checkpointVerificationMatch({
      tool: verifier,
      effect: { kind: "verification", verifies: [operation.operation], connector: { kind: "mcp", id: "postman" } },
      value: {},
      result: { ok: true, content: "ambiguous" },
      operations: [operation, { ...operation, id: "operation:2" }]
    })).toBeUndefined();

    const absenceVerifier = tool({
      ...verifier,
      operationJournal: {
        identify: () => undefined,
        verify: () => ({
          destinationId: "workspace-1",
          subjectId: "loans-v2",
          artifactHash: "a".repeat(64),
          outcome: "absent"
        })
      }
    });
    expect(checkpointVerificationMatch({
      tool: absenceVerifier,
      effect: { kind: "verification", verifies: [operation.operation], connector: { kind: "mcp", id: "postman" } },
      value: {},
      result: { ok: false, content: "lookup failed" },
      operations: [operation]
    })).toBeUndefined();
  });
});
