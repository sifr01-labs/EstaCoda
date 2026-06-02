import type { Prompt } from "../cli/readline-prompt.js";
import type { ActivityLabelsLocale, UiFlavor, UiLanguage } from "../config/runtime-config.js";
import type { SetupCopyKey, SetupCopyLocale } from "./setup-copy.js";
import { promptSetupChoice, setupPromptContext, setupCopyText, type SetupChoice } from "./setup-prompts.js";

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

export async function promptInterfaceLanguageAndStyle(
  prompt: Prompt,
  input: {
    readonly initialLocale?: SetupCopyLocale;
    readonly currentLanguage?: UiLanguage;
    readonly currentFlavor?: UiFlavor;
  } = {}
): Promise<InterfaceLanguageAndStyleSelection> {
  const initialLocale = input.initialLocale ?? input.currentLanguage ?? "en";
  const defaultLanguage = input.currentLanguage ?? "en";
  const language = await promptSetupChoice(setupPromptContext(prompt, initialLocale), {
    title: setupCopyText(initialLocale, "onboarding.interfaceLanguage.title"),
    message: `${setupCopyText(initialLocale, "onboarding.interfaceLanguage")}\n`,
    choices: [
      {
        id: "en",
        label: setupCopyText(initialLocale, "onboarding.interfaceLanguage.options.en.label"),
        description: setupCopyText(initialLocale, "onboarding.interfaceLanguage.options.en.description"),
        value: "en" as const,
      },
      {
        id: "ar",
        label: setupCopyText(initialLocale, "onboarding.interfaceLanguage.options.ar.label"),
        description: setupCopyText(initialLocale, "onboarding.interfaceLanguage.options.ar.description"),
        value: "ar" as const,
      },
    ],
    defaultValue: defaultLanguage,
  });

  const style = defaultInterfacePreferencesForLanguage(language);
  return {
    language,
    flavor: style.flavor,
    activityLabels: style.activityLabels,
  };
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
