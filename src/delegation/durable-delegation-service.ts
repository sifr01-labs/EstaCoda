import { createHash } from "node:crypto";
import type {
  DelegateSynthesis,
  DelegateTaskItem,
  DelegationAccessAudit,
  DelegationConfig,
  DelegationResearchContract,
  DelegationToolDiagnostic
} from "../contracts/delegation.js";
import { MAX_DELEGATE_RESEARCH_SCOPE_LENGTH } from "../contracts/delegation.js";
import type {
  TaskAuthorityDisposition,
  TaskAuthorityPolicy,
  TaskExecutionLimits,
  TaskDeliveryDestination,
  TaskExecutionPreference,
  TaskIdempotency,
  TaskRetryPolicy,
  TaskStep,
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
import { resolveChildToolAccess, type ChildToolAccessResult } from "./toolset-security.js";
import {
  FixedTaskCreationConflictError,
  FixedTaskService,
  type FixedTaskGraph,
  type FixedTaskStepInput
} from "../tasks/fixed-task-service.js";
import type { InitialTaskHostLeaseInput, TaskStore } from "../tasks/task-store.js";
import {
  DEFAULT_SPENDING_WARNING_THRESHOLD_PERCENT,
  assertSpendingLimit,
  cloneSpendingLimit,
  type SpendingLimit
} from "../contracts/budget.js";

const STEP_PROVIDER_CALLS = 45;
const STEP_TOTAL_TOKENS = 1_000_000;
const STEP_RESULT_BYTES = 1_048_576;
const MAX_TASK_SCHEDULING_ALLOWANCE_MS = 30_000;
const TASK_SCHEDULING_ALLOWANCE_RATIO = 0.05;
const DEFAULT_BATCH_SYNTHESIS_OBJECTIVE =
  "Synthesize all delegated results into one coherent, supported final answer. Resolve overlaps and contradictions instead of concatenating the reports.";

export type ActiveTaskExecution = {
  taskId: string;
  planRevisionId: string;
  stepId: string;
  attemptId: string;
  attemptFencingToken: number;
};

export type DurableDelegationRequest = {
  toolCallId: string;
  originTurnId?: string;
  tasks: readonly DelegateTaskItem[];
  /** Multi-Step batches synthesize by default; `false` explicitly creates an inspection-only batch. */
  synthesis?: DelegateSynthesis | false;
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
  /** Present when the Task commit succeeded but foreground activation did not. */
  activationFailure?: "post-commit-activation-failed";
};

export type DelegationAccessErrorCode =
  | "requested-tool-unavailable"
  | "requested-toolset-unavailable"
  | "zero-effective-tools";

/** Safe admission failure raised before a durable Task graph is written. */
export class DelegationAccessError extends Error {
  readonly code: DelegationAccessErrorCode;
  readonly taskIndex: number | undefined;
  readonly access: DelegationAccessAudit;

  constructor(input: {
    code: DelegationAccessErrorCode;
    taskIndex?: number;
    message: string;
    access: DelegationAccessAudit;
  }) {
    super(input.message);
    this.name = "DelegationAccessError";
    this.code = input.code;
    this.taskIndex = input.taskIndex;
    this.access = input.access;
  }
}

export type DelegationResearchContractErrorCode =
  | "invalid-research-contract"
  | "duplicate-research-scope";

/** Deterministic structural research-contract admission failure. */
export class DelegationResearchContractError extends Error {
  readonly code: DelegationResearchContractErrorCode;
  readonly taskIndex: number | undefined;

  constructor(input: {
    code: DelegationResearchContractErrorCode;
    message: string;
    taskIndex?: number;
  }) {
    super(input.message);
    this.name = "DelegationResearchContractError";
    this.code = input.code;
    this.taskIndex = input.taskIndex;
  }
}

type ResolvedDelegationAuthority = {
  authority: TaskAuthorityPolicy;
  access: DelegationAccessAudit;
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
    if (handle.executionPreference === "auto" && this.#onTaskCreated !== undefined) {
      try {
        await this.#onTaskCreated(handle.taskId);
      } catch {
        return {
          ...handle,
          activationFailure: "post-commit-activation-failed"
        };
      }
    }
    return this.#refreshHandle(handle);
  }

  create(request: DurableDelegationRequest): DurableDelegationHandle {
    if (!request.trustedWorkspace) throw new Error("Durable delegation requires a trusted workspace.");
    if (request.tasks.length === 0 || request.tasks.length > this.#config.maxBatchTasks) {
      throw new Error(`Durable delegation requires 1-${this.#config.maxBatchTasks} task items.`);
    }
    const tasks = normalizedResearchItems(request.tasks);
    const toolCallId = boundedToken(request.toolCallId, "provider tool call ID");
    const originTurnId = request.originTurnId === undefined
      ? undefined
      : boundedToken(request.originTurnId, "origin turn ID");
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
    const creationKey = delegationCreationKey(this.#store.profileId, sessionId, originTurnId, toolCallId);
    const existing = this.#store.getTaskByCreationKey(creationKey);
    const synthesis = resolveDelegationSynthesis(request);
    const localCompletionEligible = parent === undefined && (
      synthesis !== undefined || (tasks.length === 1 && request.synthesis !== false)
    );
    const initialHostLease = existing === null && executionPreference === "auto"
      ? this.#taskHostAdmission?.()
      : undefined;
    const existingSteps = existing?.activePlanRevisionId === undefined
      ? []
      : this.#store.listSteps(existing.id, existing.activePlanRevisionId);
    const existingWorkerSteps = existingSteps.filter((step) => step.executor.role !== "synthesis");
    const existingSynthesisStep = existingSteps.find((step) => step.executor.role === "synthesis");
    const resolvedStepAuthorities = tasks.map((item, index) => existing === null
      ? this.#authorityFor(item, parent?.authority, index)
      : replayedAuthority(item, existingWorkerSteps[index]));
    const stepAuthorities = resolvedStepAuthorities.map((resolved) => resolved.authority);
    const resolvedSynthesisAuthority = synthesis === undefined
      ? undefined
      : existing === null
        ? this.#synthesisAuthority(synthesis, parent?.authority)
        : replayedSynthesisAuthority(existingSynthesisStep);
    const allAuthorities = resolvedSynthesisAuthority === undefined
      ? stepAuthorities
      : [...stepAuthorities, resolvedSynthesisAuthority.authority];
    const taskAuthority = mergeAuthorities(allAuthorities);
    const workerCount = tasks.length;
    const hasSynthesis = synthesis !== undefined;
    const executionLimits = delegationExecutionLimits(
      workerCount,
      hasSynthesis,
      this.#config.maxConcurrentChildren,
      this.#config.childTimeoutSeconds,
      parent?.executionLimits
    );
    const workerSteps = tasks.map((item, index): FixedTaskStepInput => {
      const authority = stepAuthorities[index]!;
      const access = resolvedStepAuthorities[index]!.access;
      const idempotency = delegatedStepIdempotency(authority);
      return {
        key: `delegated-${index + 1}`,
        title: tasks.length === 1 ? "Delegated work" : `Delegated work ${index + 1}`,
        objective: delegatedObjective(item),
        dependsOn: [],
        executor: {
          kind: "agent",
          role: item.role === "orchestrator" ? "orchestrator" : "worker",
          delegationAccess: access,
          ...(item.research === undefined ? {} : { research: item.research }),
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
          onAttemptsExhausted: tasks.length === 1 && synthesis === undefined ? "fail_task" : "mark_partial",
          optional: false
        },
        idempotency,
        resultPolicy: { kind: "text", required: true, maxBytes: STEP_RESULT_BYTES }
      };
    });
    const synthesisIdempotency = resolvedSynthesisAuthority === undefined
      ? undefined
      : delegatedStepIdempotency(resolvedSynthesisAuthority.authority);
    const steps: FixedTaskStepInput[] = synthesis === undefined ? workerSteps : [
      ...workerSteps,
      {
        key: "synthesis",
        title: "Synthesize delegated results",
        objective: synthesisObjective(synthesis),
        dependsOn: workerSteps.map((step) => step.key),
        executor: {
          kind: "agent",
          role: "synthesis",
          delegationAccess: resolvedSynthesisAuthority!.access,
          ...(synthesis.modelOverride === undefined ? {} : {
            model: {
              ...(synthesis.modelOverride.provider === undefined
                ? {}
                : { provider: synthesis.modelOverride.provider }),
              id: synthesis.modelOverride.model
            }
          })
        },
        childTaskPolicy: "forbid",
        authorityPolicy: resolvedSynthesisAuthority!.authority,
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
      objective: synthesis !== undefined
        ? synthesisObjective(synthesis)
        : tasks.length === 1
        ? delegatedObjective(tasks[0]!)
        : `Complete ${tasks.length} delegated Steps as one durable Task.`,
      workspace: this.#workspace,
      authorityPolicy: taskAuthority,
      ...(spendingLimit === undefined ? {} : { spendingLimit }),
      executionLimits: executionLimits.task,
      steps,
      planReason: "Created by delegate_task as durable delegated work.",
      ...(initialHostLease === undefined ? {} : { initialHostLease }),
      ...(parent === undefined && originTurnId !== undefined ? { originTurnId } : {}),
      ...(completionDestination === undefined ||
          (completionDestination.platform === "cli" && !localCompletionEligible) ? {} : {
        completionDelivery: {
          deliveryKey: TASK_ORIGIN_COMPLETION_DELIVERY_KEY,
          destination: completionDestination
        }
      }),
      ...(parent === undefined ? {} : {
        parent: {
          taskId: parent.taskId,
          attemptId: parent.attemptId,
          attemptFencingToken: parent.attemptFencingToken
        },
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
    attemptFencingToken: number;
    authority: TaskAuthorityPolicy;
    executionLimits: TaskExecutionLimits;
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
      attemptFencingToken: execution.attemptFencingToken,
      authority: step.authorityPolicy,
      executionLimits: {
        maxConcurrentAttempts: task.executionLimits.maxConcurrentAttempts,
        ...step.executionLimits
      },
      executionPreference: task.executionPreference
    };
  }

  #authorityFor(
    item: DelegateTaskItem,
    ceiling?: TaskAuthorityPolicy,
    taskIndex?: number
  ): ResolvedDelegationAuthority {
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
    const audit = delegationAccessAudit(item, visibleTools, access);
    assertDelegationAccess(item, access, audit, taskIndex);
    const allowedNames = new Set(access.effectiveAllowedTools);
    const allowedDefinitions = visibleTools.filter((tool) => allowedNames.has(tool.name));
    const mayCreateChildTasks = allowedNames.has("delegate_task") && remainingDepth > 0;
    const blockedTools = ceiling === undefined
      ? unique(access.blockedTools.map((tool) => tool.name)).slice(0, TASK_GRAPH_LIMITS.maxToolsPerStep)
      : [...ceiling.blockedTools];
    return {
      access: audit,
      authority: {
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
      }
    };
  }

  #synthesisAuthority(synthesis: DelegateSynthesis, ceiling?: TaskAuthorityPolicy): ResolvedDelegationAuthority {
    let resolved: ResolvedDelegationAuthority;
    try {
      resolved = this.#authorityFor({
        task: synthesis.objective,
        allowedToolsets: ["core"],
        allowedTools: ["task.result.read"],
        role: "leaf",
        modelOverride: synthesis.modelOverride
      }, ceiling);
    } catch (error) {
      if (error instanceof DelegationAccessError) {
        throw new DelegationAccessError({
          code: error.code,
          message: "Durable synthesis requires the task.result.read tool within inherited authority.",
          access: error.access
        });
      }
      throw error;
    }
    if (!resolved.authority.allowedTools?.includes("task.result.read")) {
      throw new Error("Durable synthesis requires the task.result.read tool within inherited authority.");
    }
    return resolved;
  }
}

