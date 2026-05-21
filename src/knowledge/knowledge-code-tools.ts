import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import { KnowledgeCache } from "./knowledge-cache.js";
import { forwardDeps, reverseDeps, affectedFiles, graphSummary } from "./code-dependency-graph.js";

export function createKnowledgeCodeTools(workspaceRoot: string): RegisteredTool[] {
  const cache = new KnowledgeCache({ workspaceRoot });

  return [
    {
      name: "knowledge.code.query",
      description:
        "Query the project's code dependency graph. Supports forward dependencies (what a file imports), reverse dependencies (what imports a file), affected files (transitive dependents), and graph summary.",
      inputSchema: {
        type: "object",
        properties: {
          moduleId: {
            type: "string",
            description: "Relative file path from workspace root, e.g. 'src/memory/memory-store.ts'"
          },
          query: {
            type: "string",
            enum: ["forward", "reverse", "affected", "summary"],
            description: "Type of query to run"
          }
        },
        required: ["query"]
      },
      riskClass: "read-only-local",
      toolsets: ["core", "coding"],
      progressLabel: "querying code graph",
      maxResultSizeChars: 8000,
      isAvailable: () => true,
      run: async (input: Record<string, unknown>): Promise<ToolResult> => {
        const query = input.query as string;

        if (query === "summary") {
          const graph = await cache.getGraph();
          const summary = graphSummary(graph);
          return {
            ok: true,
            content: JSON.stringify(summary, null, 2)
          };
        }

        const moduleId = input.moduleId as string | undefined;
        if (moduleId === undefined || moduleId.length === 0) {
          return { ok: false, content: "moduleId is required for forward, reverse, and affected queries" };
        }

        const graph = await cache.getGraph();

        switch (query) {
          case "forward": {
            const deps = forwardDeps(graph, moduleId);
            return {
              ok: true,
              content: deps.length === 0
                ? `No forward dependencies for ${moduleId}`
                : `Forward dependencies for ${moduleId}:\n${deps.join("\n")}`
            };
          }
          case "reverse": {
            const rdeps = reverseDeps(graph, moduleId);
            return {
              ok: true,
              content: rdeps.length === 0
                ? `No reverse dependencies for ${moduleId}`
                : `Reverse dependencies for ${moduleId}:\n${rdeps.join("\n")}`
            };
          }
          case "affected": {
            const affected = affectedFiles(graph, moduleId);
            return {
              ok: true,
              content: affected.length === 0
                ? `No affected files for ${moduleId}`
                : `Affected files for ${moduleId}:\n${affected.join("\n")}`
            };
          }
          default:
            return { ok: false, content: `Unknown query type: ${query}` };
        }
      }
    }
  ];
}

export const knowledgeCodeToolProvider: SessionToolProvider = {
  name: "knowledgeCode",
  kind: "session",
  createTools(ctx) {
    return createKnowledgeCodeTools(ctx.workspaceRoot);
  }
};
