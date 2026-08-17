import type {
  ExecutionPlan,
  ExecutionPlanControllerApi,
  ExecutionPlanReader
} from "../contracts/execution-plan.js";
import type { ProviderResponse } from "../contracts/provider.js";
import type { RuntimeEventSink } from "../contracts/runtime-event.js";
import type { OpenAICompatibleToolSchema } from "../tools/tool-schema.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import { BrowserObservationGuard, type BrowserObservationAssessment } from "./browser-observation-guard.js";
import {
  ExecutionPlanProgressGuard,
  type ExecutionPlanProgressAssessment
} from "./execution-plan-progress-guard.js";
import { assessExecutionPlanActivation, isPlanToolName } from "./execution-plan-activation.js";
import { applyAuthenticationExecutionEffects } from "./authentication-execution-effects.js";
import { AuthenticationEvidenceTracker } from "./authentication-evidence-tracker.js";
import { formatExecutionCapabilityBlocker } from "./execution-capability-preflight.js";
import type { ExecutionWorkingSetController } from "./execution-working-set.js";
import type { RunRecorder } from "./run-recorder.js";

const PROVISIONAL_EXECUTION_PLAN_OBJECTIVE_MAX_CHARS = 500;

export const EXECUTION_SUPERVISION_PROMPTS = {
  browserNoProgress: "Repeated browser observations show no semantic state change. Do not alternate snapshot, tabs, find, extract, screenshot, console, or CDP calls to inspect the same state. Take a relevant browser action; if protected input or another external condition blocks progress, record that precise blocker.",
  executionPlanContinuation: "Your active execution plan still has unfinished items. Continue executing the original request now. Do not stop to narrate the next step or ask whether to continue.",
  executionPlanProgress: "Your active execution plan has made no material progress for several iterations. Change approach and continue executing the original request now. Make progress by transitioning the active plan item, performing a relevant target mutation, recording verification evidence, or recording a concrete blocker. Repeated reads, cosmetic browser changes, navigation churn, narration, and failed plan updates do not count as progress. Do not ask whether to continue.",
  executionPlanActivation: "This is clearly multi-step foreground work. Before doing anything else, call plan with operation=write and create a concise Mission with exactly one in_progress item and the remaining items pending. For work spanning systems, include requirements using exact tool names exposed in this session: destination read, destination mutation, and an independent read-safe verification tool; when protected browser values must cross systems, declare the mutation tool's protectedPaths and protectedSource=browser. Call only plan in this response; do not call substantive tools yet, narrate the plan, or ask whether to proceed."
} as const;

export type ExecutionSupervisionPromptState = {
  retryInitialProviderRequest: boolean;
  activationRestrictedRequest: boolean;
  browserNoProgressNudge: boolean;
  executionPlanContinuation: boolean;
  executionPlanProgressNudge: boolean;
  executionPlanActivationNudge: boolean;
};

export type ExecutionSupervisionAssessment = {
  browserObservation: BrowserObservationAssessment;
  executionPlanProgress: ExecutionPlanProgressAssessment;
  userInputBlocker?: { summary: string };
  missingCapabilityBlocker?: { summary: string };
};

export type ExecutionSupervisionFinalization = {
  execution: ProviderExecutionResult;
  continueExecutionPlan: boolean;
};

export type ExecutionSupervisionControllerOptions = {
  userText: string;
  visibleTurnId?: string;
  providerTools: readonly OpenAICompatibleToolSchema[];
  existingExecutions: readonly ToolExecutionRecord[];
  currentSessionId: () => string;
  locale: "en" | "ar";
  maxRepeatedBrowserObservations: number;
  noProgressNudgeIteration: number;
  maxNoProgressIterations: number;
  executionPlanReader?: ExecutionPlanReader;
  executionPlanController?: ExecutionPlanControllerApi;
  executionWorkingSet?: ExecutionWorkingSetController;
  runRecorder: Pick<RunRecorder, "recordAuthenticationEvidenceAssessment">;
  onEvent?: RuntimeEventSink;
};

/**
 * Owns the deterministic supervision state for one provider turn. Provider
 * invocation, iteration accounting, and tool execution remain with their
 * existing owners; this controller decides how Mission and browser evidence
 * affect the next provider step and whether a local receipt must end the turn.
 */