function delegationAccessAudit(
  item: DelegateTaskItem,
  visibleTools: readonly ToolDefinition[],
  access: ChildToolAccessResult
): DelegationAccessAudit {
  const maxTools = TASK_GRAPH_LIMITS.maxToolsPerStep;
  const parentVisibleTools = unique(visibleTools.map((tool) => tool.name)).sort();
  const strippedTools = access.strippedTools.slice(0, maxTools).map(copyDiagnostic);
  return {
    version: 1,
    requestedTools: normalizedStrings(item.allowedTools),
    requestedToolsets: normalizedStrings(item.allowedToolsets),
    parentVisibleTools: parentVisibleTools.slice(0, maxTools),
    effectiveAllowedTools: [...access.effectiveAllowedTools].sort(),
    effectiveAllowedToolsets: [...access.effectiveAllowedToolsets].sort(),
    strippedTools,
    rejectedRequestedTools: access.rejectedRequestedTools.map(copyDiagnostic),
    rejectedRequestedToolsets: access.rejectedRequestedToolsets.map(copyDiagnostic),
    ...(parentVisibleTools.length <= maxTools
      ? {}
      : { omittedParentVisibleToolCount: parentVisibleTools.length - maxTools }),
    ...(access.strippedTools.length <= maxTools
      ? {}
      : { omittedStrippedToolCount: access.strippedTools.length - maxTools })
  };
}

