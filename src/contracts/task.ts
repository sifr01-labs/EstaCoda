import type { ProviderId } from "./provider.js";
import type { ToolRiskClass, ToolsetName } from "./tool.js";

// Durable Task identities are opaque storage keys. They are never authorization boundaries.
export type TaskId = string;
export type TaskPlanRevisionId = string;
export type TaskStepId = string;
export type TaskAttemptId = string;
export type TaskEventId = string;
export type TaskResultId = string;
export type TaskDeliveryId = string;

export type TaskGraphLimits = {
  readonly maxSteps: number;
  readonly maxDependencies: number;
  readonly maxDependenciesPerStep: number;
  readonly maxConcurrentAttempts: number;
  readonly maxTaskObjectiveChars: number;
  readonly maxStepTitleChars: number;
  readonly maxStepObjectiveChars: number;
  readonly maxToolsetsPerStep: number;
  readonly maxToolsPerStep: number;
  readonly maxAttemptsPerStep: number;
  readonly maxResultBytesPerStep: number;
  readonly maxModelIdChars: number;
};

export const TASK_GRAPH_LIMITS: TaskGraphLimits = Object.freeze({
  maxSteps: 64,
  maxDependencies: 256,
  maxDependenciesPerStep: 16,
  maxConcurrentAttempts: 10,
  maxTaskObjectiveChars: 8_000,
  maxStepTitleChars: 160,
  maxStepObjectiveChars: 4_000,
  maxToolsetsPerStep: 32,
  maxToolsPerStep: 128,
  maxAttemptsPerStep: 10,
  maxResultBytesPerStep: 10 * 1024 * 1024,
  maxModelIdChars: 200
});

export type TaskStatus =
  | "planning"
  | "queued"
  | "running"
  | "waiting_for_host"
  | "waiting_for_input"
  | "waiting_for_approval"
  | "paused"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export type TaskPlanRevisionStatus =
  | "draft"
  | "validated"
  | "active"
  | "superseded"
  | "rejected";

export type TaskStepStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_for_input"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export type TaskAttemptStatus =
  | "queued"
  | "leased"
  | "running"
  | "waiting_for_input"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "expired";

export type TaskSource = "cli" | "gateway" | "delegation" | "runtime";

export type TaskActor = {
  kind: "user" | "agent" | "system";
  sessionId?: string;
  taskId?: TaskId;
  attemptId?: TaskAttemptId;
};

export type TaskWorkspaceBinding = {
  /** Canonical real path captured at creation. Trust is still rechecked before execution. */
  canonicalPath: string;
  /** Stable hash of the canonical path for comparison and display-safe diagnostics. */
  identityHash: string;
};

/**
 * Task authority can only narrow the runtime security policy. "runtime_policy" is not
 * an allow decision: the normal trust, hardline, and approval checks still decide.
 */
export type TaskAuthorityDisposition = "forbid" | "require_approval" | "runtime_policy";

export const TASK_TOOL_RISK_CLASSES: readonly ToolRiskClass[] = [
  "read-only-local",
  "read-only-network",
  "workspace-write",
  "external-side-effect",
  "credential-access",
  "destructive-local",
  "shared-state-mutation",
  "spend-money",
  "sandbox-escape"
];

export type TaskAuthorityPolicy = {
  allowedToolsets: readonly ToolsetName[];
  /** Undefined means any tool within allowed toolsets, subject to blockedTools and runtime policy. */
  allowedTools?: readonly string[];
  blockedTools: readonly string[];
  riskClassPolicy: Readonly<Record<ToolRiskClass, TaskAuthorityDisposition>>;
  mayCreateChildTasks: boolean;
  /** Remaining descendant generations. A child must receive a strictly smaller value. */
  maxChildDepth: number;
};

export type TaskBudgetPolicy = {
  maxConcurrentAttempts: number;
  maxProviderCalls: number;
  maxTotalTokens: number;
  maxEstimatedCostUsd: number;
  maxWallClockMs: number;
};

export type TaskStepBudget = Omit<TaskBudgetPolicy, "maxConcurrentAttempts">;

export type TaskRetryPolicy = {
  maxAttempts: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  retryableFailureClasses: readonly string[];
  nonRetryableFailureClasses: readonly string[];
  requireIdempotent: boolean;
};

export type TaskFailurePolicy = {
  onAttemptsExhausted: "fail_task" | "mark_partial" | "skip_if_optional" | "wait_for_operator";
  optional: boolean;
};

