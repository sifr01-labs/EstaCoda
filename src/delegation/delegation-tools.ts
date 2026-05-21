import type { RegisteredTool, SessionToolProvider, ToolsetName } from "../contracts/tool.js";
import type { DelegationManager } from "./delegation-manager.js";

export type DelegationToolOptions = {
  manager: DelegationManager;
  parentSessionId: string | (() => string);
  profileId: string;
  trustedWorkspace: () => Promise<boolean> | boolean;
};

type DelegateTaskInput = {
  task?: string;
  context?: string;
  allowedToolsets?: ToolsetName[];
  allowedTools?: string[];
};

export function createDelegationTools(options: DelegationToolOptions): RegisteredTool[] {
  return [
    {
      name: "delegate_task",
      description: "Create an isolated child session for a bounded subtask with explicit context and tool access.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string" },
          context: { type: "string" },
          allowedToolsets: {
            type: "array",
            items: { type: "string" }
          },
          allowedTools: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["task"]
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core", "research", "coding"],
      progressLabel: "delegating task",
      maxResultSizeChars: 8000,
      isAvailable: () => true,
      run: async (input: DelegateTaskInput) => {
        const task = input.task?.trim();

        if (task === undefined || task.length === 0) {
          return {
            ok: false,
            content: "delegate_task requires a non-empty task."
          };
        }

        const summary = await options.manager.delegate({
          parentSessionId: typeof options.parentSessionId === "function" ? options.parentSessionId() : options.parentSessionId,
          profileId: options.profileId,
          task,
          context: input.context,
          allowedToolsets: input.allowedToolsets ?? ["core", "research"],
          allowedTools: input.allowedTools ?? [],
          trustedWorkspace: await options.trustedWorkspace()
        });

        return {
          ok: summary.status === "completed",
          content: [
            `Delegated to child session ${summary.childSessionId}.`,
            `Status: ${summary.status}`,
            summary.summary
          ].join("\n"),
          metadata: summary
        };
      }
    }
  ];
}

export const delegationToolProvider: SessionToolProvider = {
  name: "delegation",
  kind: "session",
  createTools(ctx) {
    return createDelegationTools({
      manager: requireProviderDependency("delegation", "delegationManager", ctx.delegationManager),
      parentSessionId: ctx.currentSessionId,
      profileId: ctx.profileId,
      trustedWorkspace: requireProviderDependency("delegation", "trustedWorkspace", ctx.trustedWorkspace)
    });
  }
};

function requireProviderDependency<T>(provider: string, dependency: string, value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError(`${provider}ToolProvider requires ${dependency}.`);
  }
  return value;
}
