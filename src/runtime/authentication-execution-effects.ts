import {
  EXECUTION_PLAN_MAX_ITEMS,
  type AuthenticationExecutionEffect,
  type ExecutionPlan,
  type ExecutionPlanBlocker,
  type ExecutionPlanControllerApi,
  type ExecutionPlanEventSink,
  type ExecutionPlanItem,
  type ExecutionPlanMergeItemInput,
  type ExecutionPlanWriteInput,
} from "../contracts/execution-plan.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { isRuntimeProvisionalExecutionPlan } from "./execution-plan-controller.js";

const AUTHENTICATION_TOOL_NAMES = new Set([
  "browser.fill_protected_form",
  "browser.type",
]);
const CREDENTIAL_ITEM_ID = "authentication.credentials";
const CHALLENGE_ITEM_ID = "authentication.challenge";
const VERIFY_ITEM_ID = "authentication.verify";
const POST_LOGIN_ITEM_ID = "authentication.continue";
const CREDENTIAL_CONTENT = "Submit the required authentication credentials";
const CHALLENGE_CONTENT = "Complete the required authentication challenge";
const VERIFY_CONTENT = "Verify the authenticated state";
const POST_LOGIN_CONTENT = "Continue the requested post-login work";
const AUTHENTICATION_TERMS = /\b(?:authenticat(?:e|ed|ion)|credentials?|log[ -]?in|sign[ -]?in|password)\b|(?:المصادقة|بيانات الاعتماد|تسجيل الدخول|كلمة المرور)/iu;
const CREDENTIAL_TERMS = /\b(?:account identifier|credentials?|e-?mail|password|user(?:name)?)\b|(?:اسم المستخدم|البريد الإلكتروني|بيانات الاعتماد|كلمة المرور)/iu;
const CHALLENGE_TERMS = /\b(?:challenge|one[ -]?time|otp|2fa|mfa|verification code|security code|authenticator|passkey|security key|hardware key|biometric|captcha|approve (?:the )?(?:request|sign[ -]?in)|approval (?:prompt|request)|push (?:notification|approval)|device verification|confirm (?:this )?(?:sign[ -]?in|login)|choose (?:a )?verification method)\b|(?:رمز التحقق|رمز الأمان|رمز المصادقة|تحدي المصادقة|مفتاح المرور|مفتاح الأمان|الموافقة على تسجيل الدخول|إشعار الموافقة|التحقق من الجهاز)/iu;
const VERIFY_TERMS = /\b(?:verify|confirm|check).{0,40}\b(?:authenticat(?:e|ed|ion)|log[ -]?in|sign[ -]?in|session)\b|\bauthenticated state\b|(?:تحقق|تأكد).{0,40}(?:المصادقة|تسجيل الدخول|الجلسة)/iu;
const GENERAL_VERIFY_TERMS = /\b(?:verify|confirm|check|validation)\b|(?:تحقق|تأكد|تأكيد)/iu;
const POST_LOGIN_SEQUENCE = /\b(?:and then|then|after(?:wards)?|once)\b|(?:ثم|بعد ذلك|بعد تسجيل الدخول)/iu;
const POST_LOGIN_CONJUNCTIVE_ACTION = /\band\b.{0,160}\b(?:add|apply|build|change|configure|create|delete|deploy|edit|inspect|publish|remove|send|set[ -]?up|test|update|upload|verify|write)\b|(?:و|،\s*و).{0,160}(?:أنشئ|انشئ|غيّر|غير|حدّث|حدث|عدّل|عدل|احذف|تحقق|راجع|هيّئ|هيئ)/iu;
const AUTHENTICATION_ERROR_TERMS = /\b(?:access denied|account locked|auth(?:entication)? (?:error|failed)|authentication service unavailable|incorrect (?:code|credentials?|password)|invalid (?:code|credentials?|password)|login failed|sign[ -]?in failed|unauthorized)\b|(?:بيانات الاعتماد غير صحيحة|رمز غير صحيح|فشل تسجيل الدخول|فشلت المصادقة|خطأ في المصادقة|خدمة المصادقة غير متاحة|غير مصرح|تم قفل الحساب)/iu;

export type AuthenticationExecutionStage = "credentials" | "challenge" | "verification";