export type TaskIdempotency = "idempotent" | "retry_safe" | "non_idempotent" | "unknown";

export type TaskAgentExecutor = {
  kind: "agent";
  role: "worker" | "orchestrator";
  model?: {
    provider?: ProviderId;
    id: string;
  };
};

export type TaskStepResultPolicy = {
  kind: "none" | "text" | "json" | "artifact";
  required: boolean;
  maxBytes: number;
};

export type TaskWaitReason = {
  kind: "user_input" | "approval" | "eligible_host" | "budget" | "operator";
  summary: string;
  requestedAt: string;
  approvalId?: string;
};

export type TaskFailure = {
  class: string;
  message: string;
  retryable: boolean;
  uncertainSideEffects: boolean;
};

export type Task = {
  id: TaskId;
  profileId: string;
  creatorSessionId?: string;
  parentTaskId?: TaskId;
  parentAttemptId?: TaskAttemptId;
  source: TaskSource;
  /** Distinct from Attempt.dispatchKey; deduplicates Task creation requests. */
  creationKey?: string;
  objective: string;
  status: TaskStatus;
  workspace: TaskWorkspaceBinding;
  authorityPolicy: TaskAuthorityPolicy;
  budgetPolicy: TaskBudgetPolicy;
  activePlanRevisionId?: TaskPlanRevisionId;
  waitReason?: TaskWaitReason;
  failure?: TaskFailure;
  createdBy: TaskActor;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
};

export type TaskPlanRevision = {
  id: TaskPlanRevisionId;
  profileId: string;
  taskId: TaskId;
  revision: number;
  status: TaskPlanRevisionStatus;
  reason: string;
  createdBy: TaskActor;
  createdAt: string;
  validatedAt?: string;
  activatedAt?: string;
  supersededAt?: string;
};

export type TaskStep = {
  id: TaskStepId;
  profileId: string;
  taskId: TaskId;
  planRevisionId: TaskPlanRevisionId;
  /** Stable plan-local key suitable for dependency and result labels. */
  key: string;
  position: number;
  status: TaskStepStatus;
  title: string;
  objective: string;
  dependsOn: readonly TaskStepId[];
  executor: TaskAgentExecutor;
  authorityPolicy: TaskAuthorityPolicy;
  budget: TaskStepBudget;
  retryPolicy: TaskRetryPolicy;
  failurePolicy: TaskFailurePolicy;
  idempotency: TaskIdempotency;
  resultPolicy: TaskStepResultPolicy;
  createdAt: string;
  updatedAt: string;
};

export type TaskAttemptLease = {
  attemptId: TaskAttemptId;
  profileId: string;
  taskId: TaskId;
  ownerId: string;
  /** Monotonically increasing token that must be presented for every settlement write. */
  fencingToken: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  /** Durable cancellation signal observed by the lease owner during heartbeat. */
  cancellationRequestedAt?: string;
};

export type TaskUsageTotals = {
  providerCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  usageComplete: boolean;
  pricingComplete: boolean;
  incompleteReasons: readonly string[];
};

