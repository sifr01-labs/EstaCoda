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
  ToolLoopProgressGuard,
  type ToolLoopProgressAssessment
} from "./tool-loop-progress-guard.js";
import { assessExecutionPlanActivation, isPlanToolName } from "./execution-plan-activation.js";
import {
  applyAuthenticationExecutionEffects,
  type AuthenticationExecutionEffectReceipt,
} from "./authentication-execution-effects.js";
import { AuthenticationEvidenceTracker } from "./authentication-evidence-tracker.js";
import { formatExecutionCapabilityBlocker } from "./execution-capability-preflight.js";
import type { ExecutionWorkingSetController } from "./execution-working-set.js";
import type { RunRecorder } from "./run-recorder.js";

const PROVISIONAL_EXECUTION_PLAN_OBJECTIVE_MAX_CHARS = 500;

export const EXECUTION_SUPERVISION_PROMPTS = {
  browserNoProgress: "Repeated browser observations show no semantic state change. Do not alternate snapshot, tabs, find, extract, screenshot, console, or CDP calls to inspect the same state. Take a relevant browser action; if protected input or another external condition blocks progress, record that precise blocker.",
  toolLoopProgress: "The foreground tool loop has repeated the same calls or results without material progress. Change approach before continuing the original request. Use a different relevant action, surface a concrete runtime blocker, or return the truthful result already established."
} as const;

export type ExecutionSupervisionPromptState = {
  browserNoProgressNudge: boolean;
  toolLoopProgressNudge: boolean;
};

export type ExecutionSupervisionAssessment = {
  browserObservation: BrowserObservationAssessment;
  toolLoopProgress: ToolLoopProgressAssessment;
  userInputBlocker?: { summary: string };
  missingCapabilityBlocker?: { summary: string };
};

