import { describe, expect, it } from "vitest";
import { isolateLtr } from "../ui/bidi.js";
import {
  getSetupCopyEntry,
  hasSetupCopyKey,
  listSetupCopyEntries,
  rawSetupCopy,
  resolveSetupCopy,
  setupCopy,
  type SetupCopyKey,
} from "./setup-copy.js";
import { setupVerificationCopy } from "./setup-verification-copy.js";

const FIRST_RUN_KEYS = [
  "onboarding.welcome",
  "onboarding.welcome.validation.acknowledged",
  "onboarding.interfaceLanguage",
  "onboarding.interfaceLanguage.validation.languageSelected",
  "onboarding.workspace.root",
  "onboarding.workspace.root.validation.selected",
  "onboarding.workspace.trust",
  "onboarding.workspace.changeWorkspaceAction.label",
  "onboarding.workspace.changeWorkspaceAction.description",
  "onboarding.workspace.trust.deferredFinal",
  "onboarding.workspace.invalid.title",
  "onboarding.workspace.invalid.tryAgain",
  "onboarding.workspace.invalid.useCurrent",
  "onboarding.workspace.invalid.cancel",
  "onboarding.workspace.trust.validation.explicit",
  "onboarding.providers.primary",
  "onboarding.providers.primary.validation.selected",
  "onboarding.providers.primaryModel",
  "onboarding.providers.primaryModel.validation.selected",
  "onboarding.providers.primaryCredential",
  "onboarding.providers.primaryCredential.validation.reference",
  "onboarding.providers.primaryCredential.localProviderSkip",
  "onboarding.security",
  "onboarding.security.validation.selected",
  "onboarding.workflowLearning",
  "onboarding.workflowLearning.validation.selected",
  "onboarding.optionalCapabilities",
  "onboarding.optionalCapabilities.title",
  "onboarding.optionalCapabilities.configureNow",
  "onboarding.optionalCapabilities.configureNow.yes",
  "onboarding.optionalCapabilities.configureNow.no",
  "onboarding.optionalCapabilities.note",
  "onboarding.optionalCapabilities.menu.title",
  "onboarding.optionalCapabilities.more.title",
  "onboarding.optionalCapabilities.more.yes",
  "onboarding.optionalCapabilities.skipped",
  "onboarding.optionalCapabilities.voice.localSttSkipped",
  "onboarding.optionalCapabilities.validation.skippable",
  "onboarding.summary.confirmTitle",
  "onboarding.summary.confirmMessage",
  "onboarding.summary.confirmAction",
  "onboarding.summary.cancelAction",
  "onboarding.summary.labels.workspace",
  "onboarding.summary.labels.language",
  "onboarding.summary.labels.interfaceStyle",
  "onboarding.summary.labels.activityLabels",
  "onboarding.summary.labels.primaryProvider",
  "onboarding.summary.labels.model",
  "onboarding.summary.labels.credentialStatus",
  "onboarding.summary.labels.securityMode",
  "onboarding.summary.labels.agentEvolution",
  "onboarding.summary.labels.optionalCapabilities",
  "onboarding.summary.labels.channelsTelegram",
  "onboarding.summary.labels.voiceStt",
  "onboarding.summary.labels.voiceTts",
  "onboarding.summary.labels.browser",
  "onboarding.summary.status.notSet",
  "onboarding.summary.status.trusted",
  "onboarding.summary.status.untrusted",
  "onboarding.summary.status.configured",
  "onboarding.summary.status.existingCredentialDetected",
  "onboarding.summary.status.newCredentialPending",
  "onboarding.review",
  "onboarding.review.validation.accepted",
  "setupEditor.review.title",
  "setupEditor.review.body",
  "setupEditor.review.selectedArea",
  "setupEditor.review.confirm",
  "setupEditor.review.confirm.description",
  "setupEditor.review.cancel",
  "setupEditor.review.cancel.description",
  "onboarding.launch.startNow",
  "onboarding.launch.startNow.yes",
  "onboarding.launch.startNow.no",
] as const;