export class ExecutionSupervisionController {
  readonly #userText: string;
  readonly #visibleTurnId: string | undefined;
  readonly #providerTools: readonly OpenAICompatibleToolSchema[];
  readonly #currentSessionId: () => string;
  readonly #locale: "en" | "ar";
  readonly #maxNoProgressIterations: number;
  readonly #executionPlanReader: ExecutionPlanReader | undefined;
  readonly #executionPlanController: ExecutionPlanControllerApi | undefined;
  readonly #executionWorkingSet: ExecutionWorkingSetController | undefined;
  readonly #runRecorder: Pick<RunRecorder, "recordAuthenticationEvidenceAssessment">;
  readonly #onEvent: RuntimeEventSink | undefined;
  readonly #browserObservationGuard: BrowserObservationGuard;
  readonly #executionPlanProgressGuard: ExecutionPlanProgressGuard;
  readonly #authenticationEvidenceTracker: AuthenticationEvidenceTracker;
  #pendingBrowserNoProgressNudge = false;
  #pendingExecutionPlanContinuation = false;
  #pendingExecutionPlanProgressNudge = false;
  #pendingExecutionPlanActivationNudge: boolean;
  #retryExecutionPlanActivation = false;
  #executionPlanActivationNudged: boolean;
  #automaticExecutionPlanRequired: boolean;
  #executionPlanIncomplete = false;

