import type { FailureClass, FailureRecord } from "../contracts/failure.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";

export type FailureContext =
  | { kind: "provider"; execution: ProviderExecutionResult; iteration?: number }
  | { kind: "tool-execution"; execution: ToolExecutionRecord }
  | { kind: "tool-plan"; plan: ToolCallPlan }
  | { kind: "budget"; budget: string; limit: number; observed: number; reason: string }
  | { kind: "cancellation"; reason: string }
  | { kind: "security-escalation"; from: string; to: string }
  | { kind: "loop-exhausted"; reason: string; iterations: number }
  | { kind: "skill-playbook-step"; skill: string; stepId: string; error: string }
  | { kind: "generic"; error: unknown; message: string };

export type ClassifiedFailure = {
  class: FailureClass;
  recoverable: boolean;
  message: string;
  context: Record<string, unknown>;
};

export function classifyFailure(context: FailureContext): ClassifiedFailure {
  switch (context.kind) {
    case "provider":
      return classifyProviderFailure(context.execution, context.iteration);
    case "tool-execution":
      return classifyToolExecutionFailure(context.execution);
    case "tool-plan":
      return classifyToolPlanFailure(context.plan);
    case "budget":
      return classifyBudgetFailure(context);
    case "cancellation":
      return classifyCancellation(context.reason);
    case "security-escalation":
      return classifySecurityEscalation(context.from, context.to);
    case "loop-exhausted":
      return classifyLoopExhausted(context.reason, context.iterations);
    case "skill-playbook-step":
      return classifySkillPlaybookStepFailure(context);
    case "generic":
      return classifyGenericFailure(context.error, context.message);
  }
}

function classifyProviderFailure(
  execution: ProviderExecutionResult,
  iteration?: number
): ClassifiedFailure {
  const attempts = execution.attempts;
  const lastAttempt = attempts[attempts.length - 1];

  if (attempts.length === 0) {
    return {
      class: "provider-error",
      recoverable: true,
      message: "No provider route available.",
      context: { iteration, fallbackUsed: execution.fallbackUsed }
    };
  }

  const errorClass = lastAttempt?.errorClass ?? "unknown";
  const message = `Provider ${lastAttempt?.provider ?? "?"}/${lastAttempt?.model ?? "?"} failed: ${errorClass}.`;

  // Map provider error classes to failure classes
  switch (errorClass) {
    case "auth":
      return {
        class: "provider-error",
        recoverable: false,
        message: `Authentication failed for ${lastAttempt.provider}/${lastAttempt.model}.`,
        context: { iteration, errorClass, attempts: attempts.length, fallbackUsed: execution.fallbackUsed }
      };
    case "rate-limit":
    case "quota":
      return {
        class: "provider-error",
        recoverable: true,
        message: `Rate limited by ${lastAttempt.provider}/${lastAttempt.model}.`,
        context: { iteration, errorClass, attempts: attempts.length, fallbackUsed: execution.fallbackUsed }
      };
    case "timeout":
      return {
        class: "provider-error",
        recoverable: true,
        message: `Provider ${lastAttempt.provider}/${lastAttempt.model} timed out.`,
        context: { iteration, errorClass, attempts: attempts.length, fallbackUsed: execution.fallbackUsed }
      };
    case "network":
    case "server":
    case "model-unavailable":
      return {
        class: "provider-error",
        recoverable: true,
        message: `Provider ${lastAttempt.provider}/${lastAttempt.model} unavailable (${errorClass}).`,
        context: { iteration, errorClass, attempts: attempts.length, fallbackUsed: execution.fallbackUsed }
      };
    case "content-filter":
    case "refusal":
      return {
        class: "provider-refusal",
        recoverable: false,
        message: `Provider ${lastAttempt.provider}/${lastAttempt.model} refused the request.`,
        context: { iteration, errorClass, attempts: attempts.length, fallbackUsed: execution.fallbackUsed }
      };
    default:
      return {
        class: "provider-error",
        recoverable: true,
        message,
        context: { iteration, errorClass, attempts: attempts.length, fallbackUsed: execution.fallbackUsed }
      };
  }
}

