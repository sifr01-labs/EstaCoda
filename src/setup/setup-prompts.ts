import type { SelectPromptInput } from "../cli/interactive-select.js";
import type { Prompt } from "../cli/readline-prompt.js";
import {
  promptUiContextForLocale,
  type PromptUiContext,
} from "../contracts/ui.js";
import {
  type SetupApplyEndState,
  type SetupApplyPlanningResult,
} from "./setup-apply-plan.js";
import {
  type SetupReviewManifest,
  type SetupReviewManifestSection,
} from "./setup-review-manifest.js";
import { hasSetupCopyKey, resolveSetupCopy, type SetupCopyKey, type SetupCopyLocale } from "./setup-copy.js";

export type SetupChoice<T> = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly value: T;
};

export type SetupPromptValue = string | number | readonly string[] | boolean | undefined;

export type SetupCardOption = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly technical?: boolean;
};

export type SetupPromptContext = {
  readonly prompt: Prompt;
  readonly locale: SetupCopyLocale;
  readonly uiContext: PromptUiContext;
};

export function setupPromptContext(prompt: Prompt, locale: SetupCopyLocale): SetupPromptContext {
  return {
    prompt,
    locale,
    uiContext: promptUiContextForLocale(locale),
  };
}

const REVIEW_SECTION_COPY_KEYS: Record<SetupReviewManifestSection, SetupCopyKey> = {
  "files-to-write-update": "setupReview.sections.filesToWriteUpdate",
  "secret-refs-to-store": "setupReview.sections.secretRefsToStore",
  "workspace-trust-grants": "setupReview.sections.workspaceTrustGrants",
  "provider-model-network": "setupReview.sections.providerModelNetwork",
  "enabled-optional-capabilities": "setupReview.sections.enabledOptionalCapabilities",
  "remote-control-surfaces": "setupReview.sections.remoteControlSurfaces",
  "security-mode": "setupReview.sections.securityMode",
  "workflow-learning": "setupReview.sections.workflowLearning",
  "verification-checks": "setupReview.sections.verificationChecks",
  "launch-handoff": "setupReview.sections.launchHandoff",
  blockers: "setupReview.sections.blockers",
  warnings: "setupReview.sections.warnings",
};

type SetupPromptTarget = Prompt | SetupPromptContext;

export async function promptSetupChoice<T>(target: SetupPromptTarget, input: {
  readonly title: string;
  readonly message: string;
  readonly choices: readonly SetupChoice<T>[];
  readonly defaultValue?: T;
}): Promise<T> {
  if (input.choices.length === 0) {
    throw new Error(`${input.title} has no choices.`);
  }

  const defaultIndex = Math.max(0, input.choices.findIndex((choice) => Object.is(choice.value, input.defaultValue)));
  const { prompt, uiContext } = resolveSetupPromptTarget(target);
  if (prompt.select !== undefined) {
    return prompt.select({
      title: input.title,
      body: input.message.trim(),
      options: input.choices.map((choice) => ({
        label: choice.label,
        description: choice.description,
        value: choice.value,
      })),
      defaultIndex,
      fallbackPrompt: "Choose: ",
      surface: "promptCard",
      locale: uiContext.locale,
      direction: uiContext.direction,
    } satisfies SelectPromptInput<T>);
  }

  const options = input.choices.map((choice, index) => `${index + 1}. ${choice.label}`).join("\n");
  const raw = await prompt(`${input.message}${options}\nChoose [${(defaultIndex === -1 ? 0 : defaultIndex) + 1}]: `);
  const selectedIndex = Number.parseInt(raw.trim(), 10) - 1;
  return input.choices[selectedIndex]?.value ?? input.choices[defaultIndex === -1 ? 0 : defaultIndex]!.value;
}

export async function promptSetupYesNo(target: SetupPromptTarget, input: {
  readonly title: string;
  readonly message: string;
  readonly yes: Omit<SetupChoice<true>, "value">;
  readonly no: Omit<SetupChoice<false>, "value">;
  readonly defaultValue?: boolean;
}): Promise<boolean> {
  return promptSetupChoice(target, {
    title: input.title,
    message: input.message,
    choices: [
      { ...input.yes, value: true },
      { ...input.no, value: false },
    ],
    defaultValue: input.defaultValue,
  });
}

export async function promptSetupStringWithDefault(
  target: SetupPromptTarget,
  question: string,
  defaultValue: string
): Promise<string> {
  // Follow-up: raw readline prompts need RTL-safe display for mixed defaults.
  const { prompt } = resolveSetupPromptTarget(target);
  const answer = (await prompt(question)).trim();
  return answer.length > 0 ? answer : defaultValue;
}

export async function showSetupCard(
  target: SetupPromptTarget,
  input: {
    readonly title: string;
    readonly bodyLines: readonly string[];
    readonly technicalLines?: readonly string[];
    readonly options: readonly SetupCardOption[];
  }
): Promise<void> {
  const { prompt, uiContext } = resolveSetupPromptTarget(target);
  await prompt.onboardingCard?.({
    title: input.title,
    bodyLines: input.bodyLines,
    technicalLines: input.technicalLines,
    options: input.options,
    selectedOptionIndex: 0,
    locale: uiContext.locale,
    direction: uiContext.direction,
  });
}

function resolveSetupPromptTarget(target: SetupPromptTarget): SetupPromptContext {
  if (typeof target === "function") {
    const uiContext = target.uiContext ?? promptUiContextForLocale("en");
    return {
      prompt: target,
      locale: uiContext.locale,
      uiContext,
    };
  }
  return target;
}

