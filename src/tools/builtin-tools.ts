import type { RegisteredTool, StaticToolProvider } from "../contracts/tool.js";
import { createRegisteredSecretStoreTool } from "./secure-input-tools.js";

export const builtinTools: readonly RegisteredTool[] = [
  createRegisteredSecretStoreTool(),
  {
    name: "trajectory.record",
    description: "Record agent trajectory events for evaluation and future learning.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        data: { type: "object" }
      },
      required: ["kind", "data"]
    },
    riskClass: "read-only-local",
    toolsets: ["core", "research"],
    progressLabel: "recording trajectory",
    maxResultSizeChars: 2000,
    isAvailable: () => true,
    run: async () => ({
      ok: true,
      content: "trajectory.record is scaffolded; runtime event capture is handled by TrajectoryRecorder."
    })
  }
];

export const builtinToolProvider: StaticToolProvider = {
  name: "builtin",
  kind: "static",
  tools: builtinTools
};
