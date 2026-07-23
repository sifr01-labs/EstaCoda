import { createHash } from "node:crypto";
import type { DelegateSynthesis, DelegateTaskItem, DelegationConfig } from "../contracts/delegation.js";
import type {
  TaskAuthorityDisposition,
  TaskAuthorityPolicy,
  TaskExecutionLimits,
  TaskDeliveryDestination,
  TaskExecutionPreference,
  TaskIdempotency,
  TaskRetryPolicy,
  TaskStepExecutionLimits,
  TaskWorkspaceBinding
} from "../contracts/task.js";
import {
  isTerminalTaskStatus,
  TASK_GRAPH_LIMITS,
  TASK_ORIGIN_COMPLETION_DELIVERY_KEY,
  TASK_TOOL_RISK_CLASSES
} from "../contracts/task.js";
import type { ToolDefinition, ToolRiskClass } from "../contracts/tool.js";
import { resolveChildToolAccess } from "./toolset-security.js";
import { FixedTaskService, type FixedTaskGraph, type FixedTaskStepInput } from "../workflow/fixed-task-service.js";
import type { InitialTaskHostLeaseInput, TaskStore } from "../workflow/task-store.js";
import {
  DEFAULT_SPENDING_WARNING_THRESHOLD_PERCENT,
  assertSpendingLimit,
  cloneSpendingLimit,
  type SpendingLimit
} from "../contracts/budget.js";

const STEP_PROVIDER_CALLS = 45;
const STEP_TOTAL_TOKENS = 1_000_000;
const STEP_RESULT_BYTES = 1_048_576;

export type ActiveTaskExecution = {
  taskId: string;
  planRevisionId: string;
  stepId: string;
  attemptId: string;
};

export type DurableDelegationRequest = {
  toolCallId: string;
  originTurnId?: string;
  tasks: readonly DelegateTaskItem[];
  synthesis?: DelegateSynthesis;
  trustedWorkspace: boolean;
  recoveredTasksFromJsonString?: boolean;
  executionPreference?: TaskExecutionPreference;
  /** Optional root-Task-only narrowing of the configured estimated-cost ceiling. */
  spendingLimit?: Pick<SpendingLimit, "maxEstimatedCostUsd">;
};

export type DurableDelegationHandle = {
  taskId: string;
  status: import("../contracts/task.js").TaskStatus;
  executionPreference: TaskExecutionPreference;
  execution: "foreground" | "background" | "waiting";
  backgroundContinuation: "available" | "unavailable" | "unknown";
  executionWaitingReason?: string;
  stepCount: number;
  workerStepIds: readonly string[];
  synthesisStepId?: string;
  primaryResultStepId?: string;
  childTask: boolean;
  parentTaskId?: string;
  recoveredTasksFromJsonString?: boolean;
  idempotentReplay: boolean;
};

/** Converts delegation requests into durable Task graphs; it never executes or waits for workers. */
export class DurableDelegationService {
  readonly #store: TaskStore;
  readonly #fixedTasks: FixedTaskService;
  readonly #creatorSessionId: () => string;
  readonly #workspace: TaskWorkspaceBinding;
  readonly #config: DelegationConfig;
  readonly #visibleTools: () => readonly ToolDefinition[];
  readonly #activeTaskExecution: ActiveTaskExecution | undefined;
  readonly #completionDestination: (() => TaskDeliveryDestination | undefined) | undefined;
  readonly #executionPreference: (() => TaskExecutionPreference) | undefined;
  readonly #backgroundContinuation: (() => DurableDelegationHandle["backgroundContinuation"]) | undefined;
  readonly #taskHostAdmission: (() => InitialTaskHostLeaseInput | undefined) | undefined;
  readonly #onTaskCreated: ((taskId: string) => Promise<void>) | undefined;
  readonly #defaultTaskSpendingLimit: SpendingLimit | undefined;

