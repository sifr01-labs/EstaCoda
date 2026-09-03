import type { ProviderResponse } from "../contracts/provider.js";
import type { ExecutionTerminationCause } from "../contracts/execution-plan.js";
import type { RuntimeEventSink } from "../contracts/runtime-event.js";
import type { BrowserSnapshot, BrowserStateIdentity } from "../contracts/browser.js";
import type {
  ExecutionCheckpointAuthenticationStage,
  ExecutionCheckpointSupervisionController
} from "../contracts/execution-checkpoint.js";
import type { RuntimeToolAdmissionGuard, ToolExecutionRecord } from "../tools/tool-executor.js";
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
  browserEvidence: "The last browser strategy repeated evidence, produced no effective change, or reached a terminal page such as HTTP 4xx/5xx. Do not repeat the same strategy and semantic outcome even if the document revision changed. Use a genuinely different grounded strategy: inspect a visible region, dismiss a blocker, scroll or reveal content, use a different exact href, switch tabs, or use a runtime-grounded region click. If popup-blocked reports a safe destination, browser.navigate with disposition=new-tab may open it without changing Chrome permissions. If no grounded alternative exists, return the truthful incomplete result.",
  browserRetarget: "The last browser target could not be resolved, so no action was dispatched. Use this bounded retargeting opportunity with current document and tab identity and a different grounded element, visible region, blocker dismissal, scroll/reveal action, or exact href. Do not retry the same missing target.",
  browserVisual: "Browser semantic evidence is ambiguous, missing a grounded action, conflicting with the observed result, or a native action produced no change. Use browser.vision once for a sanitized current-viewport inspection if visual layout can resolve the uncertainty. Prefer semantic labels; use a returned screenshot-bound visual target only when it resolves to a grounded current control. Do not repeat the exhausted search or infer masked values.",
  browserVisualRepeatedMatch: "This search returned the same incidental match. Try a different visible control or request browser.vision once for sanitized current-viewport inspection. Do not repeat the same query or infer masked values.",
  toolLoopProgress: "The foreground tool loop has repeated the same calls or results without material progress. Change approach before continuing the original request. Use a different relevant action, surface a concrete runtime blocker, or return the truthful result already established."
} as const;

export type ExecutionSupervisionPromptState = {
  browserEvidenceNudge: boolean;
  browserRetargetNudge: boolean;
  browserVisualEscalationReason?: NonNullable<BrowserObservationAssessment>["visualEscalationReason"];
  suppressedBrowserTools: string[];
  toolLoopProgressNudge: boolean;
};

export type ExecutionSupervisionAssessment = {
  browserObservation: BrowserObservationAssessment;
  toolLoopProgress: ToolLoopProgressAssessment;
  runtimeUserInputBlocker?: { summary: string };
  terminationCause?: Extract<
    ExecutionTerminationCause,
    "browser_no_progress" | "tool_loop_no_progress" | "user_input_required"
  >;
};

