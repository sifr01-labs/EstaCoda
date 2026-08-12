import type { ExecutionPlanControllerApi, ExecutionPlanToolInput } from "../contracts/execution-plan.js";
import type { RegisteredTool, SessionToolProvider, ToolExecutionContext, ToolResult } from "../contracts/tool.js";
import { ExecutionPlanValidationError } from "../runtime/execution-plan-controller.js";

export function createPlanTools(options: {
  controller?: ExecutionPlanControllerApi;
}): readonly RegisteredTool<ExecutionPlanToolInput>[] {
  if (options.controller === undefined) return [];
  const controller = options.controller;
  return [{
    name: "plan",
    description:
      "Create, read, or update the bounded execution plan for the current foreground request. Use write to start or replace a Mission, merge as work advances, and read only when the current plan is not already present in context. This tool tracks work but grants no authority and does not create durable Tasks.",
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
                enum: ["pending", "in_progress", "completed", "blocked", "cancelled"]
              },
              evidenceCallIds: {
                type: "array",
                maxItems: 16,
                items: { type: "string", minLength: 1, maxLength: 256 }
              },
              blocker: {
                anyOf: [
                  {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      kind: {
                        type: "string",
                        enum: [
                          "user_input_required",
                          "approval_required",
                          "missing_capability",
                          "external_state",
                          "budget"
                        ]
                      },
                      summary: { type: "string", minLength: 1, maxLength: 500 }
                    },
                    required: ["kind", "summary"]
                  },
                  { type: "null" }
                ]
              }
            },
            required: ["id"]
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
          return planResult(controller.write(input, context.visibleTurnId));
        }
        if (input.operation === "merge") {
          return planResult(controller.merge(input));
        }
        return error("invalid-operation", "plan operation must be read, write, or merge.");
      } catch (caught) {
        return caught instanceof ExecutionPlanValidationError
          ? error("invalid-plan", caught.message)
          : error("plan-update-failed", "Execution plan state could not be updated.");
      }
    }
  }];
}

export const planToolProvider: SessionToolProvider = {
  name: "plan",
  kind: "session",
  createTools(ctx) {
    return createPlanTools({ controller: ctx.executionPlanController });
  }
};

function planResult(plan: NonNullable<ReturnType<ExecutionPlanControllerApi["current"]>>): ToolResult {
  return {
    ok: true,
    content: JSON.stringify(plan),
    metadata: { plan }
  };
}

function error(code: string, content: string): ToolResult {
  return { ok: false, content, metadata: { error: code } };
}