  constructor(options: {
    store: TaskStore;
    creatorSessionId: () => string;
    workspace: TaskWorkspaceBinding;
    config: DelegationConfig;
    visibleTools: () => readonly ToolDefinition[];
    activeTaskExecution?: ActiveTaskExecution;
    completionDestination?: () => TaskDeliveryDestination | undefined;
    executionPreference?: () => TaskExecutionPreference;
    backgroundContinuation?: () => DurableDelegationHandle["backgroundContinuation"];
    taskHostAdmission?: () => InitialTaskHostLeaseInput | undefined;
    onTaskCreated?: (taskId: string) => Promise<void>;
    defaultTaskSpendingLimit?: SpendingLimit;
    fixedTasks?: FixedTaskService;
  }) {
    this.#store = options.store;
    this.#fixedTasks = options.fixedTasks ?? new FixedTaskService({ store: options.store });
    this.#creatorSessionId = options.creatorSessionId;
    this.#workspace = options.workspace;
    this.#config = options.config;
    this.#visibleTools = options.visibleTools;
    this.#activeTaskExecution = options.activeTaskExecution;
    this.#completionDestination = options.completionDestination;
    this.#executionPreference = options.executionPreference;
    this.#backgroundContinuation = options.backgroundContinuation;
    this.#taskHostAdmission = options.taskHostAdmission;
    this.#onTaskCreated = options.onTaskCreated;
    this.#defaultTaskSpendingLimit = cloneSpendingLimit(options.defaultTaskSpendingLimit);
  }

  async createAndActivate(request: DurableDelegationRequest): Promise<DurableDelegationHandle> {
    const handle = this.create(request);
    if (handle.executionPreference === "auto") await this.#onTaskCreated?.(handle.taskId);
    return this.#refreshHandle(handle);
  }

