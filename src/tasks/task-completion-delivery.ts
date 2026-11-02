import { randomUUID } from "node:crypto";
import type {
  Task,
  TaskDeliveryBinding,
  TaskDeliveryDestination,
  TaskResult
} from "../contracts/task.js";
import type { ChannelTextOptions } from "../contracts/channel.js";
import type { DeliveryTarget } from "../channels/delivery-router.js";
import { TASK_RESULT_PAGE_MAX_CHARS, type TaskResultService } from "./task-result-service.js";
import type { TaskStore } from "./task-store.js";
import { deliveredReportPath, taskPrimaryResult, taskPrimaryResultStepId, taskRequestCompletion } from "./task-primary-result.js";
import { listTaskTreeUsageEntries } from "./task-tree-accounting.js";
import { taskUsageFromEntries } from "./task-agent-usage.js";
import { formatUsageCost, formatUsageCostNotice, formatUsdAmount } from "../ui/usage-cost-format.js";
import { spendingBudgetSummary } from "../providers/provider-spend-projection.js";
import { formatSpendingThresholdWarning } from "../ui/spending-warning-format.js";
import { isolateLtr, isolateRtl } from "../ui/bidi.js";

const MAX_DELIVERY_TEXT_CHARS = 100_000;
const MAX_DELIVERY_RESULTS = 64;