/** Runtime-only receipt. It is never accepted from provider tool input. */
export type AuthenticationExecutionEffectReceipt = {
  effect: AuthenticationExecutionEffect;
  stage: AuthenticationExecutionStage;
  toolCallId: string;
  blocker?: ExecutionPlanBlocker;
  failureProof?: "authentication-error" | "signed-out";
};

export function deriveAuthenticationExecutionEffects(
  executions: readonly ToolExecutionRecord[]
): AuthenticationExecutionEffectReceipt[] {
  return executions.flatMap((execution) => deriveAuthenticationExecutionEffectsForTool(execution));
}

export async function applyAuthenticationExecutionEffects(input: {
  controller: ExecutionPlanControllerApi;
  effects: readonly AuthenticationExecutionEffectReceipt[];
  objective: string;
  originTurnId: string;
  sink?: ExecutionPlanEventSink;
}): Promise<void> {
  for (const effect of prioritizeAuthenticationExecutionEffects(input.effects)) {
    const current = input.controller.current();
    if (current === undefined) {
      await input.controller.write(
        initialAuthenticationPlan(input.objective, effect),
        input.originTurnId,
        input.sink
      );
      continue;
    }
    if (current.status === "transferred" || current.status === "abandoned") continue;
    const patches = authenticationEffectPatches(current, effect);
    if (patches.length > 0 && planHasCapacityForPatches(current, patches)) {
      await input.controller.merge({ items: patches }, input.sink);
    }
  }
}

/** A challenge observed in the same trusted receipt always outranks a success claim. */
export function prioritizeAuthenticationExecutionEffects(
  effects: readonly AuthenticationExecutionEffectReceipt[]
): AuthenticationExecutionEffectReceipt[] {
  const challengedCalls = new Set(
    effects
      .filter((effect) => effect.effect === "challenge-required")
      .map((effect) => effect.toolCallId)
  );
  return effects.filter((effect) =>
    effect.effect !== "authentication-verified" || !challengedCalls.has(effect.toolCallId)
  );
}

function deriveAuthenticationExecutionEffectsForTool(
  execution: ToolExecutionRecord
): AuthenticationExecutionEffectReceipt[] {
  if (
    execution.decision !== "allow" ||
    !AUTHENTICATION_TOOL_NAMES.has(execution.tool.name) ||
    execution.toolCallId?.trim().length === 0 ||
    execution.toolCallId === undefined
  ) {
    return [];
  }
  const metadata = record(execution.result?.metadata);
  if (metadata === undefined) return [];
  return execution.tool.name === "browser.fill_protected_form"
    ? credentialEffects(metadata, execution.toolCallId, execution.result?.ok === true)
    : challengeEffects(metadata, execution.toolCallId, execution.result?.ok === true);
}

function credentialEffects(
  metadata: Record<string, unknown>,
  toolCallId: string,
  succeeded: boolean
): AuthenticationExecutionEffectReceipt[] {
  const receipt = record(metadata.secureInputGroupReceipt);
  const receiptStatus = secureInputReceiptStatus(receipt?.status);
  if (receiptStatus === "cancelled" || receiptStatus === "expired") {
    return [{
      effect: "credentials-required",
      stage: "credentials",
      toolCallId,
      blocker: {
        kind: "user_input_required",
        summary: receiptStatus === "expired"
          ? "The protected credential request expired before all required values were provided."
          : "The required authentication credentials were not provided.",
      },
    }];
  }
  if (receiptStatus === "failed") {
    return [blockedEffect(toolCallId, "credentials", "Protected credential delivery failed before authentication could continue.")];
  }

  const delivery = protectedDelivery(metadata.protectedDelivery);
  if (delivery === undefined) return [];
  if (delivery.submission === "failed") {
    return [blockedEffect(toolCallId, "credentials", "The verified authentication control could not be submitted.")];
  }
  if (delivery.challengeState === "still-present") {
    return [blockedEffect(toolCallId, "credentials", "The credential challenge remained after the protected submission.")];
  }
  if (delivery.sensitiveInputActive || delivery.challengeState === "unknown") {
    return [blockedEffect(toolCallId, "credentials", "The protected credential transaction could not be safely settled.")];
  }
  if (snapshotReportsAuthenticationError(metadata.snapshot)) {
    return [blockedEffect(
      toolCallId,
      "credentials",
      "The protected credential submission reached an authentication error state.",
      "authentication-error"
    )];
  }
  if (!succeeded || (delivery.submission !== "clicked" && delivery.submission !== "automatic")) return [];

  const effects: AuthenticationExecutionEffectReceipt[] = [{
    effect: "credentials-submitted",
    stage: "credentials",
    toolCallId,
  }];
  effects.push(snapshotRequiresAuthenticationChallenge(metadata.snapshot)
    ? { effect: "challenge-required", stage: "challenge", toolCallId }
    : { effect: "authentication-candidate", stage: "credentials", toolCallId });
  return effects;
}