  constructor(options: ExecutionSupervisionControllerOptions) {
    this.#userText = options.userText;
    this.#visibleTurnId = options.visibleTurnId;
    this.#providerTools = options.providerTools;
    this.#currentSessionId = options.currentSessionId;
    this.#locale = options.locale;
    this.#maxNoProgressIterations = options.maxNoProgressIterations;
    this.#executionPlanController = options.executionPlanController;
    this.#executionPlanReader = options.executionPlanController ?? options.executionPlanReader;
    this.#executionWorkingSet = options.executionWorkingSet;
    this.#runRecorder = options.runRecorder;
    this.#onEvent = options.onEvent;
    this.#browserObservationGuard = new BrowserObservationGuard(options.maxRepeatedBrowserObservations);
    this.#executionPlanProgressGuard = new ExecutionPlanProgressGuard({
      plan: this.#executionPlanReader?.current(),
      existingExecutions: options.existingExecutions,
      noProgressNudgeIteration: options.noProgressNudgeIteration,
      maxNoProgressIterations: options.maxNoProgressIterations
    });
    this.#authenticationEvidenceTracker = new AuthenticationEvidenceTracker(options.existingExecutions);
    const initialActivation = this.#assessActivation([]);
    this.#pendingExecutionPlanActivationNudge = initialActivation.required;
    this.#executionPlanActivationNudged = initialActivation.required;
    this.#automaticExecutionPlanRequired = initialActivation.required;

    this.#executionWorkingSet?.beginTurn(this.#executionPlanReader?.current(), this.#currentSessionId());
    this.#executionWorkingSet?.observe(
      this.#executionPlanReader?.current(),
      options.existingExecutions,
      this.#currentSessionId()
    );
  }

  get executionPlanIncomplete(): boolean {
    return this.#executionPlanIncomplete;
  }

  consumePromptState(): ExecutionSupervisionPromptState {
    const state = {
      retryInitialProviderRequest: this.#retryExecutionPlanActivation,
      activationRestrictedRequest: this.#pendingExecutionPlanActivationNudge,
      browserNoProgressNudge: this.#pendingBrowserNoProgressNudge,
      executionPlanContinuation: this.#pendingExecutionPlanContinuation,
      executionPlanProgressNudge: this.#pendingExecutionPlanProgressNudge,
      executionPlanActivationNudge: this.#pendingExecutionPlanActivationNudge
    };
    this.#retryExecutionPlanActivation = false;
    this.#pendingBrowserNoProgressNudge = false;
    this.#pendingExecutionPlanContinuation = false;
    this.#pendingExecutionPlanProgressNudge = false;
    this.#pendingExecutionPlanActivationNudge = false;
    return state;
  }

  async superviseActivation(input: {
    toolNames: readonly string[];
    activationRestrictedRequest: boolean;
    canRetry: boolean;
  }): Promise<{ retryProvider: boolean }> {
    const activation = this.#assessActivation(input.toolNames);
    this.#automaticExecutionPlanRequired ||= activation.required;
    const onlyPlanCalls = input.toolNames.length > 0 && input.toolNames.every(isPlanToolName);

    if (input.activationRestrictedRequest && !onlyPlanCalls) {
      await this.#writeProvisionalExecutionPlan();
      this.#retryExecutionPlanActivation = true;
      return { retryProvider: true };
    }
    if (
      activation.required &&
      this.#executionPlanReader?.current() === undefined &&
      !onlyPlanCalls &&
      !this.#executionPlanActivationNudged &&
      input.canRetry
    ) {
      this.#executionPlanActivationNudged = true;
      this.#pendingExecutionPlanActivationNudge = true;
      this.#retryExecutionPlanActivation = true;
      return { retryProvider: true };
    }
    if (
      activation.required &&
      this.#executionPlanReader?.current() === undefined &&
      !onlyPlanCalls
    ) {
      await this.#writeProvisionalExecutionPlan();
    }
    return { retryProvider: false };
  }

  observeReasoningOnly(): ExecutionPlanProgressAssessment {
    const progress = this.#executionPlanProgressGuard.observe({
      plan: this.#executionPlanReader?.current(),
      executions: []
    });
    if (progress.shouldNudge) this.#pendingExecutionPlanProgressNudge = true;
    return progress;
  }

  async applyRuntimeMissionEffects(input: {
    executions: ToolExecutionRecord[];
    providerToolNames: readonly string[];
  }): Promise<void> {
    const authenticationObservation = this.#authenticationEvidenceTracker.observe(input.executions);
    for (const assessment of authenticationObservation.assessments) {
      await this.#runRecorder.recordAuthenticationEvidenceAssessment(assessment);
    }
    if (
      authenticationObservation.effects.length > 0 &&
      this.#executionPlanController !== undefined &&
      this.#visibleTurnId !== undefined
    ) {
      await applyAuthenticationExecutionEffects({
        controller: this.#executionPlanController,
        effects: authenticationObservation.effects,
        objective: boundedProvisionalObjective(this.#userText),
        originTurnId: this.#visibleTurnId,
        sink: this.#onEvent
      });
      this.#automaticExecutionPlanRequired = true;
    }
    if (
      this.#automaticExecutionPlanRequired &&
      this.#executionPlanReader?.current() === undefined &&
      input.providerToolNames.some(isPlanToolName)
    ) {
      await this.#writeProvisionalExecutionPlan();
    }
  }

  assessProgress(executions: ToolExecutionRecord[]): ExecutionSupervisionAssessment {
    const browserObservation = this.#browserObservationGuard.observe(executions);
    const executionPlanProgress = this.#executionPlanProgressGuard.observe({
      plan: this.#executionPlanReader?.current(),
      executions
    });
    this.#executionWorkingSet?.observe(
      this.#executionPlanReader?.current(),
      executions,
      this.#currentSessionId()
    );
    if (browserObservation?.shouldNudge === true) this.#pendingBrowserNoProgressNudge = true;
    if (executionPlanProgress.shouldNudge) this.#pendingExecutionPlanProgressNudge = true;

    const userInputBlocker = executionPlanUserInputBlocker(this.#executionPlanReader?.current());
    const missingCapabilityBlocker = executionPlanMissingCapabilityBlocker(
      this.#executionPlanReader?.current(),
      this.#locale
    );
    return {
      browserObservation,
      executionPlanProgress,
      ...(userInputBlocker === undefined ? {} : { userInputBlocker }),
      ...(missingCapabilityBlocker === undefined ? {} : { missingCapabilityBlocker })
    };
  }

  userInputRequiredReceipt(execution: ProviderExecutionResult, summary: string): ProviderExecutionResult {
    return receiptExecution(execution, this.#locale === "ar"
      ? `تحتاج خطة التنفيذ إلى إدخالك قبل أن تتابع: ${summary}`
      : `The Mission needs your input before it can continue: ${summary}`);
  }

  missingCapabilityReceipt(execution: ProviderExecutionResult, summary: string): ProviderExecutionResult {
    this.#executionPlanIncomplete = true;
    return receiptExecution(execution, this.#locale === "ar"
      ? `توقفت خطة التنفيذ قبل بدء العمل لأن قدرة مطلوبة غير متاحة: ${summary}`
      : `The Mission stopped before substantive work because a required capability is unavailable: ${summary}`);
  }

  browserNoProgressStopReceipt(execution: ProviderExecutionResult): ProviderExecutionResult {
    const response = execution.response;
    return {
      ...execution,
      response: {
        ok: true,
        content: "I stopped this browser turn because repeated observations showed no state change. I can continue after switching tabs, taking a different browser action, or receiving clarification about the next step.",
        model: response?.model ?? execution.route?.id ?? "unknown",
        provider: (response?.provider ?? execution.route?.provider ?? "unknown") as ProviderResponse["provider"],
        finishReason: "stop",
        ...(response?.usage === undefined ? {} : { usage: response.usage })
      }
    };
  }

  executionPlanNoProgressStopReceipt(execution: ProviderExecutionResult): ProviderExecutionResult {
    this.#executionPlanIncomplete = true;
    return incompleteExecutionPlanReceipt(
      execution,
      this.#executionPlanReader?.current(),
      this.#locale,
      "no_progress",
      this.#maxNoProgressIterations
    );
  }

  emergencyDeadlineReceipt(execution: ProviderExecutionResult): ProviderExecutionResult {
    if (hasUnfinishedExecutionPlan(this.#executionPlanReader?.current())) {
      this.#executionPlanIncomplete = true;
      return incompleteExecutionPlanReceipt(
        execution,
        this.#executionPlanReader?.current(),
        this.#locale,
        "deadline"
      );
    }
    return receiptExecution(execution, this.#locale === "ar"
      ? "توقّف بدء عمل جديد عند بلوغ مهلة الطوارئ، مع الحفاظ على وقت لإظهار نتيجة موثوقة."
      : "New work stopped at the emergency deadline reserve so the runtime could return a truthful local result.");
  }

  finalizeProviderExecution(input: {
    execution: ProviderExecutionResult;
    executionPlanProgress: ExecutionPlanProgressAssessment;
    canContinue: boolean;
  }): ExecutionSupervisionFinalization {
    if (
      input.execution.ok !== true ||
      input.execution.toolCalls.length > 0 ||
      !hasUnfinishedExecutionPlan(this.#executionPlanReader?.current())
    ) {
      return { execution: input.execution, continueExecutionPlan: false };
    }
    if (!input.executionPlanProgress.shouldStop && input.canContinue) {
      this.#pendingExecutionPlanContinuation = !input.executionPlanProgress.shouldNudge;
      return { execution: input.execution, continueExecutionPlan: true };
    }
    if (!input.executionPlanProgress.shouldStop) {
      this.#executionPlanIncomplete = true;
      return {
        execution: incompleteExecutionPlanReceipt(
          input.execution,
          this.#executionPlanReader?.current(),
          this.#locale,
          "hard_limit"
        ),
        continueExecutionPlan: false
      };
    }
    return { execution: input.execution, continueExecutionPlan: false };
  }

  #assessActivation(proposedToolNames: readonly string[]) {
    if (
      this.#executionPlanController === undefined ||
      this.#visibleTurnId === undefined ||
      this.#executionPlanReader?.current() !== undefined ||
      !this.#providerTools.some((tool) => isPlanToolName(tool.function.name))
    ) {
      return { required: false, reasons: [] } as const;
    }
    return assessExecutionPlanActivation({
      userText: this.#userText,
      proposedToolNames
    });
  }

  async #writeProvisionalExecutionPlan(): Promise<void> {
    if (
      this.#executionPlanController === undefined ||
      this.#visibleTurnId === undefined ||
      this.#executionPlanReader?.current() !== undefined
    ) return;
    await this.#executionPlanController.write({
      objective: boundedProvisionalObjective(this.#userText),
      items: [
        {
          id: "execute",
          content: "Complete the requested multi-step work",
          status: "in_progress"
        },
        {
          id: "verify",
          content: "Verify the resulting state and report the outcome",
          status: "pending"
        }
      ]
    }, this.#visibleTurnId, this.#onEvent);
  }
}

