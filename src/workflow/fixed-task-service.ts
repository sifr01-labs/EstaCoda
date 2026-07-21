import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  Task,
  TaskActor,
  TaskAuthorityPolicy,
  TaskBudgetPolicy,
  TaskDeliveryBinding,
  TaskDeliveryDestination,
  TaskEvent,
  TaskExecutionPreference,
  TaskGuidance,
  TaskPlanRevision,
  TaskSource,
  TaskStep,
  TaskWorkspaceBinding
} from "../contracts/task.js";
import {
  isChildTaskAuthorityAllowed,
  isTaskDeliveryDestination,
  isTerminalTaskStatus
} from "../contracts/task.js";
import type { TaskStore } from "./task-store.js";

const MAX_GUIDANCE_RECORDS = 64;

export type FixedTaskStepInput = Pick<
  TaskStep,
  | "key"
  | "title"
  | "objective"
  | "executor"
  | "childTaskPolicy"
  | "authorityPolicy"
  | "budget"
  | "retryPolicy"
  | "failurePolicy"
  | "idempotency"
  | "resultPolicy"
> & {
  /** Stable Step keys, resolved to immutable Step IDs during creation. */
  dependsOn: readonly string[];
};

export type CreateFixedTaskInput = {
  /** Every executable fixed Task has an explicit profile-owned authorization root. */
  creatorSessionId: string;
  source: TaskSource;
  executionPreference?: TaskExecutionPreference;
  creationKey?: string;
  /** Stable origin attribution for a root Task; descendants inherit it unchanged. */
  originTurnId?: string;
  objective: string;
  workspace: TaskWorkspaceBinding;
  authorityPolicy: TaskAuthorityPolicy;
  budgetPolicy: TaskBudgetPolicy;
  steps: readonly FixedTaskStepInput[];
  planReason?: string;
  createdBy?: TaskActor;
  /** Optional completion outbox row, authorized by and bound to the creator session. */
  completionDelivery?: {
    deliveryKey: string;
    destination: TaskDeliveryDestination;
  };
  parent?: {
    taskId: string;
    attemptId: string;
  };
};

export type FixedTaskGraph = {
  task: Task;
  revision: TaskPlanRevision;
  steps: readonly TaskStep[];
  completionDelivery?: TaskDeliveryBinding;
};

type FixedTaskIdKind = "task" | "revision" | "step" | "event" | "guidance" | "delivery";

export class FixedTaskCreationConflictError extends Error {
  constructor() {
    super("The Task creation key is already bound to a different fixed Task definition.");
    this.name = "FixedTaskCreationConflictError";
  }
}

/** Creates immutable, profile-owned fixed Task graphs and durable steering context. */
export class FixedTaskService {
  readonly #store: TaskStore;
  readonly #now: () => Date;
  readonly #id: (kind: FixedTaskIdKind) => string;

