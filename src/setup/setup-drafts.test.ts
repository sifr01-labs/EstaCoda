import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderDiagnostic } from "../config/provider-diagnostics.js";
import type { SetupEntryRecommendedAction, SetupEntryState, SetupEntryStateKind } from "./setup-entry-state.js";
import type { SetupVerificationReport } from "./verification.js";
import { routeSetupEntryState } from "./setup-router.js";
import { planSetupApply } from "./setup-apply-plan.js";
import {
  buildOnboardingWizardDraftBundle,
  buildSetupEditorActionDraftBundle,
  buildSetupEditorDraftBundle,
  type SetupDraftBundle,
} from "./setup-drafts.js";
import { buildSetupReviewManifest } from "./setup-review-manifest.js";
import { scopedPatch, setupEditorAction } from "./setup-editor-actions.js";
import type { OnboardingWizardState } from "./onboarding-wizard/state.js";

function providerDiagnostic(status: ProviderDiagnostic["status"] = "ready"): ProviderDiagnostic {
  return {
    status,
    lines: ["Selected route: local/local-test-model"],
    warnings: status === "ready" ? [] : ["Configured model context window is below 64K tokens."],
  };
}

function verificationReport(overrides: Partial<SetupVerificationReport> = {}): SetupVerificationReport {
  return {
    stateWritable: true,
    envFilePresent: false,
    envFileSecure: true,
    workspaceTrusted: true,
    securityModeLabel: "Adaptive",
    securityModeValue: "adaptive",
    skillAutonomyLabel: "Suggest",
    skillAutonomyValue: "suggest",
    providerDiagnostic: providerDiagnostic(),
    toolStatus: "skipped",
    configSources: ["/tmp/home/.estacoda/config.json"],
    warnings: [],
    issueCodes: [],
    ...overrides,
  };
}

function state(kind: SetupEntryStateKind, overrides: Partial<SetupEntryState> = {}): SetupEntryState {
  const report = verificationReport({
    workspaceTrusted: kind !== "untrusted-workspace",
    stateWritable: kind !== "state-not-writable",
    providerDiagnostic: providerDiagnostic(kind === "configured-degraded" ? "warning" : kind === "configured-ready" || kind === "untrusted-workspace" ? "ready" : "blocked"),
    warnings: kind === "configured-degraded" ? ["Configured model context window is below 64K tokens."] : [],
  });

  return {
    kind,
    recommendedAction: recommendedAction(kind),
    configSources: kind === "new-user" ? [] : ["/tmp/home/.estacoda/config.json"],
    configPaths: {
      profile: "/tmp/home/.estacoda/profiles/default/config.json",
    },
    providerReadiness: kind === "configured-ready" || kind === "untrusted-workspace" ? "ready" : kind === "configured-degraded" ? "degraded" : "missing-config",
    workspaceTrust: kind === "untrusted-workspace" ? "untrusted" : "trusted",
    workspaceVerification: kind === "configured-ready" ? "verified" : "unverified",
    stateDirectoryWritable: kind !== "state-not-writable",
    missingCredentials: kind === "missing-secret" ? { envVars: ["OPENAI_API_KEY"], providers: [] } : { envVars: [], providers: [] },
    setupVerification: report,
    warnings: report.warnings,
    blockers: kind === "configured-ready" ? [] : [`${kind} blocker`],
    model: {
      provider: kind === "new-user" ? "unconfigured" : "local",
      id: kind === "new-user" ? "unconfigured" : "local-test-model",
    },
    ...overrides,
  };
}

function recommendedAction(kind: SetupEntryStateKind): SetupEntryRecommendedAction {
  switch (kind) {
    case "new-user":
      return "start-first-run";
    case "configured-ready":
      return "launch-agent";
    case "configured-degraded":
      return "review-warnings";
    case "partial-provider":
      return "repair-provider";
    case "missing-secret":
      return "add-missing-secret";
    case "broken-config":
      return "repair-config";
    case "untrusted-workspace":
      return "trust-workspace";
    case "state-not-writable":
      return "fix-state-directory";
  }
}