export type TaskAttempt = {
  id: TaskAttemptId;
  profileId: string;
  taskId: TaskId;
  planRevisionId: TaskPlanRevisionId;
  stepId: TaskStepId;
  attemptNumber: number;
  status: TaskAttemptStatus;
  dispatchKey: string;
  workerSessionId?: string;
  trajectoryId?: string;
  lease?: TaskAttemptLease;
  usage: TaskUsageTotals;
  failure?: TaskFailure;
  resultIds: readonly TaskResultId[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type TaskResultKind = "text" | "json" | "artifact" | "summary";
export type TaskResultStatus = "available" | "pruned";

export type TaskResult = {
  id: TaskResultId;
  profileId: string;
  taskId: TaskId;
  stepId?: TaskStepId;
  attemptId?: TaskAttemptId;
  kind: TaskResultKind;
  status: TaskResultStatus;
  /** Opaque model- and UI-safe handle. Never an internal filesystem path. */
  handle: string;
  byteLength: number;
  contentHash: string;
  mimeType?: string;
  summary?: string;
  createdAt: string;
  expiresAt?: string;
  prunedAt?: string;
};

export type TaskSessionLink = {
  taskId: TaskId;
  profileId: string;
  sessionId: string;
  relationship: "creator" | "worker" | "observer";
  stepId?: TaskStepId;
  attemptId?: TaskAttemptId;
  createdAt: string;
};

export type TaskDeliveryStatus = "pending" | "delivering" | "delivered" | "failed";

export type TaskDeliveryDestination = {
  platform: "telegram" | "discord" | "whatsapp" | "email";
  chatId?: string;
  threadId?: string;
  address?: string;
};

/** Durable, profile-owned completion destination authorized by a Task-linked session. */
export type TaskDeliveryBinding = {
  id: TaskDeliveryId;
  profileId: string;
  taskId: TaskId;
  authorizedSessionId: string;
  /** Caller-supplied idempotency key for one logical destination binding. */
  deliveryKey: string;
  destination: TaskDeliveryDestination;
  status: TaskDeliveryStatus;
  failureClass?: string;
  failureMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  deliveredAt?: string;
  failedAt?: string;
};

export function isTaskDeliveryDestination(value: unknown): value is TaskDeliveryDestination {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TaskDeliveryDestination>;
  if (candidate.platform === "email") {
    return isBoundedDeliveryToken(candidate.address, 320) &&
      candidate.chatId === undefined && candidate.threadId === undefined;
  }
  return (candidate.platform === "telegram" || candidate.platform === "discord" || candidate.platform === "whatsapp") &&
    isBoundedDeliveryToken(candidate.chatId, 256) &&
    (candidate.threadId === undefined || isBoundedDeliveryToken(candidate.threadId, 256)) &&
    candidate.address === undefined;
}

function isBoundedDeliveryToken(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxChars &&
    !/[\u0000-\u001F\u007F]/u.test(value);
}

export type TaskEventKind =
  | "task-created"
  | "task-state-changed"
  | "plan-revision-created"
  | "plan-revision-validated"
  | "plan-revision-activated"
  | "plan-revision-rejected"
  | "plan-revision-superseded"
  | "step-state-changed"
  | "attempt-created"
  | "attempt-leased"
  | "attempt-started"
  | "attempt-progressed"
  | "attempt-waiting"
  | "attempt-completed"
  | "attempt-failed"
  | "attempt-cancelled"
  | "attempt-interrupted"
  | "attempt-expired"
  | "approval-requested"
  | "approval-resolved"
  | "usage-recorded"
  | "result-recorded";

export type TaskEvent = {
  id: TaskEventId;
  profileId: string;
  taskId: TaskId;
  planRevisionId?: TaskPlanRevisionId;
  stepId?: TaskStepId;
  attemptId?: TaskAttemptId;
  kind: TaskEventKind;
  timestamp: string;
  /** Bounded persistence-safe data only; never raw tool input, raw result bodies, or secrets. */
  data: Readonly<Record<string, unknown>>;
};

const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  planning: ["queued", "failed", "cancelled"],
  queued: ["running", "waiting_for_host", "paused", "failed", "cancelled"],
  running: ["waiting_for_host", "waiting_for_input", "waiting_for_approval", "paused", "completed", "partial", "failed", "cancelled"],
  waiting_for_host: ["queued", "paused", "failed", "cancelled"],
  waiting_for_input: ["queued", "paused", "failed", "cancelled"],
  waiting_for_approval: ["queued", "paused", "failed", "cancelled"],
  paused: ["queued", "failed", "cancelled"],
  completed: [],
  partial: [],
  failed: [],
  cancelled: []
};

const PLAN_REVISION_TRANSITIONS: Readonly<Record<TaskPlanRevisionStatus, readonly TaskPlanRevisionStatus[]>> = {
  draft: ["validated", "rejected"],
  validated: ["active", "rejected"],
  active: ["superseded"],
  superseded: [],
  rejected: []
};

const STEP_TRANSITIONS: Readonly<Record<TaskStepStatus, readonly TaskStepStatus[]>> = {
  pending: ["ready", "skipped", "cancelled"],
  ready: ["running", "skipped", "cancelled"],
  running: ["ready", "waiting_for_input", "waiting_for_approval", "completed", "failed", "skipped", "cancelled"],
  waiting_for_input: ["ready", "failed", "cancelled"],
  waiting_for_approval: ["ready", "failed", "cancelled"],
  completed: [],
  failed: [],
  skipped: [],
  cancelled: []
};

const ATTEMPT_TRANSITIONS: Readonly<Record<TaskAttemptStatus, readonly TaskAttemptStatus[]>> = {
  queued: ["leased", "cancelled"],
  leased: ["queued", "running", "cancelled", "expired"],
  running: ["waiting_for_input", "waiting_for_approval", "completed", "failed", "cancelled", "interrupted", "expired"],
  waiting_for_input: ["queued", "failed", "cancelled", "interrupted"],
  waiting_for_approval: ["queued", "failed", "cancelled", "interrupted"],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
  expired: []
};

export type TaskTransitionEntity = "task" | "plan revision" | "step" | "attempt";

export class IllegalTaskTransitionError extends Error {
  constructor(
    public readonly entity: TaskTransitionEntity,
    public readonly from: string,
    public readonly to: string
  ) {
    super(`Illegal ${entity} transition: ${from} → ${to}`);
    this.name = "IllegalTaskTransitionError";
  }
}

export function isTaskTransitionAllowed(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function isTaskPlanRevisionTransitionAllowed(from: TaskPlanRevisionStatus, to: TaskPlanRevisionStatus): boolean {
  return PLAN_REVISION_TRANSITIONS[from].includes(to);
}

export function isTaskStepTransitionAllowed(from: TaskStepStatus, to: TaskStepStatus): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

export function isTaskAttemptTransitionAllowed(from: TaskAttemptStatus, to: TaskAttemptStatus): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!isTaskTransitionAllowed(from, to)) throw new IllegalTaskTransitionError("task", from, to);
}