  constructor(options: {
    store: TaskStore;
    now?: () => Date;
    id?: (kind: FixedTaskIdKind) => string;
  }) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? ((kind) => `${kind}_${randomUUID()}`);
  }

  create(input: CreateFixedTaskInput): FixedTaskGraph {
    const normalized = normalizeCreateInput(input);
    const existing = normalized.creationKey === undefined
      ? null
      : this.#store.getTaskByCreationKey(normalized.creationKey);
    if (existing !== null) return this.#existingGraph(existing, normalized);
    const parent = normalized.parent;

    const timestamp = this.#now().toISOString();
    const taskId = boundedToken(this.#id("task"), "Task ID", 256);
    const parentTask = parent === undefined ? undefined : this.#store.getTask(parent.taskId) ?? undefined;
    const rootTaskId = parentTask?.rootTaskId ?? taskId;
    const originSessionId = parentTask?.originSessionId ?? normalized.creatorSessionId;
    const originTurnId = parentTask?.originTurnId ?? normalized.originTurnId;
    const revisionId = boundedToken(this.#id("revision"), "PlanRevision ID", 256);
    const createdBy = normalized.createdBy ?? { kind: "user" as const, sessionId: normalized.creatorSessionId };
    const stepIds = new Map(normalized.steps.map((step) => [
      step.key,
      boundedToken(this.#id("step"), "Step ID", 256)
    ]));
    const task: Task = {
      id: taskId,
      profileId: this.#store.profileId,
      creatorSessionId: normalized.creatorSessionId,
      rootTaskId,
      originSessionId,
      ...(originTurnId === undefined ? {} : { originTurnId }),
      ...(parent === undefined ? {} : {
        parentTaskId: parent.taskId,
        parentAttemptId: parent.attemptId
      }),
      source: normalized.source,
      executionPreference: normalized.executionPreference,
      ...(normalized.creationKey === undefined ? {} : { creationKey: normalized.creationKey }),
      objective: normalized.objective,
      status: "queued",
      workspace: normalized.workspace,
      authorityPolicy: normalized.authorityPolicy,
      budgetPolicy: normalized.budgetPolicy,
      activePlanRevisionId: revisionId,
      createdBy,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const revision: TaskPlanRevision = {
      id: revisionId,
      profileId: this.#store.profileId,
      taskId,
      revision: 1,
      status: "active",
      reason: normalized.planReason,
      createdBy,
      createdAt: timestamp,
      validatedAt: timestamp,
      activatedAt: timestamp
    };
    const steps: TaskStep[] = normalized.steps.map((step, position) => ({
      ...step,
      id: stepIds.get(step.key)!,
      profileId: this.#store.profileId,
      taskId,
      planRevisionId: revisionId,
      position,
      status: "pending",
      dependsOn: step.dependsOn.map((key) => stepIds.get(key) ?? `missing:${key}`),
      createdAt: timestamp,
      updatedAt: timestamp
    }));
    const completionDelivery: TaskDeliveryBinding | undefined = normalized.completionDelivery === undefined
      ? undefined
      : {
          id: boundedToken(this.#id("delivery"), "Task Delivery ID", 256),
          profileId: this.#store.profileId,
          taskId,
          authorizedSessionId: normalized.creatorSessionId,
          deliveryKey: normalized.completionDelivery.deliveryKey,
          destination: normalized.completionDelivery.destination,
          status: "pending",
          createdAt: timestamp,
          updatedAt: timestamp
        };
    const graph: FixedTaskGraph = {
      task,
      revision,
      steps,
      ...(completionDelivery === undefined ? {} : { completionDelivery })
    };
    const initialEvents = this.#creationEvents(graph, timestamp);
    try {
      this.#store.atomicWrite((store) => {
        if (normalized.parent !== undefined) {
          const parentContext = this.#validateParent(normalized, task, store);
          store.reserveChildTaskBudget({
            profileId: task.profileId,
            childTaskId: task.id,
            rootTaskId: task.rootTaskId,
            parentTaskId: parentContext.task.id,
            parentStepId: parentContext.step.id,
            parentAttemptId: parentContext.attempt.id,
            budget: task.budgetPolicy,
            createdAt: timestamp
          });
        }
        store.createTaskGraph({ task, revision, steps, initialEvents });
        if (task.parentTaskId !== undefined && task.originSessionId !== task.creatorSessionId) {
          store.linkSession({
            taskId: task.id,
            profileId: task.profileId,
            sessionId: task.originSessionId,
            relationship: "observer",
            createdAt: timestamp
          });
        }
        if (completionDelivery !== undefined) store.createDeliveryBinding(completionDelivery);
      });
      return graph;
    } catch (error) {
      if (normalized.creationKey === undefined) throw error;
      const raced = this.#store.getTaskByCreationKey(normalized.creationKey);
      if (raced === null) throw error;
      return this.#existingGraph(raced, normalized);
    }
  }

  #validateParent(input: NormalizedCreateFixedTaskInput, child: Task, store: TaskStore) {
    const parent = input.parent!;
    const task = store.getTask(parent.taskId);
    const attempt = store.getAttempt(parent.attemptId);
    if (task === null || attempt === null || attempt.taskId !== task.id) {
      throw new Error("The parent Task Attempt was not found in this profile.");
    }
    const step = store.getStep(attempt.stepId);
    if (step === null || step.taskId !== task.id || step.planRevisionId !== attempt.planRevisionId) {
      throw new Error("The parent Task Attempt does not own a valid active Step.");
    }
    if (!isDeepStrictEqual(input.workspace, task.workspace)) {
      throw new Error("A child Task must retain its parent Task workspace binding.");
    }
    if (isTerminalTaskStatus(task.status) || attempt.status !== "running" ||
      task.activePlanRevisionId !== attempt.planRevisionId ||
      input.createdBy?.sessionId !== attempt.workerSessionId) {
      throw new Error("A child Task must be created by its active parent Task Attempt worker.");
    }
    if (step.childTaskPolicy !== "fire_and_forget") {
      throw new Error("The active parent Step forbids runtime child Tasks.");
    }
    if (child.rootTaskId !== task.rootTaskId || child.originSessionId !== task.originSessionId ||
      child.originTurnId !== task.originTurnId) {
      throw new Error("A child Task must inherit its parent Task lineage attribution.");
    }
    if (!isChildTaskAuthorityAllowed(input.authorityPolicy, step.authorityPolicy)) {
      throw new Error("Child Task authority exceeds the active parent Step authority.");
    }
    if (!budgetNarrowerOrEqual(input.budgetPolicy, step.budget)) {
      throw new Error("Child Task budget exceeds the active parent Step budget.");
    }
    return { task, attempt, step };
  }

  steer(input: { taskId: string; authorizedSessionId: string; guidance: string }): TaskGuidance {
    const taskId = boundedToken(input.taskId, "Task ID", 256);
    const sessionId = boundedToken(input.authorizedSessionId, "authorized session ID", 256);
    const guidanceText = boundedText(input.guidance, "Task guidance", 4_000);
    const timestamp = this.#now().toISOString();
    return this.#store.atomicWrite((store) => {
      const task = store.getTask(taskId);
      if (task === null) throw new Error(`Task ${taskId} was not found.`);
      if (isTerminalTaskStatus(task.status)) throw new Error(`Task ${taskId} is already settled.`);
      if (store.listGuidance(taskId).length >= MAX_GUIDANCE_RECORDS) {
        throw new Error(`Task ${taskId} has reached its durable guidance limit.`);
      }
      const guidance: TaskGuidance = {
        id: boundedToken(this.#id("guidance"), "Task Guidance ID", 256),
        profileId: store.profileId,
        taskId,
        authorizedSessionId: sessionId,
        guidance: guidanceText,
        createdAt: timestamp
      };
      store.createGuidance(guidance);
      store.appendEvent({
        id: boundedToken(this.#id("event"), "Task Event ID", 256),
        profileId: store.profileId,
        taskId,
        kind: "task-steered",
        timestamp,
        data: { guidanceId: guidance.id, characterCount: guidance.guidance.length }
      });
      return guidance;
    });
  }

  #existingGraph(task: Task, input: NormalizedCreateFixedTaskInput): FixedTaskGraph {
    const revision = task.activePlanRevisionId === undefined
      ? null
      : this.#store.getPlanRevision(task.activePlanRevisionId);
    if (revision === null) throw new FixedTaskCreationConflictError();
    const steps = this.#store.listSteps(task.id, revision.id);
    const completionDelivery = input.completionDelivery === undefined
      ? undefined
      : this.#store.listDeliveryBindings({ taskId: task.id }).find((binding) =>
          binding.deliveryKey === input.completionDelivery!.deliveryKey
        );
    const graph: FixedTaskGraph = {
      task,
      revision,
      steps,
      ...(completionDelivery === undefined ? {} : { completionDelivery })
    };
    if (input.parent !== undefined) {
      const parent = this.#store.getTask(input.parent.taskId);
      if (parent === null || task.rootTaskId !== parent.rootTaskId ||
        task.originSessionId !== parent.originSessionId || task.originTurnId !== parent.originTurnId) {
        throw new FixedTaskCreationConflictError();
      }
    }
    if (!matchesInput(graph, input)) throw new FixedTaskCreationConflictError();
    return graph;
  }

  #creationEvents(graph: FixedTaskGraph, timestamp: string): TaskEvent[] {
    const common = {
      profileId: this.#store.profileId,
      taskId: graph.task.id,
      planRevisionId: graph.revision.id
    };
    const eventId = (order: number) => `${order}-${boundedToken(this.#id("event"), "Task Event ID", 252)}`;
    return [
      {
        ...common,
        id: eventId(0),
        kind: "task-created",
        timestamp,
        data: { source: graph.task.source, stepCount: graph.steps.length }
      },
      {
        ...common,
        id: eventId(1),
        kind: "plan-revision-created",
        timestamp,
        data: { revision: 1, stepCount: graph.steps.length }
      },
      {
        ...common,
        id: eventId(2),
        kind: "plan-revision-validated",
        timestamp,
        data: { revision: 1 }
      },
      {
        ...common,
        id: eventId(3),
        kind: "plan-revision-activated",
        timestamp,
        data: { revision: 1 }
      }
    ];
  }
}

