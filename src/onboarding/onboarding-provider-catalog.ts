import type { ActivityLabelsLocale, UiFlavor, UiLanguage } from "../config/runtime-config.js";
import type { ProviderId } from "../contracts/provider.js";
import type { OnboardingCopy } from "./onboarding-copy.js";

export type ModelChoice = {
  provider: ProviderId;
  model: string;
  label: string;
  description?: string;
};

export type ProviderChoice = {
  provider: ProviderId;
  label: string;
  description: string;
  models: ModelChoice[];
};

export type InterfaceChoice = {
  language: UiLanguage;
  label: string;
  description: string;
};

export type InterfaceStyleChoice = {
  flavor: UiFlavor;
  activityLabels: ActivityLabelsLocale;
  label: string;
  description: string;
};

export function formatProviderModel(provider: string, model: string): string {
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}

export function providerChoices(copy: OnboardingCopy): ProviderChoice[] {
  const catalog = copy.providers.catalog;
  return [
    {
      provider: "openai",
      label: catalog.openai.label,
      description: catalog.openai.description,
      models: [
        { provider: "openai", model: "gpt-4.1-mini", label: catalog.openai.models["gpt-4.1-mini"]!.label, description: catalog.openai.models["gpt-4.1-mini"]!.description }
      ]
    },
    {
      provider: "kimi",
      label: catalog.kimi.label,
      description: catalog.kimi.description,
      models: [
        { provider: "kimi", model: "kimi-k2.5", label: catalog.kimi.models["kimi-k2.5"]!.label, description: catalog.kimi.models["kimi-k2.5"]!.description },
        { provider: "kimi", model: "kimi-k2-turbo-preview", label: catalog.kimi.models["kimi-k2-turbo-preview"]!.label, description: catalog.kimi.models["kimi-k2-turbo-preview"]!.description }
      ]
    },
    {
      provider: "deepseek",
      label: catalog.deepseek.label,
      description: catalog.deepseek.description,
      models: [
        { provider: "deepseek", model: "deepseek-chat", label: catalog.deepseek.models["deepseek-chat"]!.label, description: catalog.deepseek.models["deepseek-chat"]!.description }
      ]
    },
    {
      provider: "openrouter",
      label: catalog.openrouter.label,
      description: catalog.openrouter.description,
      models: [
        { provider: "openrouter", model: "qwen/qwen3.6-plus", label: catalog.openrouter.models["qwen/qwen3.6-plus"]!.label, description: catalog.openrouter.models["qwen/qwen3.6-plus"]!.description }
      ]
    },
    {
      provider: "local",
      label: catalog.local.label,
      description: catalog.local.description,
      models: [
        { provider: "local", model: "ollama/auto", label: catalog.local.models["ollama/auto"]!.label, description: catalog.local.models["ollama/auto"]!.description }
      ]
    }
  ];
}

export function interfaceLanguageChoices(copy: OnboardingCopy): InterfaceChoice[] {
  return [
    {
      language: "en",
      label: copy.interfaceLanguage.options.en.label,
      description: copy.interfaceLanguage.options.en.description
    },
    {
      language: "ar",
      label: copy.interfaceLanguage.options.ar.label,
      description: copy.interfaceLanguage.options.ar.description
    }
  ];
}

export function interfaceStyleChoices(language: UiLanguage, copy: OnboardingCopy): InterfaceStyleChoice[] {
  if (language === "ar") {
    return [
      {
        flavor: "arabic-light",
        activityLabels: "ar",
        label: copy.interfaceStyle.arabicTouch.label,
        description: copy.interfaceStyle.arabicTouch.description
      },
      {
        flavor: "standard",
        activityLabels: "ar",
        label: copy.interfaceStyle.arabicStandard.label,
        description: copy.interfaceStyle.arabicStandard.description
      }
    ];
  }

  return [
    {
      flavor: "standard",
      activityLabels: "en",
      label: copy.interfaceStyle.standard.label,
      description: copy.interfaceStyle.standard.description
    },
    {
      flavor: "arabic-light",
      activityLabels: "en",
      label: copy.interfaceStyle.arabicTouch.label,
      description: copy.interfaceStyle.arabicTouch.description
    }
  ];
}
