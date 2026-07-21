import type {
  Task,
  TaskApprovalLink,
  TaskApprovalStatus,
  TaskAttempt,
  TaskAttemptLease,
  TaskBudgetReservation,
  TaskDeliveryBinding,
  TaskDeliveryStatus,
  TaskEvent,
  TaskEventKind,
  TaskGuidance,
  TaskHostKind,
  TaskHostLease,
  TaskPlanRevision,
  TaskResult,
  TaskSessionLink,
  TaskStatus,
  TaskStep
} from "../contracts/task.js";
import type { ProviderUsageEntry, ProviderUsageQuery } from "../contracts/provider-usage.js";

export type CreateTaskGraphInput = {
  task: Task;
  revision: TaskPlanRevision;
  steps: readonly TaskStep[];
  /** Creation journal records persisted atomically with the graph. */
  initialEvents?: readonly TaskEvent[];
  /** Optional first host ownership record persisted atomically with a new graph. */
  initialHostLease?: InitialTaskHostLeaseInput;
};

export type ListTasksOptions = {
  statuses?: readonly TaskStatus[];
  limit?: number;
};

export type ListTaskEventsOptions = {
  kinds?: readonly TaskEventKind[];
  stepId?: string;
  attemptId?: string;
  limit?: number;
  order?: "asc" | "desc";
};

export type AcquireTaskAttemptLeaseInput = {
  attemptId: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
};

export type RenewTaskAttemptLeaseInput = {
  attemptId: string;
  ownerId: string;
  fencingToken: number;
  heartbeatAt: string;
  expiresAt: string;
};

export type ReleaseTaskAttemptLeaseInput = {
  attemptId: string;
  ownerId: string;
  fencingToken: number;
};

export type InitialTaskHostLeaseInput = {
  workspaceIdentityHash: string;
  ownerId: string;
  kind: "foreground";
  acquiredAt: string;
  expiresAt: string;
};

export type AcquireTaskHostLeaseInput = Omit<InitialTaskHostLeaseInput, "kind"> & {
  taskId: string;
  kind: TaskHostKind;
};

export type RenewTaskHostLeaseInput = {
  taskId: string;
  workspaceIdentityHash: string;
  ownerId: string;
  kind: TaskHostKind;
  fencingToken: number;
  heartbeatAt: string;
  expiresAt: string;
};

export type ReleaseTaskHostLeaseInput = {
  taskId: string;
  workspaceIdentityHash: string;
  ownerId: string;
  kind: TaskHostKind;
  fencingToken: number;
};

export type ListTaskHostLeasesOptions = {
  workspaceIdentityHash?: string;
  ownerId?: string;
  kind?: TaskHostKind;
  limit?: number;
};

export type ListTaskDeliveryBindingsOptions = {
  taskId?: string;
  statuses?: readonly TaskDeliveryStatus[];
  limit?: number;
};

export type SettleTaskDeliveryInput = {
  id: string;
  status: "delivered" | "failed";
  settledAt: string;
  failureClass?: string;
  failureMessage?: string;
};

export type ListTaskApprovalLinksOptions = {
  taskId?: string;
  attemptId?: string;
  statuses?: readonly TaskApprovalStatus[];
  limit?: number;
};

/** Profile-bound persistence contract. A store instance can never opt out of profile scoping. */
export interface TaskStore {
  readonly profileId: string;

  createTaskGraph(input: CreateTaskGraphInput): void;
  createTask(task: Task): void;
  updateTask(task: Task): void;
  getTask(id: string): Task | null;
  getTaskByCreationKey(creationKey: string): Task | null;
  listTasks(options?: ListTasksOptions): Task[];
  listChildTasks(parentTaskId: string): Task[];
  reserveChildTaskBudget(reservation: TaskBudgetReservation): void;
  listChildTaskBudgetReservations(parentTaskId: string, parentStepId?: string): TaskBudgetReservation[];
  acquireTaskHostLease(input: AcquireTaskHostLeaseInput): TaskHostLease | null;
  renewTaskHostLease(input: RenewTaskHostLeaseInput): TaskHostLease | null;
  releaseTaskHostLease(input: ReleaseTaskHostLeaseInput): boolean;
  getTaskHostLease(taskId: string): TaskHostLease | null;
  listTaskHostLeases(options?: ListTaskHostLeasesOptions): TaskHostLease[];

  createPlanRevisionGraph(revision: TaskPlanRevision, steps: readonly TaskStep[]): void;
  updatePlanRevision(revision: TaskPlanRevision): void;
  getPlanRevision(id: string): TaskPlanRevision | null;
  listPlanRevisions(taskId: string): TaskPlanRevision[];

  updateStep(step: TaskStep): void;
  getStep(id: string): TaskStep | null;
  listSteps(taskId: string, planRevisionId: string): TaskStep[];

  createAttempt(attempt: TaskAttempt): void;
  updateAttempt(attempt: TaskAttempt): void;
  getAttempt(id: string): TaskAttempt | null;
  listAttempts(taskId: string, stepId?: string): TaskAttempt[];
  acquireAttemptLease(input: AcquireTaskAttemptLeaseInput): TaskAttemptLease | null;
  renewAttemptLease(input: RenewTaskAttemptLeaseInput): TaskAttemptLease | null;
  requestAttemptCancellation(attemptId: string, requestedAt: string): TaskAttemptLease | null;
  releaseAttemptLease(input: ReleaseTaskAttemptLeaseInput): boolean;

  recordProviderUsageEntry(entry: ProviderUsageEntry): void;
  listProviderUsageEntries(query?: ProviderUsageQuery): ProviderUsageEntry[];

  recordResult(result: TaskResult): void;
  updateResult(result: TaskResult): void;
  getResult(id: string): TaskResult | null;
  listResults(taskId: string, attemptId?: string): TaskResult[];

  appendEvent(event: TaskEvent): void;
  listEvents(taskId: string, options?: ListTaskEventsOptions): TaskEvent[];

  linkSession(link: TaskSessionLink): void;
  listSessionLinks(taskId: string): TaskSessionLink[];

  createGuidance(guidance: TaskGuidance): void;
  listGuidance(taskId: string): TaskGuidance[];

  createApprovalLink(link: TaskApprovalLink): void;
  updateApprovalLink(link: TaskApprovalLink): void;
  getApprovalLink(id: string): TaskApprovalLink | null;
  listApprovalLinks(options?: ListTaskApprovalLinksOptions): TaskApprovalLink[];

  createDeliveryBinding(binding: TaskDeliveryBinding): void;
  getDeliveryBinding(id: string): TaskDeliveryBinding | null;
  listDeliveryBindings(options?: ListTaskDeliveryBindingsOptions): TaskDeliveryBinding[];
  claimDeliveryBinding(id: string, startedAt: string): TaskDeliveryBinding | null;
  settleDeliveryBinding(input: SettleTaskDeliveryInput): TaskDeliveryBinding;
  retryDeliveryBinding(id: string, retriedAt: string): TaskDeliveryBinding;

  atomicWrite<T>(work: (store: TaskStore) => T): T;
}
