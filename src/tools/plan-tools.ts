import type { ExecutionPlanControllerApi, ExecutionPlanToolInput } from "../contracts/execution-plan.js";
import type { RegisteredTool, SessionToolProvider, ToolExecutionContext, ToolResult } from "../contracts/tool.js";
import { ExecutionPlanValidationError } from "../runtime/execution-plan-controller.js";

export function createPlanTools(options: {
  controller?: ExecutionPlanControllerApi;
  currentSessionId?: () => string;
}): readonly RegisteredTool<ExecutionPlanToolInput>[] {
  if (options.controller === undefined) return [];
  const controller = options.controller;
  return [{
    name: "plan",
    description:
      "Optionally create, read, or refine a lightweight Plan for genuinely long or branching work. Ordinary execution does not require a Plan, and updates are only useful when material progress changes the steps. Use write when no Plan exists and merge to replace or add steps by id. A Plan is coordination data only: it grants no tool authority, records no execution evidence, and does not govern continuation or final outcomes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operation: { type: "string", enum: ["read", "write", "merge"] },
        objective: { type: "string", minLength: 1, maxLength: 500 },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1, maxLength: 64 },
              content: { type: "string", minLength: 1, maxLength: 240 },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"]
              }
            },
            required: ["id", "content", "status"]
          }
        }
      },
      required: ["operation"]
    },
    riskClass: "read-only-local",
    toolsets: ["core"],
    progressLabel: "updating execution plan",
    maxResultSizeChars: 8_192,
    isAvailable: () => true,
    run: async (input: ExecutionPlanToolInput, context?: ToolExecutionContext): Promise<ToolResult> => {
      try {
        if (input.operation === "read") {
          const plan = controller.current();
          return plan === undefined
            ? { ok: true, content: "No execution plan exists.", metadata: { plan: null } }
            : planResult(plan);
        }
        if (input.operation === "write") {
          if (context?.visibleTurnId === undefined) {
            return error("missing-origin-turn", "plan write requires a current visible turn.");
          }
          const plan = await controller.write(
            input,
            context.visibleTurnId,
            context.onEvent,
            {
              source: "provider",
              ...(options.currentSessionId === undefined ? {} : { sessionId: options.currentSessionId() })
            }
          );
          return planResult(plan);
        }
        if (input.operation === "merge") {
          return planResult(await controller.merge(input, context?.onEvent));
        }
        return error("invalid-operation", "plan operation must be read, write, or merge.");
      } catch (caught) {
        if (caught instanceof ExecutionPlanValidationError) {
          return error("invalid-plan", caught.message);
        }
        return error("plan-update-failed", "Execution plan state could not be updated.");
      }
    }
  }];
}

export const planToolProvider: SessionToolProvider = {
  name: "plan",
  kind: "session",
  createTools(ctx) {
    return createPlanTools({
      controller: ctx.executionPlanController,
      currentSessionId: ctx.currentSessionId
    });
  }
};

function planResult(
  plan: NonNullable<ReturnType<ExecutionPlanControllerApi["current"]>>
): ToolResult {
  return {
    ok: true,
    content: JSON.stringify(plan),
    metadata: { plan }
  };
}

function error(code: string, content: string): ToolResult {
  return { ok: false, content, metadata: { error: code } };
}
