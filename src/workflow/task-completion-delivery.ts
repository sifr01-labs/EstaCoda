import { randomUUID } from "node:crypto";
import type {
  Task,
  TaskDeliveryBinding,
  TaskDeliveryDestination,
  TaskResult
} from "../contracts/task.js";
import type { DeliveryTarget } from "../channels/delivery-router.js";
import { TASK_RESULT_PAGE_MAX_CHARS, type TaskResultService } from "./task-result-service.js";
import type { TaskStore } from "./task-store.js";
import { taskPrimaryResult, taskPrimaryResultStepId } from "./task-primary-result.js";

const MAX_DELIVERY_TEXT_CHARS = 100_000;
const MAX_DELIVERY_RESULTS = 64;

export type TaskCompletionDeliveryRouter = {
  deliverText(
    targets: DeliveryTarget[],
    text: string
  ): Promise<Map<string, { success: boolean; error?: string }>>;
};

export type BindTaskCompletionDeliveryInput = {
  taskId: string;
  authorizedSessionId: string;
  deliveryKey: string;
  destination: TaskDeliveryDestination;
};

export type TaskCompletionDeliveryRunResult = {
  recovered: number;
  claimed: number;
  delivered: number;
  failed: number;
};

export class TaskCompletionDeliveryService {
  readonly #store: TaskStore;
  readonly #resultService: TaskResultService;
  readonly #router: TaskCompletionDeliveryRouter;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(options: {
    store: TaskStore;
    resultService: TaskResultService;
    router: TaskCompletionDeliveryRouter;
    now?: () => Date;
    id?: () => string;
  }) {
    this.#store = options.store;
    this.#resultService = options.resultService;
    this.#router = options.router;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
  }

  bind(input: BindTaskCompletionDeliveryInput): TaskDeliveryBinding {
    const destination = validateDestination(input.destination);
    const deliveryKey = boundedToken(input.deliveryKey, "delivery key", 256);
    const now = this.#now().toISOString();
    const binding: TaskDeliveryBinding = {
      id: boundedToken(this.#id(), "delivery ID", 256),
      profileId: this.#store.profileId,
      taskId: boundedToken(input.taskId, "Task ID", 256),
      authorizedSessionId: boundedToken(input.authorizedSessionId, "authorized session ID", 256),
      deliveryKey,
      destination,
      status: "pending",
      createdAt: now,
      updatedAt: now
    };
    this.#store.atomicWrite((store) => store.createDeliveryBinding(binding));
    return binding;
  }

  /**
   * Explicitly retries a confirmed failed delivery. Ambiguous post-crash outcomes
   * stay failed so an operator cannot accidentally duplicate an external message.
   */
  retry(bindingId: string, authorizedSessionId: string): TaskDeliveryBinding {
    const id = boundedToken(bindingId, "delivery ID", 256);
    const sessionId = boundedToken(authorizedSessionId, "authorized session ID", 256);
    const binding = this.#store.getDeliveryBinding(id);
    if (binding === null || binding.authorizedSessionId !== sessionId) {
      throw new Error("Task completion delivery was not found or is not authorized for this session.");
    }
    return this.#store.retryDeliveryBinding(
      id,
      this.#now().toISOString()
    );
  }

  /**
   * A process may have sent an external message before crashing. Those outcomes are
   * deliberately marked ambiguous and are never retried automatically.
   */
  recoverInterrupted(): number {
    let recovered = 0;
    for (const binding of this.#store.listDeliveryBindings({ statuses: ["delivering"], limit: 1_000 })) {
      this.#store.settleDeliveryBinding({
        id: binding.id,
        status: "failed",
        settledAt: this.#now().toISOString(),
        failureClass: "delivery-outcome-unknown",
        failureMessage: "The previous delivery process stopped before confirming the external outcome."
      });
      recovered++;
    }
    return recovered;
  }

  async runOnce(): Promise<TaskCompletionDeliveryRunResult> {
    const result: TaskCompletionDeliveryRunResult = {
      recovered: 0,
      claimed: 0,
      delivered: 0,
      failed: 0
    };
    const pending = this.#store.listDeliveryBindings({ statuses: ["pending"], limit: 1_000 });
    for (const candidate of pending) {
      const claimed = this.#store.claimDeliveryBinding(candidate.id, this.#now().toISOString());
      if (claimed === null) continue;
      result.claimed++;
      let text: string;
      try {
        const task = this.#store.getTask(claimed.taskId);
        if (task === null) throw new Error("task-unavailable");
        text = await this.#renderCompletion(task, claimed);
      } catch {
        this.#store.settleDeliveryBinding({
          id: claimed.id,
          status: "failed",
          settledAt: this.#now().toISOString(),
          failureClass: "delivery-preparation-failed",
          failureMessage: "Task completion delivery could not be prepared."
        });
        result.failed++;
        continue;
      }
      let delivery: Map<string, { success: boolean; error?: string }>;
      try {
        delivery = await this.#router.deliverText([toDeliveryTarget(claimed.destination)], text);
      } catch {
        this.#store.settleDeliveryBinding({
          id: claimed.id,
          status: "failed",
          settledAt: this.#now().toISOString(),
          failureClass: "delivery-outcome-unknown",
          failureMessage: "Task completion delivery ended without a confirmed external outcome."
        });
        result.failed++;
        continue;
      }
      if (delivery.size !== 1 || [...delivery.values()].some((entry) => !entry.success)) {
        this.#store.settleDeliveryBinding({
          id: claimed.id,
          status: "failed",
          settledAt: this.#now().toISOString(),
          failureClass: "delivery-failed",
          failureMessage: "Task completion delivery failed."
        });
        result.failed++;
        continue;
      }
      this.#store.settleDeliveryBinding({
        id: claimed.id,
        status: "delivered",
        settledAt: this.#now().toISOString()
      });
      result.delivered++;
    }
    return result;
  }

  async #renderCompletion(task: Task, binding: TaskDeliveryBinding): Promise<string> {
    const lines = [
      `Task ${task.id} ${task.status}.`,
      `Objective: ${boundText(task.objective, 2_000)}`
    ];
    if (task.failure !== undefined) lines.push(`Failure: ${boundText(task.failure.class, 80)}`);

    const availableResults = this.#store.listResults(task.id)
      .filter((result) => result.status === "available");
    const primaryResultStepId = taskPrimaryResultStepId(this.#store, task);
    const primaryResult = taskPrimaryResult(this.#store, task);
    const results = (primaryResultStepId === undefined
      ? availableResults
      : primaryResult === undefined ? [] : [primaryResult])
      .slice(0, MAX_DELIVERY_RESULTS);
    for (const result of results) {
      lines.push("", resultHeading(result, result.id === primaryResult?.id));
      if (result.kind === "artifact") {
        lines.push(`Artifact handle: ${result.handle}`);
        if (result.summary !== undefined) lines.push(boundText(result.summary, 1_000));
        continue;
      }
      lines.push(await this.#readTextResult(task.id, result, binding.authorizedSessionId));
    }
    if (results.length === 0) {
      lines.push("", primaryResultStepId === undefined
        ? "No durable results were produced."
        : "No durable primary result was produced.");
    }
    if (availableResults.length > results.length) {
      const label = primaryResultStepId === undefined ? "additional" : "intermediate";
      lines.push("", `${availableResults.length - results.length} ${label} result(s) remain available through task.result.read.`);
    }
    return boundText(lines.join("\n"), MAX_DELIVERY_TEXT_CHARS);
  }

  async #readTextResult(taskId: string, result: TaskResult, sessionId: string): Promise<string> {
    let offset = 0;
    let content = "";
    do {
      const page = await this.#resultService.readPage({
        taskId,
        resultId: result.id,
        sessionId,
        offset,
        maxChars: Math.min(TASK_RESULT_PAGE_MAX_CHARS, MAX_DELIVERY_TEXT_CHARS - content.length)
      });
      content += page.content;
      if (!page.hasMore || page.nextOffset === undefined || content.length >= MAX_DELIVERY_TEXT_CHARS) break;
      offset = page.nextOffset;
    } while (content.length < MAX_DELIVERY_TEXT_CHARS);
    return content;
  }
}

