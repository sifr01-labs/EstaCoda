import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import type { EnvironmentType } from "../contracts/security.js";
import { assessCommandSafety } from "../security/command-safety.js";
import type { ProcessManager } from "./process-manager.js";

export type ProcessToolOptions = {
  processManager: ProcessManager;
};

export function createProcessTools(options: ProcessToolOptions): readonly RegisteredTool[] {
  return [
    {
      name: "process.start",
      description: "Start a long-running workspace process in the background.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" }
        },
        required: ["command"]
      },
      riskClass: "workspace-write",
      toolsets: ["shell-write", "coding", "research"],
      progressLabel: "starting process",
      maxResultSizeChars: 3000,
      isAvailable: () => true,
      run: async (input: { command?: string }, context) => {
        if (typeof input.command !== "string" || input.command.trim().length === 0) {
          return errorResult("command must be a non-empty string");
        }

        const blockedReason = explainCommandBlock(input.command, context?.environmentType);
        if (blockedReason !== undefined) {
          return errorResult(blockedReason);
        }

        const process = await options.processManager.start(input.command);

        return {
          ok: process.status === "running",
          content: `Started ${process.id}: ${process.command}`,
          metadata: {
            process
          }
        };
      }
    },
    {
      name: "process.list",
      description: "List background processes for the active runtime.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      riskClass: "read-only-local",
      toolsets: ["shell-readonly", "coding", "research"],
      progressLabel: "listing processes",
      maxResultSizeChars: 6000,
      isAvailable: () => true,
      run: async () => {
        const processes = options.processManager.list();

        return {
          ok: true,
          content: processes.length === 0
            ? "No managed processes."
            : processes
                .map((process) => `${process.id}\t${process.status}\t${process.command}`)
                .join("\n"),
          metadata: {
            processes
          }
        };
      }
    },
    {
      name: "process.logs",
      description: "Read recent logs from a managed background process.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          tailChars: { type: "number" }
        },
        required: ["id"]
      },
      riskClass: "read-only-local",
      toolsets: ["shell-readonly", "coding", "research"],
      progressLabel: "reading process logs",
      maxResultSizeChars: 12_000,
      isAvailable: () => true,
      run: async (input: { id?: string; tailChars?: number }) => {
        if (typeof input.id !== "string" || input.id.length === 0) {
          return errorResult("id must be a non-empty string");
        }

        const logs = options.processManager.logs(input.id, {
          tailChars: input.tailChars
        });

        if (logs === undefined) {
          return errorResult(`No managed process found for ${input.id}.`);
        }

        return {
          ok: true,
          content: logs.length === 0
            ? "(no logs)"
            : logs.map((log) => `[${log.stream}] ${log.text.trimEnd()}`).join("\n"),
          metadata: {
            id: input.id,
            logs
          }
        };
      }
    },
    {
      name: "process.stop",
      description: "Stop a managed background process.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          signal: { type: "string" }
        },
        required: ["id"]
      },
      riskClass: "workspace-write",
      toolsets: ["shell-write", "coding", "research"],
      progressLabel: "stopping process",
      maxResultSizeChars: 3000,
      isAvailable: () => true,
      run: async (input: { id?: string; signal?: NodeJS.Signals }) => {
        if (typeof input.id !== "string" || input.id.length === 0) {
          return errorResult("id must be a non-empty string");
        }

        const process = await options.processManager.stop(input.id, input.signal ?? "SIGTERM");

        if (process === undefined) {
          return errorResult(`No managed process found for ${input.id}.`);
        }

        return {
          ok: true,
          content: `${process.status === "stopped" ? "Stopped" : "Process already finished"} ${process.id}: ${process.command}`,
          metadata: {
            process
          }
        };
      }
    }
  ];
}

function explainCommandBlock(command: string, environmentType?: EnvironmentType): string | undefined {
  const assessment = assessCommandSafety(command, { environmentType });
  if (assessment.hardBlock !== undefined) {
    return assessment.hardBlock.reason;
  }
  if (assessment.riskClass === "destructive-local") {
    return "command matches a destructive or privilege-escalating pattern";
  }
  return undefined;
}

function errorResult(content: string): ToolResult {
  return {
    ok: false,
    content
  };
}