function challengeEffects(
  metadata: Record<string, unknown>,
  toolCallId: string,
  succeeded: boolean
): AuthenticationExecutionEffectReceipt[] {
  const receipt = record(metadata.secureInputReceipt);
  const receiptStatus = secureInputReceiptStatus(receipt?.status);
  if (receiptStatus === "cancelled" || receiptStatus === "expired") {
    return [{
      effect: "challenge-required",
      stage: "challenge",
      toolCallId,
      blocker: {
        kind: "user_input_required",
        summary: receiptStatus === "expired"
          ? "The authentication challenge expired before the required code was provided."
          : "The required authentication challenge code was not provided.",
      },
    }];
  }
  if (receiptStatus === "failed") {
    return [blockedEffect(toolCallId, "challenge", "Protected authentication challenge delivery failed.")];
  }

  const delivery = protectedDelivery(metadata.protectedDelivery);
  if (delivery === undefined) return [];
  if (delivery.submission === "not-requested") {
    return [{ effect: "challenge-required", stage: "challenge", toolCallId }];
  }
  if (delivery.submission === "failed") {
    return [blockedEffect(toolCallId, "challenge", "The verified authentication challenge control could not be submitted.")];
  }
  if (delivery.challengeState === "still-present") {
    return [
      { effect: "challenge-submitted", stage: "challenge", toolCallId },
      {
        effect: "challenge-required",
        stage: "challenge",
        toolCallId,
        blocker: {
          kind: "user_input_required",
          summary: "The authentication challenge remained after submission; provide a new or corrected response.",
        },
      },
    ];
  }
  if (delivery.sensitiveInputActive || delivery.challengeState === "unknown") {
    return [blockedEffect(toolCallId, "challenge", "The protected authentication challenge could not be safely settled.")];
  }
  if (snapshotReportsAuthenticationError(metadata.snapshot)) {
    return [blockedEffect(
      toolCallId,
      "challenge",
      "The protected authentication challenge reached an error state.",
      "authentication-error"
    )];
  }
  if (!succeeded || (delivery.submission !== "clicked" && delivery.submission !== "automatic")) return [];
  const effects: AuthenticationExecutionEffectReceipt[] = [
    { effect: "challenge-submitted", stage: "challenge", toolCallId },
  ];
  if (snapshotRequiresAuthenticationChallenge(metadata.snapshot)) {
    effects.push({ effect: "challenge-required", stage: "challenge", toolCallId });
  } else {
    effects.push({ effect: "authentication-candidate", stage: "challenge", toolCallId });
  }
  return effects;
}

function initialAuthenticationPlan(
  objective: string,
  effect: AuthenticationExecutionEffectReceipt
): ExecutionPlanWriteInput {
  const items: ExecutionPlanWriteInput["items"] = [];
  if (effect.stage === "credentials" || effect.effect === "credentials-submitted") {
    items.push({ id: CREDENTIAL_ITEM_ID, content: CREDENTIAL_CONTENT, status: "pending" });
  }
  if (effect.stage === "challenge" || effect.effect === "challenge-required") {
    items.push({ id: CHALLENGE_ITEM_ID, content: CHALLENGE_CONTENT, status: "pending" });
  }
  items.push({ id: VERIFY_ITEM_ID, content: VERIFY_CONTENT, status: "pending" });
  if (hasPostLoginObjective(objective)) {
    items.push({ id: POST_LOGIN_ITEM_ID, content: POST_LOGIN_CONTENT, status: "pending" });
  }
  const plan: ExecutionPlan = {
    objective,
    originTurnId: "runtime-authentication-effect",
    revision: 1,
    status: "active",
    items: items.map((item) => ({ ...item, status: item.status ?? "pending" })),
  };
  const patches = authenticationEffectPatches(plan, effect);
  return {
    objective,
    items: applyPatchesToWriteItems(items, patches),
  };
}