export function assertTaskPlanRevisionTransition(from: TaskPlanRevisionStatus, to: TaskPlanRevisionStatus): void {
  if (!isTaskPlanRevisionTransitionAllowed(from, to)) throw new IllegalTaskTransitionError("plan revision", from, to);
}

export function assertTaskStepTransition(from: TaskStepStatus, to: TaskStepStatus): void {
  if (!isTaskStepTransitionAllowed(from, to)) throw new IllegalTaskTransitionError("step", from, to);
}

export function assertTaskAttemptTransition(from: TaskAttemptStatus, to: TaskAttemptStatus): void {
  if (!isTaskAttemptTransitionAllowed(from, to)) throw new IllegalTaskTransitionError("attempt", from, to);
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "partial" || status === "failed" || status === "cancelled";
}

export function isTerminalTaskPlanRevisionStatus(status: TaskPlanRevisionStatus): boolean {
  return status === "superseded" || status === "rejected";
}

export function isTerminalTaskStepStatus(status: TaskStepStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped" || status === "cancelled";
}

export function isTerminalTaskAttemptStatus(status: TaskAttemptStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted" || status === "expired";
}

export type TaskPlanValidationIssueCode =
  | "task-id-empty"
  | "task-profile-id-empty"
  | "task-workspace-invalid"
  | "task-objective-empty"
  | "task-objective-too-long"
  | "task-authority-invalid"
  | "plan-id-empty"
  | "plan-task-mismatch"
  | "plan-profile-mismatch"
  | "plan-revision-invalid"
  | "plan-empty"
  | "plan-too-many-steps"
  | "plan-too-many-dependencies"
  | "step-id-empty"
  | "step-id-duplicate"
  | "step-key-empty"
  | "step-key-duplicate"
  | "step-task-mismatch"
  | "step-profile-mismatch"
  | "step-plan-revision-mismatch"
  | "step-position-invalid"
  | "step-position-duplicate"
  | "step-title-empty"
  | "step-title-too-long"
  | "step-objective-empty"
  | "step-objective-too-long"
  | "step-executor-invalid"
  | "step-too-many-dependencies"
  | "step-dependency-duplicate"
  | "step-dependency-self"
  | "step-dependency-missing"
  | "plan-cycle"
  | "step-authority-invalid"
  | "step-authority-exceeds-task"
  | "task-budget-invalid"
  | "step-budget-invalid"
  | "step-budget-exceeds-task"
  | "step-retry-policy-invalid"
  | "step-failure-policy-invalid"
  | "step-result-policy-invalid";

export type TaskPlanValidationIssue = {
  code: TaskPlanValidationIssueCode;
  message: string;
  stepId?: TaskStepId;
};

export type TaskPlanValidationInput = {
  task: Pick<Task, "id" | "profileId" | "objective" | "workspace" | "authorityPolicy" | "budgetPolicy">;
  revision: TaskPlanRevision;
  steps: readonly TaskStep[];
};

export type TaskPlanValidationResult = {
  ok: boolean;
  issues: readonly TaskPlanValidationIssue[];
  /** Present only for a valid plan; dependencies always precede their consumers. */
  topologicalOrder?: readonly TaskStepId[];
};

