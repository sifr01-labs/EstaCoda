import type { ProviderResponse } from "../contracts/provider.js";
import type { RuntimeEventSink } from "../contracts/runtime-event.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import { BrowserObservationGuard, type BrowserObservationAssessment } from "./browser-observation-guard.js";
import {
  ToolLoopProgressGuard,
  type ToolLoopProgressAssessment
} from "./tool-loop-progress-guard.js";
import type { AuthenticationExecutionEffectReceipt } from "./authentication-execution-effects.js";
import { AuthenticationEvidenceTracker } from "./authentication-evidence-tracker.js";
import type { ExecutionWorkingSetController } from "./execution-working-set.js";
import type { RunRecorder } from "./run-recorder.js";

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
  runtimeUserInputBlocker?: { summary: string };
};

export type ExecutionSupervisionControllerOptions = {
  foregroundTurnId: string;
  existingExecutions: readonly ToolExecutionRecord[];
  currentSessionId: () => string;
  locale: "en" | "ar";
  maxRepeatedBrowserObservations: number;
  noProgressNudgeIteration: number;
  maxNoProgressIterations: number;
  executionWorkingSet?: ExecutionWorkingSetController;
  runRecorder: Pick<RunRecorder, "recordAuthenticationEvidenceAssessment">;
  onEvent?: RuntimeEventSink;
};

/**
 * Owns the deterministic supervision state for one provider turn. Provider
 * invocation, iteration accounting, and tool execution remain with their
 * existing owners; this controller decides how runtime tool and browser
 * evidence affect the next provider step and whether a local receipt must end
 * the turn. Execution plans are outside this supervision path.
 */
export class ExecutionSupervisionController {
  readonly #foregroundTurnId: string;
  readonly #currentSessionId: () => string;
  readonly #locale: "en" | "ar";
  readonly #noProgressNudgeIteration: number;
  readonly #maxNoProgressIterations: number;
  readonly #executionWorkingSet: ExecutionWorkingSetController | undefined;
  readonly #runRecorder: Pick<RunRecorder, "recordAuthenticationEvidenceAssessment">;
  readonly #onEvent: RuntimeEventSink | undefined;
  readonly #existingExecutions: readonly ToolExecutionRecord[];
  readonly #browserObservationGuard: BrowserObservationGuard;
  #toolLoopProgressGuard: ToolLoopProgressGuard;
  readonly #authenticationEvidenceTracker: AuthenticationEvidenceTracker;
  #pendingBrowserNoProgressNudge = false;
  #pendingToolLoopProgressNudge = false;
  #runtimeUserInputBlocker: { summary: string } | undefined;
  #initialized = false;

  constructor(options: ExecutionSupervisionControllerOptions) {
    this.#foregroundTurnId = options.foregroundTurnId;
    this.#currentSessionId = options.currentSessionId;
    this.#locale = options.locale;
    this.#noProgressNudgeIteration = options.noProgressNudgeIteration;
    this.#maxNoProgressIterations = options.maxNoProgressIterations;
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
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
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

  observeReasoningOnly(): ToolLoopProgressAssessment {
    const progress = this.#toolLoopProgressGuard.observe([]);
    if (progress.shouldNudge) this.#pendingToolLoopProgressNudge = true;
    return progress;
  }

  async applyRuntimeEffects(input: {
    executions: ToolExecutionRecord[];
  }): Promise<void> {
    const authenticationObservation = this.#authenticationEvidenceTracker.observe(input.executions);
    for (const assessment of authenticationObservation.assessments) {
      await this.#runRecorder.recordAuthenticationEvidenceAssessment(assessment);
    }
    await emitAuthenticationLifecycleEvents(this.#onEvent, authenticationObservation.effects);
    this.#runtimeUserInputBlocker = authenticationObservation.effects
      .find((effect) => effect.blocker?.kind === "user_input_required")
      ?.blocker;
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

    return {
      browserObservation,
      toolLoopProgress,
      ...(this.#runtimeUserInputBlocker === undefined
        ? {}
        : { runtimeUserInputBlocker: this.#runtimeUserInputBlocker })
    };
  }

  runtimeUserInputRequiredReceipt(execution: ProviderExecutionResult, summary: string): ProviderExecutionResult {
    return receiptExecution(execution, this.#locale === "ar"
      ? `تحتاج المصادقة إلى إدخالك قبل أن يتابع وقت التشغيل: ${summary}`
      : `Authentication needs your input before the runtime can continue: ${summary}`);
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
