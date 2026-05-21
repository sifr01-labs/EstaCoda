import type { RegisteredTool, RuntimeToolProvider } from "../contracts/tool.js";
import type { WorkspaceTrustStore } from "./workspace-trust-store.js";

export type WorkspaceTrustToolOptions = {
  workspaceRoot: string;
  trustStore: WorkspaceTrustStore;
};

export function createWorkspaceTrustTools(options: WorkspaceTrustToolOptions): readonly RegisteredTool[] {
  return [
    {
      name: "workspace.trust.status",
      description: "Report whether the active workspace directory is trusted for proactive EstaCoda operation.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      riskClass: "read-only-local",
      toolsets: ["core", "files", "coding"],
      progressLabel: "checking workspace trust",
      maxResultSizeChars: 2000,
      isAvailable: () => true,
      run: async () => {
        const trusted = await options.trustStore.isTrusted(options.workspaceRoot);

        return {
          ok: true,
          content: trusted
            ? `Workspace is trusted: ${options.workspaceRoot}`
            : `Workspace is not trusted yet: ${options.workspaceRoot}`,
          metadata: {
            trusted,
            workspaceRoot: options.workspaceRoot
          }
        };
      }
    },
    {
      name: "workspace.trust.grant",
      description: "Trust the active workspace directory for behavioral safety checks without changing config loading.",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string" }
        }
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core", "files", "coding"],
      progressLabel: "trusting workspace",
      maxResultSizeChars: 2000,
      isAvailable: () => true,
      run: async (input: { label?: string }) => {
        const grant = await options.trustStore.grant(options.workspaceRoot, {
          label: input.label ?? "EstaCoda workspace"
        });

        return {
          ok: true,
          content: `Trusted workspace directory ${grant.root}.`,
          metadata: {
            grant
          }
        };
      }
    },
    {
      name: "workspace.trust.revoke",
      description: "Revoke trust for the active workspace.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core", "files", "coding"],
      progressLabel: "revoking workspace trust",
      maxResultSizeChars: 2000,
      isAvailable: () => true,
      run: async () => {
        const revoked = await options.trustStore.revoke(options.workspaceRoot);

        return {
          ok: true,
          content: revoked
            ? `Revoked workspace trust for ${options.workspaceRoot}.`
            : `No workspace trust grant existed for ${options.workspaceRoot}.`,
          metadata: {
            revoked,
            workspaceRoot: options.workspaceRoot
          }
        };
      }
    }
  ];
}

export const workspaceTrustToolProvider: RuntimeToolProvider = {
  name: "workspaceTrust",
  kind: "runtime",
  createTools(ctx) {
    return createWorkspaceTrustTools({
      workspaceRoot: ctx.workspaceRoot,
      trustStore: ctx.trustStore
    });
  }
};