export function validateTaskPlan(
  input: TaskPlanValidationInput,
  limits: TaskGraphLimits = TASK_GRAPH_LIMITS
): TaskPlanValidationResult {
  const issues: TaskPlanValidationIssue[] = [];
  if (input.task.id.trim().length === 0) {
    issues.push(issue("task-id-empty", "Task ID must not be empty."));
  }
  if (input.task.profileId.trim().length === 0) {
    issues.push(issue("task-profile-id-empty", "Task profile ID must not be empty."));
  }
  if (input.task.workspace.canonicalPath.trim().length === 0 || input.task.workspace.identityHash.trim().length === 0) {
    issues.push(issue("task-workspace-invalid", "Task workspace binding must contain a canonical path and identity hash."));
  }
  const objective = input.task.objective.trim();
  if (objective.length === 0) {
    issues.push(issue("task-objective-empty", "Task objective must not be empty."));
  } else if (objective.length > limits.maxTaskObjectiveChars) {
    issues.push(issue("task-objective-too-long", `Task objective exceeds ${limits.maxTaskObjectiveChars} characters.`));
  }

  if (input.revision.id.trim().length === 0) {
    issues.push(issue("plan-id-empty", "Plan revision ID must not be empty."));
  }
  if (input.revision.taskId !== input.task.id) {
    issues.push(issue("plan-task-mismatch", "Plan revision does not belong to the Task."));
  }
  if (input.revision.profileId !== input.task.profileId) {
    issues.push(issue("plan-profile-mismatch", "Plan revision does not belong to the Task profile."));
  }
  if (!positiveSafeInteger(input.revision.revision)) {
    issues.push(issue("plan-revision-invalid", "Plan revision number must be a positive integer."));
  }

  if (input.steps.length === 0) {
    issues.push(issue("plan-empty", "A fixed Task plan must contain at least one Step."));
  }
  if (input.steps.length > limits.maxSteps) {
    issues.push(issue("plan-too-many-steps", `Task plan exceeds the ${limits.maxSteps}-Step limit.`));
  }

  validateTaskAuthority(input.task.authorityPolicy, limits, issues);
  validateTaskBudget(input.task.budgetPolicy, limits, issues);

  // A plan over the hard limit is already invalid. Bound deeper validation so model-proposed
  // input cannot cause unbounded validation work.
  const steps = input.steps.slice(0, limits.maxSteps);
  const stepIds = new Map<TaskStepId, TaskStep>();
  const stepKeys = new Set<string>();
  const positions = new Set<number>();
  let dependencyCount = 0;

  for (const step of steps) {
    const trimmedId = step.id.trim();
    if (trimmedId.length === 0) {
      issues.push(issue("step-id-empty", "Step ID must not be empty.", step.id));
    } else if (stepIds.has(step.id)) {
      issues.push(issue("step-id-duplicate", `Duplicate Step ID: ${step.id}.`, step.id));
    } else {
      stepIds.set(step.id, step);
    }

    const trimmedKey = step.key.trim();
    if (trimmedKey.length === 0) {
      issues.push(issue("step-key-empty", "Step key must not be empty.", step.id));
    } else if (stepKeys.has(trimmedKey)) {
      issues.push(issue("step-key-duplicate", `Duplicate Step key: ${trimmedKey}.`, step.id));
    } else {
      stepKeys.add(trimmedKey);
    }

    if (step.taskId !== input.task.id) {
      issues.push(issue("step-task-mismatch", "Step does not belong to the Task.", step.id));
    }
    if (step.profileId !== input.task.profileId) {
      issues.push(issue("step-profile-mismatch", "Step does not belong to the Task profile.", step.id));
    }
    if (step.planRevisionId !== input.revision.id) {
      issues.push(issue("step-plan-revision-mismatch", "Step does not belong to the PlanRevision.", step.id));
    }
    if (!Number.isSafeInteger(step.position) || step.position < 0 || step.position >= input.steps.length) {
      issues.push(issue("step-position-invalid", "Step position must be a unique zero-based index within the plan.", step.id));
    } else if (positions.has(step.position)) {
      issues.push(issue("step-position-duplicate", `Duplicate Step position: ${step.position}.`, step.id));
    } else {
      positions.add(step.position);
    }

    const title = step.title.trim();
    if (title.length === 0) {
      issues.push(issue("step-title-empty", "Step title must not be empty.", step.id));
    } else if (title.length > limits.maxStepTitleChars) {
      issues.push(issue("step-title-too-long", `Step title exceeds ${limits.maxStepTitleChars} characters.`, step.id));
    }

    const stepObjective = step.objective.trim();
    if (stepObjective.length === 0) {
      issues.push(issue("step-objective-empty", "Step objective must not be empty.", step.id));
    } else if (stepObjective.length > limits.maxStepObjectiveChars) {
      issues.push(issue("step-objective-too-long", `Step objective exceeds ${limits.maxStepObjectiveChars} characters.`, step.id));
    }

    if (
      step.executor.kind !== "agent" ||
      (step.executor.role !== "worker" && step.executor.role !== "orchestrator") ||
      (step.executor.model !== undefined && (
        step.executor.model.id.trim().length === 0 ||
        step.executor.model.id.length > limits.maxModelIdChars
      ))
    ) {
      issues.push(issue("step-executor-invalid", "Step executor is unsupported or contains an invalid model selection.", step.id));
    }

    dependencyCount += step.dependsOn.length;
    if (step.dependsOn.length > limits.maxDependenciesPerStep) {
      issues.push(issue(
        "step-too-many-dependencies",
        `Step exceeds the ${limits.maxDependenciesPerStep}-dependency limit.`,
        step.id
      ));
    }

    validateStepAuthority(step, input.task.authorityPolicy, limits, issues);
    validateStepBudget(step, input.task.budgetPolicy, issues);
    validateRetryPolicy(step, limits, issues);
    validateFailurePolicy(step, issues);
    validateResultPolicy(step, limits, issues);
  }

  if (dependencyCount > limits.maxDependencies) {
    issues.push(issue("plan-too-many-dependencies", `Task plan exceeds the ${limits.maxDependencies}-dependency limit.`));
  }

  for (const step of steps) {
    const seenDependencies = new Set<TaskStepId>();
    for (const dependencyId of step.dependsOn.slice(0, limits.maxDependenciesPerStep)) {
      if (seenDependencies.has(dependencyId)) {
        issues.push(issue("step-dependency-duplicate", `Step repeats dependency ${dependencyId}.`, step.id));
        continue;
      }
      seenDependencies.add(dependencyId);
      if (dependencyId === step.id) {
        issues.push(issue("step-dependency-self", "Step cannot depend on itself.", step.id));
      } else if (!stepIds.has(dependencyId)) {
        issues.push(issue("step-dependency-missing", `Step dependency does not exist: ${dependencyId}.`, step.id));
      }
    }
  }

  const cycleCheckBlocked = issues.some((entry) =>
    entry.code === "step-id-empty" ||
    entry.code === "step-id-duplicate" ||
    entry.code === "step-dependency-self" ||
    entry.code === "step-dependency-missing"
  );
  const topologicalOrder = cycleCheckBlocked ? undefined : topologicalSort(steps, stepIds);
  if (!cycleCheckBlocked && topologicalOrder === undefined && steps.length > 0) {
    issues.push(issue("plan-cycle", "Task plan contains a dependency cycle."));
  }

  return issues.length === 0
    ? { ok: true, issues: [], topologicalOrder }
    : { ok: false, issues };
}

