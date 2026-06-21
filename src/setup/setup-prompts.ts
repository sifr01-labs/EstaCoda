import type { SelectPromptInput } from "../cli/interactive-select.js";
import type { Prompt } from "../cli/readline-prompt.js";
import type { PromptCardBodyLineStyle, PromptCardStatusLine } from "../contracts/view-model.js";
import { isolateLtr, isolateRtl } from "../ui/bidi.js";
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
  readonly technical?: boolean;
  readonly cells?: Readonly<Record<string, string>>;
  readonly badges?: readonly string[];
  readonly current?: boolean;
  readonly group?: "main" | "navigation";
  readonly value: T;
};

export type SetupChoiceResult<T> =
  | { readonly kind: "selected"; readonly value: T }
  | { readonly kind: "back" };

export type SetupChoiceColumn = {
  readonly key: string;
  readonly header: string;
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

export type PromptSetupChoiceInput<T> = {
  readonly title: string;
  readonly message: string;
  readonly bodyLineStyles?: readonly PromptCardBodyLineStyle[];
  readonly choices: readonly SetupChoice<T>[];
  readonly defaultValue?: T;
  readonly columns?: readonly SetupChoiceColumn[];
  readonly statusLines?: readonly PromptCardStatusLine[];
  readonly hint?: string;
  readonly showCurrentBadge?: boolean;
  readonly showColumnHeaders?: boolean;
};

const SETUP_BACK_CHOICE_VALUE = Symbol("setup-back-choice");

export async function promptSetupChoice<T>(
  target: SetupPromptTarget,
  input: PromptSetupChoiceInput<T>
): Promise<T> {
  if (input.choices.length === 0) {
    throw new Error(`${input.title} has no choices.`);
  }

  const defaultIndex = Math.max(0, input.choices.findIndex((choice) => Object.is(choice.value, input.defaultValue)));
  const { prompt, uiContext } = resolveSetupPromptTarget(target);
  if (prompt.select !== undefined) {
    return prompt.select({
      title: input.title,
      body: input.message.trim(),
      bodyLineStyles: input.bodyLineStyles,
      options: input.choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
        description: choice.description,
        technical: choice.technical,
        cells: choice.cells,
        badges: choice.badges,
        current: choice.current,
        group: choice.group,
        value: choice.value,
      })),
      defaultIndex,
      fallbackPrompt: "Choose: ",
      surface: "promptCard",
      columns: input.columns,
      statusLines: input.statusLines,
      hint: input.hint ?? setupNavigationHint(uiContext.locale),
      showCurrentBadge: input.showCurrentBadge,
      showColumnHeaders: input.showColumnHeaders,
      locale: uiContext.locale,
      direction: uiContext.direction,
    } satisfies SelectPromptInput<T>);
  }

  const options = input.choices.map((choice, index) => `${index + 1}. ${choice.label}`).join("\n");
  const raw = await prompt(`${input.message}${options}\nChoose [${(defaultIndex === -1 ? 0 : defaultIndex) + 1}]: `);
  const selectedIndex = Number.parseInt(raw.trim(), 10) - 1;
  return input.choices[selectedIndex]?.value ?? input.choices[defaultIndex === -1 ? 0 : defaultIndex]!.value;
}

export async function promptSetupChoiceResult<T>(
  target: SetupPromptTarget,
  input: PromptSetupChoiceInput<T> & {
    readonly allowBack?: boolean;
  }
): Promise<SetupChoiceResult<T>> {
  const { uiContext } = resolveSetupPromptTarget(target);
  const choices: readonly SetupChoice<T | typeof SETUP_BACK_CHOICE_VALUE>[] = input.allowBack === true
    ? [...input.choices, setupBackChoice(uiContext.locale)]
    : input.choices;
  const selected = await promptSetupChoice<T | typeof SETUP_BACK_CHOICE_VALUE>(target, {
    ...input,
    choices,
    defaultValue: input.defaultValue,
  });
  if (selected === SETUP_BACK_CHOICE_VALUE) {
    return { kind: "back" };
  }
  return { kind: "selected", value: selected };
}

function setupBackChoice(locale: SetupCopyLocale): SetupChoice<typeof SETUP_BACK_CHOICE_VALUE> {
  return setupNavigationChoice({
    id: "back",
    label: locale === "ar" ? "رجوع" : "Back",
    description: setupCopyText(locale, "onboarding.providers.navigation.back.description"),
    value: SETUP_BACK_CHOICE_VALUE,
  });
}

export function setupChoiceColumns(locale: SetupCopyLocale): readonly SetupChoiceColumn[] {
  return [
    { key: "name", header: locale === "ar" ? "الاسم" : "Name" },
    { key: "description", header: locale === "ar" ? "التفاصيل" : "Details" },
  ];
}

export function setupNavigationHint(_locale: SetupCopyLocale): string {
  return "↑↓ navigate   ENTER select   CTRL+C exit";
}

export function setupCurrentStatusLine(
  locale: SetupCopyLocale,
  text: string
): PromptCardStatusLine {
  const label = locale === "ar" ? "الحالي" : "Current";
  return {
    text: `${label}: ${text}`,
    tone: "active",
    direction: locale === "ar" ? "rtl" : "ltr",
  };
}