function authenticationEffectPatches(
  plan: ExecutionPlan,
  effect: AuthenticationExecutionEffectReceipt
): ExecutionPlanMergeItemInput[] {
  const ids = resolveAuthenticationItemIds(plan);
  const patches: ExecutionPlanMergeItemInput[] = [];
  const provisional = isProvisionalPlan(plan);
  const verificationCompleted = plan.items.find((item) => item.id === ids.verify)?.status === "completed";
  if (
    verificationCompleted &&
    effect.effect !== "authentication-verified" &&
    !(effect.effect === "authentication-blocked" && effect.failureProof !== undefined)
  ) {
    return patches;
  }
  if (provisional) {
    patches.push({ id: "verify", content: VERIFY_CONTENT });
    if (hasPostLoginObjective(plan.objective) && !plan.items.some((item) => item.id === POST_LOGIN_ITEM_ID)) {
      patches.push({ id: POST_LOGIN_ITEM_ID, content: POST_LOGIN_CONTENT, status: "pending" });
    }
  }
  const activate = (id: string, content: string, blocker?: ExecutionPlanBlocker) => {
    const existing = plan.items.find((item) => item.id === id);
    demoteOtherActiveItems(plan, id, patches);
    patches.push({
      id,
      ...(existing === undefined || (provisional && id === "execute") ? { content } : {}),
      status: blocker === undefined ? "in_progress" : "blocked",
      evidenceCallIds: existing?.evidenceCallIds ?? [],
      blocker: blocker ?? null,
    });
  };
  const complete = (id: string, content: string) => {
    const existing = plan.items.find((item) => item.id === id);
    if (existing?.status === "completed") return;
    patches.push({
      id,
      ...(existing === undefined || (provisional && id === "execute") ? { content } : {}),
      status: "completed",
      evidenceCallIds: [...new Set([...(existing?.evidenceCallIds ?? []), effect.toolCallId])],
      blocker: null,
    });
  };

  switch (effect.effect) {
    case "credentials-required":
      activate(ids.credentials, CREDENTIAL_CONTENT, effect.blocker);
      break;
    case "credentials-submitted":
      complete(ids.credentials, CREDENTIAL_CONTENT);
      activate(ids.verify, VERIFY_CONTENT);
      break;
    case "challenge-required":
      activate(ids.challenge, CHALLENGE_CONTENT, effect.blocker);
      ensurePending(ids.verify, VERIFY_CONTENT, plan, patches);
      break;
    case "challenge-submitted":
      awaitChallengeVerification(ids.challenge, CHALLENGE_CONTENT, plan, patches, effect.toolCallId);
      activate(ids.verify, VERIFY_CONTENT);
      break;
    case "authentication-candidate":
      if (effect.stage === "credentials") complete(ids.credentials, CREDENTIAL_CONTENT);
      if (effect.stage === "challenge") {
        awaitChallengeVerification(ids.challenge, CHALLENGE_CONTENT, plan, patches, effect.toolCallId);
      }
      activate(ids.verify, VERIFY_CONTENT);
      break;
    case "authentication-verified":
      if (plan.items.some((item) => item.id === ids.challenge)) {
        complete(ids.challenge, CHALLENGE_CONTENT);
      }
      complete(ids.verify, VERIFY_CONTENT);
      activateNextPostLoginItem(plan, patches, new Set([ids.credentials, ids.challenge, ids.verify]));
      break;
    case "authentication-blocked":
      activate(
        effect.stage === "credentials" ? ids.credentials : effect.stage === "challenge" ? ids.challenge : ids.verify,
        effect.stage === "credentials" ? CREDENTIAL_CONTENT : effect.stage === "challenge" ? CHALLENGE_CONTENT : VERIFY_CONTENT,
        effect.blocker ?? { kind: "external_state", summary: "Authentication could not continue from the current browser state." }
      );
      break;
  }
  return dedupePatches(patches);
}

