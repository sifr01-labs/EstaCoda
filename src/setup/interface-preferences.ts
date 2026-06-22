import type { Prompt } from "../cli/readline-prompt.js";
import type { ActivityLabelsLocale, UiFlavor, UiLanguage } from "../config/runtime-config.js";
import type { SetupCopyKey, SetupCopyLocale } from "./setup-copy.js";
import {
  promptSetupChoice,
  promptSetupChoiceResult,
  setupPromptContext,
  setupCopyText,
  setupCurrentStatusLines,
  type SetupChoice,
} from "./setup-prompts.js";

export type InterfaceStyleChoice = SetupChoice<{
  readonly flavor: UiFlavor;
  readonly activityLabels: ActivityLabelsLocale;
}> & {
  readonly labelKey: SetupCopyKey;
  readonly descriptionKey: SetupCopyKey;
};

export type InterfaceLanguageAndStyleSelection = {
  readonly language: UiLanguage;
  readonly flavor: UiFlavor;
  readonly activityLabels: ActivityLabelsLocale;
};

export type InterfaceLanguageAndStylePromptResult =
  | { readonly kind: "selected"; readonly selection: InterfaceLanguageAndStyleSelection }
  | { readonly kind: "back" };

type InterfaceLanguageAndStylePromptOptions = {
  readonly initialLocale?: SetupCopyLocale;
  readonly currentLanguage?: UiLanguage;
  readonly currentFlavor?: UiFlavor;
  readonly showCurrentState?: boolean;
};

export async function promptInterfaceLanguageAndStyle(
  prompt: Prompt,
  input: InterfaceLanguageAndStylePromptOptions & { readonly allowBack: true }
): Promise<InterfaceLanguageAndStylePromptResult>;
export async function promptInterfaceLanguageAndStyle(
  prompt: Prompt,
  input?: InterfaceLanguageAndStylePromptOptions & { readonly allowBack?: false }
): Promise<InterfaceLanguageAndStyleSelection>;
export async function promptInterfaceLanguageAndStyle(
  prompt: Prompt,
  input: InterfaceLanguageAndStylePromptOptions & { readonly allowBack?: boolean } = {}
): Promise<InterfaceLanguageAndStyleSelection | InterfaceLanguageAndStylePromptResult> {
  const initialLocale = input.initialLocale ?? input.currentLanguage ?? "en";
  const defaultLanguage = input.currentLanguage ?? "en";
  const languageChoices: SetupChoice<UiLanguage>[] = [
    {
      id: "en",
      label: setupCopyText(initialLocale, "onboarding.interfaceLanguage.options.en.label"),
      value: "en" as const,
      current: input.showCurrentState === true && defaultLanguage === "en",
    },
    {
      id: "ar",
      label: setupCopyText(initialLocale, "onboarding.interfaceLanguage.options.ar.label"),
      value: "ar" as const,
      current: input.showCurrentState === true && defaultLanguage === "ar",
    },
  ];
  const currentLanguageLabel = languageChoices.find((choice) => choice.value === defaultLanguage)?.label;
  const languagePrompt = {
    title: setupCopyText(initialLocale, "onboarding.interfaceLanguage.title"),
    message: `${setupCopyText(initialLocale, "onboarding.interfaceLanguage")}\n`,
    statusLines: setupCurrentStatusLines(
      initialLocale,
      input.showCurrentState === true ? currentLanguageLabel : undefined
    ),
    showCurrentBadge: input.showCurrentState === true ? false : undefined,
    choices: languageChoices,
    defaultValue: defaultLanguage,
  };
  let language: UiLanguage;
  if (input.allowBack === true) {
    const result = await promptSetupChoiceResult(setupPromptContext(prompt, initialLocale), {
      ...languagePrompt,
      allowBack: true,
    });
    if (result.kind === "back") return result;
    language = result.value;
  } else {
    language = await promptSetupChoice(setupPromptContext(prompt, initialLocale), languagePrompt);
  }

  const style = defaultInterfacePreferencesForLanguage(language);
  const selection = {
    language,
    flavor: style.flavor,
    activityLabels: style.activityLabels,
  };
  if (input.allowBack === true) {
    return { kind: "selected", selection };
  }
  return selection;
}

function defaultInterfacePreferencesForLanguage(
  language: UiLanguage
): Pick<InterfaceLanguageAndStyleSelection, "flavor" | "activityLabels"> {
  return language === "ar"
    ? { flavor: "arabic-light", activityLabels: "ar" }
    : { flavor: "standard", activityLabels: "en" };
}

export function interfaceStyleChoices(language: UiLanguage): readonly InterfaceStyleChoice[] {
  if (language === "ar") {
    return [
      {
        id: "arabic-light",
        label: "",
        labelKey: "onboarding.interfaceStyle.arabicLight.label",
        description: "",
        descriptionKey: "onboarding.interfaceStyle.arabicLight.description",
        value: { flavor: "arabic-light", activityLabels: "ar" },
      },
      {
        id: "standard",
        label: "",
        labelKey: "onboarding.interfaceStyle.standard.label",
        description: "",
        descriptionKey: "onboarding.interfaceStyle.arabicStandard.description",
        value: { flavor: "standard", activityLabels: "ar" },
      },
    ];
  }

  return [
    {
      id: "standard",
      label: "",
      labelKey: "onboarding.interfaceStyle.standard.label",
      description: "",
      descriptionKey: "onboarding.interfaceStyle.standard.description",
      value: { flavor: "standard", activityLabels: "en" },
    },
    {
      id: "arabic-light",
      label: "",
      labelKey: "onboarding.interfaceStyle.arabicLight.label",
      description: "",
      descriptionKey: "onboarding.interfaceStyle.englishArabicLight.description",
      value: { flavor: "arabic-light", activityLabels: "en" },
    },
  ];
}