export function isTaskAuthorityNarrowerOrEqual(
  candidate: TaskAuthorityPolicy,
  ceiling: TaskAuthorityPolicy
): boolean {
  if (!isChildDepthConsistent(candidate) || !isChildDepthConsistent(ceiling)) return false;
  const ceilingToolsets = new Set(ceiling.allowedToolsets);
  if (candidate.allowedToolsets.some((toolset) => !ceilingToolsets.has(toolset))) return false;

  if (ceiling.allowedTools !== undefined) {
    if (candidate.allowedTools === undefined) return false;
    const ceilingTools = new Set(ceiling.allowedTools);
    if (candidate.allowedTools.some((tool) => !ceilingTools.has(tool))) return false;
  }

  const candidateBlocked = new Set(candidate.blockedTools);
  if (ceiling.blockedTools.some((tool) => !candidateBlocked.has(tool))) return false;

  for (const riskClass of TASK_TOOL_RISK_CLASSES) {
    if (
      !isAuthorityDisposition(candidate.riskClassPolicy[riskClass]) ||
      !isAuthorityDisposition(ceiling.riskClassPolicy[riskClass])
    ) {
      return false;
    }
    if (authorityRank(candidate.riskClassPolicy[riskClass]) > authorityRank(ceiling.riskClassPolicy[riskClass])) {
      return false;
    }
  }

  if (candidate.mayCreateChildTasks && !ceiling.mayCreateChildTasks) return false;
  return candidate.maxChildDepth <= ceiling.maxChildDepth;
}