function boundedProvisionalObjective(userText: string): string {
  const normalized = userText.replace(/\s+/gu, " ").trim();
  if ([...normalized].length <= PROVISIONAL_EXECUTION_PLAN_OBJECTIVE_MAX_CHARS) return normalized;
  return [...normalized].slice(0, PROVISIONAL_EXECUTION_PLAN_OBJECTIVE_MAX_CHARS - 1).join("").trimEnd() + "…";
}

function hasUnfinishedExecutionPlan(plan: ExecutionPlan | undefined): boolean {
  return plan?.status === "active" && executionPlanUserInputBlocker(plan) === undefined && plan.items.some((item) =>
    item.status === "pending" || item.status === "in_progress"
  );
}

function executionPlanUserInputBlocker(plan: ExecutionPlan | undefined): { summary: string } | undefined {
  return plan?.items.find((item) =>
    item.status === "blocked" && item.blocker?.kind === "user_input_required"
  )?.blocker;
}

function executionPlanMissingCapabilityBlocker(
  plan: ExecutionPlan | undefined,
  locale: "en" | "ar"
): { summary: string } | undefined {
  const assessment = plan?.capabilityPreflight?.assessments.find((entry) => entry.status !== "ready");
  if (assessment === undefined) return undefined;
  return {
    summary: formatExecutionCapabilityBlocker({
      assessment,
      requirement: plan?.requirements?.find((entry) => entry.id === assessment.requirementId),
      locale
    })
  };
}