function assertDelegationAccess(
  item: DelegateTaskItem,
  access: ChildToolAccessResult,
  audit: DelegationAccessAudit,
  taskIndex: number | undefined
): void {
  const effectiveTools = new Set(access.effectiveAllowedTools);
  const unavailableTools = normalizedStrings(item.allowedTools).filter((name) => !effectiveTools.has(name));
  if (unavailableTools.length > 0) {
    throw new DelegationAccessError({
      code: "requested-tool-unavailable",
      taskIndex,
      message: `Delegated work requested unavailable tools: ${unavailableTools.join(", ")}.`,
      access: audit
    });
  }
  const effectiveToolsets = new Set(access.effectiveAllowedToolsets);
  const unavailableToolsets = normalizedStrings(item.allowedToolsets).filter((name) => !effectiveToolsets.has(name));
  if (unavailableToolsets.length > 0) {
    throw new DelegationAccessError({
      code: "requested-toolset-unavailable",
      taskIndex,
      message: `Delegated work requested unavailable toolsets: ${unavailableToolsets.join(", ")}.`,
      access: audit
    });
  }
  if (access.effectiveAllowedTools.length === 0) {
    throw new DelegationAccessError({
      code: "zero-effective-tools",
      taskIndex,
      message: "Delegated work resolved to zero effective tools.",
      access: audit
    });
  }
  const research = item.research;
  if (research?.requireLiveSources === true && !effectiveTools.has("web.search")) {
    throw new DelegationAccessError({
      code: "requested-tool-unavailable",
      taskIndex,
      message: `Research scope '${research.scope}' requires unavailable tool web.search.`,
      access: audit
    });
  }
  if (research?.requireRepositoryEvidence === true) {
    const discoveryTools = ["file.search", "file.grep", "file.glob"];
    if (!effectiveTools.has("file.read") || !discoveryTools.some((name) => effectiveTools.has(name))) {
      throw new DelegationAccessError({
        code: "requested-tool-unavailable",
        taskIndex,
        message: `Research scope '${research.scope}' requires file.read and at least one repository discovery tool.`,
        access: audit
      });
    }
  }
}