const SETUP_EDITOR_KEYS = [
  "setupRouter.firstRun.title",
  "setupRouter.firstRun.summary",
  "setupRouter.configured.title",
  "setupRouter.configured.summary",
  "setupRouter.degraded.title",
  "setupRouter.degraded.summary",
  "setupRouter.repair.title",
  "setupRoute.action.launchAgent",
  "setupRoute.action.acceptLimitedMode",
  "setupRoute.action.verifySetup",
  "setupRoute.action.exit",
  "setupStateSummary.title",
  "setupStateSummary.advancedTitle",
  "setupStateSummary.directProviderExample",
  "setupEditor.shell.title",
  "setupEditor.shell.labels.state",
  "setupEditor.shell.labels.kind",
  "setupEditor.shell.labels.route",
  "setupEditor.shell.labels.editorMode",
  "setupEditor.shell.labels.recommended",
  "setupEditor.shell.labels.model",
  "setupEditor.shell.labels.userConfig",
  "setupEditor.shell.labels.projectConfig",
  "setupEditor.shell.labels.stateWritable",
  "setupEditor.shell.labels.blockers",
  "setupEditor.shell.labels.warnings",
  "setupEditor.shell.labels.status",
  "setupEditor.shell.labels.blocker",
  "setupEditor.shell.labels.warning",
  "setupEditor.shell.labels.none",
  "setupEditor.shell.values.yes",
  "setupEditor.shell.values.no",
  "setupEditor.sections.heading",
  "setupEditor.actions.heading",
  "setupEditor.summary.configuredReady",
  "setupEditor.summary.configuredDegraded",
  "setupEditor.summary.repairFirst",
  "setupEditor.sections.configSummary",
  "setupEditor.sections.configSafety",
  "setupEditor.sections.stateSafety",
  "setupEditor.sections.modelRoute",
  "setupEditor.sections.credentials",
  "setupEditor.sections.securityMode",
  "setupEditor.sections.workflowLearning",
  "setupEditor.sections.interfacePreference",
  "setupEditor.sections.workspaceTrust",
  "setupEditor.sections.optionalCapabilities",
  "setupEditor.sections.verification",
  "setupEditor.sections.exit",
  "setupEditor.actions.editPrimaryModelRoute",
  "setupEditor.actions.repairPrimaryProvider",
  "setupEditor.actions.editPrimaryCredentialReference",
  "setupEditor.actions.storeProviderCredentialReference",
  "setupEditor.actions.editFallbackModelRoute",
  "setupEditor.actions.editAuxiliaryModelRoute",
  "setupEditor.actions.repairMissingCredential",
  "setupEditor.actions.editSecurityMode",
  "setupEditor.actions.editWorkflowLearning",
  "setupEditor.actions.chooseLanguage",
  "setupEditor.actions.repairWorkspaceTrust",
  "setupEditor.actions.configureChannels",
  "setupEditor.actions.configureVoice",
  "setupEditor.actions.configureImageGeneration",
  "setupEditor.actions.configureBrowser",
  "setupEditor.actions.runReadonlyVerification",
  "setupEditor.actions.showDiagnostics",
  "setupEditor.actions.exitWithoutChanges",
  "setupEditor.actions.repairBrokenConfig",
  "setupEditor.actions.repairStateDirectory",
  "setupEditor.actions.cancelSetupEditor",
  "setupEditor.actions.repairWorkspaceTrust.description",
  "setupEditor.actions.editSecurityMode.description",
  "setupEditor.actions.editWorkflowLearning.description",
  "setupEditor.actions.chooseLanguage.description",
  "setupEditor.actions.repairPrimaryProvider.description",
  "setupEditor.actions.editPrimaryModelRoute.description",
  "setupEditor.actions.repairMissingCredential.description",
  "setupEditor.actions.editPrimaryCredentialReference.description",
  "setupEditor.actions.storeProviderCredentialReference.description",
  "setupEditor.actions.editFallbackModelRoute.description",
  "setupEditor.actions.editAuxiliaryModelRoute.description",
  "setupEditor.actions.configureChannels.description",
  "setupEditor.actions.configureVoice.description",
  "setupEditor.actions.configureImageGeneration.description",
  "setupEditor.actions.configureBrowser.description",
  "setupEditor.actions.runReadonlyVerification.description",
  "setupEditor.actions.showDiagnostics.description",
  "setupEditor.actions.exitWithoutChanges.description",
  "setupEditor.result.unsupportedState",
  "setupEditor.result.noActions",
  "setupEditor.result.unavailableAction",
  "setupEditor.result.unimplementedAction",
  "setupEditor.result.verifyPrepared",
  "setupEditor.result.exitWithoutChanges",
  "setupEditor.result.repairAgainSelected",
  "setupEditor.result.activeModelMissing",
  "setupEditor.result.activeModelUnavailable",
  "setupEditor.result.activeModelCredentialUnsupported",
  "setupEditor.diagnostics.title",
  "setupEditor.diagnostics.labels.error",
  "setupEditor.diagnostics.manualRepair.heading",
  "setupEditor.diagnostics.manualRepair.brokenConfig",
  "setupEditor.diagnostics.manualRepair.stateNotWritable",
  "setupEditor.diagnostics.manualRepair.availableActions",
  "setupEditor.prompt.action.title",
  "setupEditor.prompt.action.body",
  "setupEditor.prompt.postApply.title",
  "setupEditor.prompt.postApply.body",
  "setupEditor.prompt.postApply.launch",
  "setupEditor.prompt.postApply.launch.description",
  "setupEditor.prompt.postApply.acceptLimitedMode",
  "setupEditor.prompt.postApply.acceptLimitedMode.description",
  "setupEditor.prompt.postApply.repairAgain",
  "setupEditor.prompt.postApply.repairAgain.description",
  "setupEditor.prompt.postApply.exit",
  "setupEditor.prompt.postApply.exit.description",
  "setupEditor.postApply.warningList",
  "setupEditor.prompt.credentialReuse.title",
  "setupEditor.prompt.credentialReuse.body",
  "setupEditor.prompt.credentialReuse.existing",
  "setupEditor.prompt.credentialReuse.existing.description",
  "setupEditor.prompt.credentialReuse.new",
  "setupEditor.prompt.credentialReuse.new.description",
  "setupEditor.prompt.fallbackRoute.title",
  "setupEditor.prompt.fallbackRoute.body",
  "setupEditor.prompt.fallbackRoute.edit",
  "setupEditor.prompt.fallbackRoute.edit.description",
  "setupEditor.prompt.fallbackRoute.add",
  "setupEditor.prompt.fallbackRoute.add.description",
  "setupEditor.prompt.auxiliaryRoute.title",
  "setupEditor.prompt.auxiliaryRoute.body",
  "setupEditor.prompt.auxiliaryRoute.assessor",
  "setupEditor.prompt.auxiliaryRoute.assessor.description",
  "setupEditor.prompt.auxiliaryRoute.compression",
  "setupEditor.prompt.auxiliaryRoute.compression.description",
  "setupEditor.prompt.auxiliaryRoute.sessionSearch",
  "setupEditor.prompt.auxiliaryRoute.sessionSearch.description",
  "setupEditor.prompt.auxiliaryRoute.memoryCompaction",
  "setupEditor.prompt.auxiliaryRoute.memoryCompaction.description",
  "setupEditor.prompt.auxiliaryRoute.profileContext",
  "setupEditor.prompt.auxiliaryRoute.profileContext.description",
  "setupEditor.prompt.optionalCapabilityAction.leaveUnchanged",
  "setupEditor.prompt.optionalCapabilityAction.skip",
  "setupEditor.prompt.optionalCapabilityAction.enableConfigure",
  "setupEditor.prompt.optionalCapabilityAction.leaveUnchanged.description",
  "setupEditor.prompt.optionalCapabilityAction.skip.description",
  "setupEditor.prompt.optionalCapabilityAction.enableConfigure.description",
  "setupEditor.prompt.channels.title",
  "setupEditor.prompt.channels.body",
  "setupEditor.prompt.channels.telegram",
  "setupEditor.prompt.channels.telegram.description",
  "setupEditor.prompt.channels.whatsapp",
  "setupEditor.prompt.channels.whatsapp.description",
  "setupEditor.prompt.channels.discord",
  "setupEditor.prompt.channels.discord.description",
  "setupEditor.prompt.telegram.summary",
  "setupEditor.prompt.telegram.card.title",
  "setupEditor.prompt.telegram.botToken.heading",
  "setupEditor.prompt.telegram.botToken.body",
  "setupEditor.prompt.telegram.botToken",
  "setupEditor.prompt.telegram.allowedUserIds.heading",
  "setupEditor.prompt.telegram.allowedUserIds.body",
  "setupEditor.prompt.telegram.allowedUserIds",
  "setupEditor.prompt.telegram.allowedChatIds.heading",
  "setupEditor.prompt.telegram.allowedChatIds.body",
  "setupEditor.prompt.telegram.allowedChatIds",
  "setupEditor.prompt.telegram.remoteControlRisk",
  "setupEditor.prompt.telegram.incomplete.body",
  "setupEditor.prompt.telegram.incomplete.retry",
  "setupEditor.prompt.telegram.incomplete.retry.description",
  "setupEditor.prompt.discord.summary",
  "setupEditor.prompt.discord.beta",
  "setupEditor.prompt.discord.remoteControlRisk",
  "setupEditor.prompt.discord.botTokenEnv",
  "setupEditor.prompt.discord.botToken",
  "setupEditor.prompt.discord.allowedUsers",
  "setupEditor.prompt.discord.allowedGuilds",
  "setupEditor.prompt.discord.allowedChannels",
  "setupEditor.prompt.discord.incomplete.body",
  "setupEditor.prompt.whatsapp.summary",
  "setupEditor.prompt.whatsapp.beta",
  "setupEditor.prompt.whatsapp.remoteControlRisk",
  "setupEditor.prompt.whatsapp.authDir",
  "setupEditor.prompt.whatsapp.allowedUsers",
  "setupEditor.prompt.whatsapp.incomplete.body",
  "setupEditor.prompt.voice.mode.title",
  "setupEditor.prompt.voice.mode.body",
  "setupEditor.prompt.voice.mode.stt",
  "setupEditor.prompt.voice.mode.stt.description",
  "setupEditor.prompt.voice.mode.tts",
  "setupEditor.prompt.voice.mode.tts.description",
  "setupEditor.prompt.voice.summary",
  "setupEditor.prompt.voice.ttsProvider",
  "setupEditor.prompt.voice.ttsModel",
  "setupEditor.prompt.voice.ttsApiKeyEnv",
  "setupEditor.prompt.voice.sttProvider",
  "setupEditor.prompt.voice.sttModel",
  "setupEditor.prompt.voice.sttApiKeyEnv",
  "setupEditor.prompt.vision.summary",
  "setupEditor.prompt.vision.provider",
  "setupEditor.prompt.vision.model",
  "setupEditor.prompt.vision.apiKeyEnv",
  "setupEditor.prompt.vision.useGateway",
  "setupEditor.prompt.browser.summary",
  "setupEditor.prompt.browser.backend",
  "setupEditor.prompt.browser.cdpUrl",
  "setupEditor.prompt.browser.launchExecutable",
  "setupEditor.prompt.browser.launchArgs",
  "setupEditor.prompt.browser.chromeFlags",
  "setupEditor.prompt.browser.noAutoLaunch",
] as const;