type NormalizedCreateFixedTaskInput = Omit<
  CreateFixedTaskInput,
  "creationKey" | "originTurnId" | "objective" | "steps" | "planReason" | "completionDelivery" | "executionPreference"
> & {
  executionPreference: TaskExecutionPreference;
  creationKey?: string;
  originTurnId?: string;
  objective: string;
  steps: readonly FixedTaskStepInput[];
  planReason: string;
  completionDelivery?: {
    deliveryKey: string;
    destination: TaskDeliveryDestination;
  };
};

function normalizeCreateInput(input: CreateFixedTaskInput): NormalizedCreateFixedTaskInput {
  const seen = new Set<string>();
  const steps = input.steps.map((step) => {
    const key = boundedToken(step.key, "Step key", 128);
    if (seen.has(key)) throw new Error(`Task Step key is duplicated: ${key}.`);
    seen.add(key);
    return {
      ...step,
      key,
      title: boundedText(step.title, "Step title", 500),
      objective: boundedText(step.objective, "Step objective", 8_000),
      dependsOn: step.dependsOn.map((dependency) => boundedToken(dependency, "Step dependency key", 128))
    };
  });
  const creatorSessionId = boundedToken(input.creatorSessionId, "creator session ID", 256);
  const originTurnId = input.originTurnId === undefined
    ? undefined
    : boundedToken(input.originTurnId, "origin turn ID", 256);
  const completionDelivery = normalizeCompletionDelivery(input.completionDelivery);
  let parent: CreateFixedTaskInput["parent"];
  if (input.parent === undefined) {
    const validSessionActor = input.createdBy === undefined || (
      input.createdBy.kind !== "system" && input.createdBy.sessionId === creatorSessionId &&
      input.createdBy.taskId === undefined && input.createdBy.attemptId === undefined
    );
    if (!validSessionActor) {
      throw new Error("A root fixed Task actor must be its creator session.");
    }
  } else {
    if (originTurnId !== undefined) {
      throw new Error("A child fixed Task inherits origin turn attribution from its parent.");
    }
    parent = {
      taskId: boundedToken(input.parent.taskId, "parent Task ID", 256),
      attemptId: boundedToken(input.parent.attemptId, "parent Attempt ID", 256)
    };
    if (input.createdBy?.kind !== "agent" ||
      input.createdBy.sessionId !== creatorSessionId ||
      input.createdBy.taskId !== parent.taskId ||
      input.createdBy.attemptId !== parent.attemptId) {
      throw new Error("A child fixed Task actor must identify its creator session and parent Task Attempt.");
    }
  }
  return {
    ...input,
    executionPreference: normalizeExecutionPreference(input.executionPreference),
    ...(parent === undefined ? {} : { parent }),
    creatorSessionId,
    ...(originTurnId === undefined ? {} : { originTurnId }),
    ...(completionDelivery === undefined ? {} : { completionDelivery }),
    ...(input.creationKey === undefined
      ? {}
      : { creationKey: boundedToken(input.creationKey, "Task creation key", 256) }),
    objective: boundedText(input.objective, "Task objective", 8_000),
    planReason: boundedText(input.planReason ?? "Initial fixed Task plan.", "Plan reason", 1_000),
    steps
  };
}

