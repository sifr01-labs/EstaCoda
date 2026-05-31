import type {
  OnboardingCredentialSummaryStatus,
  OnboardingOptionalCapabilitySummaryStatus,
  OnboardingWizardState,
  OnboardingWorkspaceTrustStatus,
} from "./state.js";
import { resolveSetupCopy, type SetupCopyKey, type SetupCopyLocale } from "../setup-copy.js";
import { isolateLtr } from "../../ui/bidi.js";

type SummaryLocale = SetupCopyLocale;

export function renderOnboardingWizardSummary(
  state: OnboardingWizardState,
  locale: SummaryLocale = "en"
): string {
  const interfacePreferences = state.interfacePreferences;
  const workspace = state.workspace;
  const primaryRoute = state.primaryRoute;
  const optionalCapabilities = state.optionalCapabilities;
  const value = (input: string | undefined) => summaryValueLabel(input, locale);
  const label = (key: SummaryLabelKey) => summaryCopy(locale, key);

  return [
    summaryCopy(locale, "onboarding.summary.confirmTitle"),
    `${label("onboarding.summary.labels.workspace")}: ${value(workspace?.path)} (${workspaceTrustStatusLabel(workspace?.trustStatus, locale)})`,
    `${label("onboarding.summary.labels.language")}: ${value(interfacePreferences?.language)}`,
    `${label("onboarding.summary.labels.interfaceStyle")}: ${value(interfacePreferences?.flavor)}`,
    `${label("onboarding.summary.labels.activityLabels")}: ${value(interfacePreferences?.activityLabels)}`,
    `${label("onboarding.summary.labels.primaryProvider")}: ${value(primaryRoute?.provider)}`,
    `${label("onboarding.summary.labels.model")}: ${value(primaryRoute?.model)}`,
    `${label("onboarding.summary.labels.credentialStatus")}: ${credentialSummaryStatusLabel(state.credential?.status, locale)}`,
    `${label("onboarding.summary.labels.securityMode")}: ${value(state.securityMode)}`,
    `${label("onboarding.summary.labels.agentEvolution")}: ${value(state.agentEvolution)}`,
    `${label("onboarding.summary.labels.optionalCapabilities")}:`,
    `  - ${label("onboarding.summary.labels.channelsTelegram")}: ${optionalCapabilityStatusLabel(optionalCapabilities?.channels?.telegram, locale)}`,
    `  - ${label("onboarding.summary.labels.voiceStt")}: ${optionalCapabilityStatusLabel(optionalCapabilities?.voice?.stt, locale)}`,
    `  - ${label("onboarding.summary.labels.voiceTts")}: ${optionalCapabilityStatusLabel(optionalCapabilities?.voice?.tts, locale)}`,
    `  - ${label("onboarding.summary.labels.browser")}: ${optionalCapabilityStatusLabel(optionalCapabilities?.browser, locale)}`,
  ].join("\n");
}

export function credentialSummaryStatusLabel(
  status: OnboardingCredentialSummaryStatus | undefined,
  locale: SummaryLocale = "en"
): string {
  switch (status) {
    case "existing_detected":
      return summaryCopy(locale, "onboarding.summary.status.existingCredentialDetected");
    case "new_pending":
      return summaryCopy(locale, "onboarding.summary.status.newCredentialPending");
    case "not_set":
    case undefined:
      return summaryCopy(locale, "onboarding.summary.status.notSet");
  }
}

export function optionalCapabilityStatusLabel(
  status: OnboardingOptionalCapabilitySummaryStatus | undefined,
  locale: SummaryLocale = "en"
): string {
  switch (status) {
    case "configured":
      return summaryCopy(locale, "onboarding.summary.status.configured");
    case "not_set":
    case undefined:
      return summaryCopy(locale, "onboarding.summary.status.notSet");
  }
}

export function workspaceTrustStatusLabel(
  status: OnboardingWorkspaceTrustStatus | undefined,
  locale: SummaryLocale = "en"
): string {
  switch (status) {
    case "trusted":
      return summaryCopy(locale, "onboarding.summary.status.trusted");
    case "untrusted":
    case undefined:
      return summaryCopy(locale, "onboarding.summary.status.untrusted");
  }
}

type SummaryLabelKey =
  | "onboarding.summary.labels.workspace"
  | "onboarding.summary.labels.language"
  | "onboarding.summary.labels.interfaceStyle"
  | "onboarding.summary.labels.activityLabels"
  | "onboarding.summary.labels.primaryProvider"
  | "onboarding.summary.labels.model"
  | "onboarding.summary.labels.credentialStatus"
  | "onboarding.summary.labels.securityMode"
  | "onboarding.summary.labels.agentEvolution"
  | "onboarding.summary.labels.optionalCapabilities"
  | "onboarding.summary.labels.channelsTelegram"
  | "onboarding.summary.labels.voiceStt"
  | "onboarding.summary.labels.voiceTts"
  | "onboarding.summary.labels.browser";

function summaryCopy(locale: SummaryLocale, key: SetupCopyKey): string {
  return resolveSetupCopy(locale, key);
}

function summaryValueLabel(value: string | undefined, locale: SummaryLocale): string {
  if (value === undefined || value.length === 0) {
    return summaryCopy(locale, "onboarding.summary.status.notSet");
  }
  return locale === "ar" ? isolateLtr(value) : value;
}
