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
  "onboarding.optionalCapabilities.skipped",
  "onboarding.optionalCapabilities.validation.skippable",
  "onboarding.review",
  "onboarding.review.validation.accepted",
  "onboarding.save",
  "onboarding.save.validation.confirmed",
  "onboarding.verification",
  "onboarding.verification.validation.selected",
  "onboarding.launch",
  "onboarding.launch.validation.explicit",
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
  "setupEditor.actions.repairWorkspaceTrust",
  "setupEditor.actions.configureChannels",
  "setupEditor.actions.configureVoice",
  "setupEditor.actions.configureImageGeneration",
  "setupEditor.actions.configureBrowser",
  "setupEditor.actions.runReadonlyVerification",
  "setupEditor.actions.repairBrokenConfig",
  "setupEditor.actions.repairStateDirectory",
  "setupEditor.actions.cancelSetupEditor",
  "setupEditor.actions.repairWorkspaceTrust.description",
  "setupEditor.actions.editSecurityMode.description",
  "setupEditor.actions.editWorkflowLearning.description",
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
  "setupEditor.diagnostics.title",
  "setupEditor.diagnostics.manualRepair.brokenConfig",
  "setupEditor.diagnostics.manualRepair.stateNotWritable",
  "setupEditor.prompt.action.title",
  "setupEditor.prompt.action.body",
  "setupEditor.prompt.postApply.title",
  "setupEditor.prompt.postApply.body",
  "setupEditor.prompt.postApply.launch",
  "setupEditor.prompt.postApply.acceptLimitedMode",
  "setupEditor.prompt.postApply.repairAgain",
  "setupEditor.prompt.postApply.exit",
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
  "setupEditor.prompt.telegram.summary",
  "setupEditor.prompt.telegram.botTokenEnv",
  "setupEditor.prompt.telegram.botToken",
  "setupEditor.prompt.telegram.allowedUserIds",
  "setupEditor.prompt.telegram.allowedChatIds",
  "setupEditor.prompt.telegram.remoteControlRisk",
  "setupEditor.prompt.telegram.incomplete.body",
  "setupEditor.prompt.telegram.incomplete.retry",
  "setupEditor.prompt.telegram.incomplete.retry.description",
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
  "setupEditor.prompt.browser.launchCommand",
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
  "setupDrafts.optionalCapabilities.summary",
  "setupDrafts.verification.summary",
  "setupDrafts.launch.summary",
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
  "setupApply.endState.savedNotLaunched",
  "setupApply.endState.launched",
  "setupApply.endState.acceptedDegraded",
  "setupApply.repairRequired",
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
  "setupValidation.browser.noAutoLaunch",
] as const;

describe("setup copy", () => {
  it("selects screenshot-approved Arabic copy", () => {
    const copy = setupCopy("ar");

    expect(copy["onboarding.welcome"]).toContain("سنضع القواعد");
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
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.ttsProvider")).toContain(isolateLtr("TTS"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.summary")).toContain(isolateLtr("faster-whisper"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.summary")).toContain(isolateLtr("pythonBinary"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.summary")).toContain(isolateLtr("~/.estacoda/python-env"));
    expect(resolveSetupCopy("ar", "setupEditor.prompt.voice.summary")).toContain(isolateLtr("~/.estacoda/cache/huggingface"));
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
  });

  it("contains Phase 1 setup editor foundation copy", () => {
    expect(rawSetupCopy("en", "setupEditor.actions.editFallbackModelRoute")).toBe("Edit fallback provider/model route.");
    expect(rawSetupCopy("en", "setupEditor.actions.editFallbackModelRoute.description")).toBe("Choose or add a fallback provider/model route through a reviewed setup change.");
    expect(rawSetupCopy("en", "setupEditor.actions.editAuxiliaryModelRoute")).toBe("Edit auxiliary provider/model route.");
    expect(rawSetupCopy("en", "setupEditor.actions.editAuxiliaryModelRoute.description")).toBe("Choose an auxiliary route for assessor, compression, session search, memory compaction, or profile context.");
    expect(rawSetupCopy("en", "setupEditor.actions.configureChannels")).toBe("Configure channels.");
    expect(rawSetupCopy("en", "setupEditor.actions.configureVoice")).toBe("Configure voice.");
    expect(rawSetupCopy("en", "setupEditor.actions.configureImageGeneration")).toBe("Configure image generation.");
    expect(rawSetupCopy("en", "setupEditor.actions.configureBrowser")).toBe("Configure browser.");
    expect(rawSetupCopy("en", "setupEditor.actions.storeProviderCredentialReference")).toBe("Store provider credential reference.");
    expect(rawSetupCopy("en", "setupDrafts.fallbackModelRoute.add.summary")).toBe("Add fallback route {providerId} / {modelId}.");
    expect(rawSetupCopy("en", "setupDrafts.fallbackModelRoute.replace.summary")).toBe("Replace fallback route {previousProviderId} / {previousModelId} with {providerId} / {modelId}.");
    expect(rawSetupCopy("en", "setupDrafts.auxiliaryModelRoute.summary")).toBe("Set auxiliary {auxiliaryTask} route to {providerId} / {modelId}.");
    expect(rawSetupCopy("en", "setupDrafts.credentialReference.summary")).toBe("Store credential env-var reference {envVar} only.");
    expect(rawSetupCopy("en", "setupEditor.prompt.fallbackRoute.add")).toBe("Add another fallback route");
    expect(rawSetupCopy("en", "setupEditor.prompt.fallbackRoute.edit")).toBe("Edit fallback {index}: {providerId}/{modelId}");
    expect(rawSetupCopy("en", "setupEditor.prompt.auxiliaryRoute.title")).toBe("Choose auxiliary route.");
    expect(rawSetupCopy("en", "setupEditor.prompt.auxiliaryRoute.assessor")).toBe("Assessor");
    expect(rawSetupCopy("en", "setupEditor.prompt.auxiliaryRoute.compression")).toBe("Compression");
    expect(rawSetupCopy("en", "setupEditor.prompt.auxiliaryRoute.sessionSearch")).toBe("Session search");
    expect(rawSetupCopy("en", "setupEditor.prompt.auxiliaryRoute.memoryCompaction")).toBe("Memory compaction");
    expect(rawSetupCopy("en", "setupEditor.prompt.auxiliaryRoute.profileContext")).toBe("Profile context");
    expect(rawSetupCopy("en", "setupEditor.prompt.auxiliaryRoute.assessor.description")).toContain("approval assessment");

    expect(rawSetupCopy("ar", "setupEditor.actions.editAuxiliaryModelRoute.description")).toContain("assessor");
    expect(rawSetupCopy("ar", "setupEditor.actions.editAuxiliaryModelRoute.description")).toContain("compression");
    expect(rawSetupCopy("ar", "setupEditor.actions.editAuxiliaryModelRoute.description")).toContain("session_search");
    expect(rawSetupCopy("ar", "setupEditor.actions.editAuxiliaryModelRoute.description")).toContain("memory_compaction");
    expect(rawSetupCopy("ar", "setupEditor.actions.editAuxiliaryModelRoute.description")).toContain("profile_context");
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
