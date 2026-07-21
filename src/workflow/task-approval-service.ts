import { createHash, randomUUID } from "node:crypto";
import type { SecurityAssessment, SecurityPolicy, SecurityRequest } from "../contracts/security.js";
import { assessSecurityPolicy } from "../contracts/security.js";
import type { Task, TaskApprovalLink, TaskAttempt, TaskStep } from "../contracts/task.js";
import type { PendingApproval, PendingApprovalCreationOptions } from "../gateway/approval-queue.js";
import type { TaskStore } from "./task-store.js";

type ApprovalQueue = {
  createPendingApproval(
    approval: Omit<PendingApproval, "id" | "status">,
    options?: PendingApprovalCreationOptions
  ): Promise<PendingApproval>;
  getApproval(id: string, scope: { profileId: string; sessionId?: string }): Promise<PendingApproval | undefined>;
};

export type TaskApprovalRequest = {
  toolName: string;
  riskClass: TaskApprovalLink["riskClass"];
  targetFingerprint: string;
  targetPreview: string;
};

export type TaskApprovalServiceOptions = {
  store: TaskStore;
  queue?: ApprovalQueue;
  now?: () => Date;
  id?: () => string;
  ttlMs?: number;
};

const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000;

/** Bridges an in-process security ask to the shared durable, session-authorized approval queue. */
export class TaskApprovalService {
  readonly #store: TaskStore;
  readonly #queue: ApprovalQueue | undefined;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #ttlMs: number;
  readonly #requests = new Map<string, TaskApprovalRequest>();
  readonly #approvedRequests = new Map<string, TaskApprovalRequest[]>();

  constructor(options: TaskApprovalServiceOptions) {
    this.#store = options.store;
    this.#queue = options.queue;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
    this.#ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS, "Task approval TTL");
  }

  securityPolicyFor(
    task: Task,
    step: TaskStep,
    attempt: TaskAttempt,
    basePolicy: SecurityPolicy
  ): SecurityPolicy {
    const decide = (request: SecurityRequest) => {
      const baseDecision = basePolicy.decide(request);
      return this.#narrowDecision(task, step, attempt, request, baseDecision);
    };
    return {
      decide,
      assess: async (request) => {
        const base = await assessSecurityPolicy(basePolicy, request);
        const decision = this.#narrowDecision(task, step, attempt, request, base.decision);
        // Persist one deterministic approval boundary at a time. A later replay can
        // surface the next gated call after the first exact target is approved.
        if (decision === "ask" && !this.#requests.has(attempt.id)) {
          this.#requests.set(attempt.id, approvalRequest(request));
        }
        if (decision === "allow" && this.#matchingApproved(attempt.id, taskApprovalFingerprint(request)) !== undefined) {
          const approved = this.#approvedRequests.get(attempt.id) ?? [];
          approved.push(approvalRequest(request));
          this.#approvedRequests.set(attempt.id, approved);
        }
        if (decision === base.decision) return base;
        return taskAssessment(base, decision);
      }
    };
  }

  takeRequest(attemptId: string): TaskApprovalRequest | undefined {
    const request = this.#requests.get(attemptId);
    this.#requests.delete(attemptId);
    return request;
  }

  takeApprovedRequests(attemptId: string): readonly TaskApprovalRequest[] {
    const requests = this.#approvedRequests.get(attemptId) ?? [];
    this.#approvedRequests.delete(attemptId);
    return requests;
  }

  clearAttempt(attemptId: string): void {
    this.#requests.delete(attemptId);
    this.#approvedRequests.delete(attemptId);
  }

  createLink(input: {
    task: Task;
    step: TaskStep;
    attempt: TaskAttempt;
    request: TaskApprovalRequest;
  }): TaskApprovalLink {
    const sessionId = input.task.creatorSessionId;
    if (sessionId === undefined) throw new Error("A durable approval requires the Task creator session.");
    const now = this.#now();
    return {
      id: this.#id(),
      profileId: input.task.profileId,
      taskId: input.task.id,
      planRevisionId: input.step.planRevisionId,
      stepId: input.step.id,
      attemptId: input.attempt.id,
      authorizedSessionId: sessionId,
      toolName: input.request.toolName,
      riskClass: input.request.riskClass,
      targetFingerprint: input.request.targetFingerprint,
      targetPreview: input.request.targetPreview,
      status: "requesting",
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
      updatedAt: now.toISOString()
    };
  }

  async reconcile(options: { eligibleTaskIds?: ReadonlySet<string> } = {}): Promise<void> {
    const links = this.#store.listApprovalLinks({ statuses: ["requesting", "pending"], limit: 1_000 });
    for (const link of links) {
      if (options.eligibleTaskIds !== undefined && !options.eligibleTaskIds.has(link.taskId)) continue;
      if (link.status === "requesting") await this.#enqueue(link);
      else await this.#refresh(link);
    }
  }

