import type { RegisteredTool } from "../contracts/tool.js";
import { runPythonWorker } from "../workers/python-worker.js";

export type PythonToolOptions = {
  workspaceRoot?: string;
};

export function createPythonTools(options: PythonToolOptions = {}): readonly RegisteredTool[] {
  return [
  {
    name: "python.probe",
    description: "Probe the Python execution lane and return worker metadata.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string" }
      }
    },
    riskClass: "read-only-local",
    toolsets: ["core", "research"],
    progressLabel: "probing python worker",
    maxResultSizeChars: 2000,
    isAvailable: () => true,
    run: async (input: Record<string, unknown>) =>
      runPythonWorker({
        tool: "python.probe",
        input
      }, {
        cwd: options.workspaceRoot
      })
  },
  {
    name: "document.probe",
    description: "Inspect a local document path and return basic metadata plus a text preview when safe.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxPreviewChars: { type: "number" }
      },
      required: ["path"]
    },
    riskClass: "read-only-local",
    toolsets: ["files", "media", "research"],
    progressLabel: "probing document",
    maxResultSizeChars: 4000,
    isAvailable: () => true,
    run: async (input: Record<string, unknown>) =>
      runPythonWorker({
        tool: "document.probe",
        input
      }, {
        cwd: options.workspaceRoot
      })
  }
  ];
}

export const pythonTools: readonly RegisteredTool[] = createPythonTools();