function resolveAuthenticationItemIds(plan: ExecutionPlan): {
  credentials: string;
  challenge: string;
  verify: string;
} {
  const provisional = isProvisionalPlan(plan);
  const credentialsExisting = findItem(plan.items, CREDENTIAL_ITEM_ID, CREDENTIAL_TERMS)?.id ?? (provisional ? "execute" : undefined);
  const challenge = findItem(plan.items, CHALLENGE_ITEM_ID, CHALLENGE_TERMS)?.id ?? CHALLENGE_ITEM_ID;
  const authenticationPlan = AUTHENTICATION_TERMS.test(plan.objective) || credentialsExisting !== undefined || challenge !== CHALLENGE_ITEM_ID;
  const verify = findItem(plan.items, VERIFY_ITEM_ID, VERIFY_TERMS)?.id ??
    (authenticationPlan ? plan.items.find((item) => GENERAL_VERIFY_TERMS.test(item.content))?.id : undefined) ??
    (provisional ? "verify" : undefined) ??
    VERIFY_ITEM_ID;
  return {
    credentials: credentialsExisting ?? CREDENTIAL_ITEM_ID,
    challenge,
    verify,
  };
}

function isProvisionalPlan(plan: ExecutionPlan): boolean {
  return isRuntimeProvisionalExecutionPlan(plan);
}

function findItem(items: readonly ExecutionPlanItem[], preferredId: string, pattern: RegExp): ExecutionPlanItem | undefined {
  return items.find((item) => item.id === preferredId) ?? items.find((item) => pattern.test(item.content));
}

function demoteOtherActiveItems(
  plan: ExecutionPlan,
  activeId: string,
  patches: ExecutionPlanMergeItemInput[]
): void {
  for (const item of plan.items) {
    const planned = [...patches].reverse().find((patch) => patch.id === item.id);
    if (
      item.id !== activeId &&
      item.status === "in_progress" &&
      planned?.status !== "completed" &&
      planned?.status !== "blocked"
    ) {
      patches.push({ id: item.id, status: "pending", blocker: null });
    }
  }
}

function ensurePending(
  id: string,
  content: string,
  plan: ExecutionPlan,
  patches: ExecutionPlanMergeItemInput[]
): void {
  const existing = plan.items.find((item) => item.id === id);
  if (existing === undefined) {
    patches.push({ id, content, status: "pending" });
  } else if (existing.status === "blocked") {
    patches.push({ id, status: "pending", evidenceCallIds: [], blocker: null });
  }
}

function awaitChallengeVerification(
  id: string,
  content: string,
  plan: ExecutionPlan,
  patches: ExecutionPlanMergeItemInput[],
  toolCallId: string
): void {
  const existing = plan.items.find((item) => item.id === id);
  patches.push({
    id,
    ...(existing === undefined ? { content } : {}),
    status: "pending",
    evidenceCallIds: [toolCallId],
    blocker: null,
  });
}

function activateNextPostLoginItem(
  plan: ExecutionPlan,
  patches: ExecutionPlanMergeItemInput[],
  authenticationIds: ReadonlySet<string>
): void {
  const next = plan.items.find((item) => !authenticationIds.has(item.id) && item.status === "pending");
  if (next === undefined) return;
  demoteOtherActiveItems(plan, next.id, patches);
  patches.push({ id: next.id, status: "in_progress", blocker: null });
}

function applyPatchesToWriteItems(
  items: ExecutionPlanWriteInput["items"],
  patches: readonly ExecutionPlanMergeItemInput[]
): ExecutionPlanWriteInput["items"] {
  const output = items.map((item) => ({ ...item }));
  const indexes = new Map(output.map((item, index) => [item.id, index]));
  for (const patch of patches) {
    const index = indexes.get(patch.id);
    const next = {
      ...(index === undefined ? { id: patch.id, content: patch.content! } : output[index]!),
      ...(patch.content === undefined ? {} : { content: patch.content }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.evidenceCallIds === undefined ? {} : { evidenceCallIds: patch.evidenceCallIds }),
      ...(patch.blocker === undefined || patch.blocker === null ? {} : { blocker: patch.blocker }),
    };
    if (patch.blocker === null) delete next.blocker;
    if (index === undefined) {
      if (output.length >= EXECUTION_PLAN_MAX_ITEMS) continue;
      indexes.set(patch.id, output.length);
      output.push(next);
    } else {
      output[index] = next;
    }
  }
  return output;
}