function matchesInput(graph: FixedTaskGraph, input: NormalizedCreateFixedTaskInput): boolean {
  const keyById = new Map(graph.steps.map((step) => [step.id, step.key]));
  const actualSteps: FixedTaskStepInput[] = graph.steps.map((step) => ({
    key: step.key,
    title: step.title,
    objective: step.objective,
    dependsOn: step.dependsOn.map((id) => keyById.get(id) ?? `missing:${id}`).sort(),
    executor: step.executor,
    childTaskPolicy: step.childTaskPolicy,
    authorityPolicy: step.authorityPolicy,
    budget: step.budget,
    retryPolicy: step.retryPolicy,
    failurePolicy: step.failurePolicy,
    idempotency: step.idempotency,
    resultPolicy: step.resultPolicy
  }));
  const expectedSteps: FixedTaskStepInput[] = input.steps.map((step) => ({
    ...step,
    dependsOn: [...step.dependsOn].sort()
  }));
  const expectedActor = input.createdBy ?? { kind: "user", sessionId: input.creatorSessionId };
  const deliveryMatches = input.completionDelivery === undefined || (
    graph.completionDelivery?.authorizedSessionId === input.creatorSessionId &&
    graph.completionDelivery.deliveryKey === input.completionDelivery.deliveryKey &&
    isDeepStrictEqual(graph.completionDelivery.destination, input.completionDelivery.destination)
  );
  return deliveryMatches &&
    graph.task.creatorSessionId === input.creatorSessionId &&
    (input.parent !== undefined || (
      graph.task.rootTaskId === graph.task.id &&
      graph.task.originSessionId === input.creatorSessionId &&
      graph.task.originTurnId === input.originTurnId
    )) &&
    graph.task.parentTaskId === input.parent?.taskId &&
    graph.task.parentAttemptId === input.parent?.attemptId &&
    graph.task.source === input.source &&
    graph.task.executionPreference === input.executionPreference &&
    graph.task.creationKey === input.creationKey &&
    graph.task.objective === input.objective &&
    graph.revision.reason === input.planReason &&
    isDeepStrictEqual(graph.task.createdBy, expectedActor) &&
    isDeepStrictEqual(graph.task.workspace, input.workspace) &&
    isDeepStrictEqual(graph.task.authorityPolicy, input.authorityPolicy) &&
    isDeepStrictEqual(graph.task.budgetPolicy, input.budgetPolicy) &&
    isDeepStrictEqual(actualSteps, expectedSteps);
}