export function isChildTaskAuthorityAllowed(
  candidate: TaskAuthorityPolicy,
  parent: TaskAuthorityPolicy
): boolean {
  return isChildDepthConsistent(candidate) &&
    isChildDepthConsistent(parent) &&
    parent.mayCreateChildTasks &&
    parent.maxChildDepth > 0 &&
    candidate.maxChildDepth < parent.maxChildDepth &&
    isTaskAuthorityNarrowerOrEqual(candidate, parent);
}

function validateTaskAuthority(
  authority: TaskAuthorityPolicy,
  limits: TaskGraphLimits,
  issues: TaskPlanValidationIssue[]
): void {
  if (!isAuthorityPolicyValid(authority, limits)) {
    issues.push(issue("task-authority-invalid", "Task authority policy is malformed or exceeds fixed limits."));
  }
}

function validateTaskBudget(
  budget: TaskBudgetPolicy,
  limits: TaskGraphLimits,
  issues: TaskPlanValidationIssue[]
): void {
  if (
    !positiveSafeInteger(budget.maxConcurrentAttempts) ||
    budget.maxConcurrentAttempts > limits.maxConcurrentAttempts ||
    !nonNegativeSafeInteger(budget.maxProviderCalls) ||
    !nonNegativeSafeInteger(budget.maxTotalTokens) ||
    !nonNegativeFinite(budget.maxEstimatedCostUsd) ||
    !positiveSafeInteger(budget.maxWallClockMs)
  ) {
    issues.push(issue("task-budget-invalid", "Task budget contains an invalid or out-of-range limit."));
  }
}

function validateStepAuthority(
  step: TaskStep,
  ceiling: TaskAuthorityPolicy,
  limits: TaskGraphLimits,
  issues: TaskPlanValidationIssue[]
): void {
  if (!isAuthorityPolicyValid(step.authorityPolicy, limits)) {
    issues.push(issue("step-authority-invalid", "Step authority policy is malformed or exceeds fixed limits.", step.id));
    return;
  }

  if (!isTaskAuthorityNarrowerOrEqual(step.authorityPolicy, ceiling)) {
    issues.push(issue("step-authority-exceeds-task", "Step authority exceeds its Task authority ceiling.", step.id));
  }
}

function validateStepBudget(
  step: TaskStep,
  ceiling: TaskBudgetPolicy,
  issues: TaskPlanValidationIssue[]
): void {
  const budget = step.budget;
  if (
    !nonNegativeSafeInteger(budget.maxProviderCalls) ||
    !nonNegativeSafeInteger(budget.maxTotalTokens) ||
    !nonNegativeFinite(budget.maxEstimatedCostUsd) ||
    !positiveSafeInteger(budget.maxWallClockMs)
  ) {
    issues.push(issue("step-budget-invalid", "Step budget contains an invalid limit.", step.id));
    return;
  }

  if (
    budget.maxProviderCalls > ceiling.maxProviderCalls ||
    budget.maxTotalTokens > ceiling.maxTotalTokens ||
    budget.maxEstimatedCostUsd > ceiling.maxEstimatedCostUsd ||
    budget.maxWallClockMs > ceiling.maxWallClockMs
  ) {
    issues.push(issue("step-budget-exceeds-task", "Step budget exceeds its Task budget ceiling.", step.id));
  }
}

function validateRetryPolicy(
  step: TaskStep,
  limits: TaskGraphLimits,
  issues: TaskPlanValidationIssue[]
): void {
  const retry = step.retryPolicy;
  if (
    !positiveSafeInteger(retry.maxAttempts) ||
    retry.maxAttempts > limits.maxAttemptsPerStep ||
    !nonNegativeSafeInteger(retry.initialBackoffMs) ||
    !Number.isFinite(retry.backoffMultiplier) ||
    retry.backoffMultiplier < 1 ||
    !nonNegativeSafeInteger(retry.maxBackoffMs) ||
    retry.initialBackoffMs > retry.maxBackoffMs ||
    !uniqueNonEmptyStrings(retry.retryableFailureClasses) ||
    !uniqueNonEmptyStrings(retry.nonRetryableFailureClasses) ||
    retry.retryableFailureClasses.some((value) => retry.nonRetryableFailureClasses.includes(value)) ||
    (retry.maxAttempts > 1 && retry.requireIdempotent && step.idempotency !== "idempotent" && step.idempotency !== "retry_safe")
  ) {
    issues.push(issue("step-retry-policy-invalid", "Step retry policy is invalid for its idempotency classification.", step.id));
  }
}