function dedupePatches(patches: readonly ExecutionPlanMergeItemInput[]): ExecutionPlanMergeItemInput[] {
  const byId = new Map<string, ExecutionPlanMergeItemInput>();
  for (const patch of patches) {
    byId.set(patch.id, { ...(byId.get(patch.id) ?? {}), ...patch });
  }
  return [...byId.values()];
}

function planHasCapacityForPatches(
  plan: ExecutionPlan,
  patches: readonly ExecutionPlanMergeItemInput[]
): boolean {
  const existingIds = new Set(plan.items.map((item) => item.id));
  const newIds = new Set(patches.filter((patch) => !existingIds.has(patch.id)).map((patch) => patch.id));
  return plan.items.length + newIds.size <= EXECUTION_PLAN_MAX_ITEMS;
}

function blockedEffect(
  toolCallId: string,
  stage: AuthenticationExecutionStage,
  summary: string,
  failureProof?: AuthenticationExecutionEffectReceipt["failureProof"]
): AuthenticationExecutionEffectReceipt {
  return {
    effect: "authentication-blocked",
    stage,
    toolCallId,
    blocker: { kind: "external_state", summary },
    ...(failureProof === undefined ? {} : { failureProof }),
  };
}

export function snapshotRequiresAuthenticationChallenge(value: unknown): boolean {
  const snapshot = record(value);
  if (snapshot === undefined) return false;
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
  const evidence = [
    typeof snapshot.title === "string" ? snapshot.title : "",
    typeof snapshot.text === "string" ? snapshot.text.slice(0, 4_000) : "",
    ...elements.slice(0, 64).flatMap((element) => {
      const candidate = record(element);
      if (
        candidate === undefined ||
        candidate.hidden === true ||
        candidate.disabled === true ||
        candidate.interactable === false
      ) return [];
      return [candidate.role, candidate.name, candidate.label, candidate.text]
        .filter((entry): entry is string => typeof entry === "string");
    }),
  ].join(" ");
  return CHALLENGE_TERMS.test(evidence);
}

export function snapshotReportsAuthenticationError(value: unknown): boolean {
  const snapshot = record(value);
  if (snapshot === undefined) return false;
  const evidence = [snapshot.url, snapshot.title, typeof snapshot.text === "string" ? snapshot.text.slice(0, 4_000) : undefined]
    .filter((entry): entry is string => typeof entry === "string")
    .join(" ");
  return AUTHENTICATION_ERROR_TERMS.test(evidence);
}

function hasPostLoginObjective(objective: string): boolean {
  return POST_LOGIN_SEQUENCE.test(objective) || POST_LOGIN_CONJUNCTIVE_ACTION.test(objective);
}

function protectedDelivery(value: unknown): {
  submission: "not-requested" | "clicked" | "automatic" | "failed";
  challengeState: "departed" | "still-present" | "unknown";
  sensitiveInputActive: boolean;
} | undefined {
  const candidate = record(value);
  if (
    candidate?.delivery !== "delivered" ||
    !isSubmission(candidate.submission) ||
    !isChallengeState(candidate.challengeState) ||
    typeof candidate.sensitiveInputActive !== "boolean"
  ) return undefined;
  return {
    submission: candidate.submission,
    challengeState: candidate.challengeState,
    sensitiveInputActive: candidate.sensitiveInputActive,
  };
}

function secureInputReceiptStatus(value: unknown): "delivered" | "cancelled" | "expired" | "failed" | undefined {
  return value === "delivered" || value === "cancelled" || value === "expired" || value === "failed" ? value : undefined;
}

function isSubmission(value: unknown): value is "not-requested" | "clicked" | "automatic" | "failed" {
  return value === "not-requested" || value === "clicked" || value === "automatic" || value === "failed";
}

function isChallengeState(value: unknown): value is "departed" | "still-present" | "unknown" {
  return value === "departed" || value === "still-present" || value === "unknown";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