function validateDestination(destination: TaskDeliveryDestination): TaskDeliveryDestination {
  if (destination.platform === "email") {
    const address = boundedToken(destination.address, "email delivery address", 320);
    if (destination.chatId !== undefined || destination.threadId !== undefined) {
      throw new Error("Email Task delivery cannot include chat routing fields.");
    }
    return { platform: "email", address };
  }
  const chatId = boundedToken(destination.chatId, "delivery chat ID", 256);
  const threadId = destination.threadId === undefined
    ? undefined
    : boundedToken(destination.threadId, "delivery thread ID", 256);
  if (destination.address !== undefined) {
    throw new Error("Chat Task delivery cannot include an email address.");
  }
  return { platform: destination.platform, chatId, ...(threadId === undefined ? {} : { threadId }) };
}

function toDeliveryTarget(destination: TaskDeliveryDestination): DeliveryTarget {
  return destination.platform === "email"
    ? { kind: "channel", platform: "email", address: destination.address }
    : {
        kind: "channel",
        platform: destination.platform,
        chatId: destination.chatId,
        ...(destination.threadId === undefined ? {} : { threadId: destination.threadId })
      };
}

function resultHeading(result: TaskResult, primary: boolean): string {
  return `${primary ? "Primary result" : "Result"} ${result.id} (${result.kind}, ${result.byteLength} bytes, handle ${result.handle}):`;
}

function boundedToken(value: string | undefined, label: string, maxChars: number): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0 || normalized.length > maxChars ||
      /[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new Error(`Task ${label} is invalid.`);
  }
  return normalized;
}

function boundText(value: string, maxChars: number): string {
  const normalized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ");
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 3)}...`;
}