const SETUP_MODULE_KEYS = [
  "setupModules.provider.title",
  "setupModules.provider.review",
  "setupModules.provider.draft",
  "setupModules.credentials.title",
  "setupModules.credentials.review",
  "setupModules.credentials.draft",
  "setupModules.workspaceTrust.title",
  "setupModules.workspaceTrust.review",
  "setupModules.workspaceTrust.draft",
  "setupModules.securityMode.title",
  "setupModules.security-mode.review",
  "setupModules.security-mode.draft",
  "setupModules.workflowLearning.title",
  "setupModules.workflow-learning.review",
  "setupModules.workflow-learning.draft",
  "setupModules.telegram.title",
  "setupModules.telegram.review",
  "setupModules.telegram.draft",
  "setupModules.discord.title",
  "setupModules.discord.review",
  "setupModules.discord.draft",
  "setupModules.whatsapp.title",
  "setupModules.whatsapp.review",
  "setupModules.whatsapp.draft",
  "setupModules.voice.title",
  "setupModules.voice.review",
  "setupModules.voice.draft",
  "setupModules.vision.title",
  "setupModules.vision.review",
  "setupModules.vision.draft",
  "setupModules.browser.title",
  "setupModules.browser.review",
  "setupModules.browser.draft",
  "setupModules.{moduleId}.blocked",
] as const;

const WHATSAPP_WIZARD_KEYS = [
  "whatsappWizard.intro.block",
  "whatsappWizard.dependencies.missingQuestion",
  "whatsappWizard.dependencies.ready",
  "whatsappWizard.dependencies.declined",
  "whatsappWizard.dependencies.failed",
  "whatsappWizard.repair.question",
  "whatsappWizard.repair.declined",
  "whatsappWizard.mode.block",
  "whatsappWizard.mode.invalid",
  "whatsappWizard.mode.selectedDedicated",
  "whatsappWizard.mode.selectedPersonal",
  "whatsappWizard.dedicated.guidance",
  "whatsappWizard.personal.guidance",
  "whatsappWizard.allowlist.question",
  "whatsappWizard.allowlist.selected",
  "whatsappWizard.allowlist.empty",
  "whatsappWizard.pairing.instructions",
  "whatsappWizard.pairing.block",
  "whatsappWizard.pairing.timeout",
  "whatsappWizard.pairing.failed",
  "whatsappWizard.success.linked",
  "whatsappWizard.success.sessionSaved",
  "whatsappWizard.success.restricted",
  "whatsappWizard.success.pairingPending",
  "whatsappWizard.success.ready",
  "whatsappWizard.cancelled",
] as const;

const REVIEW_MANIFEST_KEYS = [
  "setupReview.diagnostic",
  "setupReview.bundleBlocker.summary",
  "setupReview.bundleWarning.summary",
  "setupReview.sections.filesToWriteUpdate",
  "setupReview.sections.secretRefsToStore",
  "setupReview.sections.workspaceTrustGrants",
  "setupReview.sections.providerModelNetwork",
  "setupReview.sections.enabledOptionalCapabilities",
  "setupReview.sections.remoteControlSurfaces",
  "setupReview.sections.securityMode",
  "setupReview.sections.workflowLearning",
  "setupReview.sections.verificationChecks",
  "setupReview.sections.launchHandoff",
  "setupReview.sections.blockers",
  "setupReview.sections.warnings",
  "setupDrafts.review",
  "setupDrafts.providerModelRoute.summary",
  "setupDrafts.fallbackModelRoute.add.summary",
  "setupDrafts.fallbackModelRoute.replace.summary",
  "setupDrafts.auxiliaryModelRoute.summary",
  "setupDrafts.credentialReference.summary",
  "setupDrafts.workspaceTrust.summary",
  "setupDrafts.securityMode.summary",
  "setupDrafts.workflowLearning.summary",
  "setupDrafts.uiPreferences.summary",
  "setupDrafts.optionalCapabilities.summary",
  "setupDrafts.verification.summary",
  "setupDrafts.exit.summary",
  "setupDrafts.brokenConfig.summary",
] as const;