function normalizedResearchItems(items: readonly DelegateTaskItem[]): DelegateTaskItem[] {
  const seenScopes = new Set<string>();
  return items.map((item, taskIndex) => {
    const research = item.research;
    if (research === undefined) return item;
    if (typeof research !== "object" || research === null ||
      typeof research.scope !== "string" ||
      typeof research.requireLiveSources !== "boolean" ||
      typeof research.requireRepositoryEvidence !== "boolean") {
      throw new DelegationResearchContractError({
        code: "invalid-research-contract",
        taskIndex,
        message: `Delegated research item ${taskIndex + 1} has an invalid evidence contract.`
      });
    }
    const scope = normalizeResearchScope(research.scope);
    if (scope.length === 0 || scope.length > MAX_DELEGATE_RESEARCH_SCOPE_LENGTH || /[\u0000-\u001F\u007F]/u.test(scope)) {
      throw new DelegationResearchContractError({
        code: "invalid-research-contract",
        taskIndex,
        message: `Delegated research item ${taskIndex + 1} requires a bounded non-empty scope.`
      });
    }
    if (seenScopes.has(scope)) {
      throw new DelegationResearchContractError({
        code: "duplicate-research-scope",
        taskIndex,
        message: `Delegated research scope '${scope}' is duplicated in this batch.`
      });
    }
    seenScopes.add(scope);
    return {
      ...item,
      research: { ...research, scope }
    };
  });
}