export function setupCopyText(locale: SetupCopyLocale, key: SetupCopyKey): string {
  return resolveSetupCopy(locale, key);
}

export function formatSetupCopy(
  locale: SetupCopyLocale,
  key: SetupCopyKey,
  values: Record<string, SetupPromptValue>
): string {
  const template = setupCopyText(locale, key);
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) return "";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  });
}

export function renderSetupReviewManifest(manifest: SetupReviewManifest, locale: SetupCopyLocale): string {
  const lines = [setupCopyText(locale, "setupReview.title")];
  for (const section of Object.keys(REVIEW_SECTION_COPY_KEYS) as SetupReviewManifestSection[]) {
    const entries = manifest.sections[section];
    if (entries.length === 0) continue;
    lines.push("", setupCopyText(locale, REVIEW_SECTION_COPY_KEYS[section]));
    for (const line of entries) {
      lines.push(`- ${renderReviewLine(locale, line.summaryKey, line.review.values)}`);
    }
  }
  if (manifest.metadata.lineCount === 0) {
    lines.push(`- ${setupCopyText(locale, "setupReview.empty")}`);
  }
  return lines.join("\n");
}

export function renderSetupApplyPlanningResult(
  result: SetupApplyPlanningResult,
  locale: SetupCopyLocale
): string {
  switch (result.kind) {
    case "apply-plan-ready":
      return setupCopyText(locale, "setupApply.plan.ready");
    case "blocked":
      return formatSetupCopy(locale, "setupApply.review.blocked", {
        blockerCount: String(result.eligibility.blockers.length),
      });
    case "cancelled":
      return setupCopyText(locale, "setupApply.review.cancelled");
  }
}

export function renderSetupApplyEndState(endState: SetupApplyEndState, locale: SetupCopyLocale): string {
  switch (endState.kind) {
    case "verified-ready":
      return setupCopyText(locale, "setupApply.endState.verifiedReady");
    case "verified-degraded":
      return setupCopyText(locale, "setupApply.endState.verifiedDegraded");
    case "blocked":
      if (endState.reason === "save-failed") {
        return formatSetupCopy(locale, "setupApply.endState.saveFailed", {
          error: endState.blockers[0] ?? "unknown",
        });
      }
      if (endState.reason === "verification-blocked") {
        if ((endState.persistedSecretCount ?? 0) > 0) {
          return formatSetupCopy(locale, "setupApply.endState.verificationBlockedAfterPersistence", {
            blocker: endState.blockers[0] ?? "unknown",
          });
        }
        return formatSetupCopy(locale, "setupApply.endState.verificationBlocked", {
          blocker: endState.blockers[0] ?? "unknown",
        });
      }
      return formatSetupCopy(locale, "setupApply.review.blocked", {
        blockerCount: String(endState.blockers.length),
      });
    case "cancelled":
      return setupCopyText(locale, "setupApply.review.cancelled");
    case "saved-not-launched":
      return setupCopyText(locale, "setupApply.endState.savedNotLaunched");
    case "launched":
      return [
        setupCopyText(locale, "setupApply.endState.launched"),
        endState.acceptedDegraded ? setupCopyText(locale, "setupApply.endState.acceptedDegraded") : undefined,
      ].filter((line): line is string => line !== undefined).join("\n");
  }
}

function renderReviewLine(
  locale: SetupCopyLocale,
  summaryKey: string,
  values: Record<string, SetupPromptValue>
): string {
  if (hasSetupCopyKey(summaryKey)) {
    return formatSetupCopy(locale, summaryKey, reviewPlaceholderValues(values));
  }
  return setupCopyText(locale, "setupReview.itemFallback");
}

function reviewPlaceholderValues(
  values: Record<string, SetupPromptValue>
): Record<string, SetupPromptValue> {
  const envVars = values.envVars;
  return {
    ...values,
    providerId: values.providerId ?? values.provider,
    modelId: values.modelId ?? values.model,
    envVar: values.envVar ?? values.botTokenEnv ?? (Array.isArray(envVars) ? envVars.join(", ") : envVars),
    identityRefs: values.identityRefs ?? remoteControlIdentityRefs(values),
    workspacePath: values.workspacePath ?? values.workspaceRoot,
    workflowMode: values.workflowMode ?? values.workflowLearning,
    capabilities: values.capabilities,
  };
}

function remoteControlIdentityRefs(values: Record<string, SetupPromptValue>): string | undefined {
  const allowedUserIds = Array.isArray(values.allowedUserIds) ? values.allowedUserIds : [];
  const allowedChatIds = Array.isArray(values.allowedChatIds) ? values.allowedChatIds : [];
  const allowedUsers = Array.isArray(values.allowedUsers) ? values.allowedUsers : [];
  const allowedGuilds = Array.isArray(values.allowedGuilds) ? values.allowedGuilds : [];
  const allowedChannels = Array.isArray(values.allowedChannels) ? values.allowedChannels : [];
  const refs = [
    ...allowedUserIds.map((id) => `user:${id}`),
    ...allowedChatIds.map((id) => `chat:${id}`),
    ...allowedUsers.map((id) => `user:${id}`),
    ...allowedGuilds.map((id) => `guild:${id}`),
    ...allowedChannels.map((id) => `channel:${id}`),
  ];
  return refs.length > 0 ? refs.join(", ") : undefined;
}
