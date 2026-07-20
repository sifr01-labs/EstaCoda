import type {
  Task,
  TaskApprovalLink,
  TaskApprovalStatus,
  TaskAttempt,
  TaskAttemptLease,
  TaskDeliveryBinding,
  TaskDeliveryStatus,
  TaskEvent,
  TaskEventKind,
  TaskPlanRevision,
  TaskResult,
  TaskSessionLink,
  TaskStatus,
  TaskStep,
  TaskUsageEntry
} from "../contracts/task.js";

export type CreateTaskGraphInput = {
  task: Task;
  revision: TaskPlanRevision;
  steps: readonly TaskStep[];
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
  listTasks(options?: ListTasksOptions): Task[];

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

  recordUsageEntry(entry: TaskUsageEntry): void;
  listUsageEntries(taskId: string, attemptId?: string): TaskUsageEntry[];

  recordResult(result: TaskResult): void;
  updateResult(result: TaskResult): void;
  getResult(id: string): TaskResult | null;
  listResults(taskId: string, attemptId?: string): TaskResult[];

  appendEvent(event: TaskEvent): void;
  listEvents(taskId: string, options?: ListTaskEventsOptions): TaskEvent[];

  linkSession(link: TaskSessionLink): void;
  listSessionLinks(taskId: string): TaskSessionLink[];

  createApprovalLink(link: TaskApprovalLink): void;
  updateApprovalLink(link: TaskApprovalLink): void;
  getApprovalLink(id: string): TaskApprovalLink | null;
  listApprovalLinks(options?: ListTaskApprovalLinksOptions): TaskApprovalLink[];

  createDeliveryBinding(binding: TaskDeliveryBinding): void;
  getDeliveryBinding(id: string): TaskDeliveryBinding | null;
  listDeliveryBindings(options?: ListTaskDeliveryBindingsOptions): TaskDeliveryBinding[];
  claimDeliveryBinding(id: string, startedAt: string): TaskDeliveryBinding | null;
  settleDeliveryBinding(input: SettleTaskDeliveryInput): TaskDeliveryBinding;

  atomicWrite<T>(work: (store: TaskStore) => T): T;
}