function validateFailurePolicy(step: TaskStep, issues: TaskPlanValidationIssue[]): void {
  if (step.failurePolicy.onAttemptsExhausted === "skip_if_optional" && !step.failurePolicy.optional) {
    issues.push(issue(
      "step-failure-policy-invalid",
      "Step can skip on exhausted Attempts only when it is explicitly optional.",
      step.id
    ));
  }
}

function validateResultPolicy(
  step: TaskStep,
  limits: TaskGraphLimits,
  issues: TaskPlanValidationIssue[]
): void {
  const result = step.resultPolicy;
  if (
    !nonNegativeSafeInteger(result.maxBytes) ||
    result.maxBytes > limits.maxResultBytesPerStep ||
    (result.kind === "none" && (result.required || result.maxBytes !== 0)) ||
    (result.kind !== "none" && result.maxBytes === 0)
  ) {
    issues.push(issue("step-result-policy-invalid", "Step result policy is internally inconsistent or exceeds its size limit.", step.id));
  }
}

function topologicalSort(
  steps: readonly TaskStep[],
  stepIds: ReadonlyMap<TaskStepId, TaskStep>
): TaskStepId[] | undefined {
  const inDegree = new Map<TaskStepId, number>();
  const dependents = new Map<TaskStepId, TaskStepId[]>();
  for (const step of steps) {
    inDegree.set(step.id, 0);
    dependents.set(step.id, []);
  }

  for (const step of steps) {
    for (const dependencyId of new Set(step.dependsOn)) {
      if (dependencyId === step.id || !stepIds.has(dependencyId)) continue;
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
      dependents.get(dependencyId)?.push(step.id);
    }
  }

  const position = new Map(steps.map((step) => [step.id, step.position] as const));
  const compare = (left: TaskStepId, right: TaskStepId) =>
    (position.get(left) ?? 0) - (position.get(right) ?? 0) || (left < right ? -1 : left > right ? 1 : 0);
  const ready = steps.filter((step) => (inDegree.get(step.id) ?? 0) === 0).map((step) => step.id).sort(compare);
  const ordered: TaskStepId[] = [];

  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) break;
    ordered.push(current);
    for (const dependentId of dependents.get(current)?.sort(compare) ?? []) {
      const nextDegree = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, nextDegree);
      if (nextDegree === 0) {
        ready.push(dependentId);
        ready.sort(compare);
      }
    }
  }

  return ordered.length === steps.length ? ordered : undefined;
}

function isAuthorityPolicyValid(authority: TaskAuthorityPolicy, limits: TaskGraphLimits): boolean {
  const allowedTools = authority.allowedTools ?? [];
  const blockedTools = new Set(authority.blockedTools);
  return authority.allowedToolsets.length <= limits.maxToolsetsPerStep &&
    allowedTools.length <= limits.maxToolsPerStep &&
    authority.blockedTools.length <= limits.maxToolsPerStep &&
    uniqueNonEmptyStrings(authority.allowedToolsets) &&
    uniqueNonEmptyStrings(allowedTools) &&
    uniqueNonEmptyStrings(authority.blockedTools) &&
    allowedTools.every((tool) => !blockedTools.has(tool)) &&
    isChildDepthConsistent(authority) &&
    TASK_TOOL_RISK_CLASSES.every((riskClass) => isAuthorityDisposition(authority.riskClassPolicy[riskClass]));
}

function isChildDepthConsistent(authority: TaskAuthorityPolicy): boolean {
  return authority.mayCreateChildTasks
    ? positiveSafeInteger(authority.maxChildDepth)
    : authority.maxChildDepth === 0;
}

function issue(code: TaskPlanValidationIssueCode, message: string, stepId?: TaskStepId): TaskPlanValidationIssue {
  return stepId === undefined ? { code, message } : { code, message, stepId };
}

function authorityRank(value: TaskAuthorityDisposition | undefined): number {
  return value === "forbid" ? 0 : value === "require_approval" ? 1 : value === "runtime_policy" ? 2 : Number.POSITIVE_INFINITY;
}

function isAuthorityDisposition(value: unknown): value is TaskAuthorityDisposition {
  return value === "forbid" || value === "require_approval" || value === "runtime_policy";
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function nonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function uniqueNonEmptyStrings(values: readonly string[]): boolean {
  const normalized = values.map((value) => value.trim());
  return normalized.every((value) => value.length > 0) && new Set(normalized).size === normalized.length;
}