export type ExecutionSupervisionControllerOptions = {
  userText: string;
  visibleTurnId?: string;
  foregroundTurnId: string;
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
 * existing owners; this controller decides how runtime tool and browser
 * evidence affect the next provider step and whether a local receipt must end
 * the turn. Plan management remains compatibility state, not supervision
 * authority.
 */
export class ExecutionSupervisionController {
  readonly #userText: string;
  readonly #visibleTurnId: string | undefined;
  readonly #foregroundTurnId: string;
  readonly #providerTools: readonly OpenAICompatibleToolSchema[];
  readonly #currentSessionId: () => string;
  readonly #locale: "en" | "ar";
  readonly #noProgressNudgeIteration: number;
  readonly #maxNoProgressIterations: number;
  readonly #executionPlanReader: ExecutionPlanReader | undefined;
  readonly #executionPlanController: ExecutionPlanControllerApi | undefined;
  readonly #executionWorkingSet: ExecutionWorkingSetController | undefined;
  readonly #runRecorder: Pick<RunRecorder, "recordAuthenticationEvidenceAssessment">;
  readonly #onEvent: RuntimeEventSink | undefined;
  readonly #existingExecutions: readonly ToolExecutionRecord[];
  readonly #browserObservationGuard: BrowserObservationGuard;
  #toolLoopProgressGuard: ToolLoopProgressGuard;
  readonly #authenticationEvidenceTracker: AuthenticationEvidenceTracker;
  #pendingBrowserNoProgressNudge = false;
  #pendingToolLoopProgressNudge = false;
  #automaticExecutionPlanRequired: boolean;
  #initialized = false;
  #executionPlanIncomplete = false;

  constructor(options: ExecutionSupervisionControllerOptions) {
    this.#userText = options.userText;
    this.#visibleTurnId = options.visibleTurnId;
    this.#foregroundTurnId = options.foregroundTurnId;
    this.#providerTools = options.providerTools;
    this.#currentSessionId = options.currentSessionId;
    this.#locale = options.locale;
    this.#noProgressNudgeIteration = options.noProgressNudgeIteration;
    this.#maxNoProgressIterations = options.maxNoProgressIterations;
    this.#executionPlanController = options.executionPlanController;
    this.#executionPlanReader = options.executionPlanController ?? options.executionPlanReader;
    this.#executionWorkingSet = options.executionWorkingSet;
    this.#runRecorder = options.runRecorder;
    this.#onEvent = options.onEvent;
    this.#existingExecutions = options.existingExecutions;
    this.#browserObservationGuard = new BrowserObservationGuard(options.maxRepeatedBrowserObservations);
    this.#toolLoopProgressGuard = new ToolLoopProgressGuard({
      existingExecutions: options.existingExecutions,
      noProgressNudgeIteration: options.noProgressNudgeIteration,
      maxNoProgressIterations: options.maxNoProgressIterations
    });
    this.#authenticationEvidenceTracker = new AuthenticationEvidenceTracker(options.existingExecutions);
    const initialActivation = this.#assessActivation([]);
    this.#automaticExecutionPlanRequired = initialActivation.required;
  }

  get executionPlanIncomplete(): boolean {
    return this.#executionPlanIncomplete;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    if (this.#automaticExecutionPlanRequired) {
      await this.#writeProvisionalExecutionPlan();
    }
    this.#toolLoopProgressGuard = new ToolLoopProgressGuard({
      existingExecutions: this.#existingExecutions,
      noProgressNudgeIteration: this.#noProgressNudgeIteration,
      maxNoProgressIterations: this.#maxNoProgressIterations
    });
    this.#executionWorkingSet?.beginTurn(this.#foregroundTurnId, this.#currentSessionId());
    this.#executionWorkingSet?.observe(
      this.#existingExecutions,
      this.#foregroundTurnId,
      this.#currentSessionId()
    );
  }

  consumePromptState(): ExecutionSupervisionPromptState {
    const state = {
      browserNoProgressNudge: this.#pendingBrowserNoProgressNudge,
      toolLoopProgressNudge: this.#pendingToolLoopProgressNudge
    };
    this.#pendingBrowserNoProgressNudge = false;
    this.#pendingToolLoopProgressNudge = false;
    return state;
  }

  async superviseActivation(toolNames: readonly string[]): Promise<void> {
    const activation = this.#assessActivation(toolNames);
    this.#automaticExecutionPlanRequired ||= activation.required;
    const containsSubstantiveTool = toolNames.some((name) => !isPlanToolName(name));
    if (
      activation.required &&
      this.#executionPlanReader?.current() === undefined &&
      containsSubstantiveTool
    ) {
      await this.#writeProvisionalExecutionPlan();
    }
  }

  observeReasoningOnly(): ToolLoopProgressAssessment {
    const progress = this.#toolLoopProgressGuard.observe([]);
    if (progress.shouldNudge) this.#pendingToolLoopProgressNudge = true;
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
    await emitAuthenticationLifecycleEvents(this.#onEvent, authenticationObservation.effects);
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
    const toolLoopProgress = this.#toolLoopProgressGuard.observe(executions);
    this.#executionWorkingSet?.observe(
      executions,
      this.#foregroundTurnId,
      this.#currentSessionId()
    );
    if (browserObservation?.shouldNudge === true) this.#pendingBrowserNoProgressNudge = true;
    if (toolLoopProgress.shouldNudge) this.#pendingToolLoopProgressNudge = true;

    const userInputBlocker = executionPlanUserInputBlocker(this.#executionPlanReader?.current());
    const missingCapabilityBlocker = executionPlanMissingCapabilityBlocker(
      this.#executionPlanReader?.current(),
      this.#locale
    );
    return {
      browserObservation,
      toolLoopProgress,
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

  toolLoopNoProgressStopReceipt(execution: ProviderExecutionResult): ProviderExecutionResult {
    return receiptExecution(execution, this.#locale === "ar"
      ? `توقفت حلقة الأدوات بعد ${this.#maxNoProgressIterations} تكرارات متتالية بلا تقدم مادي. لم تعد الخطة أو حالتها شرطًا لهذا القرار.`
      : `The foreground tool loop stopped after ${this.#maxNoProgressIterations} consecutive iterations without material progress. This decision is independent of any plan or plan status.`);
  }

  emergencyDeadlineReceipt(execution: ProviderExecutionResult): ProviderExecutionResult {
    return receiptExecution(execution, this.#locale === "ar"
      ? "توقّف بدء عمل جديد عند بلوغ مهلة الطوارئ، مع الحفاظ على وقت لإظهار نتيجة موثوقة."
      : "New work stopped at the emergency deadline reserve so the runtime could return a truthful local result.");
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
    }, this.#visibleTurnId, this.#onEvent, {
      source: "runtime",
      provisional: true,
      sessionId: this.#currentSessionId()
    });
  }
}

async function emitAuthenticationLifecycleEvents(
  sink: RuntimeEventSink | undefined,
  effects: readonly AuthenticationExecutionEffectReceipt[]
): Promise<void> {
  if (sink === undefined) return;
  for (const effect of effects) {
    const stage = effect.effect === "credentials-required"
      ? "credentials-requested" as const
      : effect.effect === "credentials-submitted"
        ? "credentials-submitted" as const
        : effect.effect === "challenge-required"
          ? "challenge-required" as const
          : effect.effect === "challenge-submitted"
            ? "challenge-submitted" as const
            : effect.effect === "authentication-candidate"
              ? "verification-pending" as const
              : effect.effect === "authentication-verified"
                ? "authenticated" as const
                : "blocked" as const;
    try {
      await sink({
        kind: "authentication-lifecycle",
        stage,
        toolCallId: effect.toolCallId,
        ...(effect.blocker === undefined ? {} : { blockerKind: effect.blocker.kind }),
      });
    } catch {
      // Runtime UI/event consumers are observational and cannot block authentication.
    }
  }
}

function boundedProvisionalObjective(userText: string): string {
  const normalized = userText.replace(/\s+/gu, " ").trim();
  if ([...normalized].length <= PROVISIONAL_EXECUTION_PLAN_OBJECTIVE_MAX_CHARS) return normalized;
  return [...normalized].slice(0, PROVISIONAL_EXECUTION_PLAN_OBJECTIVE_MAX_CHARS - 1).join("").trimEnd() + "…";
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
