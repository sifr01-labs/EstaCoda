import type { RegisteredTool, SessionToolProvider, ToolExecutionContext, ToolResult } from "../contracts/tool.js";
import type { UsageInspection, UsageInspector } from "../session/usage-inspector.js";
import { formatUsageInspection } from "../ui/usage-inspection-format.js";

type SessionUsageInput = { scope: "session" | "latest_turn" };

export function createSessionUsageTool(options: {
  inspector?: UsageInspector;
  currentSessionId: () => string;
}): RegisteredTool<SessionUsageInput>[] {
  if (options.inspector === undefined) return [];
  return [{
    name: "session.usage",
    description:
      "Inspect recorded token usage and estimated provider cost for the current session or latest completed turn. Use task.status for a particular durable Task. This is read-only and makes no model request.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: {
          type: "string",
          enum: ["session", "latest_turn"],
          description: "Usage scope to inspect."
        }
      },
      required: ["scope"]
    },
    riskClass: "read-only-local",
    toolsets: ["core"],
    progressLabel: "checking usage",
    maxResultSizeChars: 8_000,
    isAvailable: () => true,
    run: async (input: unknown, context?: ToolExecutionContext): Promise<ToolResult> => {
      if (!validInput(input)) {
        return error("invalid-input", "session.usage requires scope=session or scope=latest_turn.");
      }
      const sessionId = options.currentSessionId();
      let inspection: UsageInspection | undefined;
      try {
        inspection = input.scope === "session"
          ? await options.inspector!.inspectSession(sessionId)
          : await options.inspector!.inspectLatestTurn(sessionId, { excludeTurnId: context?.visibleTurnId });
      } catch {
        return error("usage-read-failed", "Usage could not be read from local accounting records.");
      }
      if (inspection === undefined) {
        return error(
          "usage-unavailable",
          input.scope === "latest_turn"
            ? "No completed turn usage is available in this session."
            : "Session usage is unavailable."
        );
      }
      return { ok: true, content: formatUsageInspection(inspection), metadata: inspection };
    }
  }];
}

export const sessionUsageToolProvider: SessionToolProvider = {
  name: "sessionUsage",
  kind: "session",
  createTools(ctx) {
    return createSessionUsageTool({
      inspector: ctx.usageInspector,
      currentSessionId: ctx.currentSessionId
    });
  }
};

function validInput(input: unknown): input is SessionUsageInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const candidate = input as Record<string, unknown>;
  return Object.keys(candidate).length === 1 &&
    (candidate.scope === "session" || candidate.scope === "latest_turn");
}

function error(code: string, content: string): ToolResult {
  return { ok: false, content, metadata: { error: code } };
}
