import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import type { MemoryInspector } from "./memory-inspector.js";

export function createKnowledgeMemoryTools(inspector: MemoryInspector | undefined): RegisteredTool[] {
  if (inspector === undefined) {
    return [];
  }

  return [
    {
      name: "knowledge.memory.inspect",
      description:
        "Inspect memory promotions. List active or inactive memory entries, or get full details of a specific promotion by ID.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "inspect"], description: "list all promotions or inspect one by id" },
          id: { type: "string", description: "promotion id to inspect (required when action=inspect)" },
          activeOnly: { type: "boolean", description: "when listing, show only active entries" },
          kind: { type: "string", enum: ["preference", "fact"], description: "filter by kind" },
          limit: { type: "number", description: "max entries to list" }
        },
        required: ["action"]
      },
      riskClass: "read-only-local",
      toolsets: ["core", "memory"],
      progressLabel: "inspecting memory",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: {
        action: "list" | "inspect";
        id?: string;
        activeOnly?: boolean;
        kind?: "preference" | "fact";
        limit?: number;
      }): Promise<ToolResult> => {
        if (input.action === "inspect") {
          if (input.id === undefined || input.id.length === 0) {
            return { ok: false, content: "id is required for inspect action" };
          }
          const record = await inspector.inspect(input.id);
          if (record === undefined) {
            return { ok: false, content: `No promotion record found with id: ${input.id}` };
          }
          return {
            ok: true,
            content: JSON.stringify(record, null, 2)
          };
        }

        const records = await inspector.list({
          activeOnly: input.activeOnly,
          kind: input.kind === "preference" ? "user-preference" : input.kind === "fact" ? "project-fact" : undefined,
          limit: input.limit
        });

        return {
          ok: true,
          content: records.map((r) => `${r.id} | ${r.kind} | ${r.active ? "active" : "inactive"} | ${r.content}`).join("\n") || "No memory promotions found."
        };
      }
    },
    {
      name: "knowledge.memory.deactivate",
      description:
        "Deactivate a memory promotion by ID. This suppresses the entry from rendered context. Cannot deactivate SOUL.md entries. Requires approval.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "promotion id to deactivate" }
        },
        required: ["id"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "memory"],
      progressLabel: "deactivating memory",
      maxResultSizeChars: 2000,
      isAvailable: () => true,
      run: async (input: { id: string }): Promise<ToolResult> => {
        const result = await inspector.deactivate(input.id);
        if (!result.ok) {
          return { ok: false, content: result.reason };
        }
        return {
          ok: true,
          content: `Deactivated ${result.record.id}. File removed: ${result.fileRemoved ? "yes" : "no (renderer will suppress)"}`
        };
      }
    }
  ];
}