function receiptExecution(execution: ProviderExecutionResult, content: string): ProviderExecutionResult {
  const response = execution.response;
  return {
    ...execution,
    ok: true,
    response: {
      ok: true,
      content,
      model: response?.model ?? execution.route?.id ?? "unknown",
      provider: (response?.provider ?? execution.route?.provider ?? "unknown") as ProviderResponse["provider"],
      finishReason: "stop",
      ...(response?.usage === undefined ? {} : { usage: response.usage })
    },
    toolCalls: []
  };
}

function incompleteExecutionPlanReceipt(
  execution: ProviderExecutionResult,
  plan: ExecutionPlan | undefined,
  locale: "en" | "ar",
  reason: "no_progress" | "deadline" | "hard_limit",
  noProgressLimit?: number
): ProviderExecutionResult {
  const unfinished = plan?.items.filter((item) =>
    item.status === "pending" || item.status === "in_progress" || item.status === "blocked"
  ) ?? [];
  const closing = incompletePlanClosing(reason, locale, noProgressLimit);
  const content = locale === "ar"
    ? [
        "لم تكتمل خطة التنفيذ.",
        "",
        "العناصر المتبقية:",
        ...unfinished.map((item) => `- ${item.content}${item.blocker === undefined ? "" : ` — ${item.blocker.summary}`}`),
        "",
        closing
      ].join("\n")
    : [
        "The Mission is incomplete.",
        "",
        "Remaining items:",
        ...unfinished.map((item) => `- ${item.content}${item.blocker === undefined ? "" : ` — ${item.blocker.summary}`}`),
        "",
        closing
      ].join("\n");
  return receiptExecution(execution, content);
}

function incompletePlanClosing(
  reason: "no_progress" | "deadline" | "hard_limit",
  locale: "en" | "ar",
  noProgressLimit?: number
): string {
  if (locale === "ar") {
    if (reason === "no_progress") return [
      `توقّف التنفيذ بعد ${noProgressLimit ?? 6} محاولات متتالية بلا تقدم ملموس.`,
      "لم يُسجَّل انتقال في خطة التنفيذ أو تغيير في الحالة المستهدفة أو دليل تحقق أو عائق محدد."
    ].join(" ");
    if (reason === "deadline") return "توقّف بدء عمل جديد عند بلوغ مهلة الطوارئ، مع الحفاظ على وقت لإظهار نتيجة موثوقة.";
    return "توقّف التنفيذ عند بلوغ حد الأمان العام مع بقاء عناصر غير مكتملة.";
  }
  if (reason === "no_progress") return [
    `Execution stopped after ${noProgressLimit ?? 6} consecutive iterations without material progress;`,
    "no Mission transition, target mutation, verification evidence, or concrete blocker was recorded."
  ].join(" ");
  if (reason === "deadline") return "New work stopped at the emergency deadline reserve so the runtime could return a truthful local result.";
  return "Execution reached a general safety ceiling with unfinished items remaining.";
}
