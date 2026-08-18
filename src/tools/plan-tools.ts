import type { ExecutionPlanControllerApi, ExecutionPlanToolInput } from "../contracts/execution-plan.js";
import type { RegisteredTool, SessionToolProvider, ToolExecutionContext, ToolResult } from "../contracts/tool.js";
import { ExecutionPlanValidationError } from "../runtime/execution-plan-controller.js";
import {
  repairExecutionPlanWriteInput,
  type ExecutionPlanRepair
} from "../runtime/execution-plan-repair.js";

export function createPlanTools(options: {
  controller?: ExecutionPlanControllerApi;
  currentSessionId?: () => string;
}): readonly RegisteredTool<ExecutionPlanToolInput>[] {
  if (options.controller === undefined) return [];
  const controller = options.controller;
  return [{
    name: "plan",
    description:
      "Read or refine the bounded execution plan for the current foreground request. The runtime automatically starts a provisional Mission for clearly multi-step work; use write once to replace it with a specific plan from the same turn. Otherwise use merge to refine or record material progress. Cross-system plans must contain exact session-visible read, mutate, and independent verify tool requirements. Set requiresProtectedInput=true and protectedSource=browser when the mutation needs protected browser values; the runtime derives risk, reviewed argument mappings, grouped delivery, and verification facts from registered tools. Preflight invokes no tools and grants no authority. Use write for other work only when no plan exists, and read only when the current plan is not already present in context. This tool tracks work but grants no authority and does not create durable Tasks.",
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
              completionKind: { type: "string", enum: ["reasoning"] },
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
        },
        requirements: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1, maxLength: 64 },
              itemId: { type: "string", minLength: 1, maxLength: 64 },
              tool: { type: "string", minLength: 1, maxLength: 160 },
              capability: { type: "string", enum: ["read", "mutate", "verify"] },
              requiresProtectedInput: { type: "boolean" },
              protectedSource: { type: "string", enum: ["browser"] }
            },
            required: ["id", "itemId", "tool", "capability"]
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
          const repair = repairExecutionPlanWriteInput(input);
          const plan = await controller.write(
            repair?.plan ?? input,
            context.visibleTurnId,
            context.onEvent,
            {
              protectedTransferAvailable: context.onSecureInputRequest !== undefined,
              groupedProtectedTransferAvailable:
                context.onSecureInputRequest !== undefined &&
                "transferGroup" in context.onSecureInputRequest &&
                typeof context.onSecureInputRequest.transferGroup === "function",
              source: "provider",
              ...(options.currentSessionId === undefined ? {} : { sessionId: options.currentSessionId() })
            }
          );
          return planResult(plan, repair?.repairs);
        }
        if (input.operation === "merge") {
          return planResult(await controller.merge(input, context?.onEvent));
        }
        return error("invalid-operation", "plan operation must be read, write, or merge.");
      } catch (caught) {
        if (caught instanceof ExecutionPlanValidationError) {
          if (caught.code === "completion-evidence-required" && caught.itemId !== undefined) {
            return missingEvidenceError({
              controller,
              itemId: caught.itemId,
              visibleTurnId: context?.visibleTurnId
            });
          }
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
  plan: NonNullable<ReturnType<ExecutionPlanControllerApi["current"]>>,
  repairs: readonly ExecutionPlanRepair[] = []
): ToolResult {
  return {
    ok: true,
    content: repairs.length === 0
      ? JSON.stringify(plan)
      : JSON.stringify({ plan, repairs }),
    metadata: {
      plan,
      ...(repairs.length === 0 ? {} : { repairs })
    }
  };
}

function error(code: string, content: string): ToolResult {
  return { ok: false, content, metadata: { error: code } };
}

function missingEvidenceError(input: {
  controller: ExecutionPlanControllerApi;
  itemId: string;
  visibleTurnId?: string;
}): ToolResult {
  const evidenceCandidates = input.visibleTurnId === undefined
    ? []
    : input.controller.evidenceCandidates(input.itemId, input.visibleTurnId);
  const instruction =
    "Retry the plan merge using only successful evidence that actually proves this item. " +
    "If none of these calls proves completion, perform or verify the required action first.";
  const feedback = {
    error: "completion-evidence-required",
    itemId: input.itemId,
    instruction,
    evidenceCandidates
  };
  return {
    ok: false,
    content: JSON.stringify(feedback),
    metadata: {
      error: feedback.error,
      itemId: feedback.itemId,
      evidenceCandidates: feedback.evidenceCandidates
    }
  };
}
