import { createHash } from "node:crypto";
import type { SessionDB, SessionMessage } from "../contracts/session.js";
import type { Task, TaskDeliveryBinding, TaskResult } from "../contracts/task.js";
import { verifiedCompressionLineage } from "../session/session-lineage.js";
import { TASK_RESULT_PAGE_MAX_CHARS, type TaskResultService } from "./task-result-service.js";
import type { TaskStore } from "./task-store.js";
import { taskPrimaryResult, taskPrimaryResultStepId } from "./task-primary-result.js";

const MAX_SESSION_COMPLETION_CHARS = 100_000;
const MAX_SESSION_COMPLETION_BINDINGS = 1_000;
const INTERRUPTED_LOCAL_DELIVERY_MS = 30_000;

type TaskCompletionSessionDb = Pick<SessionDB, "appendMessage" | "getSession"> & {
  getMessage(id: string): Promise<SessionMessage | undefined>;
};

export type TaskSessionCompletionMessage = {
  readonly bindingId: string;
  readonly messageId: string;
  readonly taskId: string;
  readonly resultId: string;
  readonly text: string;
};

/**
 * Moves accepted Task answers into their originating interactive transcript.
 *
 * The Task Delivery binding is the durable outbox record. The deterministic
 * SessionMessage ID makes the local append retryable after a crash, unlike an
 * external channel send whose outcome can be ambiguous.
 */
export class TaskSessionCompletionService {
  readonly #store: TaskStore;
  readonly #resultService: TaskResultService;
  readonly #sessionDb: TaskCompletionSessionDb;
  readonly #profileId: string;
  readonly #now: () => Date;
  readonly #runs = new Map<string, Promise<readonly TaskSessionCompletionMessage[]>>();

  constructor(options: {
    store: TaskStore;
    resultService: TaskResultService;
    sessionDb: TaskCompletionSessionDb;
    profileId: string;
    now?: () => Date;
  }) {
    if (options.store.profileId !== options.profileId) {
      throw new Error("Task session completion profile does not match its TaskStore profile.");
    }
    this.#store = options.store;
    this.#resultService = options.resultService;
    this.#sessionDb = options.sessionDb;
    this.#profileId = options.profileId;
    this.#now = options.now ?? (() => new Date());
  }