function normalizeResearchScope(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function replayedAuthority(
  item: DelegateTaskItem,
  step: TaskStep | undefined
): ResolvedDelegationAuthority {
  const access = step?.executor.delegationAccess;
  if (step === undefined || step.executor.role === "synthesis" || access === undefined ||
    !sameStrings(access.requestedTools, normalizedStrings(item.allowedTools)) ||
    !sameStrings(access.requestedToolsets, normalizedStrings(item.allowedToolsets))) {
    throw new FixedTaskCreationConflictError();
  }
  return {
    authority: step.authorityPolicy,
    access
  };
}

function replayedSynthesisAuthority(step: TaskStep | undefined): ResolvedDelegationAuthority {
  const access = step?.executor.delegationAccess;
  if (step === undefined || step.executor.role !== "synthesis" || access === undefined) {
    throw new FixedTaskCreationConflictError();
  }
  return {
    authority: step.authorityPolicy,
    access
  };
}

function copyDiagnostic(diagnostic: DelegationToolDiagnostic): DelegationToolDiagnostic {
  return {
    name: diagnostic.name,
    reasons: [...diagnostic.reasons],
    ...(diagnostic.toolsets === undefined ? {} : { toolsets: [...diagnostic.toolsets].sort() }),
    ...(diagnostic.riskClass === undefined ? {} : { riskClass: diagnostic.riskClass })
  };
}

function normalizedStrings<T extends string>(values: readonly T[] | undefined): T[] {
  return unique((values ?? []).map((value) => value.trim()).filter((value): value is T => value.length > 0)).sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
  workerCount: number,
  hasSynthesis: boolean,
  maxConcurrentChildren: number,
  timeoutSeconds: number,
  ceiling?: TaskExecutionLimits
): {
  task: TaskExecutionLimits;
  step: TaskStepExecutionLimits;
} {
  const stepCount = workerCount + (hasSynthesis ? 1 : 0);
  const maxConcurrentAttempts = Math.min(
    stepCount,
    maxConcurrentChildren,
    TASK_GRAPH_LIMITS.maxConcurrentAttempts,
    ceiling?.maxConcurrentAttempts ?? Number.MAX_SAFE_INTEGER
  );
  const workerCapacity = Math.min(workerCount, maxConcurrentAttempts);
  const workerWaveCount = Math.ceil(workerCount / workerCapacity);
  const scheduledPhaseCount = workerWaveCount + (hasSynthesis ? 1 : 0);
  const wall = Math.max(1, Math.floor(timeoutSeconds * 1_000));
  const phaseWall = ceiling === undefined
    ? wall
    : Math.max(1, Math.floor(ceiling.maxWallClockMs / scheduledPhaseCount));
  let rootTaskWall = ceiling?.maxWallClockMs;
  if (rootTaskWall === undefined) {
    const workerWall = wall * workerWaveCount;
    const synthesisWall = hasSynthesis ? wall : 0;
    const scheduledWall = workerWall + synthesisWall;
    if (!Number.isSafeInteger(scheduledWall)) {
      throw new Error("Delegation wall-clock limit exceeds the safe integer range.");
    }
    const schedulingAllowance = Math.min(
      MAX_TASK_SCHEDULING_ALLOWANCE_MS,
      Math.max(1, Math.floor(scheduledWall * TASK_SCHEDULING_ALLOWANCE_RATIO))
    );
    rootTaskWall = scheduledWall + schedulingAllowance;
    if (!Number.isSafeInteger(rootTaskWall)) {
      throw new Error("Delegation wall-clock limit exceeds the safe integer range.");
    }
  }
  const totalCalls = STEP_PROVIDER_CALLS * stepCount;
  const totalTokens = STEP_TOTAL_TOKENS * stepCount;
  const task: TaskExecutionLimits = ceiling === undefined ? {
    maxConcurrentAttempts,
    maxProviderCalls: totalCalls,
    maxTotalTokens: totalTokens,
    maxWallClockMs: rootTaskWall
  } : {
    maxConcurrentAttempts,
    maxProviderCalls: ceiling.maxProviderCalls,
    maxTotalTokens: ceiling.maxTotalTokens,
    maxWallClockMs: ceiling.maxWallClockMs
  };
  return {
    task,
    step: {
      maxProviderCalls: ceiling === undefined ? STEP_PROVIDER_CALLS : Math.floor(ceiling.maxProviderCalls / stepCount),
      maxTotalTokens: ceiling === undefined ? STEP_TOTAL_TOKENS : Math.floor(ceiling.maxTotalTokens / stepCount),
      maxWallClockMs: phaseWall
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
  const baseObjective = item.context?.trim()
    ? `${item.task.trim()}\n\nContext:\n${item.context.trim()}`
    : item.task.trim();
  const objective = item.research === undefined
    ? baseObjective
    : `${baseObjective}\n\n${researchContractBlock(item.research)}`;
  if (objective.length === 0 || objective.length > TASK_GRAPH_LIMITS.maxStepObjectiveChars || objective.includes("\u0000")) {
    throw new Error(`A delegated Step objective must be 1-${TASK_GRAPH_LIMITS.maxStepObjectiveChars} characters.`);
  }
  return objective;
}

function researchContractBlock(research: DelegationResearchContract): string {
  return [
    "Research evidence contract:",
    `- Assigned scope: ${research.scope}`,
    `- Live-source evidence: ${research.requireLiveSources ? "required" : "not required"}`,
    `- Repository evidence: ${research.requireRepositoryEvidence ? "required" : "not required"}`,
    "- Cite every supported live-source claim with an HTTP(S) source returned by web.search.",
    "- Cite repository findings with workspace-relative file references observed through file tools.",
    "- If required evidence cannot be obtained, report the gap explicitly; never substitute training knowledge or fabricate citations."
  ].join("\n");
}

function synthesisObjective(synthesis: DelegateSynthesis): string {
  const objective = synthesis.objective.trim();
  if (objective.length === 0 || objective.length > TASK_GRAPH_LIMITS.maxStepObjectiveChars || objective.includes("\u0000")) {
    throw new Error(`A synthesis objective must be 1-${TASK_GRAPH_LIMITS.maxStepObjectiveChars} characters.`);
  }
  return objective;
}

function resolveDelegationSynthesis(request: DurableDelegationRequest): DelegateSynthesis | undefined {
  if (request.synthesis === false) return undefined;
  if (request.synthesis !== undefined) return request.synthesis;
  if (request.tasks.length < 2) return undefined;
  return { objective: DEFAULT_BATCH_SYNTHESIS_OBJECTIVE };
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

function delegationCreationKey(
  profileId: string,
  sessionId: string,
  originTurnId: string | undefined,
  toolCallId: string
): string {
  const digest = createHash("sha256")
    .update(`${profileId}\u0000${sessionId}\u0000${originTurnId ?? ""}\u0000${toolCallId}`)
    .digest("hex");
  return `delegate:v2:${digest}`;
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