function normalizeExecutionPreference(value: TaskExecutionPreference | undefined): TaskExecutionPreference {
  if (value === undefined) return "auto";
  if (value !== "auto" && value !== "background") throw new Error("Task execution preference is invalid.");
  return value;
}

function normalizeCompletionDelivery(
  input: CreateFixedTaskInput["completionDelivery"]
): NormalizedCreateFixedTaskInput["completionDelivery"] {
  if (input === undefined) return undefined;
  const deliveryKey = boundedToken(input.deliveryKey, "Task Delivery key", 256);
  if (!isTaskDeliveryDestination(input.destination)) {
    throw new Error("Task completion delivery destination is invalid.");
  }
  return {
    deliveryKey,
    destination: structuredClone(input.destination)
  };
}

function budgetNarrowerOrEqual(
  candidate: TaskBudgetPolicy,
  ceiling: Omit<TaskBudgetPolicy, "maxConcurrentAttempts">
): boolean {
  return candidate.maxProviderCalls <= ceiling.maxProviderCalls &&
    candidate.maxTotalTokens <= ceiling.maxTotalTokens &&
    candidate.maxEstimatedCostUsd <= ceiling.maxEstimatedCostUsd &&
    candidate.maxWallClockMs <= ceiling.maxWallClockMs;
}

function boundedToken(value: string, label: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxChars || /[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new Error(`${label} is invalid or exceeds ${maxChars} characters.`);
  }
  return normalized;
}

function boundedText(value: string, label: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxChars || /\u0000/u.test(normalized)) {
    throw new Error(`${label} is invalid or exceeds ${maxChars} characters.`);
  }
  return normalized;
}