const APPLY_HANDOFF_KEYS = [
  "setupApply.review.approved",
  "setupApply.review.cancelled",
  "setupApply.review.blocked",
  "setupApply.plan.ready",
  "setupApply.operations.configPatch",
  "setupApply.operations.credentialReference",
  "setupApply.operations.workspaceTrustGrant",
  "setupApply.operations.verificationRequest",
  "setupApply.operations.launchHandoff",
  "setupApply.endState.saveFailed",
  "setupApply.endState.verifiedReady",
  "setupApply.endState.verifiedDegraded",
  "setupApply.endState.verificationBlocked",
  "setupApply.endState.verificationBlockedAfterPersistence",
  "setupApply.endState.savedNotLaunched",
  "setupApply.endState.launched",
  "setupApply.endState.acceptedDegraded",
  "setupApply.repairRequired",
  "setupApply.warnings.title",
] as const;

const SETUP_VERIFICATION_KEYS = [
  "setupVerification.title",
  "setupVerification.body",
  "setupVerification.stateDirectory",
  "setupVerification.secretStore",
  "setupVerification.workspaceTrust",
  "setupVerification.securityMode",
  "setupVerification.workflowLearning",
  "setupVerification.readOnlyToolCheck",
  "setupVerification.configSources",
  "setupVerification.status.writable",
  "setupVerification.status.blocked",
  "setupVerification.status.notPresent",
  "setupVerification.status.presentMode",
  "setupVerification.status.skipped",
  "setupVerification.status.ready",
  "setupVerification.status.trusted",
  "setupVerification.status.notTrusted",
  "setupVerification.warning.workspaceNotTrusted",
  "setupVerification.warning.stateNotWritable",
  "setupVerification.warning.secretMode",
  "setupVerification.warning.readOnlyTool",
  "setupVerification.warning.skippedNoPackageJson",
  "setupVerification.warningsTitle",
  "setupVerification.nextActionsTitle",
  "setupVerification.statusReady",
  "setupVerification.nextReady",
  "setupVerification.fallbackNextAction",
  "setupVerification.actions.providerIncomplete",
  "setupVerification.actions.missingApiKey.generic",
  "setupVerification.actions.missingApiKey.env",
  "setupVerification.actions.missingCredentialReference",
  "setupVerification.actions.networkDisabled",
  "setupVerification.actions.workspaceNotTrusted",
  "setupVerification.actions.secretPermissions",
  "setupVerification.actions.stateNotWritable",
  "setupVerification.actions.readOnlyTool",
] as const;

const VALIDATION_KEYS = [
  "setupValidation.provider.invalid",
  "setupValidation.model.invalid",
  "setupValidation.credential.missing",
  "setupValidation.secret.permissionsUnsafe",
  "setupValidation.workspace.untrusted",
  "setupValidation.state.notWritable",
  "setupValidation.config.broken",
  "setupValidation.provider.degraded",
  "setupValidation.terminal.bidiWarning",
  "setupValidation.capability.unavailable",
  "setupValidation.capability.skipped",
  "setupValidation.cancel.noMutation",
  "setupValidation.secret.rawValueBlocked",
  "setupValidation.remote.identityMissing",
] as const;