  consumeApproved(attemptId: string, request: TaskApprovalRequest): void {
    const link = this.#matchingApproved(attemptId, request.targetFingerprint);
    if (link === undefined) return;
    const now = this.#now().toISOString();
    this.#store.atomicWrite((store) => store.updateApprovalLink({
      ...link,
      status: "consumed",
      updatedAt: now,
      consumedAt: now
    }));
  }

  #narrowDecision(
    task: Task,
    step: TaskStep,
    attempt: TaskAttempt,
    request: SecurityRequest,
    baseDecision: "allow" | "ask" | "deny"
  ): "allow" | "ask" | "deny" {
    if (baseDecision === "deny") return "deny";
    const taskDisposition = task.authorityPolicy.riskClassPolicy[request.riskClass];
    const stepDisposition = step.authorityPolicy.riskClassPolicy[request.riskClass];
    if (taskDisposition === "forbid" || stepDisposition === "forbid") return "deny";
    const fingerprint = taskApprovalFingerprint(request);
    if (this.#matchingApproved(attempt.id, fingerprint) !== undefined) return "allow";
    if (taskDisposition === "require_approval" || stepDisposition === "require_approval") return "ask";
    return baseDecision;
  }

  #matchingApproved(attemptId: string, fingerprint: string): TaskApprovalLink | undefined {
    return this.#store.listApprovalLinks({ attemptId, statuses: ["approved"], limit: 10 })
      .find((link) => link.targetFingerprint === fingerprint && Date.parse(link.expiresAt) > this.#now().getTime());
  }

  async #enqueue(link: TaskApprovalLink): Promise<void> {
    if (this.#queue === undefined) return;
    const pending = await this.#queue.createPendingApproval(
      {
        sessionId: link.authorizedSessionId,
        profileId: link.profileId,
        commandPreview: link.targetPreview,
        commandHash: link.targetFingerprint,
        toolName: link.toolName,
        approvalKind: "command",
        requestedAt: new Date(link.requestedAt),
        expiresAt: new Date(link.expiresAt),
        channel: "cli"
      },
      { idempotencyKey: `task-approval:${link.id}` }
    );
    const now = this.#now().toISOString();
    const status = pending.status === "pending" ? "pending" : pending.status;
    this.#store.atomicWrite((store) => store.updateApprovalLink({
      ...link,
      pendingApprovalId: pending.id,
      status,
      updatedAt: now,
      ...(status === "pending" ? {} : { resolvedAt: pending.resolvedAt?.toISOString() ?? now })
    }));
  }

  async #refresh(link: TaskApprovalLink): Promise<void> {
    if (this.#queue === undefined || link.pendingApprovalId === undefined) return;
    const pending = await this.#queue.getApproval(link.pendingApprovalId, {
      profileId: link.profileId,
      sessionId: link.authorizedSessionId
    });
    if (pending === undefined || pending.status === "pending") return;
    const now = this.#now().toISOString();
    this.#store.atomicWrite((store) => store.updateApprovalLink({
      ...link,
      status: pending.status,
      updatedAt: now,
      resolvedAt: pending.resolvedAt?.toISOString() ?? now
    }));
  }
}

export function taskApprovalFingerprint(request: SecurityRequest): string {
  const commandHash = request.command === undefined
    ? ""
    : createHash("sha256").update(request.command).digest("hex");
  const digest = createHash("sha256").update(JSON.stringify([
    request.toolName ?? "",
    request.riskClass,
    request.targetKey ?? "",
    request.targetSummary ?? "",
    commandHash
  ])).digest("hex");
  return `sha256:${digest}`;
}

function approvalRequest(request: SecurityRequest): TaskApprovalRequest {
  return {
    toolName: bounded(request.toolName ?? "unknown-tool", 120),
    riskClass: request.riskClass,
    targetFingerprint: taskApprovalFingerprint(request),
    targetPreview: bounded(request.targetSummary ?? request.targetKey ?? request.description, 240)
  };
}

function taskAssessment(
  base: SecurityAssessment,
  decision: "allow" | "ask" | "deny"
): SecurityAssessment {
  return {
    ...base,
    decision,
    reason: decision === "allow"
      ? "Allowed by an exact, durable Task approval after the runtime policy accepted the operation."
      : decision === "deny"
        ? "Denied by the durable Task authority ceiling."
        : "Durable Task approval is required before this operation can run."
  };
}

function bounded(value: string, maxChars: number): string {
  const normalized = value.replace(/[\u0000-\u001F\u007F]/gu, " ").trim();
  return (normalized.length === 0 ? "Task operation" : normalized).slice(0, maxChars);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}
