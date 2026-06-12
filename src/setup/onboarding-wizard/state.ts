import type { ActivityLabelsLocale, UiFlavor, UiLanguage } from "../../config/runtime-config.js";
import type { ProviderApiMode, ProviderAuthMethod, ProviderId } from "../../contracts/provider.js";
import type { SecurityApprovalMode } from "../../contracts/security.js";
import type { SkillAutonomy } from "../../skills/skill-learning.js";
import type { SetupDraft } from "../setup-drafts.js";

export type OnboardingCredentialSummaryStatus =
  | "not_set"
  | "existing_detected"
  | "new_pending";

export type OnboardingWorkspaceTrustStatus = "trusted" | "untrusted";

export type OnboardingOptionalCapabilitySummaryStatus = "configured" | "not_set" | "skipped" | "incomplete";

export type OnboardingSupportedOptionalCapabilityId = "channels" | "voice" | "browser";

export type OnboardingCredentialReference =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "env";
      readonly name: string;
    };

export type OnboardingInterfacePreferences = {
  readonly language?: UiLanguage;
  readonly flavor?: UiFlavor;
  readonly activityLabels?: ActivityLabelsLocale;
};

export type OnboardingWorkspaceSummary = {
  readonly path?: string;
  readonly trustStatus?: OnboardingWorkspaceTrustStatus;
};

export type OnboardingPrimaryRouteSummary = {
  readonly provider?: ProviderId;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly contextWindowTokens?: number;
  readonly apiMode?: ProviderApiMode;
  readonly authMethod?: ProviderAuthMethod;
};

export type OnboardingCredentialSummary = {
  readonly status: OnboardingCredentialSummaryStatus;
  readonly envVarName?: string;
};

export type OnboardingOptionalCapabilityDraftId = OnboardingSupportedOptionalCapabilityId;

export type OnboardingOptionalCapabilitySummaries = {
  readonly channels?: {
    readonly telegram?: OnboardingOptionalCapabilitySummaryStatus;
    readonly whatsapp?: OnboardingOptionalCapabilitySummaryStatus;
  };
  readonly voice?: {
    readonly stt?: OnboardingOptionalCapabilitySummaryStatus;
    readonly tts?: OnboardingOptionalCapabilitySummaryStatus;
  };
  readonly browser?: OnboardingOptionalCapabilitySummaryStatus;
  readonly selected?: readonly OnboardingOptionalCapabilityDraftId[];
};

export type OnboardingWizardSelections = {
  readonly language?: UiLanguage;
  readonly interfaceFlavor?: UiFlavor;
  readonly activityLabels?: ActivityLabelsLocale;
  readonly workspaceRoot?: string;
  readonly workspaceTrusted?: boolean;
  readonly primaryProvider?: ProviderId;
  readonly primaryModel?: string;
  readonly primaryBaseUrl?: string;
  readonly primaryContextWindowTokens?: number;
  readonly primaryApiMode?: ProviderApiMode;
  readonly primaryAuthMethod?: ProviderAuthMethod;
  readonly primaryCredential?: OnboardingCredentialReference;
  readonly securityMode?: SecurityApprovalMode;
  readonly workflowLearning?: SkillAutonomy;
  readonly optionalCapabilities?: readonly OnboardingSupportedOptionalCapabilityId[];
  readonly reviewAccepted?: boolean;
  readonly saveAccepted?: boolean;
};

export type OnboardingWizardState = {
  readonly interfacePreferences?: OnboardingInterfacePreferences;
  readonly workspace?: OnboardingWorkspaceSummary;
  readonly primaryRoute?: OnboardingPrimaryRouteSummary;
  readonly credential?: OnboardingCredentialSummary;
  readonly securityMode?: SecurityApprovalMode;
  readonly agentEvolution?: SkillAutonomy;
  readonly optionalCapabilities?: OnboardingOptionalCapabilitySummaries;
  readonly optionalCapabilityDrafts?: readonly SetupDraft[];
};