export type ProtectedAuthenticationChallenge = {
  sessionId: string;
  identity: BrowserStateIdentity;
  tabRef: string;
  fieldRef: string;
  submitRef: string;
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
  executionCheckpointController?: ExecutionCheckpointSupervisionController;
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
  readonly #executionCheckpointController: ExecutionCheckpointSupervisionController | undefined;
  readonly #runRecorder: Pick<RunRecorder, "recordAuthenticationEvidenceAssessment">;
  readonly #onEvent: RuntimeEventSink | undefined;
  readonly #existingExecutions: readonly ToolExecutionRecord[];
  readonly #browserObservationGuard: BrowserObservationGuard;
  #toolLoopProgressGuard: ToolLoopProgressGuard;
  readonly #authenticationEvidenceTracker: AuthenticationEvidenceTracker;
  #pendingBrowserEvidenceNudge = false;
  #pendingBrowserRetargetNudge = false;
  #pendingBrowserVisualEscalationReason: NonNullable<BrowserObservationAssessment>["visualEscalationReason"] | undefined;
  #suppressedBrowserTools: string[] = [];
  #pendingToolLoopProgressNudge = false;
  #runtimeUserInputBlocker: { summary: string } | undefined;
  #authenticationGateState: "challenge-required" | "revalidation-required" | "blocked" | undefined;
  #pendingProtectedChallenge: ProtectedAuthenticationChallenge | undefined;
  #initialized = false;

  constructor(options: ExecutionSupervisionControllerOptions) {
    this.#foregroundTurnId = options.foregroundTurnId;
    this.#currentSessionId = options.currentSessionId;
    this.#locale = options.locale;
    this.#noProgressNudgeIteration = options.noProgressNudgeIteration;
    this.#maxNoProgressIterations = options.maxNoProgressIterations;
    this.#executionWorkingSet = options.executionWorkingSet;
    this.#executionCheckpointController = options.executionCheckpointController;
    this.#runRecorder = options.runRecorder;
    this.#onEvent = options.onEvent;
    this.#existingExecutions = options.existingExecutions;
    this.#browserObservationGuard = new BrowserObservationGuard(options.maxRepeatedBrowserObservations);
    this.#toolLoopProgressGuard = new ToolLoopProgressGuard({
      existingExecutions: options.existingExecutions,
      noProgressNudgeIteration: options.noProgressNudgeIteration,
      maxNoProgressIterations: options.maxNoProgressIterations,
      checkpointReader: options.executionCheckpointController
    });
    const recoveryStage = options.executionCheckpointController?.current()?.authenticationRecoveryStage;
    this.#authenticationEvidenceTracker = new AuthenticationEvidenceTracker(options.existingExecutions, recoveryStage);
    this.#authenticationGateState = recoveryStage === undefined ? undefined : "revalidation-required";
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#toolLoopProgressGuard = new ToolLoopProgressGuard({
      existingExecutions: this.#existingExecutions,
      noProgressNudgeIteration: this.#noProgressNudgeIteration,
      maxNoProgressIterations: this.#maxNoProgressIterations,
      checkpointReader: this.#executionCheckpointController
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
      browserEvidenceNudge: this.#pendingBrowserEvidenceNudge,
      browserRetargetNudge: this.#pendingBrowserRetargetNudge,
      ...(this.#pendingBrowserVisualEscalationReason === undefined
        ? {}
        : { browserVisualEscalationReason: this.#pendingBrowserVisualEscalationReason }),
      suppressedBrowserTools: [...this.#suppressedBrowserTools],
      toolLoopProgressNudge: this.#pendingToolLoopProgressNudge
    };
    this.#pendingBrowserEvidenceNudge = false;
    this.#pendingBrowserRetargetNudge = false;
    this.#pendingBrowserVisualEscalationReason = undefined;
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
    await this.#applyAuthenticationCheckpointEffects(authenticationObservation.effects);
    this.#updateAuthenticationGate(authenticationObservation.effects);
    const userInputBlocker = authenticationObservation.effects
      .find((effect) => effect.blocker?.kind === "user_input_required")
      ?.blocker;
    if (userInputBlocker !== undefined) {
      this.#runtimeUserInputBlocker = userInputBlocker;
    } else if (authenticationObservation.effects.length > 0) {
      this.#runtimeUserInputBlocker = undefined;
    }
    const challenge = authenticationObservation.effects.find((effect) =>
      effect.effect === "challenge-required" && effect.blocker === undefined
    );
    if (challenge !== undefined) {
      this.#pendingProtectedChallenge = visibleProtectedChallenge(input.executions);
    } else if (authenticationObservation.effects.some((effect) =>
      effect.effect === "challenge-submitted" ||
      effect.effect === "authentication-verified" ||
      effect.effect === "authentication-blocked" ||
      effect.effect === "credentials-required"
    )) {
      this.#pendingProtectedChallenge = undefined;
    }
  }

  runtimeAdmissionGuard(): RuntimeToolAdmissionGuard {
    return ({ tool, input, executionEffect }) => {
      if (executionEffect?.kind !== "mutation" || this.#authenticationGateState === undefined) return undefined;
      if (isProtectedAuthenticationMutation(tool.name, input)) return undefined;
      return {
        code: "authentication-live-state-required",
        reason: this.#authenticationGateState === "challenge-required"
          ? "Tool execution blocked: complete and verify the live authentication challenge before unrelated mutations."
          : "Tool execution blocked: re-observe and verify the live authentication state before unrelated mutations."
      };
    };
  }

  takeProtectedAuthenticationChallenge(): ProtectedAuthenticationChallenge | undefined {
    const challenge = this.#pendingProtectedChallenge;
    this.#pendingProtectedChallenge = undefined;
    return challenge;
  }

  requireProtectedChallengeInput(): void {
    this.#runtimeUserInputBlocker = {
      summary: "The authentication challenge is visible, but protected one-time-code input is unavailable."
    };
  }

  assessProgress(executions: ToolExecutionRecord[]): ExecutionSupervisionAssessment {
    const browserObservation = this.#browserObservationGuard.observe(executions);
    const toolLoopProgress = this.#toolLoopProgressGuard.observe(executions);
    this.#executionWorkingSet?.observe(
      executions,
      this.#foregroundTurnId,
      this.#currentSessionId()
    );
    if (browserObservation?.evidenceAdvanced === true || browserObservation === undefined) {
      this.#suppressedBrowserTools = [];
    } else {
      this.#suppressedBrowserTools = [...browserObservation.suppressedTools];
    }
    if (browserObservation?.shouldNudge === true) this.#pendingBrowserEvidenceNudge = true;
    if (browserObservation?.shouldRetarget === true) this.#pendingBrowserRetargetNudge = true;
    if (browserObservation?.visualEscalationReason !== undefined) {
      this.#pendingBrowserVisualEscalationReason = browserObservation.visualEscalationReason;
    }
    if (toolLoopProgress.shouldNudge) this.#pendingToolLoopProgressNudge = true;

    return {
      browserObservation,
      toolLoopProgress,
      ...(this.#runtimeUserInputBlocker === undefined
        ? {}
        : { runtimeUserInputBlocker: this.#runtimeUserInputBlocker }),
      ...(this.#runtimeUserInputBlocker !== undefined
        ? { terminationCause: "user_input_required" as const }
        : browserObservation?.shouldStop === true
          ? { terminationCause: "browser_no_progress" as const }
          : toolLoopProgress.shouldStop
            ? { terminationCause: "tool_loop_no_progress" as const }
            : {})
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
        content: "I stopped this browser turn because the available evidence or ineffective target was repeated without a new grounded strategy. Completed effects were preserved, but the remaining browser work is incomplete.",
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

  async #applyAuthenticationCheckpointEffects(
    effects: readonly AuthenticationExecutionEffectReceipt[]
  ): Promise<void> {
    for (const effect of effects) {
      const stage = checkpointAuthenticationStage(effect);
      if (stage === "unchanged") continue;
      const current = this.#executionCheckpointController?.current();
      if (current === undefined) continue;
      await this.#executionCheckpointController
        ?.updateAuthenticationRecoveryStage(current.revision, stage)
        .catch(() => undefined);
    }
  }

  #updateAuthenticationGate(effects: readonly AuthenticationExecutionEffectReceipt[]): void {
    for (const effect of effects) {
      if (effect.effect === "authentication-verified") {
        this.#authenticationGateState = undefined;
      } else if (effect.effect === "challenge-required") {
        this.#authenticationGateState = "challenge-required";
      } else if (
        effect.effect === "credentials-submitted" ||
        effect.effect === "challenge-submitted" ||
        effect.effect === "authentication-candidate"
      ) {
        this.#authenticationGateState = "revalidation-required";
      } else if (effect.effect === "credentials-required" || effect.effect === "authentication-blocked") {
        this.#authenticationGateState = "blocked";
      }
    }
  }
}

function isProtectedAuthenticationMutation(
  toolName: string,
  input: Readonly<Record<string, unknown>>
): boolean {
  if (toolName === "browser.type") {
    const protectedInput = record(input.protectedInput);
    return protectedInput?.kind === "one-time-code" || protectedInput?.kind === "recovery-code";
  }
  if (toolName !== "browser.fill_protected_form" || !Array.isArray(input.fields) || input.fields.length === 0) {
    return false;
  }
  return input.fields.every((field) => {
    const kind = record(field)?.kind;
    return kind === "account-identifier" || kind === "password" ||
      kind === "one-time-code" || kind === "recovery-code";
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function checkpointAuthenticationStage(
  effect: AuthenticationExecutionEffectReceipt
): ExecutionCheckpointAuthenticationStage | undefined | "unchanged" {
  if (effect.effect === "credentials-submitted") return "credentials_submitted";
  if (effect.effect === "challenge-required") return "challenge_required";
  if (effect.effect === "challenge-submitted") return "challenge_submitted";
  if (effect.effect === "authentication-candidate") return "authentication_revalidation_required";
  if (effect.effect === "authentication-verified") return undefined;
  return "unchanged";
}

function visibleProtectedChallenge(
  executions: readonly ToolExecutionRecord[]
): ProtectedAuthenticationChallenge | undefined {
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    const execution = executions[index]!;
    if (!execution.tool.toolsets.includes("browser")) continue;
    const snapshot = browserSnapshot(execution.result?.metadata?.snapshot);
    if (snapshot === undefined || snapshot.sensitiveInputActive === true || snapshot.tab?.ref === undefined) return undefined;
    const elements = snapshot.elements ?? [];
    const codeFields = elements.filter((element) =>
      typeof element.ref === "string" &&
      (element.role === "textbox" || element.role === "searchbox" || element.role === "combobox") &&
      /one[-\s]?time|otp|mfa|verification\s+code|security\s+code|authenticat(?:ion|or)\s+code|رمز التحقق|رمز الأمان/iu
        .test([element.name, element.label, element.withinText].filter(Boolean).join(" "))
    );
    const submitControls = elements.filter((element) =>
      typeof element.ref === "string" && element.role === "button" &&
      /verify|submit|continue|confirm|next|authenticat(?:e|ion)|sign\s*in|log\s*in|تحقق|تأكيد|متابعة|مصادقة|دخول/iu
        .test([element.name, element.label, element.withinText].filter(Boolean).join(" "))
    );
    if (codeFields.length !== 1 || submitControls.length !== 1) return undefined;
    return {
      sessionId: snapshot.sessionId,
      identity: { ...snapshot.identity },
      tabRef: snapshot.tab.ref,
      fieldRef: codeFields[0]!.ref!,
      submitRef: submitControls[0]!.ref!
    };
  }
  return undefined;
}

function browserSnapshot(value: unknown): BrowserSnapshot | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const snapshot = value as Partial<BrowserSnapshot>;
  if (
    typeof snapshot.sessionId !== "string" ||
    typeof snapshot.url !== "string" ||
    typeof snapshot.observedAt !== "string" ||
    typeof snapshot.identity !== "object" || snapshot.identity === null
  ) return undefined;
  return snapshot as BrowserSnapshot;
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