function classifyToolExecutionFailure(execution: ToolExecutionRecord): ClassifiedFailure {
  const result = execution.result;

  if (result === undefined) {
    return {
      class: "tool-execution-error",
      recoverable: true,
      message: `Tool ${execution.tool.name} returned no result.`,
      context: { tool: execution.tool.name, decision: execution.decision }
    };
  }

  if (result.ok === false) {
    const errorMessage = typeof result.content === "string" ? result.content : "Unknown tool error";
    if (result.metadata?.reason === "delegation-access-error") {
      return {
        class: "tool-invalid-args",
        recoverable: true,
        message: `Tool ${execution.tool.name} rejected delegated access arguments: ${truncate(errorMessage, 200)}`,
        context: {
          tool: execution.tool.name,
          error: errorMessage,
          reason: result.metadata.reason,
          code: result.metadata.code,
          taskIndex: result.metadata.taskIndex
        }
      };
    }

    if (errorMessage.includes("timeout") || errorMessage.includes("timed out")) {
      return {
        class: "tool-timeout",
        recoverable: true,
        message: `Tool ${execution.tool.name} timed out: ${truncate(errorMessage, 200)}`,
        context: { tool: execution.tool.name, error: errorMessage }
      };
    }

    if (errorMessage.includes("not found") || errorMessage.includes("unavailable")) {
      return {
        class: "tool-not-found",
        recoverable: false,
        message: `Tool ${execution.tool.name} unavailable: ${truncate(errorMessage, 200)}`,
        context: { tool: execution.tool.name, error: errorMessage }
      };
    }

    if (errorMessage.includes("invalid") || errorMessage.includes("validation")) {
      return {
        class: "tool-invalid-args",
        recoverable: true,
        message: `Tool ${execution.tool.name} received invalid arguments: ${truncate(errorMessage, 200)}`,
        context: { tool: execution.tool.name, error: errorMessage }
      };
    }

    return {
      class: "tool-execution-error",
      recoverable: true,
      message: `Tool ${execution.tool.name} failed: ${truncate(errorMessage, 200)}`,
      context: { tool: execution.tool.name, error: errorMessage }
    };
  }

  if (execution.decision !== "allow") {
    return {
      class: "tool-blocked",
      recoverable: true,
      message: `Tool ${execution.tool.name} blocked by security policy: ${execution.decision}.`,
      context: { tool: execution.tool.name, decision: execution.decision }
    };
  }

  return {
    class: "unknown",
    recoverable: true,
    message: `Tool ${execution.tool.name} produced unclassifiable failure signal.`,
    context: { tool: execution.tool.name }
  };
}

function classifyToolPlanFailure(plan: ToolCallPlan): ClassifiedFailure {
  switch (plan.status) {
    case "invalid":
      return {
        class: "tool-invalid-args",
        recoverable: true,
        message: `Tool plan ${plan.tool} invalid: ${plan.error ?? "unknown reason"}.`,
        context: { tool: plan.tool, error: plan.error }
      };
    case "unavailable":
      return {
        class: "tool-not-found",
        recoverable: false,
        message: `Tool ${plan.tool} unavailable: ${plan.error ?? "not registered"}.`,
        context: { tool: plan.tool, error: plan.error }
      };
    case "blocked":
      return {
        class: "tool-blocked",
        recoverable: true,
        message: `Tool ${plan.tool} blocked: ${plan.error ?? "security policy"}.`,
        context: { tool: plan.tool, error: plan.error }
      };
    default:
      return {
        class: "unknown",
        recoverable: true,
        message: `Tool plan ${plan.tool} in unexpected state: ${plan.status}.`,
        context: { tool: plan.tool, status: plan.status }
      };
  }
}

function classifyBudgetFailure(context: {
  budget: string;
  limit: number;
  observed: number;
  reason: string;
}): ClassifiedFailure {
  return {
    class: "budget-exhausted",
    recoverable: true,
    message: `Budget exhausted (${context.budget}): ${context.reason}`,
    context: { budget: context.budget, limit: context.limit, observed: context.observed }
  };
}

function classifyCancellation(reason: string): ClassifiedFailure {
  return {
    class: "user-cancelled",
    recoverable: true,
    message: `Run cancelled: ${reason}`,
    context: { reason }
  };
}

function classifySecurityEscalation(from: string, to: string): ClassifiedFailure {
  return {
    class: "security-escalation",
    recoverable: true,
    message: `Security risk escalated from ${from} to ${to}.`,
    context: { from, to }
  };
}

function classifyLoopExhausted(reason: string, iterations: number): ClassifiedFailure {
  return {
    class: "agent-loop-exhausted",
    recoverable: true,
    message: `Agent loop exhausted after ${iterations} iterations: ${reason}`,
    context: { iterations, reason }
  };
}

function classifySkillPlaybookStepFailure(context: {
  skill: string;
  stepId: string;
  error: string;
}): ClassifiedFailure {
  return {
    class: "skill-playbook-step-error",
    recoverable: true,
    message: `Skill playbook step ${context.stepId} in skill ${context.skill} failed: ${context.error}`,
    context: { skill: context.skill, stepId: context.stepId, error: context.error }
  };
}

function classifyGenericFailure(error: unknown, message: string): ClassifiedFailure {
  const errorMessage = error instanceof Error ? error.message : message;

  if (errorMessage.includes("timeout")) {
    return {
      class: "tool-timeout",
      recoverable: true,
      message: errorMessage,
      context: { error: String(error) }
    };
  }

  return {
    class: "unknown",
    recoverable: true,
    message: errorMessage,
    context: { error: String(error) }
  };
}

export function buildFailureRecord(
  context: FailureContext,
  options: {
    sessionId: string;
    trajectoryId?: string;
    sourceEventKind: string;
    sourceEventId?: string;
    tool?: string;
    now?: () => Date;
    id?: () => string;
  }
): FailureRecord {
  const classified = classifyFailure(context);
  const now = options.now ?? (() => new Date());
  const id = options.id ?? (() => crypto.randomUUID());

  return {
    id: id(),
    sessionId: options.sessionId,
    trajectoryId: options.trajectoryId,
    timestamp: now().toISOString(),
    class: classified.class,
    sourceEventKind: options.sourceEventKind,
    sourceEventId: options.sourceEventId,
    tool: options.tool,
    message: classified.message,
    recoverable: classified.recoverable,
    context: classified.context
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