export function setupCurrentStatusLines(
  locale: SetupCopyLocale,
  text: string | undefined
): readonly PromptCardStatusLine[] | undefined {
  return text === undefined ? undefined : [setupCurrentStatusLine(locale, text)];
}

export function setupNavigationChoice<T>(choice: Omit<SetupChoice<T>, "group">): SetupChoice<T> {
  return {
    ...choice,
    group: "navigation",
  };
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
  const { prompt } = resolveSetupPromptTarget(target);
  const answer = (await prompt(question)).trim();
  return answer.length > 0 ? answer : defaultValue;
}

export function setupProviderCredentialQuestion(
  locale: SetupCopyLocale,
  input: {
    readonly providerName: string;
    readonly envVarName: string;
  }
): string {
  return setupOutputLine(locale, formatSetupCopy(locale, "setupEditor.actions.storeProviderCredentialReference.description", {
    providerName: input.providerName,
  }) + " ");
}

export function setupPromptWithDefault(
  locale: SetupCopyLocale,
  label: string,
  defaultValue: string
): string {
  return setupOutputLine(locale, `${label} [${renderDisplayToken(locale, defaultValue)}]: `);
}

export function setupPromptLabel(locale: SetupCopyLocale, label: string): string {
  return setupOutputLine(locale, `${label}: `);
}

export function setupCsvPromptLabel(locale: SetupCopyLocale, label: string): string {
  return setupOutputLine(locale, `${label}, ${renderDisplayToken(locale, "comma-separated")}: `);
}

export function setupOutputLine(locale: SetupCopyLocale, value: string): string {
  return locale === "ar" ? isolateRtl(value) : value;
}

export function setupTechnicalToken(locale: SetupCopyLocale, value: string): string {
  return renderDisplayToken(locale, value);
}

export function setupTelegramBotTokenQuestion(locale: SetupCopyLocale): string {
  return setupQuestionLine(locale, setupCopyText(locale, "setupEditor.prompt.telegram.botToken"));
}

export function setupTelegramAllowedUserIdsQuestion(locale: SetupCopyLocale): string {
  return setupQuestionLine(locale, setupCopyText(locale, "setupEditor.prompt.telegram.allowedUserIds"));
}

export function setupTelegramAllowedChatIdsQuestion(locale: SetupCopyLocale): string {
  return setupQuestionLine(locale, setupCopyText(locale, "setupEditor.prompt.telegram.allowedChatIds"));
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
      return setupOutputLine(locale, setupCopyText(locale, "setupApply.plan.ready"));
    case "blocked":
      return setupOutputLine(locale, formatSetupCopy(locale, "setupApply.review.blocked", {
        blockerCount: String(result.eligibility.blockers.length),
      }));
    case "cancelled":
      return setupOutputLine(locale, setupCopyText(locale, "setupApply.review.cancelled"));
  }
}

export function renderSetupApplyEndState(endState: SetupApplyEndState, locale: SetupCopyLocale): string {
  switch (endState.kind) {
    case "verified-ready":
      return setupOutputLine(locale, setupCopyText(locale, "setupApply.endState.verifiedReady"));
    case "verified-degraded":
      return setupOutputLine(locale, setupCopyText(locale, "setupApply.endState.verifiedDegraded"));
    case "blocked":
      if (endState.reason === "save-failed") {
        return setupOutputLine(locale, formatSetupCopy(locale, "setupApply.endState.saveFailed", {
          error: endState.blockers[0] ?? "unknown",
        }));
      }
      if (endState.reason === "verification-blocked") {
        if ((endState.persistedSecretCount ?? 0) > 0) {
          return setupOutputLine(locale, formatSetupCopy(locale, "setupApply.endState.verificationBlockedAfterPersistence", {
            blocker: endState.blockers[0] ?? "unknown",
          }));
        }
        return setupOutputLine(locale, formatSetupCopy(locale, "setupApply.endState.verificationBlocked", {
          blocker: endState.blockers[0] ?? "unknown",
        }));
      }
      return setupOutputLine(locale, formatSetupCopy(locale, "setupApply.review.blocked", {
        blockerCount: String(endState.blockers.length),
      }));
    case "cancelled":
      return setupOutputLine(locale, setupCopyText(locale, "setupApply.review.cancelled"));
    case "saved-not-launched":
      return setupOutputLine(locale, setupCopyText(locale, "setupApply.endState.savedNotLaunched"));
    case "launched":
      return [
        setupCopyText(locale, "setupApply.endState.launched"),
        endState.acceptedDegraded ? setupCopyText(locale, "setupApply.endState.acceptedDegraded") : undefined,
      ].filter((line): line is string => line !== undefined)
        .map((line) => setupOutputLine(locale, line))
        .join("\n");
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

function renderDisplayToken(locale: SetupCopyLocale, value: string): string {
  if (value.length === 0) return value;
  return locale === "ar" ? isolateLtr(value) : value;
}

function setupQuestionLine(locale: SetupCopyLocale, value: string): string {
  return `${locale === "ar" ? isolateRtl(value) : value} `;
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