  deliverPending(sessionId: string): Promise<readonly TaskSessionCompletionMessage[]> {
    const normalizedSessionId = boundedSessionId(sessionId);
    const current = this.#runs.get(normalizedSessionId);
    if (current !== undefined) return current;
    const run = this.#deliverPending(normalizedSessionId).finally(() => {
      if (this.#runs.get(normalizedSessionId) === run) this.#runs.delete(normalizedSessionId);
    });
    this.#runs.set(normalizedSessionId, run);
    return run;
  }

  async acknowledge(input: { sessionId: string; bindingId: string; messageId: string }): Promise<void> {
    const sessionId = boundedSessionId(input.sessionId);
    const lineage = await verifiedCompressionLineage(this.#sessionDb, sessionId, this.#profileId);
    if (lineage === undefined) throw new Error("Task session completion acknowledgement is not authorized.");
    const binding = this.#store.getDeliveryBinding(input.bindingId);
    if (binding === null || binding.destination.platform !== "cli" ||
        !lineage.some((session) => session.id === binding.authorizedSessionId) ||
        input.messageId !== taskSessionCompletionMessageId(this.#profileId, binding.id) ||
        !(await this.#completionMessageExists(binding))) {
      throw new Error("Task session completion acknowledgement is invalid or unauthorized.");
    }
    if (binding.status === "delivered") return;
    if (binding.status !== "delivering") {
      throw new Error("Task session completion is not awaiting display acknowledgement.");
    }
    this.#settleDelivered(binding);
  }

  async #deliverPending(sessionId: string): Promise<readonly TaskSessionCompletionMessage[]> {
    const lineage = await verifiedCompressionLineage(this.#sessionDb, sessionId, this.#profileId);
    if (lineage === undefined) return [];
    const authorizedSessionIds = new Set(lineage.map((session) => session.id));
    const delivered = await this.#recoverInterrupted(authorizedSessionIds);
    const candidates = this.#store.listDeliveryBindings({ statuses: ["pending"], limit: MAX_SESSION_COMPLETION_BINDINGS })
      .filter((binding) => binding.destination.platform === "cli" && authorizedSessionIds.has(binding.authorizedSessionId));
    for (const candidate of candidates) {
      const claimed = this.#store.claimDeliveryBinding(candidate.id, this.#now().toISOString());
      if (claimed === null) continue;
      const messageId = taskSessionCompletionMessageId(this.#profileId, claimed.id);
      const existing = await this.#completionMessage(claimed);
      if (existing !== undefined) {
        delivered.push(existing);
        continue;
      }
      try {
        const task = this.#store.getTask(claimed.taskId);
        if (task === null) throw new Error("Task is unavailable.");
        const result = sessionCompletionResult(this.#store, task);
        if (result === undefined) throw new Error("Task has no accepted terminal answer.");
        const text = await this.#readResult(task.id, result, sessionId);
        const message = await this.#appendMessage({
          id: messageId,
          sessionId,
          taskId: task.id,
          resultId: result.id,
          bindingId: claimed.id,
          text,
        });
        delivered.push({
          bindingId: claimed.id,
          messageId: message.id,
          taskId: task.id,
          resultId: result.id,
          text: message.content,
        });
      } catch (error) {
        const recovered = await this.#completionMessage(claimed);
        if (recovered !== undefined) {
          delivered.push(recovered);
          continue;
        }
        this.#requeuePreparationFailure(claimed, error);
      }
    }
    return delivered;
  }

  async #recoverInterrupted(
    authorizedSessionIds: ReadonlySet<string>
  ): Promise<TaskSessionCompletionMessage[]> {
    const recovered: TaskSessionCompletionMessage[] = [];
    const interrupted = this.#store.listDeliveryBindings({ statuses: ["delivering"], limit: MAX_SESSION_COMPLETION_BINDINGS })
      .filter((binding) => binding.destination.platform === "cli" && authorizedSessionIds.has(binding.authorizedSessionId));
    for (const binding of interrupted) {
      const startedAt = binding.startedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(binding.startedAt);
      if (Number.isFinite(startedAt) && this.#now().getTime() - startedAt < INTERRUPTED_LOCAL_DELIVERY_MS) continue;
      const message = await this.#completionMessage(binding);
      if (message !== undefined) {
        recovered.push(message);
        continue;
      }
      this.#requeuePreparationFailure(binding, new Error("Local Task completion delivery was interrupted."));
    }
    return recovered;
  }

  async #appendMessage(input: {
    id: string;
    sessionId: string;
    taskId: string;
    resultId: string;
    bindingId: string;
    text: string;
  }): Promise<SessionMessage> {
    return await this.#sessionDb.appendMessage({
      id: input.id,
      sessionId: input.sessionId,
      role: "agent",
      channel: "cli",
      content: input.text,
      metadata: {
        taskCompletion: {
          version: 1,
          bindingId: input.bindingId,
          taskId: input.taskId,
          resultId: input.resultId,
        },
      },
    });
  }

  async #completionMessage(binding: TaskDeliveryBinding): Promise<TaskSessionCompletionMessage | undefined> {
    const message = await this.#sessionDb.getMessage(taskSessionCompletionMessageId(this.#profileId, binding.id));
    if (message?.role !== "agent" || message.channel !== "cli") return undefined;
    const completion = message.metadata?.taskCompletion;
    if (typeof completion !== "object" || completion === null) return undefined;
    const metadata = completion as Record<string, unknown>;
    if (metadata.version !== 1 || metadata.bindingId !== binding.id || metadata.taskId !== binding.taskId ||
        typeof metadata.resultId !== "string") {
      return undefined;
    }
    return {
      bindingId: binding.id,
      messageId: message.id,
      taskId: binding.taskId,
      resultId: metadata.resultId,
      text: message.content,
    };
  }

  async #completionMessageExists(binding: TaskDeliveryBinding): Promise<boolean> {
    return await this.#completionMessage(binding) !== undefined;
  }

  async #readResult(taskId: string, result: TaskResult, sessionId: string): Promise<string> {
    let offset = 0;
    let content = "";
    while (content.length < MAX_SESSION_COMPLETION_CHARS) {
      const page = await this.#resultService.readPage({
        taskId,
        resultId: result.id,
        sessionId,
        offset,
        maxChars: Math.min(TASK_RESULT_PAGE_MAX_CHARS, MAX_SESSION_COMPLETION_CHARS - content.length),
      });
      content += page.content;
      if (!page.hasMore || page.nextOffset === undefined) return content;
      offset = page.nextOffset;
    }
    return `${content}\n\n[Task answer truncated in the session; open Task inspection to read the durable result.]`;
  }

  #settleDelivered(binding: TaskDeliveryBinding): void {
    this.#store.settleDeliveryBinding({
      id: binding.id,
      status: "delivered",
      settledAt: this.#now().toISOString(),
    });
  }

  #requeuePreparationFailure(binding: TaskDeliveryBinding, error: unknown): void {
    const timestamp = this.#now().toISOString();
    this.#store.settleDeliveryBinding({
      id: binding.id,
      status: "failed",
      settledAt: timestamp,
      failureClass: "delivery-preparation-failed",
      failureMessage: boundedFailure(error),
    });
    this.#store.retryDeliveryBinding(binding.id, timestamp);
  }
}

function sessionCompletionResult(store: TaskStore, task: Task): TaskResult | undefined {
  const primaryStepId = taskPrimaryResultStepId(store, task);
  if (primaryStepId !== undefined) return taskPrimaryResult(store, task);
  const accepted = store.listResults(task.id)
    .filter((result) => result.status === "available" && result.disposition === "accepted");
  return accepted.length === 1 ? accepted[0] : undefined;
}

export function taskSessionCompletionMessageId(profileId: string, bindingId: string): string {
  const digest = createHash("sha256").update(`${profileId}\0${bindingId}`).digest("hex");
  return `task-completion-${digest}`;
}

function boundedSessionId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256 || /[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new Error("Task session completion requires a valid session ID.");
  }
  return normalized;
}

function boundedFailure(error: unknown): string {
  const value = error instanceof Error ? error.message : "Task completion delivery could not be prepared.";
  const normalized = value.replace(/[\u0000-\u001F\u007F]/gu, " ").trim();
  return (normalized.length === 0 ? "Task completion delivery could not be prepared." : normalized).slice(0, 1_000);
}