export type TaskCompletionDeliveryRouter = {
  deliverText(
    targets: DeliveryTarget[],
    text: string,
    options?: ChannelTextOptions
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
  recoveryFailed: number;
  claimed: number;
  delivered: number;
  failed: number;
};

export type TaskCompletionDeliveryRecoveryResult = {
  recovered: number;
  failed: number;
};

export class TaskCompletionDeliveryService {
  readonly #store: TaskStore;
  readonly #resultService: TaskResultService;
  readonly #router: TaskCompletionDeliveryRouter;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #locale: "en" | "ar";

  constructor(options: {
    store: TaskStore;
    resultService: TaskResultService;
    router: TaskCompletionDeliveryRouter;
    now?: () => Date;
    id?: () => string;
    locale?: "en" | "ar";
  }) {
    this.#store = options.store;
    this.#resultService = options.resultService;
    this.#router = options.router;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
    this.#locale = options.locale ?? "en";
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
  recoverInterrupted(): TaskCompletionDeliveryRecoveryResult {
    const result: TaskCompletionDeliveryRecoveryResult = { recovered: 0, failed: 0 };
    for (const warning of this.#store.listProviderSpendingWarningDeliveries({
      statuses: ["delivering"],
      limit: 1_000
    })) {
      try {
        this.#store.settleProviderSpendingWarningDelivery({
          id: warning.id,
          status: "failed",
          settledAt: this.#now().toISOString(),
          failureClass: "delivery-outcome-unknown",
          failureMessage: "The previous warning delivery process stopped before confirming the external outcome."
        });
        result.recovered++;
      } catch {
        result.failed++;
      }
    }
    for (const binding of this.#store.listDeliveryBindings({ statuses: ["delivering"], limit: 1_000 })) {
      if (binding.destination.platform === "cli") continue;
      try {
        this.#store.settleDeliveryBinding({
          id: binding.id,
          status: "failed",
          settledAt: this.#now().toISOString(),
          failureClass: "delivery-outcome-unknown",
          failureMessage: "The previous delivery process stopped before confirming the external outcome."
        });
        result.recovered++;
      } catch {
        result.failed++;
      }
    }
    return result;
  }

  async runOnce(): Promise<TaskCompletionDeliveryRunResult> {
    const result: TaskCompletionDeliveryRunResult = {
      recovered: 0,
      recoveryFailed: 0,
      claimed: 0,
      delivered: 0,
      failed: 0
    };
    const warnings = this.#store.listProviderSpendingWarningDeliveries({ statuses: ["pending"], limit: 1_000 });
    for (const candidate of warnings) {
      const claimed = this.#store.claimProviderSpendingWarningDelivery(candidate.id, this.#now().toISOString());
      if (claimed === null) continue;
      result.claimed++;
      const binding = this.#store.getDeliveryBinding(claimed.deliveryBindingId);
      if (binding === null || binding.destination.platform === "cli") {
        this.#store.settleProviderSpendingWarningDelivery({
          id: claimed.id,
          status: "failed",
          settledAt: this.#now().toISOString(),
          failureClass: "delivery-preparation-failed",
          failureMessage: "The authorized external warning destination is unavailable."
        });
        result.failed++;
        continue;
      }
      const taskPrefix = claimed.rootTaskId === undefined
        ? ""
        : this.#locale === "ar"
          ? `${isolateRtl("المهمة")} ${isolateLtr(claimed.rootTaskId)}\n`
          : `Task ${claimed.rootTaskId}\n`;
      let delivery: Map<string, { success: boolean; error?: string }>;
      try {
        delivery = await this.#router.deliverText(
          [toDeliveryTarget(binding.destination)],
          `${taskPrefix}${formatSpendingThresholdWarning(claimed, this.#locale)}`
        );
      } catch {
        this.#store.settleProviderSpendingWarningDelivery({
          id: claimed.id,
          status: "failed",
          settledAt: this.#now().toISOString(),
          failureClass: "delivery-outcome-unknown",
          failureMessage: "Warning delivery ended without a confirmed external outcome."
        });
        result.failed++;
        continue;
      }
      if (delivery.size !== 1 || [...delivery.values()].some((entry) => !entry.success)) {
        this.#store.settleProviderSpendingWarningDelivery({
          id: claimed.id,
          status: "failed",
          settledAt: this.#now().toISOString(),
          failureClass: "delivery-failed",
          failureMessage: "Provider spending warning delivery failed."
        });
        result.failed++;
        continue;
      }
      this.#store.settleProviderSpendingWarningDelivery({
        id: claimed.id,
        status: "delivered",
        settledAt: this.#now().toISOString()
      });
      result.delivered++;
    }
    const pending = this.#store.listDeliveryBindings({ statuses: ["pending"], limit: 1_000 });
    for (const candidate of pending) {
      if (candidate.destination.platform === "cli") continue;
      const claimed = this.#store.claimDeliveryBinding(candidate.id, this.#now().toISOString());
      if (claimed === null) continue;
      result.claimed++;
      let message: { text: string; options?: ChannelTextOptions };
      try {
        const task = this.#store.getTask(claimed.taskId);
        if (task === null) throw new Error("task-unavailable");
        message = await this.#renderCompletion(task, claimed);
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
        delivery = await this.#router.deliverText([toDeliveryTarget(claimed.destination)], message.text, message.options);
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
          failureClass: message.options?.report === undefined ? "delivery-failed" : "delivery-outcome-unknown",
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

  async #renderCompletion(task: Task, binding: TaskDeliveryBinding): Promise<{ text: string; options?: ChannelTextOptions }> {
    const available = this.#store.listResults(task.id).filter((result) => result.status === "available");
    const primaryStepId = taskPrimaryResultStepId(this.#store, task);
    const primary = taskPrimaryResult(this.#store, task);
    const accepted = available.filter((result) => result.disposition === "accepted");
    const selected = primaryStepId === undefined ? accepted : primary === undefined ? [] : [primary];
    const results = selected.slice(0, MAX_DELIVERY_RESULTS);
    const bodies: string[] = [];
    let remaining = MAX_DELIVERY_TEXT_CHARS;
    let excerpted = selected.length > results.length;
    for (const result of results) {
      if (remaining <= 0) {
        excerpted = true;
        bodies.push(copy(this.#locale, "[Delivery excerpt limit reached. Ask me for the remaining saved results.]", "[بلغ المقتطف حد التسليم. يمكنك طلب بقية النتائج المحفوظة.]"));
        break;
      }
      if (result.kind === "artifact") {
        bodies.push(copy(this.#locale, "**Additional output**", "**مخرجات إضافية**"),
          boundText(result.displaySummary ?? result.summary ?? copy(this.#locale, "An output is saved with this task.", "حُفظت مخرجات هذه المهمة."), 1_000),
          copy(this.#locale, "Ask me to retrieve the saved output.", "يمكنك أن تطلب مني استرجاع المخرجات المحفوظة."));
      } else {
        const content = await this.#readTextResult(task.id, result, binding.authorizedSessionId, remaining);
        bodies.push(content.text);
        remaining -= content.text.length;
        excerpted ||= content.truncated;
      }
    }
    const filePending = taskRequestCompletion(this.#store, task).fileOutputPending;
    const status = task.status === "cancelled" ? copy(this.#locale, "Work cancelled", "أُلغي العمل")
      : task.status === "failed" ? copy(this.#locale, "Work stopped before completion", "توقف العمل قبل اكتماله")
      : results.length === 0 ? copy(this.#locale, "No answer available", "لا توجد إجابة متاحة")
      : task.status === "partial" || filePending ? copy(this.#locale, "Partially complete", "اكتمل جزئيًا")
      : copy(this.#locale, "Result ready", "النتيجة جاهزة");
    const notices: string[] = [];
    if (task.status === "partial") notices.push(copy(this.#locale,
      "Some requested work is still incomplete. You can ask me to continue it.",
      "لم يكتمل بعض العمل المطلوب بعد. يمكنك أن تطلب مني متابعته."));
    if (filePending) notices.push(copy(this.#locale,
      "The requested file has not been verified as saved. File delivery is still incomplete.",
      "لم يُتحقق بعد من حفظ الملف المطلوب. لم يكتمل تسليم الملف."));
    const reportPath = deliveredReportPath(this.#store, task);
    if (reportPath !== undefined) notices.push(`${copy(this.#locale, "Saved and verified:", "تم حفظ الملف والتحقق منه:")} ${this.#locale === "ar" ? isolateLtr(reportPath) : reportPath}.`);
    if (results.length === 0) bodies.push(copy(this.#locale,
      "The work ended without an accepted answer. No substitute answer was generated. You can ask me to inspect what stopped it.",
      "انتهى العمل من دون إجابة مقبولة. لم تُنشأ إجابة بديلة. يمكنك أن تطلب مني فحص سبب توقفه."));
    if (available.some((result) => result.disposition === "diagnostic")) notices.push(copy(this.#locale,
      "Incomplete output is retained for inspection; it is not included as an accepted answer.",
      "احتُفظ بالمخرجات غير المكتملة للفحص؛ ولم تُدرج بوصفها إجابة مقبولة."));

    const usage = taskUsageFromEntries(listTaskTreeUsageEntries(this.#store, task.id));
    // Known cost and spending limits remain visible; missing per-worker prices do not crowd the answer.
    if (usage.pricingComplete || usage.estimatedCostUsd > 0) {
      notices.push(`${copy(this.#locale, "Cost", "التكلفة")}: ${formatTaskUsage(usage, this.#locale)}`);
      const pricingNotice = formatUsageCostNotice(taskUsageCostSummary(usage), { locale: this.#locale });
      if (pricingNotice !== undefined) notices.push(pricingNotice);
    }
    const root = task.id === task.rootTaskId ? task : this.#store.getTask(task.rootTaskId);
    if (root?.spendingLimit !== undefined) {
      const budget = spendingBudgetSummary(root.spendingLimit, undefined, usage.estimatedCostUsd);
      notices.push(copy(this.#locale, "Task spending", "إنفاق المهمة"),
        `${copy(this.#locale, "Spent", "المنفق")}: ${formatUsdAmount(budget.spentCostUsd, this.#locale)}`,
        `${copy(this.#locale, "Remaining", "المتبقي")}: ${formatUsdAmount(budget.remainingCostUsd, this.#locale)}`,
        `${copy(this.#locale, "Limit", "الحد")}: ${formatUsdAmount(budget.maxEstimatedCostUsd, this.#locale)}`);
    }
    const body = bodies.join("\n\n");
    const title = body.match(/^#{1,3} ([^\n]{1,140})(?:\n|$)/u)?.[1];
    const heading = title === undefined ? `**${status}**` : `**${title}**\n${status}`;
    if (body.length <= 3_000) {
      return { text: [heading, body, ...notices].join("\n\n") };
    }
    // Use a recorded summary when available. A fallback is labelled as an excerpt, not an invented verdict.
    const summary = primary?.displaySummary ?? primary?.summary ?? (results.length === 1 ? results[0]?.displaySummary ?? results[0]?.summary : undefined);
    const preview = summary?.trim()
      ? boundText(summary, 1_000)
      : `${copy(this.#locale, "Report preview", "مقتطف من التقرير")}\n${boundText(body, 1_000)}`;
    const details = [
      copy(this.#locale, "## Run details", "## تفاصيل التنفيذ"),
      `Task: ${task.id} (${task.status})`,
      `Objective: ${boundText(task.objective, 2_000)}`,
      ...available.slice(0, MAX_DELIVERY_RESULTS).map((result) => `${result.disposition}: ${result.id} (${result.kind}, ${result.byteLength} bytes, handle ${result.handle})`),
      ...(task.failure === undefined ? [] : [`Failure: ${boundText(task.failure.class, 80)}`])
    ];
    return {
      text: [heading, preview, ...notices, excerpted
        ? copy(this.#locale, "A report excerpt and run details follow. The full results exceed the delivery limit and remain saved; ask me for the rest.",
          "يلي ذلك مقتطف من التقرير وتفاصيل التنفيذ. تتجاوز النتائج الكاملة حد التسليم وتظل محفوظة؛ يمكنك طلب البقية.")
        : copy(this.#locale, "Full report and run details follow. The preview is not the complete report.",
          "يلي ذلك التقرير الكامل وتفاصيل التنفيذ. المقتطف ليس التقرير الكامل.")].join("\n\n"),
      options: { report: { content: [body, ...notices, ...details].join("\n\n") } }
    };
  }

  async #readTextResult(taskId: string, result: TaskResult, sessionId: string, maxChars: number): Promise<{ text: string; truncated: boolean }> {
    let offset = 0;
    let content = "";
    let truncated = false;
    do {
      const page = await this.#resultService.readPage({
        taskId,
        resultId: result.id,
        sessionId,
        offset,
        maxChars: Math.min(TASK_RESULT_PAGE_MAX_CHARS, maxChars - content.length)
      });
      content += page.content;
      if (!page.hasMore) break;
      if (page.nextOffset === undefined || content.length >= maxChars) {
        truncated = true;
        content += "\n\n" + copy(this.#locale,
          "[Delivery excerpt limit reached. The full result remains saved; ask me to retrieve the rest.]",
          "[بلغ المقتطف حد التسليم. النتيجة الكاملة محفوظة؛ يمكنك طلب استرجاع البقية.]");
        break;
      }
      offset = page.nextOffset;
    } while (content.length < maxChars);
    return { text: content, truncated };
  }
}

function formatTaskUsage(
  usage: import("../contracts/task.js").TaskUsageTotals,
  locale: "en" | "ar"
): string {
  return formatUsageCost(taskUsageCostSummary(usage), { locale });
}

function taskUsageCostSummary(
  usage: import("../contracts/task.js").TaskUsageTotals
): { estimatedCostUsd?: number; costComplete: boolean } {
  return {
    estimatedCostUsd: usage.pricingComplete || usage.estimatedCostUsd > 0
      ? usage.estimatedCostUsd
      : undefined,
    costComplete: usage.pricingComplete
  };
}

function copy(locale: "en" | "ar", english: string, arabic: string): string {
  return locale === "ar" ? arabic : english;
}

function validateDestination(destination: TaskDeliveryDestination): TaskDeliveryDestination {
  if (destination.platform === "cli") {
    throw new Error("Local CLI Task delivery is handled by the authorized interactive session.");
  }
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
  if (destination.platform === "cli") {
    throw new Error("Local CLI Task delivery cannot be routed to an external channel.");
  }
  return destination.platform === "email"
    ? { kind: "channel", platform: "email", address: destination.address }
    : {
        kind: "channel",
        platform: destination.platform,
        chatId: destination.chatId,
        ...(destination.threadId === undefined ? {} : { threadId: destination.threadId })
      };
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