function onboardingBundle(overrides: Partial<{
  primaryBaseUrl?: string;
  primaryContextWindowTokens?: number;
  primaryApiMode?: OnboardingWizardState["primaryRoute"] extends infer Route ? Route extends { apiMode?: infer Mode } ? Mode : never : never;
  primaryAuthMethod?: OnboardingWizardState["primaryRoute"] extends infer Route ? Route extends { authMethod?: infer Method } ? Method : never : never;
}> = {}): SetupDraftBundle {
  return buildOnboardingWizardDraftBundle(onboardingWizardState({
    primaryRoute: {
      provider: "openai",
      model: "gpt-4.1-mini",
      baseUrl: overrides.primaryBaseUrl,
      contextWindowTokens: overrides.primaryContextWindowTokens,
      apiMode: overrides.primaryApiMode,
      authMethod: overrides.primaryAuthMethod,
    },
    optionalCapabilities: {
      selected: [],
      channels: { telegram: "not_set" },
      voice: { stt: "not_set", tts: "not_set" },
      browser: "not_set",
    },
    optionalCapabilityDrafts: [],
  }), {
    configPath: "/tmp/home/.estacoda/config.json",
    workspaceRoot: "/tmp/workspace",
    trustStorePath: "/tmp/home/.estacoda/trust.json",
  });
}

function onboardingWizardState(overrides: Partial<OnboardingWizardState> = {}): OnboardingWizardState {
  return {
    interfacePreferences: {
      language: "en",
      flavor: "standard",
      activityLabels: "en",
    },
    workspace: {
      path: "/tmp/workspace",
      trustStatus: "trusted",
    },
    primaryRoute: {
      provider: "openai",
      model: "gpt-5.5",
      baseUrl: "https://api.openai.com/v1",
      contextWindowTokens: 128000,
      apiMode: "custom_openai_compatible",
      authMethod: "api_key",
    },
    credential: {
      status: "new_pending",
      envVarName: "OPENAI_API_KEY",
    },
    securityMode: "adaptive",
    agentEvolution: "suggest",
    optionalCapabilities: {
      selected: ["channels", "voice", "browser"],
      channels: { telegram: "configured" },
      voice: { stt: "configured", tts: "configured" },
      browser: "configured",
    },
    ...overrides,
  };
}