  create(request: DurableDelegationRequest): DurableDelegationHandle {
    if (!request.trustedWorkspace) throw new Error("Durable delegation requires a trusted workspace.");
    if (request.tasks.length === 0 || request.tasks.length > this.#config.maxBatchTasks) {
      throw new Error(`Durable delegation requires 1-${this.#config.maxBatchTasks} Steps.`);
    }
    boundedToken(request.toolCallId, "provider tool call ID");
    const sessionId = boundedToken(this.#creatorSessionId(), "creator session ID");
    const completionDestination = this.#completionDestination?.();
    const parent = this.#parentContext();
    if (parent !== undefined && request.spendingLimit !== undefined) {
      throw new Error("A child Task inherits the root Task spending scope and cannot redefine it.");
    }
    const spendingLimit = parent === undefined
      ? resolveRootSpendingLimit(this.#defaultTaskSpendingLimit, request.spendingLimit)
      : undefined;
    const executionPreference = request.executionPreference ?? this.#executionPreference?.() ?? parent?.executionPreference ?? "auto";
    if (executionPreference !== "auto" && executionPreference !== "background") {
      throw new Error("Delegation execution preference is invalid.");
    }
    const creationKey = delegationCreationKey(this.#store.profileId, sessionId, request.toolCallId);
    const existing = this.#store.getTaskByCreationKey(creationKey);
    const initialHostLease = existing === null && executionPreference === "auto"
      ? this.#taskHostAdmission?.()
      : undefined;
    const stepAuthorities = request.tasks.map((item) => this.#authorityFor(item, parent?.authority));
    const synthesisAuthority = request.synthesis === undefined
      ? undefined
      : this.#synthesisAuthority(request.synthesis, parent?.authority);
    const allAuthorities = synthesisAuthority === undefined
      ? stepAuthorities
      : [...stepAuthorities, synthesisAuthority];
    const taskAuthority = mergeAuthorities(allAuthorities);
    const totalStepCount = request.tasks.length + (request.synthesis === undefined ? 0 : 1);
    const executionLimits = delegationExecutionLimits(
      totalStepCount,
      this.#config.maxConcurrentChildren,
      this.#config.childTimeoutSeconds,
      parent?.executionLimits
    );
    const workerSteps = request.tasks.map((item, index): FixedTaskStepInput => {
      const authority = stepAuthorities[index]!;
      const idempotency = delegatedStepIdempotency(authority);
      return {
        key: `delegated-${index + 1}`,
        title: request.tasks.length === 1 ? "Delegated work" : `Delegated work ${index + 1}`,
        objective: delegatedObjective(item),
        dependsOn: [],
        executor: {
          kind: "agent",
          role: item.role === "orchestrator" ? "orchestrator" : "worker",
          ...(item.modelOverride === undefined ? {} : {
            model: {
              ...(item.modelOverride.provider === undefined ? {} : { provider: item.modelOverride.provider }),
              id: item.modelOverride.model
            }
          })
        },
        childTaskPolicy: item.role === "orchestrator" && authority.mayCreateChildTasks
          ? "fire_and_forget"
          : "forbid",
        authorityPolicy: authority,
        executionLimits: executionLimits.step,
        retryPolicy: delegatedRetryPolicy(idempotency),
        failurePolicy: {
          onAttemptsExhausted: request.tasks.length === 1 && request.synthesis === undefined ? "fail_task" : "mark_partial",
          optional: false
        },
        idempotency,
        resultPolicy: { kind: "text", required: true, maxBytes: STEP_RESULT_BYTES }
      };
    });
    const synthesisIdempotency = synthesisAuthority === undefined
      ? undefined
      : delegatedStepIdempotency(synthesisAuthority);
    const steps: FixedTaskStepInput[] = request.synthesis === undefined ? workerSteps : [
      ...workerSteps,
      {
        key: "synthesis",
        title: "Synthesize delegated results",
        objective: synthesisObjective(request.synthesis),
        dependsOn: workerSteps.map((step) => step.key),
        executor: {
          kind: "agent",
          role: "synthesis",
          ...(request.synthesis.modelOverride === undefined ? {} : {
            model: {
              ...(request.synthesis.modelOverride.provider === undefined
                ? {}
                : { provider: request.synthesis.modelOverride.provider }),
              id: request.synthesis.modelOverride.model
            }
          })
        },
        childTaskPolicy: "forbid",
        authorityPolicy: synthesisAuthority!,
        executionLimits: executionLimits.step,
        retryPolicy: delegatedRetryPolicy(synthesisIdempotency!),
        failurePolicy: { onAttemptsExhausted: "fail_task", optional: false },
        idempotency: synthesisIdempotency!,
        resultPolicy: { kind: "text", required: true, maxBytes: STEP_RESULT_BYTES }
      }
    ];
    const graph = this.#fixedTasks.create({
      creatorSessionId: sessionId,
      source: "delegation",
      executionPreference,
      creationKey,
      objective: request.synthesis !== undefined
        ? synthesisObjective(request.synthesis)
        : request.tasks.length === 1
        ? delegatedObjective(request.tasks[0]!)
        : `Complete ${request.tasks.length} delegated Steps as one durable Task.`,
      workspace: this.#workspace,
      authorityPolicy: taskAuthority,
      ...(spendingLimit === undefined ? {} : { spendingLimit }),
      executionLimits: executionLimits.task,
      steps,
      planReason: "Created by delegate_task as durable delegated work.",
      ...(initialHostLease === undefined ? {} : { initialHostLease }),
      ...(parent === undefined && request.originTurnId !== undefined ? { originTurnId: request.originTurnId } : {}),
      ...(completionDestination === undefined ||
          (completionDestination.platform === "cli" && (parent !== undefined || request.synthesis === undefined)) ? {} : {
        completionDelivery: {
          deliveryKey: TASK_ORIGIN_COMPLETION_DELIVERY_KEY,
          destination: completionDestination
        }
      }),
      ...(parent === undefined ? {} : {
        parent: { taskId: parent.taskId, attemptId: parent.attemptId },
        createdBy: {
          kind: "agent" as const,
          sessionId,
          taskId: parent.taskId,
          attemptId: parent.attemptId
        }
      })
    });
    return handle(graph, parent, request, existing !== null);
  }

  #refreshHandle(handle: DurableDelegationHandle): DurableDelegationHandle {
    const task = this.#store.getTask(handle.taskId);
    if (task === null) return handle;
    const lease = this.#store.getTaskHostLease(task.id);
    const execution = lease !== null && Date.parse(lease.expiresAt) > Date.now() ? lease.kind : "waiting";
    const backgroundContinuation = this.#backgroundContinuation?.() ?? "unknown";
    return {
      ...handle,
      status: task.status,
      execution,
      backgroundContinuation,
      ...(execution === "waiting" && !isTerminalTaskStatus(task.status) ? {
        executionWaitingReason: task.executionPreference === "background"
          ? backgroundContinuation === "unavailable"
            ? "Waiting for an active background host."
            : "Waiting for the background host to claim this Task."
          : backgroundContinuation === "unavailable"
            ? "Waiting for an eligible host; no active background continuation is available."
            : "Waiting for an eligible Task host."
      } : {})
    };
  }

  #parentContext(): {
    taskId: string;
    attemptId: string;
    authority: TaskAuthorityPolicy;
    executionLimits: TaskStepExecutionLimits;
    executionPreference: TaskExecutionPreference;
  } | undefined {
    if (this.#activeTaskExecution === undefined) return undefined;
    const execution = this.#activeTaskExecution;
    const task = this.#store.getTask(execution.taskId);
    const step = this.#store.getStep(execution.stepId);
    const attempt = this.#store.getAttempt(execution.attemptId);
    if (task === null || step === null || attempt === null ||
      step.taskId !== task.id || attempt.taskId !== task.id || attempt.stepId !== step.id ||
      attempt.planRevisionId !== execution.planRevisionId) {
      throw new Error("The active parent Task Attempt is no longer valid.");
    }
    if (step.childTaskPolicy !== "fire_and_forget") {
      throw new Error("The active parent Step forbids runtime child Tasks.");
    }
    return {
      taskId: task.id,
      attemptId: attempt.id,
      authority: step.authorityPolicy,
      executionLimits: step.executionLimits,
      executionPreference: task.executionPreference
    };
  }

  #authorityFor(item: DelegateTaskItem, ceiling?: TaskAuthorityPolicy): TaskAuthorityPolicy {
    const visibleTools = this.#visibleTools();
    const remainingDepth = ceiling === undefined
      ? Math.max(0, this.#config.maxSpawnDepth - 1)
      : Math.max(0, Math.min(this.#config.maxSpawnDepth - 1, ceiling.maxChildDepth - 1));
    const requestedRole = item.role === "orchestrator" && remainingDepth > 0 ? "orchestrator" : "leaf";
    const access = resolveChildToolAccess({
      parentVisibleTools: visibleTools,
      childCandidateTools: visibleTools,
      config: this.#config,
      request: {
        allowedToolsets: item.allowedToolsets,
        allowedTools: item.allowedTools,
        role: requestedRole,
        depth: Math.max(1, this.#config.maxSpawnDepth - remainingDepth)
      }
    });
    const allowedNames = new Set(access.effectiveAllowedTools);
    const allowedDefinitions = visibleTools.filter((tool) => allowedNames.has(tool.name));
    const mayCreateChildTasks = allowedNames.has("delegate_task") && remainingDepth > 0;
    const blockedTools = ceiling === undefined
      ? unique(access.blockedTools.map((tool) => tool.name)).slice(0, TASK_GRAPH_LIMITS.maxToolsPerStep)
      : [...ceiling.blockedTools];
    return {
      allowedToolsets: access.effectiveAllowedToolsets,
      allowedTools: [...allowedNames].sort(),
      blockedTools,
      riskClassPolicy: Object.fromEntries(TASK_TOOL_RISK_CLASSES.map((riskClass) => {
        const hasTool = allowedDefinitions.some((tool) => tool.riskClass === riskClass);
        const disposition = hasTool
          ? narrowerDisposition("runtime_policy", ceiling?.riskClassPolicy[riskClass])
          : "forbid";
        return [riskClass, disposition];
      })) as Record<ToolRiskClass, TaskAuthorityDisposition>,
      mayCreateChildTasks,
      maxChildDepth: mayCreateChildTasks ? remainingDepth : 0
    };
  }

  #synthesisAuthority(synthesis: DelegateSynthesis, ceiling?: TaskAuthorityPolicy): TaskAuthorityPolicy {
    const authority = this.#authorityFor({
      task: synthesis.objective,
      allowedToolsets: ["core"],
      allowedTools: ["task.result.read"],
      role: "leaf",
      modelOverride: synthesis.modelOverride
    }, ceiling);
    if (!authority.allowedTools?.includes("task.result.read")) {
      throw new Error("Durable synthesis requires the task.result.read tool within inherited authority.");
    }
    return authority;
  }
}

function delegatedStepIdempotency(authority: TaskAuthorityPolicy): TaskIdempotency {
  const allowedRiskClasses = TASK_TOOL_RISK_CLASSES.filter(
    (riskClass) => authority.riskClassPolicy[riskClass] !== "forbid"
  );
  return authority.mayCreateChildTasks === false && allowedRiskClasses.every(
    (riskClass) => riskClass === "read-only-local" || riskClass === "read-only-network"
  )
    ? "retry_safe"
    : "unknown";
}

function delegatedRetryPolicy(idempotency: TaskIdempotency): TaskRetryPolicy {
  return {
    maxAttempts: TASK_GRAPH_LIMITS.maxAttemptsPerStep,
    initialBackoffMs: 0,
    backoffMultiplier: 1,
    maxBackoffMs: 0,
    retryableFailureClasses: ["lease-expired", "lease-missing"],
    nonRetryableFailureClasses: [],
    requireIdempotent: idempotency === "idempotent" || idempotency === "retry_safe"
  };
}

function delegationExecutionLimits(
  stepCount: number,
  maxConcurrentChildren: number,
  timeoutSeconds: number,
  ceiling?: TaskStepExecutionLimits
): {
  task: TaskExecutionLimits;
  step: TaskStepExecutionLimits;
} {
  const wall = Math.max(1, Math.floor(timeoutSeconds * 1_000));
  const totalCalls = STEP_PROVIDER_CALLS * stepCount;
  const totalTokens = STEP_TOTAL_TOKENS * stepCount;
  const task: TaskExecutionLimits = ceiling === undefined ? {
    maxConcurrentAttempts: Math.min(stepCount, maxConcurrentChildren, TASK_GRAPH_LIMITS.maxConcurrentAttempts),
    maxProviderCalls: totalCalls,
    maxTotalTokens: totalTokens,
    maxWallClockMs: wall
  } : {
    maxConcurrentAttempts: Math.min(stepCount, maxConcurrentChildren, TASK_GRAPH_LIMITS.maxConcurrentAttempts),
    maxProviderCalls: ceiling.maxProviderCalls,
    maxTotalTokens: ceiling.maxTotalTokens,
    maxWallClockMs: ceiling.maxWallClockMs
  };
  return {
    task,
    step: {
      maxProviderCalls: ceiling === undefined ? STEP_PROVIDER_CALLS : Math.floor(ceiling.maxProviderCalls / stepCount),
      maxTotalTokens: ceiling === undefined ? STEP_TOTAL_TOKENS : Math.floor(ceiling.maxTotalTokens / stepCount),
      maxWallClockMs: ceiling === undefined ? wall : ceiling.maxWallClockMs
    }
  };
}

function resolveRootSpendingLimit(
  configuredDefault: SpendingLimit | undefined,
  requested: Pick<SpendingLimit, "maxEstimatedCostUsd"> | undefined
): SpendingLimit | undefined {
  if (requested === undefined) return cloneSpendingLimit(configuredDefault);
  const maxEstimatedCostUsd = requested.maxEstimatedCostUsd;
  const candidate: SpendingLimit = {
    maxEstimatedCostUsd,
    warningThresholdPercent: configuredDefault?.warningThresholdPercent ??
      DEFAULT_SPENDING_WARNING_THRESHOLD_PERCENT
  };
  assertSpendingLimit(candidate, "Requested Task spending limit");
  if (configuredDefault !== undefined && maxEstimatedCostUsd > configuredDefault.maxEstimatedCostUsd) {
    throw new Error("A delegated Task spending limit cannot exceed the configured Task default.");
  }
  return candidate;
}

function mergeAuthorities(authorities: readonly TaskAuthorityPolicy[]): TaskAuthorityPolicy {
  const blocked = authorities.map((authority) => new Set(authority.blockedTools));
  const commonBlocked = blocked.length === 0 ? [] : [...blocked[0]!].filter((name) => blocked.every((set) => set.has(name)));
  return {
    allowedToolsets: unique(authorities.flatMap((authority) => [...authority.allowedToolsets])),
    allowedTools: unique(authorities.flatMap((authority) => [...(authority.allowedTools ?? [])])),
    blockedTools: commonBlocked.sort(),
    riskClassPolicy: Object.fromEntries(TASK_TOOL_RISK_CLASSES.map((riskClass) => [
      riskClass,
      authorities.reduce<TaskAuthorityDisposition>(
        (widest, authority) => dispositionRank(authority.riskClassPolicy[riskClass]) > dispositionRank(widest)
          ? authority.riskClassPolicy[riskClass]
          : widest,
        "forbid"
      )
    ])) as Record<ToolRiskClass, TaskAuthorityDisposition>,
    mayCreateChildTasks: authorities.some((authority) => authority.mayCreateChildTasks),
    maxChildDepth: Math.max(0, ...authorities.map((authority) => authority.maxChildDepth))
  };
}

function delegatedObjective(item: DelegateTaskItem): string {
  const objective = item.context?.trim()
    ? `${item.task.trim()}\n\nContext:\n${item.context.trim()}`
    : item.task.trim();
  if (objective.length === 0 || objective.length > TASK_GRAPH_LIMITS.maxStepObjectiveChars || objective.includes("\u0000")) {
    throw new Error(`A delegated Step objective must be 1-${TASK_GRAPH_LIMITS.maxStepObjectiveChars} characters.`);
  }
  return objective;
}

function synthesisObjective(synthesis: DelegateSynthesis): string {
  const objective = synthesis.objective.trim();
  if (objective.length === 0 || objective.length > TASK_GRAPH_LIMITS.maxStepObjectiveChars || objective.includes("\u0000")) {
    throw new Error(`A synthesis objective must be 1-${TASK_GRAPH_LIMITS.maxStepObjectiveChars} characters.`);
  }
  return objective;
}

function handle(
  graph: FixedTaskGraph,
  parent: { taskId: string } | undefined,
  request: DurableDelegationRequest,
  idempotentReplay: boolean
): DurableDelegationHandle {
  const synthesisStep = graph.steps.find((step) => step.executor.role === "synthesis");
  return {
    taskId: graph.task.id,
    status: graph.task.status,
    executionPreference: graph.task.executionPreference,
    execution: "waiting",
    backgroundContinuation: "unknown",
    stepCount: graph.steps.length,
    workerStepIds: graph.steps.filter((step) => step.executor.role !== "synthesis").map((step) => step.id),
    ...(synthesisStep === undefined
      ? {}
      : { synthesisStepId: synthesisStep.id, primaryResultStepId: synthesisStep.id }),
    childTask: parent !== undefined,
    ...(parent === undefined ? {} : { parentTaskId: parent.taskId }),
    ...(request.recoveredTasksFromJsonString === true ? { recoveredTasksFromJsonString: true } : {}),
    idempotentReplay
  };
}

function delegationCreationKey(profileId: string, sessionId: string, toolCallId: string): string {
  return `delegate:${createHash("sha256").update(`${profileId}\u0000${sessionId}\u0000${toolCallId}`).digest("hex")}`;
}

function boundedToken(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256 || /[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function narrowerDisposition(
  candidate: TaskAuthorityDisposition,
  ceiling: TaskAuthorityDisposition | undefined
): TaskAuthorityDisposition {
  if (ceiling === undefined) return candidate;
  return dispositionRank(candidate) <= dispositionRank(ceiling) ? candidate : ceiling;
}

function dispositionRank(value: TaskAuthorityDisposition): number {
  return value === "forbid" ? 0 : value === "require_approval" ? 1 : 2;
}
