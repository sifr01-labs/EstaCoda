import { isolateLtr } from "../ui/bidi.js";
import { resolveSetupCopy, type SetupCopyKey, type SetupCopyLocale } from "./setup-copy.js";

export type SetupVerificationCopy = {
  readonly locale: SetupCopyLocale | string;
  readonly setupCheck: {
    readonly trusted: string;
    readonly notTrusted: string;
  };
  readonly verification: {
    readonly title: string;
    readonly body: string;
    readonly stateDirectory: string;
    readonly secretStore: string;
    readonly workspaceTrust: string;
    readonly securityMode: string;
    readonly workflowLearning: string;
    readonly taskSpendingLimit: string;
    readonly sessionSpendingLimit: string;
    readonly readOnlyToolCheck: string;
    readonly browserBackend: string;
    readonly configSources: string;
    readonly writable: string;
    readonly blocked: string;
    readonly notPresent: string;
    readonly presentMode: (mode: string) => string;
    readonly skipped: string;
    readonly ready: string;
    readonly off: string;
    readonly browserStates: {
      readonly notConfigured: string;
      readonly disabled: string;
      readonly configuredConnectionNotTested: string;
      readonly configuredRuntimeBlocked: string;
      readonly invalid: string;
    };
    readonly browserWarnings: {
      readonly existingCdpMissingUrl: string;
      readonly existingCdpNonLocal: string;
      readonly localSupervisedIncomplete: string;
      readonly missingBrowserbaseCredential: (envName: string) => string;
      readonly browserbaseSpendPending: string;
      readonly invalidConfig: (reason: string) => string;
    };
    readonly notTrustedWarning: string;
    readonly stateNotWritableWarning: string;
    readonly secretModeWarning: string;
    readonly readOnlyToolWarning: string;
    readonly skippedNoPackageJson: string;
    readonly warningsTitle: string;
    readonly nextActionsTitle: string;
    readonly statusReady: string;
    readonly nextReady: string;
    readonly fallbackNextAction: string;
    readonly actions: {
      readonly providerIncomplete: string;
      readonly missingApiKey: (envName?: string) => string;
      readonly missingCredentialReference: string;
      readonly networkDisabled: string;
      readonly workspaceNotTrusted: string;
      readonly secretPermissions: string;
      readonly stateNotWritable: string;
      readonly readOnlyTool: string;
    };
  };
};

export function setupVerificationCopy(locale: SetupCopyLocale | string): SetupVerificationCopy {
  return {
    locale,
    setupCheck: {
      trusted: copy(locale, "setupVerification.status.trusted"),
      notTrusted: copy(locale, "setupVerification.status.notTrusted"),
    },
    verification: {
      title: copy(locale, "setupVerification.title"),
      body: copy(locale, "setupVerification.body"),
      stateDirectory: copy(locale, "setupVerification.stateDirectory"),
      secretStore: copy(locale, "setupVerification.secretStore"),
      workspaceTrust: copy(locale, "setupVerification.workspaceTrust"),
      securityMode: copy(locale, "setupVerification.securityMode"),
      workflowLearning: copy(locale, "setupVerification.workflowLearning"),
      taskSpendingLimit: copy(locale, "setupVerification.taskSpendingLimit"),
      sessionSpendingLimit: copy(locale, "setupVerification.sessionSpendingLimit"),
      readOnlyToolCheck: copy(locale, "setupVerification.readOnlyToolCheck"),
      browserBackend: copy(locale, "setupVerification.browserBackend"),
      configSources: copy(locale, "setupVerification.configSources"),
      writable: copy(locale, "setupVerification.status.writable"),
      blocked: copy(locale, "setupVerification.status.blocked"),
      notPresent: copy(locale, "setupVerification.status.notPresent"),
      presentMode: (mode) => format(locale, "setupVerification.status.presentMode", { mode }),
      skipped: copy(locale, "setupVerification.status.skipped"),
      ready: copy(locale, "setupVerification.status.ready"),
      off: copy(locale, "setupVerification.status.off"),
      browserStates: {
        notConfigured: copy(locale, "setupVerification.browser.status.notConfigured"),
        disabled: copy(locale, "setupVerification.browser.status.disabled"),
        configuredConnectionNotTested: copy(locale, "setupVerification.browser.status.configuredConnectionNotTested"),
        configuredRuntimeBlocked: copy(locale, "setupVerification.browser.status.configuredRuntimeBlocked"),
        invalid: copy(locale, "setupVerification.browser.status.invalid"),
      },
      browserWarnings: {
        existingCdpMissingUrl: copy(locale, "setupVerification.browser.warning.existingCdpMissingUrl"),
        existingCdpNonLocal: copy(locale, "setupVerification.browser.warning.existingCdpNonLocal"),
        localSupervisedIncomplete: copy(locale, "setupVerification.browser.warning.localSupervisedIncomplete"),
        missingBrowserbaseCredential: (envName) => format(locale, "setupVerification.browser.warning.missingBrowserbaseCredential", { envVar: envName }),
        browserbaseSpendPending: copy(locale, "setupVerification.browser.warning.browserbaseSpendPending"),
        invalidConfig: (reason) => format(locale, "setupVerification.browser.warning.invalidConfig", { reason }),
      },
      notTrustedWarning: copy(locale, "setupVerification.warning.workspaceNotTrusted"),
      stateNotWritableWarning: copy(locale, "setupVerification.warning.stateNotWritable"),
      secretModeWarning: copy(locale, "setupVerification.warning.secretMode"),
      readOnlyToolWarning: copy(locale, "setupVerification.warning.readOnlyTool"),
      skippedNoPackageJson: copy(locale, "setupVerification.warning.skippedNoPackageJson"),
      warningsTitle: copy(locale, "setupVerification.warningsTitle"),
      nextActionsTitle: copy(locale, "setupVerification.nextActionsTitle"),
      statusReady: copy(locale, "setupVerification.statusReady"),
      nextReady: copy(locale, "setupVerification.nextReady"),
      fallbackNextAction: copy(locale, "setupVerification.fallbackNextAction"),
      actions: {
        providerIncomplete: copy(locale, "setupVerification.actions.providerIncomplete"),
        missingApiKey: (envName) => envName === undefined
          ? copy(locale, "setupVerification.actions.missingApiKey.generic")
          : format(locale, "setupVerification.actions.missingApiKey.env", { envVar: envName }),
        missingCredentialReference: copy(locale, "setupVerification.actions.missingCredentialReference"),
        networkDisabled: copy(locale, "setupVerification.actions.networkDisabled"),
        workspaceNotTrusted: copy(locale, "setupVerification.actions.workspaceNotTrusted"),
        secretPermissions: copy(locale, "setupVerification.actions.secretPermissions"),
        stateNotWritable: copy(locale, "setupVerification.actions.stateNotWritable"),
        readOnlyTool: copy(locale, "setupVerification.actions.readOnlyTool"),
      },
    },
  };
}

export const setupVerificationCopyEn = setupVerificationCopy("en");

function copy(locale: SetupCopyLocale | string, key: SetupCopyKey): string {
  return resolveSetupCopy(locale, key);
}

function format(locale: SetupCopyLocale | string, key: SetupCopyKey, values: Record<string, string>): string {
  let result = copy(locale, key);
  for (const [name, value] of Object.entries(values)) {
    const placeholder = `{${name}}`;
    result = result
      .replaceAll(placeholder, value)
      .replaceAll(isolateLtr(placeholder), isolateLtr(value));
  }
  return result;
}