describe("setup copy", () => {
  it("selects screenshot-approved Arabic copy", () => {
    const copy = setupCopy("ar");

    expect(copy["onboarding.welcome"]).toContain("اضبط مساحة العمل");
    expect(copy["onboarding.welcome"]).toContain(isolateLtr("EstaCoda"));
    expect(copy["setupEditor.summary.repairFirst"]).toContain("لا جدوى من تلميع إعداد لا يعمل");
    expect(copy["setupModules.telegram.review"]).toContain("التحكم عن بعد لا يستجيب إلا للقائمة المسموح بها");
  });

  it("keeps broken-config and state-not-writable safety copy distinct", () => {
    expect(rawSetupCopy("en", "setupEditor.sections.configSafety")).toContain("parsed safely");
    expect(rawSetupCopy("en", "setupEditor.sections.stateSafety")).toContain("not writable");
    expect(rawSetupCopy("en", "setupEditor.sections.stateSafety")).toContain("write permissions");
    expect(rawSetupCopy("en", "setupEditor.sections.stateSafety")).not.toContain("parsed safely");
    expect(rawSetupCopy("en", "setupEditor.sections.stateSafety")).not.toContain("parse safety");
    expect(rawSetupCopy("en", "setupEditor.sections.stateSafety")).not.toContain("parse failure");
  });

  it("preserves placeholders exactly in English and Arabic source copy", () => {
    for (const entry of listSetupCopyEntries()) {
      for (const placeholder of entry.placeholders) {
        expect(entry.en).toContain(placeholder);
        expect(entry.ar).toContain(placeholder);
      }
    }
  });

  it("isolates Arabic placeholders and technical tokens", () => {
    expect(resolveSetupCopy("ar", "onboarding.providers.primaryModel")).toContain(isolateLtr("{providerId}"));
    expect(resolveSetupCopy("ar", "setupModules.provider.review")).toContain(isolateLtr("{providerId}"));
    expect(resolveSetupCopy("ar", "setupModules.provider.review")).toContain(isolateLtr("{modelId}"));
    expect(resolveSetupCopy("ar", "setupApply.operations.configPatch")).toContain(isolateLtr("{scope}"));
    expect(resolveSetupCopy("ar", "setupApply.operations.configPatch")).toContain(isolateLtr("{configPath}"));
    expect(resolveSetupCopy("ar", "setupModules.telegram.title")).toBe(isolateLtr("Telegram"));
    expect(resolveSetupCopy("ar", "onboarding.providers.primaryCredential.localProviderSkip")).toContain(isolateLtr("API"));
    expect(resolveSetupCopy("ar", "setupRouter.configured.title")).toContain(isolateLtr("EstaCoda"));
    expect(resolveSetupCopy("ar", "setupStateSummary.directProviderExample")).toContain(isolateLtr("estacoda setup --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.browser.summary")).not.toContain("OAuth");
    expect(resolveSetupCopy("ar", "setupEditor.prompt.vision.useGateway")).toContain(isolateLtr("image gateway"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.mode.stt")).toContain(isolateLtr("STT"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.mode.tts")).toContain(isolateLtr("TTS"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.ttsProvider")).toContain(isolateLtr("TTS"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.summary")).toContain(isolateLtr("faster-whisper"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.summary")).toContain(isolateLtr("pythonBinary"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.summary")).toContain(isolateLtr("~/.estacoda/python-env"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.summary")).toContain(isolateLtr("~/.estacoda/cache/huggingface"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.sttProvider.local")).toContain(isolateLtr("faster-whisper"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.localModel.title")).toContain(isolateLtr("STT"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.localModel")).toContain(isolateLtr("STT"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.localModel")).toContain(isolateLtr("faster-whisper"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.localModel")).toContain(isolateLtr("EstaCoda"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.localModel")).toContain(isolateLtr("Python"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.localModel.base")).toContain(isolateLtr("Base"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.localModel.small")).toBe(isolateLtr("Small"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.localModel.small.description")).toContain(isolateLtr("Base"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.localModel.medium")).toBe(isolateLtr("Medium"));
    expect(resolveSetupCopy("ar", "setupEditor.apply.voice.localStt.failed")).toContain(isolateLtr("STT"));
    expect(resolveSetupCopy("ar", "setupEditor.apply.voice.localStt.failed")).toContain(isolateLtr("faster-whisper"));
    expect(resolveSetupCopy("ar", "setupEditor.apply.voice.localStt.failed")).toContain(isolateLtr("EstaCoda"));
    expect(resolveSetupCopy("ar", "setupEditor.apply.voice.localStt.failed")).toContain(isolateLtr("Python"));
    expect(resolveSetupCopy("ar", "setupEditor.apply.voice.localStt.failed")).toContain(isolateLtr("Debian/Ubuntu"));
    expect(resolveSetupCopy("ar", "setupEditor.apply.voice.localStt.failed")).toContain(isolateLtr("python3-venv"));
    expect(resolveSetupCopy("ar", "onboarding.optionalCapabilities.voice.localSttSkipped")).toContain(isolateLtr("STT"));
    expect(resolveSetupCopy("ar", "onboarding.optionalCapabilities.voice.localSttSkipped")).toContain(isolateLtr("faster-whisper"));
    expect(resolveSetupCopy("ar", "onboarding.optionalCapabilities.voice.localSttSkipped")).toContain(isolateLtr("EstaCoda"));
    expect(resolveSetupCopy("ar", "onboarding.optionalCapabilities.voice.localSttSkipped")).toContain(isolateLtr("Python"));
    expect(resolveSetupCopy("ar", "onboarding.optionalCapabilities.voice.localSttSkipped")).toContain(isolateLtr("venv"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.telegram.botToken.body")).toContain(isolateLtr("@BotFather"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.telegram.botToken.body")).toContain(isolateLtr("BotFather"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.telegram.botToken.body")).toContain(isolateLtr("/newbot"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.telegram.allowedUserIds.body")).toContain(isolateLtr("@userinfobot"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.telegram.allowedUserIds.body")).toContain(isolateLtr("/start"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.telegram.allowedChatIds.body")).toContain(isolateLtr("@getidsbot"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.telegram.allowedChatIds.body")).toContain(isolateLtr("@chatIDrobot"));
  });

  it("resolves onboarding local STT skipped warning copy", () => {
    expect(resolveSetupCopy("en", "setupApply.warnings.title")).toBe("Optional capability warnings");
    expect(resolveSetupCopy("ar", "setupApply.warnings.title")).toBe("تحذيرات القدرات الاختيارية");
    expect(resolveSetupCopy("en", "onboarding.optionalCapabilities.voice.localSttSkipped")).toBe(
      "Setup completed, but local faster-whisper STT was skipped because EstaCoda could not create its managed Python environment. Fix Python venv support, then reconfigure local STT from setup."
    );
    expect(rawSetupCopy("ar", "onboarding.optionalCapabilities.voice.localSttSkipped")).toBe(
      "اكتمل الإعداد، لكن تم تخطي STT المحلي عبر faster-whisper لأن EstaCoda لم تتمكن من إنشاء بيئة Python المُدارة. أصلح دعم Python venv، ثم أعد ضبط STT المحلي من الإعداد."
    );
  });

  it("uses the revised Telegram setup copy without truncating Arabic labels", () => {
    expect(rawSetupCopy("en", "setupEditor.prompt.channels.telegram.description")).toBe(
      "Configure Telegram for private and group chats"
    );
    expect(rawSetupCopy("en", "setupEditor.prompt.telegram.card.title")).toBe("Configure Telegram");
    expect(rawSetupCopy("en", "setupEditor.prompt.telegram.botToken.heading")).toBe("Connect Telegram bot");
    expect(rawSetupCopy("en", "setupEditor.prompt.telegram.botToken.body")).toContain(
      "Open Telegram and search for the official @BotFather account."
    );
    expect(rawSetupCopy("en", "setupEditor.prompt.telegram.botToken")).toBe("Telegram bot API token:");
    expect(rawSetupCopy("en", "setupEditor.prompt.telegram.allowedUserIds.heading")).toBe("Authorize Telegram users");
    expect(rawSetupCopy("en", "setupEditor.prompt.telegram.allowedUserIds")).toBe("Allowed Telegram user ID(s):");
    expect(rawSetupCopy("en", "setupEditor.prompt.telegram.allowedChatIds.heading")).toBe("Authorize Telegram group chats");
    expect(rawSetupCopy("en", "setupEditor.prompt.telegram.allowedChatIds")).toBe("Allowed Telegram group chat ID(s):");

    expect(rawSetupCopy("ar", "setupEditor.prompt.telegram.card.title")).toBe("ضبط Telegram");
    expect(resolveSetupCopy("ar", "setupEditor.prompt.telegram.card.title")).toContain(isolateLtr("Telegram"));
    expect(rawSetupCopy("ar", "setupEditor.prompt.telegram.botToken.heading")).toBe("ربط بوت Telegram");
    expect(rawSetupCopy("ar", "setupEditor.prompt.telegram.allowedUserIds.heading")).toBe("اعتماد مستخدمي Telegram");
    expect(rawSetupCopy("ar", "setupEditor.prompt.telegram.allowedUserIds")).toBe(
      "معرّف/معرّفات مستخدم Telegram المسموح بها:"
    );
    expect(rawSetupCopy("ar", "setupEditor.prompt.telegram.allowedChatIds.heading")).toBe("اعتماد محادثات مجموعات Telegram");
    expect(rawSetupCopy("ar", "setupEditor.prompt.telegram.allowedChatIds")).toBe(
      "معرّف/معرّفات محادثات مجموعات Telegram"
    );
  });

  it("contains the setup editor finalize-configuration review copy", () => {
    expect(rawSetupCopy("en", "setupEditor.review.title")).toBe("Finalize configuration");
    expect(rawSetupCopy("en", "setupEditor.review.body")).toBe("Confirm selected configuration");
    expect(rawSetupCopy("en", "setupEditor.review.selectedArea")).toBe("Selected area: {selectedArea}");
    expect(rawSetupCopy("en", "setupEditor.review.confirm")).toBe("Confirm");
    expect(rawSetupCopy("en", "setupEditor.review.confirm.description")).toBe("Update your EstaCoda configuration");
    expect(rawSetupCopy("en", "setupEditor.review.cancel")).toBe("Cancel");
    expect(rawSetupCopy("en", "setupEditor.review.cancel.description")).toBe("Keep your existing configuration unchanged.");
  });

  it("describes managed local STT as the normal onboarding path", () => {
    const english = rawSetupCopy("en", "setupEditor.prompt.voice.summary");
    expect(english).toContain("Local STT uses managed faster-whisper by default");
    expect(english).toContain("~/.estacoda/python-env");
    expect(english).toContain("~/.estacoda/cache/huggingface");
    expect(english).toContain("Onboarding does not ask for pythonBinary");
    expect(english).toContain("custom Python stay outside the normal onboarding path");

    const arabic = resolveSetupCopy("ar", "setupEditor.prompt.voice.summary");
    expect(arabic).toContain(isolateLtr("faster-whisper"));
    expect(arabic).toContain(isolateLtr("pythonBinary"));
    expect(arabic).toContain(isolateLtr("~/.estacoda/python-env"));
    expect(arabic).toContain(isolateLtr("~/.estacoda/cache/huggingface"));
  });

  it("defines setup editor local faster-whisper STT copy", () => {
    expect(rawSetupCopy("en", "setupEditor.prompt.voice.sttProvider.local")).toBe("Local (via faster-whisper)");
    expect(rawSetupCopy("ar", "setupEditor.prompt.voice.sttProvider.local")).toBe("محلي (عبر faster-whisper)");
    expect(rawSetupCopy("en", "setupEditor.prompt.voice.localModel.title")).toBe("Configure STT");
    expect(rawSetupCopy("ar", "setupEditor.prompt.voice.localModel.title")).toBe("اضبط STT");
    expect(rawSetupCopy("en", "setupEditor.prompt.voice.localModel")).toContain("Pick the faster-whisper STT model");
    expect(rawSetupCopy("en", "setupEditor.prompt.voice.localModel")).toContain("managed Python environment");
    expect(rawSetupCopy("ar", "setupEditor.prompt.voice.localModel")).toContain("بيئة Python المُدارة");
    expect(rawSetupCopy("en", "setupEditor.prompt.voice.localModel.base")).toBe("Base (recommended for everyday use)");
    expect(rawSetupCopy("en", "setupEditor.prompt.voice.localModel.small")).toBe("Small");
    expect(rawSetupCopy("en", "setupEditor.prompt.voice.localModel.medium")).toBe("Medium");
    expect(rawSetupCopy("en", "setupEditor.apply.voice.localStt.failed")).toContain("Local faster-whisper STT setup failed");
    expect(rawSetupCopy("ar", "setupEditor.apply.voice.localStt.failed")).toContain("فشل إعداد STT المحلي");
  });

  it("can return raw Arabic source copy without isolation for review tooling", () => {
    expect(rawSetupCopy("ar", "setupValidation.model.invalid")).toContain("{modelId}");
    expect(rawSetupCopy("ar", "setupValidation.model.invalid")).not.toContain(isolateLtr("{modelId}"));
  });

  it("falls back to English for intentionally unsupported locales", () => {
    expect(resolveSetupCopy("fr", "setupApply.review.cancelled")).toBe(
      "Review cancelled. No apply plan, config write, or trust grant will be created."
    );
    expect(resolveSetupCopy("en", "setupApply.review.cancelled")).toBe(resolveSetupCopy("fr", "setupApply.review.cancelled"));
  });

  it("contains the first-run, editor, and module copy keys", () => {
    assertKeys(FIRST_RUN_KEYS);
    assertKeys(SETUP_EDITOR_KEYS);
    assertKeys(SETUP_MODULE_KEYS);
    assertKeys(WHATSAPP_WIZARD_KEYS);
  });

  it("contains standalone WhatsApp wizard copy with safe default wording", () => {
    expect(rawSetupCopy("en", "whatsappWizard.mode.block")).toContain("Choose [1/2]:");
    expect(rawSetupCopy("en", "whatsappWizard.mode.block")).toContain("Dedicated WhatsApp number");
    expect(rawSetupCopy("en", "whatsappWizard.allowlist.question")).toContain("Leave blank to link WhatsApp now");
    expect(rawSetupCopy("en", "whatsappWizard.allowlist.question")).not.toContain("*");
    expect(rawSetupCopy("en", "whatsappWizard.allowlist.selected")).toContain("Allowed senders");
    expect(rawSetupCopy("en", "whatsappWizard.success.linked")).toContain("linked");
    expect(rawSetupCopy("en", "whatsappWizard.success.sessionSaved")).toContain("Session saved");
    expect(rawSetupCopy("en", "whatsappWizard.success.restricted")).toContain("Incoming messages restricted to");
  });

  it("isolates standalone WhatsApp wizard Arabic technical tokens", () => {
    expect(resolveSetupCopy("ar", "whatsappWizard.mode.block")).toContain(isolateLtr("EstaCoda"));
    expect(resolveSetupCopy("ar", "whatsappWizard.mode.block")).toContain(isolateLtr("WhatsApp"));
    expect(resolveSetupCopy("ar", "whatsappWizard.mode.block")).toContain(isolateLtr("WhatsApp Business"));
    expect(resolveSetupCopy("ar", "whatsappWizard.dedicated.guidance")).toContain(isolateLtr("eSIM"));
    expect(resolveSetupCopy("ar", "whatsappWizard.dependencies.missingQuestion")).toContain(isolateLtr("npm ci"));
    expect(resolveSetupCopy("ar", "whatsappWizard.dependencies.missingQuestion")).toContain(isolateLtr("scripts/whatsapp-bridge/"));
    expect(resolveSetupCopy("ar", "whatsappWizard.pairing.failed")).toContain(isolateLtr("QR"));
    expect(resolveSetupCopy("ar", "whatsappWizard.pairing.block")).toContain(isolateLtr("{authDir}"));
    expect(resolveSetupCopy("ar", "whatsappWizard.success.pairingPending")).toContain(isolateLtr("pairing-pending"));
    expect(rawSetupCopy("ar", "whatsappWizard.allowlist.selected")).toContain("المرسلون المسموحون");
    expect(rawSetupCopy("ar", "whatsappWizard.allowlist.question")).not.toContain("*");
  });

  it("contains Phase 1 setup editor foundation copy", () => {
    expect(rawSetupCopy("en", "setupEditor.shell.title")).toBe("Setup Editor");
    expect(rawSetupCopy("en", "setupEditor.prompt.action.title")).toBe("Setup editor");
    expect(rawSetupCopy("en", "setupEditor.prompt.action.body")).toBe("Choose what to configure.");
    expect(rawSetupCopy("en", "setupEditor.actions.editPrimaryModelRoute")).toBe("Edit primary model");
    expect(rawSetupCopy("en", "setupEditor.actions.editPrimaryModelRoute.description")).toBe("Set the default provider and model used by the agent.");
    expect(rawSetupCopy("en", "setupEditor.actions.editFallbackModelRoute")).toBe("Edit fallback models");
    expect(rawSetupCopy("en", "setupEditor.actions.editFallbackModelRoute.description")).toBe("Configure backup providers and models used when the primary model fails.");
    expect(rawSetupCopy("en", "setupEditor.actions.editAuxiliaryModelRoute")).toBe("Edit auxiliary models");
    expect(rawSetupCopy("en", "setupEditor.actions.editAuxiliaryModelRoute.description")).toBe("Configure specialist models for assessment, compression, recall, and memory.");
    expect(rawSetupCopy("en", "setupEditor.actions.configureChannels")).toBe("Configure channels");
    expect(rawSetupCopy("en", "setupEditor.actions.configureChannels.description")).toBe("Set up remote-control channels such as Telegram.");
    expect(rawSetupCopy("en", "setupEditor.actions.configureVoice")).toBe("Configure voice");
    expect(rawSetupCopy("en", "setupEditor.actions.configureVoice.description")).toBe("Set speech-to-text and text-to-speech providers.");
    expect(rawSetupCopy("en", "setupEditor.actions.configureImageGeneration")).toBe("Configure image generation");
    expect(rawSetupCopy("en", "setupEditor.actions.configureImageGeneration.description")).toBe("Set the image generation provider.");
    expect(rawSetupCopy("en", "setupEditor.actions.configureBrowser")).toBe("Configure browser");
    expect(rawSetupCopy("en", "setupEditor.actions.configureBrowser.description")).toBe("Set browser behavior without launching a browser.");
    expect(rawSetupCopy("en", "setupEditor.actions.editSecurityMode")).toBe("Edit security mode");
    expect(rawSetupCopy("en", "setupEditor.actions.editSecurityMode.description")).toBe("Choose how strictly EstaCoda reviews risky actions.");
    expect(rawSetupCopy("en", "onboarding.workflowLearning")).toBe("Agent Evolution controls EstaCoda's reviewable self-improvement: evidence, proposals, evals, and manual promotion.");
    expect(rawSetupCopy("en", "setupEditor.actions.editWorkflowLearning")).toBe("Configure Agent Evolution");
    expect(rawSetupCopy("en", "setupEditor.actions.editWorkflowLearning.description")).toBe("Agent Evolution controls reviewable self-improvement proposals backed by evidence, evals, and manual promotion.");
    expect(rawSetupCopy("ar", "setupEditor.actions.editWorkflowLearning.description")).toBe("يتحكم Agent Evolution في proposal تحسين ذاتي قابلة للمراجعة ومدعومة بالأدلة، والتقييمات، والترقية اليدوية.");
    expect(resolveSetupCopy("ar", "setupEditor.actions.editWorkflowLearning.description")).toContain(isolateLtr("Agent Evolution"));
    expect(resolveSetupCopy("ar", "setupEditor.actions.editWorkflowLearning.description")).toContain(isolateLtr("proposal"));
    expect(rawSetupCopy("en", "setupEditor.actions.chooseLanguage")).toBe("Choose language");
    expect(rawSetupCopy("en", "setupEditor.actions.chooseLanguage.description")).toBe("Choose English or Arabic. Arabic support is beta and may fall back to English.");
    expect(rawSetupCopy("en", "setupEditor.actions.runReadonlyVerification")).toBe("Run setup verification");
    expect(rawSetupCopy("en", "setupEditor.actions.runReadonlyVerification.description")).toBe("Check setup state without changing config.");
    expect(rawSetupCopy("en", "setupEditor.actions.showDiagnostics")).toBe("Show diagnostics");
    expect(rawSetupCopy("en", "setupEditor.actions.showDiagnostics.description")).toBe("List blockers, warnings, and detected state.");
    expect(rawSetupCopy("en", "setupEditor.actions.exitWithoutChanges")).toBe("Exit without changes");
    expect(rawSetupCopy("en", "setupEditor.actions.exitWithoutChanges.description")).toBe("Leave setup without modifying config.");
    expect(rawSetupCopy("en", "setupEditor.actions.storeProviderCredentialReference")).toBe("Store provider credential reference.");
    expect(rawSetupCopy("en", "setupDrafts.fallbackModelRoute.add.summary")).toBe("Add fallback model {providerId} / {modelId}.");
    expect(rawSetupCopy("en", "setupDrafts.fallbackModelRoute.replace.summary")).toBe("Replace fallback model {previousProviderId} / {previousModelId} with {providerId} / {modelId}.");
    expect(rawSetupCopy("en", "setupDrafts.auxiliaryModelRoute.summary")).toBe("Set auxiliary {auxiliaryTask} model to {providerId} / {modelId}.");
    expect(rawSetupCopy("en", "setupDrafts.credentialReference.summary")).toBe("Store credential env-var reference {envVar} only.");
    expect(rawSetupCopy("en", "setupEditor.prompt.fallbackRoute.add")).toBe("Add another fallback model");
    expect(rawSetupCopy("en", "setupEditor.prompt.fallbackRoute.edit")).toBe("Edit fallback {index}: {providerId}/{modelId}");
    expect(rawSetupCopy("en", "setupEditor.prompt.auxiliaryRoute.title")).toBe("Choose auxiliary model.");
    expect(rawSetupCopy("en", "setupEditor.prompt.auxiliaryRoute.assessor")).toBe("Assessor");
    expect(rawSetupCopy("en", "setupEditor.prompt.auxiliaryRoute.compression")).toBe("Compression");
    expect(rawSetupCopy("en", "setupEditor.prompt.auxiliaryRoute.sessionSearch")).toBe("Session search");
    expect(rawSetupCopy("en", "setupEditor.prompt.auxiliaryRoute.memoryCompaction")).toBe("Memory compaction");
    expect(rawSetupCopy("en", "setupEditor.prompt.auxiliaryRoute.profileContext")).toBe("Profile context");
    expect(rawSetupCopy("en", "setupEditor.prompt.auxiliaryRoute.assessor.description")).toContain("approval assessment");

    expect(rawSetupCopy("ar", "setupEditor.shell.title")).toBe("محرّر الإعدادات");
    expect(rawSetupCopy("ar", "setupEditor.prompt.action.body")).toBe("اختار اللي تحب تضبطه.");
    expect(rawSetupCopy("ar", "setupEditor.actions.configureChannels.description")).toContain("Telegram");
    expect(rawSetupCopy("ar", "setupEditor.actions.editSecurityMode.description")).toContain("EstaCoda");
    expect(rawSetupCopy("ar", "setupEditor.prompt.auxiliaryRoute.assessor.description")).toContain("assessor");
    expect(rawSetupCopy("ar", "setupEditor.prompt.auxiliaryRoute.compression.description")).toContain("compression");
    expect(rawSetupCopy("ar", "setupEditor.prompt.auxiliaryRoute.sessionSearch.description")).toContain("session_search");
    expect(rawSetupCopy("ar", "setupEditor.prompt.auxiliaryRoute.memoryCompaction.description")).toContain("memory_compaction");
    expect(rawSetupCopy("ar", "setupEditor.prompt.auxiliaryRoute.profileContext.description")).toContain("profile_context");
  });

  it("contains Phase 2 credential reuse prompt copy", () => {
    expect(rawSetupCopy("en", "setupEditor.prompt.credentialReuse.existing")).toBe("Use existing saved API key.");
    expect(rawSetupCopy("en", "setupEditor.prompt.credentialReuse.existing.description")).toBe("Keep the saved credential reference and continue.");
    expect(rawSetupCopy("en", "setupEditor.prompt.credentialReuse.new")).toBe("Enter a new API key.");
    expect(rawSetupCopy("en", "setupEditor.prompt.credentialReuse.new.description")).toBe("Replace the saved secret value after review.");

    expect(rawSetupCopy("ar", "setupEditor.prompt.credentialReuse.existing")).toContain("API");
    expect(rawSetupCopy("ar", "setupEditor.prompt.credentialReuse.new")).toContain("API");
    expect(rawSetupCopy("ar", "setupEditor.prompt.credentialReuse.existing").length).toBeGreaterThan(0);
    expect(rawSetupCopy("ar", "setupEditor.prompt.credentialReuse.new.description").length).toBeGreaterThan(0);
  });

  it("contains review manifest copy keys", () => {
    assertKeys(REVIEW_MANIFEST_KEYS);
  });

  it("contains save, verify, and launch handoff copy keys", () => {
    assertKeys(SETUP_VERIFICATION_KEYS);
    assertKeys(APPLY_HANDOFF_KEYS);
  });

  it("keeps setup verification Arabic technical tokens isolated", () => {
    const copy = setupVerificationCopy("ar");

    expect(copy.verification.skippedNoPackageJson).toContain(isolateLtr("package.json"));
    expect(copy.verification.nextReady).toContain(isolateLtr("estacoda telegram setup"));
    expect(copy.verification.nextReady).toContain(isolateLtr("estacoda browser setup"));
    expect(copy.verification.actions.secretPermissions).toContain(isolateLtr("0600"));
    expect(copy.verification.actions.secretPermissions).toContain(isolateLtr("estacoda verify"));
    expect(copy.verification.actions.missingApiKey("OPENAI_API_KEY")).toContain(isolateLtr("OPENAI_API_KEY"));
  });

  it("contains validation, error, and warning copy keys", () => {
    assertKeys(VALIDATION_KEYS);
  });

  it("keeps the mixed key style from the approved inventory", () => {
    expect(hasSetupCopyKey("setupModules.securityMode.title")).toBe(true);
    expect(hasSetupCopyKey("setupModules.security-mode.review")).toBe(true);
    expect(hasSetupCopyKey("setupModules.workflowLearning.title")).toBe(true);
    expect(hasSetupCopyKey("setupModules.workflow-learning.review")).toBe(true);
    expect(hasSetupCopyKey("setupModules.securityMode.review")).toBe(false);
    expect(hasSetupCopyKey("setupModules.workflowLearning.review")).toBe(false);
  });

  it("does not expose raw secret-like values in copy surfaces", () => {
    const json = JSON.stringify({
      entries: listSetupCopyEntries(),
      ar: setupCopy("ar"),
      en: setupCopy("en"),
    });

    expect(json).not.toContain("sk-");
    expect(json).not.toContain("123456:");
    expect(json).not.toContain("do-not-render");
    expect(json).not.toContain("raw secret value");
  });

  it("does not claim full CLI localization", () => {
    const json = JSON.stringify(listSetupCopyEntries());

    expect(json).not.toContain("full CLI localization");
    expect(json).not.toContain("runtime localization");
  });
});

function assertKeys(keys: readonly string[]): void {
  for (const key of keys) {
    expect(hasSetupCopyKey(key), key).toBe(true);
    expect(getSetupCopyEntry(key as SetupCopyKey).en.length, key).toBeGreaterThan(0);
    expect(getSetupCopyEntry(key as SetupCopyKey).ar.length, key).toBeGreaterThan(0);
  }
}