describe("setup draft bundles", () => {
  it("builds onboarding wizard draft bundles without mutation", () => {
    const bundle = onboardingBundle();

    expect(bundle.kind).toBe("setup-draft-bundle");
    expect(bundle.sourceKind).toBe("onboarding-wizard-state");
    expect(bundle.drafts.map((draft) => draft.kind)).toEqual([
      "ui-preferences",
      "provider-model-route",
      "credential-reference",
      "security-mode",
      "workflow-learning",
      "workspace-trust",
      "verification",
    ]);
    expect(bundle.drafts.every((draft) => draft.applyIntent.writesConfig === false)).toBe(true);
    expect(bundle.drafts.every((draft) => draft.applyIntent.writesTrustStore === false)).toBe(true);
  });

  it("builds setup editor draft bundles without mutation", () => {
    const decision = routeSetupEntryState(state("configured-ready"));
    if (decision.setupEditorPlanSession === undefined) {
      throw new Error("Expected setup editor plan session");
    }
    const bundle = buildSetupEditorDraftBundle(decision.setupEditorPlanSession, {
      configPath: "/tmp/home/.estacoda/config.json",
    });

    expect(bundle.sourceKind).toBe("setup-editor-plan-session");
    expect(bundle.drafts.length).toBeGreaterThan(0);
    expect(bundle.drafts.every((draft) => draft.applyIntent.dryRunOnly)).toBe(true);
    expect(bundle.drafts.every((draft) => draft.applyIntent.writesConfig === false)).toBe(true);
  });

  it("builds onboarding wizard draft bundles directly from wizard state", () => {
    const bundle = buildOnboardingWizardDraftBundle(onboardingWizardState(), {
      configPath: "/tmp/home/.estacoda/config.json",
      workspaceRoot: "/tmp/workspace",
      trustStorePath: "/tmp/home/.estacoda/trust.json",
    });

    expect(bundle.sourceKind).toBe("onboarding-wizard-state");
    expect(bundle.drafts.map((draft) => draft.kind)).toEqual([
      "ui-preferences",
      "provider-model-route",
      "credential-reference",
      "security-mode",
      "workflow-learning",
      "workspace-trust",
      "optional-capability",
      "verification",
    ]);
    expect(bundle.drafts.every((draft) => draft.applyIntent.dryRunOnly)).toBe(true);
    expect(bundle.drafts.every((draft) => draft.applyIntent.writesConfig === false)).toBe(true);
    expect(bundle.drafts.every((draft) => draft.applyIntent.writesTrustStore === false)).toBe(true);
  });

  it("preserves onboarding wizard state fields in safe reviewed drafts", () => {
    const bundle = buildOnboardingWizardDraftBundle(onboardingWizardState(), {
      configPath: "/tmp/home/.estacoda/config.json",
      workspaceRoot: "/tmp/workspace",
      trustStorePath: "/tmp/home/.estacoda/trust.json",
    });

    const ui = bundle.drafts.find((draft) => draft.kind === "ui-preferences");
    const route = bundle.drafts.find((draft) => draft.kind === "provider-model-route");
    const credential = bundle.drafts.find((draft) => draft.kind === "credential-reference");
    const security = bundle.drafts.find((draft) => draft.kind === "security-mode");
    const evolution = bundle.drafts.find((draft) => draft.kind === "workflow-learning");
    const workspace = bundle.drafts.find((draft) => draft.kind === "workspace-trust");
    const optional = bundle.drafts.find((draft) => draft.kind === "optional-capability");

    expect(ui?.review.values).toEqual({
      language: "en",
      flavor: "standard",
      activityLabels: "en",
    });
    expect(route?.review.values).toEqual(expect.objectContaining({
      provider: "openai",
      model: "gpt-5.5",
      baseUrl: "https://api.openai.com/v1",
      contextWindowTokens: 128000,
      apiMode: "custom_openai_compatible",
      authMethod: "api_key",
    }));
    expect(credential?.review.values).toEqual(expect.objectContaining({
      provider: "openai",
      model: "gpt-5.5",
      envVars: ["OPENAI_API_KEY"],
      credentialValuesIncluded: false,
    }));
    expect(security?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["security.approvalMode"],
    }));
    expect(evolution?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["skills.autonomy"],
    }));
    expect(workspace?.target).toEqual({
      kind: "trust-store",
      workspaceRoot: "/tmp/workspace",
      trustStorePath: "/tmp/home/.estacoda/trust.json",
    });
    expect(optional?.review.values).toEqual({
      skipped: false,
      capabilities: ["channels", "voice", "browser"],
    });
  });

  it("derives selected channel capability when onboarding configured WhatsApp", () => {
    const bundle = buildOnboardingWizardDraftBundle(onboardingWizardState({
      optionalCapabilities: {
        channels: {
          telegram: "not_set",
          whatsapp: "configured",
        },
        voice: {
          stt: "not_set",
          tts: "not_set",
        },
        browser: "not_set",
      },
    }), {
      configPath: "/tmp/home/.estacoda/config.json",
      workspaceRoot: "/tmp/workspace",
      trustStorePath: "/tmp/home/.estacoda/trust.json",
    });
    const optional = bundle.drafts.find((draft) => draft.kind === "optional-capability");

    expect(optional?.review.values).toEqual({
      skipped: false,
      capabilities: ["channels"],
    });
  });

  it("keeps onboarding wizard credential data redacted through draft building", () => {
    const unsafeState = onboardingWizardState({
      credential: {
        status: "new_pending",
        envVarName: "OPENAI_API_KEY",
        rawSecret: "sk-not-for-drafts",
        prefix: "sk-",
        suffix: "zzzz",
        length: 17,
        hash: "abc123",
      } as unknown as OnboardingWizardState["credential"],
    });
    const bundle = buildOnboardingWizardDraftBundle(unsafeState, {
      configPath: "/tmp/home/.estacoda/config.json",
      workspaceRoot: "/tmp/workspace",
      trustStorePath: "/tmp/home/.estacoda/trust.json",
    });
    const json = JSON.stringify(bundle);

    expect(json).toContain("OPENAI_API_KEY");
    expect(json).not.toContain("sk-not-for-drafts");
    expect(json).not.toContain("sk-");
    expect(json).not.toContain("zzzz");
    expect(json).not.toContain("abc123");
  });

  it("keeps onboarding wizard raw credential data out of manifest and apply planning output", () => {
    const unsafeState = onboardingWizardState({
      credential: {
        status: "new_pending",
        envVarName: "OPENAI_API_KEY",
        rawSecret: "sk-direct-builder-secret",
      } as unknown as OnboardingWizardState["credential"],
    });
    const bundle = buildOnboardingWizardDraftBundle(unsafeState, {
      configPath: "/tmp/home/.estacoda/config.json",
      workspaceRoot: "/tmp/workspace",
      trustStorePath: "/tmp/home/.estacoda/trust.json",
    });
    const manifest = buildSetupReviewManifest([bundle]);
    const applyPlanningResult = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });
    const json = JSON.stringify({ manifest, applyPlanningResult });

    expect(json).toContain("OPENAI_API_KEY");
    expect(json).not.toContain("sk-direct-builder-secret");
    expect(json).not.toContain("rawSecret");
  });

  it("creates provider/model drafts with scoped target and preserveUnrelatedConfig", () => {
    const draft = onboardingBundle().drafts.find((candidate) => candidate.kind === "provider-model-route");

    expect(draft?.target).toEqual({
      kind: "config-scope",
      scope: ["model.provider", "model.id"],
      path: "/tmp/home/.estacoda/config.json",
      preserveUnrelatedConfig: true,
    });
    expect(draft?.preserveUnrelatedConfig).toBe(true);
  });

  it("carries route metadata in provider-model draft review values", () => {
    const bundle = onboardingBundle({
      primaryBaseUrl: "https://custom.example.com/v1",
      primaryContextWindowTokens: 256000,
      primaryApiMode: "custom_openai_compatible",
      primaryAuthMethod: "api_key",
    });
    const draft = bundle.drafts.find((candidate) => candidate.kind === "provider-model-route");

    expect(draft?.review.values.provider).toBe("openai");
    expect(draft?.review.values.model).toBe("gpt-4.1-mini");
    expect(draft?.review.values.baseUrl).toBe("https://custom.example.com/v1");
    expect(draft?.review.values.contextWindowTokens).toBe(256000);
    expect(draft?.review.values.apiMode).toBe("custom_openai_compatible");
    expect(draft?.review.values.authMethod).toBe("api_key");
  });

  it("redacts credential drafts and shows env var refs only", () => {
    const draft = onboardingBundle().drafts.find((candidate) => candidate.kind === "credential-reference");
    const json = JSON.stringify(draft);

    expect(draft?.review.values.envVars).toEqual(["OPENAI_API_KEY"]);
    expect(draft?.review.values.credentialValuesIncluded).toBe(false);
    expect(json).not.toContain("sk-");
    expect(json).not.toContain("raw");
    expect(json).not.toContain("secretValue");
  });

  it("creates workspace trust drafts with exact paths without granting trust", () => {
    const draft = onboardingBundle().drafts.find((candidate) => candidate.kind === "workspace-trust");

    expect(draft?.target).toEqual({
      kind: "trust-store",
      workspaceRoot: "/tmp/workspace",
      trustStorePath: "/tmp/home/.estacoda/trust.json",
    });
    expect(draft?.applyIntent).toEqual({
      kind: "dry-run-apply-intent",
      effect: "trust-grant",
      dryRunOnly: true,
      writesConfig: false,
      writesTrustStore: false,
    });
  });

  it("keeps security and workflow drafts scoped while preserving unrelated config", () => {
    const bundle = onboardingBundle();
    const security = bundle.drafts.find((candidate) => candidate.kind === "security-mode");
    const workflow = bundle.drafts.find((candidate) => candidate.kind === "workflow-learning");

    expect(security?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["security.approvalMode"],
      preserveUnrelatedConfig: true,
    }));
    expect(workflow?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["skills.autonomy"],
      preserveUnrelatedConfig: true,
    }));
  });

  it("builds selected setup editor security and workflow drafts with reviewed values", () => {
    const decision = routeSetupEntryState(state("configured-ready"));
    if (decision.setupEditorPlanSession === undefined) {
      throw new Error("Expected setup editor plan session");
    }
    const securityAction = decision.setupEditorPlanSession.plan.actions.find((action) => action.id === "edit-security-mode");
    const workflowAction = decision.setupEditorPlanSession.plan.actions.find((action) => action.id === "edit-workflow-learning");
    if (securityAction === undefined || workflowAction === undefined) {
      throw new Error("Expected security and workflow editor actions");
    }

    const bundle = buildSetupEditorActionDraftBundle(decision.setupEditorPlanSession, [
      {
        ...securityAction,
        reviewValues: { securityMode: "strict" },
      },
      {
        ...workflowAction,
        reviewValues: { workflowLearning: "autonomous" },
      },
    ], {
      configPath: "/tmp/home/.estacoda/config.json",
    });

    expect(bundle.drafts.map((draft) => draft.review.summaryKey)).toEqual([
      "setupDrafts.securityMode.summary",
      "setupDrafts.workflowLearning.summary",
    ]);
    expect(bundle.drafts[0]?.review.values.securityMode).toBe("strict");
    expect(bundle.drafts[1]?.review.values.workflowLearning).toBe("autonomous");
  });

  it("builds guided provider repair drafts with route-shaped scopes", () => {
    const decision = routeSetupEntryState(state("configured-degraded"));
    if (decision.setupEditorPlanSession === undefined) {
      throw new Error("Expected setup editor plan session");
    }
    const action = decision.setupEditorPlanSession.plan.actions.find((candidate) => candidate.id === "repair-primary-provider");
    if (action === undefined) {
      throw new Error("Expected provider repair action");
    }

    const bundle = buildSetupEditorActionDraftBundle(decision.setupEditorPlanSession, [{
      ...action,
      reviewValues: {
        provider: "openai",
        model: "gpt-5.5",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        contextWindowTokens: 128000,
        apiMode: "custom_openai_compatible",
        authMethod: "api_key",
      },
    }], {
      configPath: "/tmp/home/.estacoda/config.json",
    });
    const draft = bundle.drafts[0];

    expect(draft?.kind).toBe("provider-model-route");
    expect(draft?.target).toEqual({
      kind: "config-scope",
      scope: ["provider.route"],
      path: "/tmp/home/.estacoda/config.json",
      preserveUnrelatedConfig: true,
    });
    expect(draft?.review.values).toEqual(expect.objectContaining({
      provider: "openai",
      model: "gpt-5.5",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      contextWindowTokens: 128000,
      apiMode: "custom_openai_compatible",
      authMethod: "api_key",
    }));
    expect(JSON.stringify(draft)).not.toContain("model.provider");
    expect(JSON.stringify(draft)).not.toContain("model.id");
    expect(JSON.stringify(draft)).not.toContain("providers.*.apiKeyEnv");
  });

  it("builds guided credential repair drafts with env refs only and route context", () => {
    const decision = routeSetupEntryState(state("missing-secret"));
    if (decision.setupEditorPlanSession === undefined) {
      throw new Error("Expected setup editor plan session");
    }
    const action = decision.setupEditorPlanSession.plan.actions.find((candidate) => candidate.id === "repair-missing-credential");
    if (action === undefined) {
      throw new Error("Expected credential repair action");
    }

    const bundle = buildSetupEditorActionDraftBundle(decision.setupEditorPlanSession, [{
      ...action,
      reviewValues: {
        provider: "openai",
        model: "gpt-5.5",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    }], {
      configPath: "/tmp/home/.estacoda/config.json",
    });
    const draft = bundle.drafts[0];
    const json = JSON.stringify(draft);

    expect(draft?.kind).toBe("credential-reference");
    expect(draft?.target).toEqual({
      kind: "config-scope",
      scope: ["provider.credentialReference"],
      path: "/tmp/home/.estacoda/config.json",
      preserveUnrelatedConfig: true,
    });
    expect(draft?.review.values).toEqual(expect.objectContaining({
      provider: "openai",
      model: "gpt-5.5",
      envVars: ["OPENAI_API_KEY"],
      credentialValuesIncluded: false,
    }));
    expect(json).not.toContain("sk-");
    expect(json).not.toContain("raw");
    expect(json).not.toContain("secretValue");
    expect(json).not.toContain("providers.*.apiKeyEnv");
  });

  it("builds internal provider credential reference drafts without exposing values", () => {
    const decision = routeSetupEntryState(state("configured-ready"));
    if (decision.setupEditorPlanSession === undefined) {
      throw new Error("Expected setup editor plan session");
    }

    const bundle = buildSetupEditorActionDraftBundle(decision.setupEditorPlanSession, [
      setupEditorAction({
        id: "store-provider-credential-reference",
        copyKey: "setupEditor.actions.storeProviderCredentialReference",
        sectionId: "credentials",
        effect: "draft-config-patch",
        readOnly: false,
        requiresExplicitApply: true,
        patch: scopedPatch(["provider.credentialReference"]),
        credentialRefs: [{ kind: "env", name: "OPENAI_API_KEY", value: "not-included" }],
        reviewValues: {
          provider: "openai",
          model: "gpt-5.5",
          apiKeyEnv: "OPENAI_API_KEY",
        },
      }),
    ], {
      configPath: "/tmp/home/.estacoda/config.json",
    });
    const draft = bundle.drafts[0];

    expect(draft?.kind).toBe("credential-reference");
    expect(draft?.review.values).toEqual(expect.objectContaining({
      provider: "openai",
      model: "gpt-5.5",
      envVars: ["OPENAI_API_KEY"],
      credentialValuesIncluded: false,
    }));
    expect(JSON.stringify(draft)).not.toContain("sk-");
  });

  it("builds fallback provider/model drafts scoped to model fallbacks", () => {
    const decision = routeSetupEntryState(state("configured-ready"));
    if (decision.setupEditorPlanSession === undefined) {
      throw new Error("Expected setup editor plan session");
    }

    const bundle = buildSetupEditorActionDraftBundle(decision.setupEditorPlanSession, [
      setupEditorAction({
        id: "edit-fallback-model-route",
        copyKey: "setupEditor.actions.editFallbackModelRoute",
        sectionId: "model-route",
        effect: "draft-config-patch",
        readOnly: false,
        requiresExplicitApply: true,
        patch: scopedPatch(["model.fallbacks"]),
        reviewValues: {
          fallbackOperation: "add",
          provider: "openai",
          model: "gpt-5.5",
        },
      }),
    ], {
      configPath: "/tmp/home/.estacoda/config.json",
    });
    const draft = bundle.drafts[0];

    expect(draft?.kind).toBe("fallback-model-route");
    expect(draft?.target).toEqual({
      kind: "config-scope",
      scope: ["model.fallbacks"],
      path: "/tmp/home/.estacoda/config.json",
      preserveUnrelatedConfig: true,
    });
    expect(draft?.review.summaryKey).toBe("setupDrafts.fallbackModelRoute.add.summary");
  });

  it("enforces fallback provider/model draft scope over caller patch fields", () => {
    const decision = routeSetupEntryState(state("configured-ready"));
    if (decision.setupEditorPlanSession === undefined) {
      throw new Error("Expected setup editor plan session");
    }

    const bundle = buildSetupEditorActionDraftBundle(decision.setupEditorPlanSession, [
      setupEditorAction({
        id: "edit-fallback-model-route",
        copyKey: "setupEditor.actions.editFallbackModelRoute",
        sectionId: "model-route",
        effect: "draft-config-patch",
        readOnly: false,
        requiresExplicitApply: true,
        patch: scopedPatch(["security.approvalMode"]),
        reviewValues: {
          fallbackOperation: "add",
          provider: "openai",
          model: "gpt-5.5",
        },
      }),
    ], {
      configPath: "/tmp/home/.estacoda/config.json",
    });

    expect(bundle.drafts[0]?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["model.fallbacks"],
    }));
  });

  it("builds auxiliary provider/model drafts scoped to auxiliary models", () => {
    const decision = routeSetupEntryState(state("configured-ready"));
    if (decision.setupEditorPlanSession === undefined) {
      throw new Error("Expected setup editor plan session");
    }

    const bundle = buildSetupEditorActionDraftBundle(decision.setupEditorPlanSession, [
      setupEditorAction({
        id: "edit-auxiliary-model-route",
        copyKey: "setupEditor.actions.editAuxiliaryModelRoute",
        sectionId: "model-route",
        effect: "draft-config-patch",
        readOnly: false,
        requiresExplicitApply: true,
        patch: scopedPatch(["auxiliaryModels.*"]),
        reviewValues: {
          auxiliaryTask: "compression",
          provider: "openai",
          model: "gpt-5.5",
        },
      }),
    ], {
      configPath: "/tmp/home/.estacoda/config.json",
    });
    const draft = bundle.drafts[0];

    expect(draft?.kind).toBe("auxiliary-model-route");
    expect(draft?.target).toEqual({
      kind: "config-scope",
      scope: ["auxiliaryModels.*"],
      path: "/tmp/home/.estacoda/config.json",
      preserveUnrelatedConfig: true,
    });
    expect(draft?.review.summaryKey).toBe("setupDrafts.auxiliaryModelRoute.summary");
  });

  it("enforces auxiliary provider/model draft scope over caller patch fields", () => {
    const decision = routeSetupEntryState(state("configured-ready"));
    if (decision.setupEditorPlanSession === undefined) {
      throw new Error("Expected setup editor plan session");
    }

    const bundle = buildSetupEditorActionDraftBundle(decision.setupEditorPlanSession, [
      setupEditorAction({
        id: "edit-auxiliary-model-route",
        copyKey: "setupEditor.actions.editAuxiliaryModelRoute",
        sectionId: "model-route",
        effect: "draft-config-patch",
        readOnly: false,
        requiresExplicitApply: true,
        patch: scopedPatch(["model.fallbacks"]),
        reviewValues: {
          auxiliaryTask: "compression",
          provider: "openai",
          model: "gpt-5.5",
        },
      }),
    ], {
      configPath: "/tmp/home/.estacoda/config.json",
    });

    expect(bundle.drafts[0]?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["auxiliaryModels.*"],
    }));
  });

  it("keeps primary provider/model draft scope controlled by the action patch", () => {
    const decision = routeSetupEntryState(state("configured-ready"));
    if (decision.setupEditorPlanSession === undefined) {
      throw new Error("Expected setup editor plan session");
    }

    const bundle = buildSetupEditorActionDraftBundle(decision.setupEditorPlanSession, [
      setupEditorAction({
        id: "edit-primary-model-route",
        copyKey: "setupEditor.actions.editPrimaryModelRoute",
        sectionId: "model-route",
        effect: "draft-config-patch",
        readOnly: false,
        requiresExplicitApply: true,
        patch: scopedPatch(["model.provider", "model.id"]),
        reviewValues: {
          provider: "openai",
          model: "gpt-5.5",
        },
      }),
    ], {
      configPath: "/tmp/home/.estacoda/config.json",
    });

    expect(bundle.drafts[0]?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["model.provider", "model.id"],
    }));
  });

  it("keeps optional capability drafts independent and skippable", () => {
    const bundle = buildOnboardingWizardDraftBundle(onboardingWizardState({
      optionalCapabilities: {
        selected: [],
        channels: { telegram: "not_set" },
        voice: { stt: "not_set", tts: "not_set" },
        browser: "not_set",
      },
      optionalCapabilityDrafts: [],
    }));

    expect(bundle.drafts.some((candidate) => candidate.kind === "optional-capability")).toBe(false);
  });

  it("keeps verification drafts read-only", () => {
    const draft = onboardingBundle().drafts.find((candidate) => candidate.kind === "verification");

    expect(draft?.readOnly).toBe(true);
    expect(draft?.target).toEqual({ kind: "verification", readOnly: true });
    expect(draft?.applyIntent.effect).toBe("verification");
  });

  it("blocks unsafe normal apply drafts for broken config", () => {
    const decision = routeSetupEntryState(state("broken-config", { error: "Unexpected token" }));
    if (decision.setupEditorPlanSession === undefined) {
      throw new Error("Expected setup editor plan session");
    }
    const bundle = buildSetupEditorDraftBundle(decision.setupEditorPlanSession, {
      configPath: "/tmp/home/.estacoda/config.json",
    });

    expect(bundle.safeToApplyLater).toBe(false);
    expect(bundle.drafts.some((draft) => draft.kind === "diagnostic-blocker")).toBe(true);
    expect(bundle.drafts.some((draft) => draft.kind === "provider-model-route")).toBe(false);
    expect(bundle.drafts.some((draft) => draft.target.kind === "config-scope")).toBe(false);
  });

  it("blocks unsafe normal apply drafts for state-not-writable", () => {
    const decision = routeSetupEntryState(state("state-not-writable"));
    if (decision.setupEditorPlanSession === undefined) {
      throw new Error("Expected setup editor plan session");
    }
    const bundle = buildSetupEditorDraftBundle(decision.setupEditorPlanSession, {
      configPath: "/tmp/home/.estacoda/config.json",
    });

    expect(bundle.safeToApplyLater).toBe(false);
    expect(bundle.drafts.map((draft) => draft.id)).toContain("setup-editor.config-safety.repair-state-directory");
    expect(bundle.drafts.some((draft) => draft.kind === "provider-model-route")).toBe(false);
    expect(bundle.drafts.some((draft) => draft.target.kind === "config-scope")).toBe(false);
  });

  it("does not reintroduce backupForMain", () => {
    expect(JSON.stringify(onboardingBundle())).not.toContain("backupForMain");
  });

  it("does not introduce terminal rendering fields", () => {
    const bundle = onboardingBundle();
    const json = JSON.stringify(bundle);

    expect(json).not.toContain("\u001b[");
    expect(json).not.toContain("Press Enter");
    expect(json).not.toContain("Use ↑/↓");
    assertNoRenderingFields(bundle);
  });

  it("does not create config or state files during draft creation", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-setup-drafts-"));
    const workspaceRoot = join(homeDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    buildOnboardingWizardDraftBundle(onboardingWizardState({
      workspace: {
        path: workspaceRoot,
        trustStatus: "trusted",
      },
    }), {
      configPath: join(homeDir, ".estacoda", "config.json"),
      workspaceRoot,
      trustStorePath: join(homeDir, ".estacoda", "trust.json"),
    });

    expect(existsSync(join(homeDir, ".estacoda"))).toBe(false);
  });
});

function assertNoRenderingFields(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    expect(["title", "body", "render", "terminal", "promptCard"].includes(key)).toBe(false);
    assertNoRenderingFields(nested);
  }
}
