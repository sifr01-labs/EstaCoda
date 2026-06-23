import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SetupDraft, SetupDraftBundle } from "./setup-drafts.js";
import { buildOnboardingWizardDraftBundle } from "./setup-drafts.js";
import {
  buildSetupModuleDraftBundle,
  type SetupModuleContext,
} from "./setup-modules.js";
import {
  buildSetupReviewManifest,
  type SetupReviewManifest,
} from "./setup-review-manifest.js";
import type { OnboardingWizardState } from "./onboarding-wizard/state.js";
import type { SetupVerificationReport } from "./verification.js";
import {
  executeSetupApplyPlan,
  planSetupApply,
  type OptionalCapabilityApplyWarning,
  type SetupApplyExecutor,
} from "./setup-apply-plan.js";
import { renderSetupApplyEndState } from "./setup-prompts.js";

function onboardingManifest(overrides: {
  readonly configPath?: string;
  readonly workspaceRoot?: string;
  readonly trustStorePath?: string;
} = {}): SetupReviewManifest {
  const workspaceRoot = overrides.workspaceRoot ?? "/tmp/workspace";
  const trustStorePath = overrides.trustStorePath ?? "/tmp/home/.estacoda/trust.json";
  const state: OnboardingWizardState = {
    interfacePreferences: {
      language: "en",
      flavor: "standard",
      activityLabels: "en",
    },
    workspace: {
      path: workspaceRoot,
      trustStatus: "trusted",
    },
    primaryRoute: {
      provider: "openai",
      model: "gpt-4.1-mini",
    },
    credential: {
      status: "new_pending",
      envVarName: "OPENAI_API_KEY",
    },
    securityMode: "adaptive",
    agentEvolution: "suggest",
    optionalCapabilities: {
      selected: [],
      channels: { telegram: "not_set" },
      voice: { stt: "not_set", tts: "not_set" },
      browser: "not_set",
    },
    optionalCapabilityDrafts: [],
  };
  return buildSetupReviewManifest([
    buildOnboardingWizardDraftBundle(state, {
      configPath: overrides.configPath ?? "/tmp/home/.estacoda/config.json",
      workspaceRoot,
      trustStorePath,
    }),
  ]);
}

function moduleContext(overrides: SetupModuleContext = {}): SetupModuleContext {
  return {
    configPath: "/tmp/home/.estacoda/config.json",
    workspaceRoot: "/tmp/workspace",
    trustStorePath: "/tmp/home/.estacoda/trust.json",
    provider: {
      id: "openai",
      model: "gpt-4.1-mini",
      credentialEnv: "OPENAI_API_KEY",
    },
    credentials: {
      envVars: ["OPENAI_API_KEY"],
      values: {
        OPENAI_API_KEY: "sk-do-not-render",
      },
    },
    workspaceTrust: {
      trusted: true,
    },
    securityMode: "adaptive",
    workflowLearning: "suggest",
    ...overrides,
  };
}

function verificationReport(overrides: Partial<SetupVerificationReport> = {}): SetupVerificationReport {
  return {
    stateWritable: true,
    envFilePresent: true,
    envFileMode: "600",
    envFileSecure: true,
    workspaceTrusted: true,
    securityModeLabel: "Adaptive",
    securityModeValue: "adaptive",
    skillAutonomyLabel: "Suggest",
    skillAutonomyValue: "suggest",
    providerDiagnostic: {
      status: "ready",
      lines: ["Provider status: ready"],
      warnings: [],
    },
    toolStatus: "ready",
    configSources: ["/tmp/home/.estacoda/config.json"],
    warnings: [],
    issueCodes: [],
    ...overrides,
  };
}

const localSttWarning: OptionalCapabilityApplyWarning = {
  operationId: "apply.voice.stt",
  capability: "voice",
  subCapability: "stt",
  code: "managed_python_setup_failed",
  message: "Setup completed, but local faster-whisper STT was skipped.",
  cause: "ensurepip is not available",
};

describe("setup apply plan", () => {
  it("approved manifest produces a dry-run save/apply plan", () => {
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });

    expect(result.kind).toBe("apply-plan-ready");
    if (result.kind !== "apply-plan-ready") throw new Error("expected apply plan");
    expect(result.applyPlan.kind).toBe("setup-save-apply-plan");
    expect(result.applyPlan.dryRunOnly).toBe(true);
    expect(result.applyPlan.writesConfig).toBe(false);
    expect(result.applyPlan.writesTrustStore).toBe(false);
    expect(result.applyPlan.operations.map((operation) => operation.kind)).toEqual(expect.arrayContaining([
      "config-patch",
      "credential-reference",
      "workspace-trust-grant",
      "verification-request",
    ]));
    expect(result.applyPlan.verificationRequest).toEqual(expect.objectContaining({
      kind: "post-save-verification-request",
      readOnly: true,
    }));
    expect(result.applyPlan.launchHandoffIntent).toBeUndefined();
  });

  it("cancelled review produces no apply plan", () => {
    const result = planSetupApply({
      kind: "cancelled-review-result",
      manifest: onboardingManifest(),
      reason: "user-cancelled-review",
    });

    expect(result.kind).toBe("cancelled");
    if (result.kind !== "cancelled") throw new Error("expected cancelled");
    expect(result.applyPlan).toBeUndefined();
    expect(result.endState.kind).toBe("cancelled");
    expect(result.endState.launchHandoffIntent).toBeUndefined();
  });

  it("blocker manifest prevents a normal apply plan", () => {
    const manifest = buildSetupReviewManifest([diagnosticBundle("Manual review required before apply.")]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("blocked");
    expect(result.applyPlan).toBeUndefined();
    expect(result.eligibility.blockers).toContain("Manual review required before apply.");
  });

  it("missing credential blocks apply and routes to credential repair", () => {
    const manifest = buildSetupReviewManifest([
      buildSetupModuleDraftBundle(moduleContext({
        provider: {
          id: "openai",
          model: "gpt-4.1-mini",
        },
        credentials: {
          envVars: [],
        },
      })),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("blocked");
    expect(result.eligibility.blockers.join("\n")).toContain("credential");
    expect(result.eligibility.repairIntents.map((intent) => intent.kind)).toContain("credential-repair");
  });

  it("does not suppress a credential blocker with a mismatched env ref", () => {
    const manifest = buildSetupReviewManifest([
      blockerOnlyBundle("Missing credential env OPENAI_API_KEY."),
      credentialReferenceBundle("ANTHROPIC_API_KEY", "anthropic"),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("blocked");
    expect(result.eligibility.blockers).toContain("Missing credential env OPENAI_API_KEY.");
  });

  it("suppresses a credential blocker with an exact matching env ref", () => {
    const manifest = buildSetupReviewManifest([
      blockerOnlyBundle("Missing credential env OPENAI_API_KEY."),
      credentialReferenceBundle("OPENAI_API_KEY", "openai"),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("apply-plan-ready");
  });

  it("suppresses an incomplete provider setup blocker when the manifest includes a complete provider route", () => {
    const manifest = buildSetupReviewManifest([
      blockerOnlyBundle("Provider setup is incomplete."),
      providerModelRouteBundle("openai", "gpt-5.5"),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("apply-plan-ready");
  });

  it("keeps incomplete provider setup blocked when the provider route is not complete", () => {
    const manifest = buildSetupReviewManifest([
      blockerOnlyBundle("Provider setup is incomplete."),
      providerModelRouteBundle("unconfigured", "unconfigured"),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("blocked");
    expect(result.eligibility.blockers).toContain("Provider setup is incomplete.");
  });

  it("suppresses provider module route blockers when the manifest includes a complete provider route", () => {
    const manifest = buildSetupReviewManifest([
      blockerOnlyBundle("Primary provider and model are required."),
      providerModelRouteBundle("kimi", "kimi-k2.5"),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("apply-plan-ready");
  });

  it("keeps hosted credential-required blockers blocked with a hosted route only", () => {
    const manifest = buildSetupReviewManifest([
      blockerOnlyBundle("Hosted providers require a credential environment-variable reference."),
      providerModelRouteBundle("openai", "gpt-5.5"),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("blocked");
    expect(result.eligibility.blockers).toContain("Hosted providers require a credential environment-variable reference.");
  });

  it("suppresses hosted credential-required blockers with a same-provider credential reference", () => {
    const manifest = buildSetupReviewManifest([
      blockerOnlyBundle("Hosted providers require a credential environment-variable reference."),
      providerModelRouteBundle("openai", "gpt-5.5"),
      credentialReferenceBundle("OPENAI_API_KEY", "openai"),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("apply-plan-ready");
  });

  it("suppresses hosted credential-required blockers with a reviewed Codex OAuth credential", () => {
    const manifest = buildSetupReviewManifest([
      blockerOnlyBundle("Hosted providers require a credential environment-variable reference."),
      providerModelRouteBundle("codex", "gpt-5.5", {
        authMethod: "oauth_device_pkce",
        oauthCredentialStatus: "pending",
      }),
      oauthCredentialReferenceBundle("codex", "oauth_device_pkce", "pending"),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("apply-plan-ready");
    if (result.kind !== "apply-plan-ready") throw new Error("expected apply plan");
    expect(result.applyPlan.operations.some((operation) =>
      operation.kind === "credential-reference" &&
      operation.review.values.credentialSurface === "oauth"
    )).toBe(true);
  });

  it("keeps hosted credential-required blockers blocked with a provider-unspecified credential reference", () => {
    const manifest = buildSetupReviewManifest([
      blockerOnlyBundle("Hosted providers require a credential environment-variable reference."),
      providerModelRouteBundle("openai", "gpt-5.5"),
      credentialReferenceBundle("OPENAI_API_KEY"),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("blocked");
    expect(result.eligibility.blockers).toContain("Hosted providers require a credential environment-variable reference.");
  });

  it("does not suppress hosted credential-required blockers with a different-provider credential reference", () => {
    const manifest = buildSetupReviewManifest([
      blockerOnlyBundle("Hosted providers require a credential environment-variable reference."),
      providerModelRouteBundle("openai", "gpt-5.5"),
      credentialReferenceBundle("ANTHROPIC_API_KEY", "anthropic"),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("blocked");
    expect(result.eligibility.blockers).toContain("Hosted providers require a credential environment-variable reference.");
  });

  it("suppresses stale hosted credential-required blockers when the manifest switches to a local provider", () => {
    const manifest = buildSetupReviewManifest([
      blockerOnlyBundle("Hosted providers require a credential environment-variable reference."),
      providerModelRouteBundle("local", "ollama/auto"),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("apply-plan-ready");
  });

  it("suppresses stale hosted credential-required blockers for local providers even with provider-unspecified credential refs", () => {
    const manifest = buildSetupReviewManifest([
      blockerOnlyBundle("Hosted providers require a credential environment-variable reference."),
      providerModelRouteBundle("local", "ollama/auto"),
      credentialReferenceBundle("OPENAI_API_KEY"),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("apply-plan-ready");
  });

  it("keeps broken config blockers unresolved even with valid provider and credential drafts", () => {
    const manifest = buildSetupReviewManifest([
      blockerOnlyBundle("Broken config blocks normal apply planning."),
      providerModelRouteBundle("openai", "gpt-5.5"),
      credentialReferenceBundle("OPENAI_API_KEY", "openai"),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("blocked");
    expect(result.eligibility.blockers).toContain("Broken config blocks normal apply planning.");
  });

  it("keeps state-not-writable blockers unresolved even with valid provider and credential drafts", () => {
    const manifest = buildSetupReviewManifest([
      blockerOnlyBundle("EstaCoda state directory is not writable."),
      providerModelRouteBundle("openai", "gpt-5.5"),
      credentialReferenceBundle("OPENAI_API_KEY", "openai"),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("blocked");
    expect(result.eligibility.blockers).toContain("EstaCoda state directory is not writable.");
  });

  it("keeps generic credential blockers blocked when no exact env match is available", () => {
    const manifest = buildSetupReviewManifest([
      blockerOnlyBundle("Missing credential for the active provider."),
      credentialReferenceBundle("OPENAI_API_KEY", "openai"),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("blocked");
    expect(result.eligibility.blockers).toContain("Missing credential for the active provider.");
  });

  it("broken config blocks normal apply", () => {
    const manifest = buildSetupReviewManifest([
      buildSetupModuleDraftBundle(moduleContext({ brokenConfig: true })),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(manifest.suppressedNormalWrites).toEqual([{
      bundleId: "setup-modules",
      reason: "broken-config",
    }]);
    expect(result.kind).toBe("blocked");
    expect(result.eligibility.blockers).toContain("Broken config blocks normal apply planning.");
    expect(result.eligibility.repairIntents.map((intent) => intent.kind)).toContain("config-repair");
  });

  it("state-not-writable diagnostic repair blocks normal apply", () => {
    const manifest = buildSetupReviewManifest([
      diagnosticBundle("EstaCoda state directory is not writable."),
    ]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });

    expect(result.kind).toBe("blocked");
    expect(result.applyPlan).toBeUndefined();
    expect(result.eligibility.blockers).toContain("Unsafe diagnostic-only config repair blocks normal apply planning.");
    expect(result.eligibility.blockers).toContain("EstaCoda state directory is not writable.");
  });

  it("workspace trust is not granted on cancellation", () => {
    const result = planSetupApply({
      kind: "cancelled-review-result",
      manifest: onboardingManifest(),
    });

    expect(result.kind).toBe("cancelled");
    expect(JSON.stringify(result)).not.toContain("workspace-trust-grant");
    expect(JSON.stringify(result)).not.toContain("trust-store");
  });

  it("save failure does not continue to verify or launch", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");
    let verifyCalls = 0;
    const endState = await executeSetupApplyPlan(planned.applyPlan, {
      apply: () => ({
        ok: false,
        appliedOperationIds: [],
        error: "Config writer unavailable.",
      }),
      verify: () => {
        verifyCalls += 1;
        return verificationReport();
      },
    });

    expect(endState.kind).toBe("blocked");
    if (endState.kind !== "blocked") throw new Error("expected blocked");
    expect(endState.reason).toBe("save-failed");
    expect(verifyCalls).toBe(0);
    expect(endState.launchHandoffIntent).toBeUndefined();
  });

  it("firstRunTolerant mode does not tolerate save failures yet", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");
    let verifyCalls = 0;

    const endState = await executeSetupApplyPlan(planned.applyPlan, {
      apply: () => ({
        ok: false,
        appliedOperationIds: [],
        error: "Config writer unavailable.",
        warnings: [localSttWarning],
      }),
      verify: () => {
        verifyCalls += 1;
        return verificationReport();
      },
    }, {
      mode: "firstRunTolerant",
    });

    expect(endState.kind).toBe("blocked");
    if (endState.kind !== "blocked") throw new Error("expected blocked");
    expect(endState.reason).toBe("save-failed");
    expect(endState.blockers).toEqual(["Config writer unavailable."]);
    expect(verifyCalls).toBe(0);
    expect("warnings" in endState).toBe(false);
  });

  it("does not apply deferred secrets when the reviewed save fails", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");
    let deferredSecretCalls = 0;

    const endState = await executeSetupApplyPlan(planned.applyPlan, {
      apply: () => ({
        ok: false,
        appliedOperationIds: [],
        error: "Config writer unavailable.",
      }),
      applyDeferredSecrets: () => {
        deferredSecretCalls += 1;
        return {
          ok: true,
          appliedSecretCount: 1,
        };
      },
    }, {
      deferredSecretWrites: [{ envVarName: "OPENAI_API_KEY", value: "sk-not-written" }],
    });

    expect(endState.kind).toBe("blocked");
    expect(deferredSecretCalls).toBe(0);
  });

  it("reports verification failure honestly after deferred secret persistence", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");

    const endState = await executeSetupApplyPlan(planned.applyPlan, {
      apply: () => ({
        ok: true,
        appliedOperationIds: planned.applyPlan.operations.map((operation) => operation.id),
      }),
      applyDeferredSecrets: () => ({
        ok: true,
        appliedSecretCount: 1,
      }),
      verify: () => verificationReport({
        workspaceTrusted: false,
        warnings: ["Workspace is not trusted yet"],
        issueCodes: ["workspace-not-trusted"],
      }),
    }, {
      deferredSecretWrites: [{ envVarName: "OPENAI_API_KEY", value: "sk-persisted-before-verify" }],
    });

    expect(endState.kind).toBe("blocked");
    if (endState.kind !== "blocked") throw new Error("expected blocked");
    expect(endState.reason).toBe("verification-blocked");
    expect(endState.persistedSecretCount).toBe(1);
    expect(renderSetupApplyEndState(endState, "en")).toBe(
      "Setup was saved, including credential persistence, but verification failed because of Workspace is not trusted yet. No rollback was performed."
    );
  });

  it("verified-ready is represented after reviewed apply and verification", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");

    const endState = await executeSetupApplyPlan(planned.applyPlan, executorWithVerification(verificationReport()));

    expect(endState.kind).toBe("verified-ready");
    if (endState.kind !== "verified-ready") throw new Error("expected verified ready");
    expect(endState.launchHandoffIntent).toBeUndefined();
  });

  it("empty apply warnings do not change successful end-state shape", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");

    const endState = await executeSetupApplyPlan(
      planned.applyPlan,
      executorWithVerification(verificationReport(), [])
    );

    expect(endState.kind).toBe("verified-ready");
    if (endState.kind !== "verified-ready") throw new Error("expected verified ready");
    expect(endState.warnings).toBeUndefined();
  });

  it("preserves structured apply warnings on verified-ready end states", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");

    const endState = await executeSetupApplyPlan(
      planned.applyPlan,
      executorWithVerification(verificationReport(), [localSttWarning])
    );

    expect(endState.kind).toBe("verified-ready");
    if (endState.kind !== "verified-ready") throw new Error("expected verified ready");
    expect(endState.warnings).toEqual([localSttWarning]);
  });

  it("verified-degraded requires explicit continue or limited-mode decision", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");
    const degradedReport = verificationReport({
      providerDiagnostic: {
        status: "warning",
        lines: ["Provider status: warning"],
        warnings: ["Configured model context window is below 64K tokens."],
      },
      warnings: ["Configured model context window is below 64K tokens."],
      issueCodes: ["small-context-window"],
    });

    const endState = await executeSetupApplyPlan(planned.applyPlan, executorWithVerification(degradedReport));

    expect(endState.kind).toBe("verified-degraded");
    if (endState.kind !== "verified-degraded") throw new Error("expected degraded");
    expect(endState.requiresExplicitContinueDecision).toBe(true);
    expect(endState.launchHandoffIntent).toBeUndefined();
  });

  it("preserves structured apply warnings on verified-degraded end states", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");
    const degradedReport = verificationReport({
      providerDiagnostic: {
        status: "warning",
        lines: ["Provider status: warning"],
        warnings: ["Configured model context window is below 64K tokens."],
      },
      warnings: ["Configured model context window is below 64K tokens."],
      issueCodes: ["small-context-window"],
    });

    const endState = await executeSetupApplyPlan(
      planned.applyPlan,
      executorWithVerification(degradedReport, [localSttWarning])
    );

    expect(endState.kind).toBe("verified-degraded");
    if (endState.kind !== "verified-degraded") throw new Error("expected degraded");
    expect(endState.warnings).toEqual([localSttWarning]);
  });

  it("accepted degraded verification saves without launching when no manifest launch intent exists", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");
    const endState = await executeSetupApplyPlan(
      planned.applyPlan,
      executorWithVerification(verificationReport({
        providerDiagnostic: {
          status: "warning",
          lines: ["Provider status: warning"],
          warnings: ["Network inference is disabled for the selected hosted provider."],
        },
        warnings: ["Network inference is disabled for the selected hosted provider."],
        issueCodes: ["network-disabled"],
      })),
      { acceptDegraded: true }
    );

    expect(endState.kind).toBe("saved-not-launched");
    if (endState.kind !== "saved-not-launched") throw new Error("expected saved-not-launched");
    expect(endState.verification).toBeDefined();
    expect(endState.launchHandoffIntent).toBeUndefined();
  });

  it("degraded verification does not launch when automatic handoff is disabled", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");
    const endState = await executeSetupApplyPlan(
      planned.applyPlan,
      executorWithVerification(verificationReport({
        providerDiagnostic: {
          status: "warning",
          lines: ["Provider status: warning"],
          warnings: ["Network inference is disabled for the selected hosted provider."],
        },
        warnings: ["Network inference is disabled for the selected hosted provider."],
        issueCodes: ["network-disabled"],
      })),
      { acceptDegraded: true, allowAutomaticLaunch: false }
    );

    expect(endState.kind).toBe("verified-degraded");
    if (endState.kind !== "verified-degraded") throw new Error("expected degraded");
    expect(endState.launchHandoffIntent).toBeUndefined();
  });

  it("blocked verification prevents automatic launch", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");

    const endState = await executeSetupApplyPlan(planned.applyPlan, executorWithVerification(verificationReport({
      stateWritable: false,
      warnings: ["State directory is not writable."],
      issueCodes: ["state-not-writable"],
    })));

    expect(endState.kind).toBe("blocked");
    if (endState.kind !== "blocked") throw new Error("expected blocked");
    expect(endState.reason).toBe("verification-blocked");
    expect(endState.launchHandoffIntent).toBeUndefined();
  });

  it("saved-not-launched state is represented when verification cannot run", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");

    const endState = await executeSetupApplyPlan(planned.applyPlan, {
      apply: () => ({
        ok: true,
        appliedOperationIds: planned.applyPlan.operations.map((operation) => operation.id),
      }),
    });

    expect(endState.kind).toBe("saved-not-launched");
    if (endState.kind !== "saved-not-launched") throw new Error("expected saved-not-launched");
    expect(endState.verification).toBeUndefined();
    expect(endState.launchHandoffIntent).toBeUndefined();
  });

  it("preserves structured apply warnings on saved-not-launched end states", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");

    const endState = await executeSetupApplyPlan(planned.applyPlan, {
      apply: (plan) => ({
        ok: true,
        appliedOperationIds: plan.operations.map((operation) => operation.id),
        warnings: [localSttWarning],
      }),
    });

    expect(endState.kind).toBe("saved-not-launched");
    if (endState.kind !== "saved-not-launched") throw new Error("expected saved-not-launched");
    expect(endState.warnings).toEqual([localSttWarning]);
  });

  it("preserves structured apply warnings on launched end states", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");
    const launchPlan = {
      ...planned.applyPlan,
      launchHandoffIntent: {
        kind: "launch-handoff-intent",
        sourceLineIds: ["launch"],
        preference: "offer-after-verify",
        requiresVerifiedReadyOrAcceptedDegraded: true,
      },
    } as const;

    const endState = await executeSetupApplyPlan(
      launchPlan,
      executorWithVerification(verificationReport(), [localSttWarning])
    );

    expect(endState.kind).toBe("launched");
    if (endState.kind !== "launched") throw new Error("expected launched");
    expect(endState.acceptedDegraded).toBe(false);
    expect(endState.warnings).toEqual([localSttWarning]);
  });

  it("raw secrets never appear in apply planning output", () => {
    const manifest = buildSetupReviewManifest([rawSecretBundle()]);
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest,
    });
    const json = JSON.stringify(result);

    expect(json).not.toContain("sk-do-not-render");
    expect(json).not.toContain("123456:do-not-render");
    expect(json).toContain("OPENAI_API_KEY");
  });

  it("unrelated config preservation is retained", () => {
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    if (result.kind !== "apply-plan-ready") throw new Error("expected apply plan");

    expect(result.applyPlan.preservesUnrelatedConfig).toBe(true);
    expect(result.applyPlan.operations
      .filter((operation) => operation.target?.kind === "config-scope")
      .every((operation) =>
        operation.preserveUnrelatedConfig === true &&
        operation.target?.kind === "config-scope" &&
        operation.target.preserveUnrelatedConfig === true
      )).toBe(true);
  });

  it("contains no terminal rendering fields", () => {
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });
    const json = JSON.stringify(result);

    expect(json).not.toContain("\u001b[");
    expect(json).not.toContain("Press Enter");
    expect(json).not.toContain("Use ↑/↓");
    assertNoRenderingFields(result);
  });

  it("does not mutate filesystem, config, or trust stores during planning or fake execution", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-setup-apply-plan-"));
    const configPath = join(homeDir, ".estacoda", "config.json");
    const trustStorePath = join(homeDir, ".estacoda", "trust.json");
    const workspaceRoot = join(homeDir, "workspace");
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest({ configPath, trustStorePath, workspaceRoot }),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");

    await executeSetupApplyPlan(planned.applyPlan, executorWithVerification(verificationReport()));

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(trustStorePath)).toBe(false);
    expect(existsSync(join(homeDir, ".estacoda"))).toBe(false);
  });

  it("does not reintroduce backupForMain", () => {
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest: onboardingManifest(),
    });

    expect(JSON.stringify(result)).not.toContain("backupForMain");
  });
});

function executorWithVerification(
  report: SetupVerificationReport,
  warnings?: readonly OptionalCapabilityApplyWarning[]
): SetupApplyExecutor {
  return {
    apply: (plan) => ({
      ok: true,
      appliedOperationIds: plan.operations.map((operation) => operation.id),
      ...(warnings === undefined ? {} : { warnings }),
    }),
    verify: () => report,
  };
}

function diagnosticBundle(blocker: string): SetupDraftBundle {
  const draft: SetupDraft = {
    id: "diagnostic.blocker",
    kind: "diagnostic-blocker",
    source: {
      kind: "setup-module",
      moduleId: "provider",
      actionId: "diagnostic-only",
    },
    riskSurface: "config-repair",
    target: { kind: "diagnostic-only" },
    review: {
      copyKey: "setupDrafts.review",
      summaryKey: "setupDrafts.diagnostic.summary",
      redacted: true,
      values: {},
    },
    applyIntent: {
      kind: "dry-run-apply-intent",
      effect: "diagnostic-only",
      dryRunOnly: true,
      writesConfig: false,
      writesTrustStore: false,
    },
    requiresReview: true,
    readOnly: true,
    blockers: [blocker],
    warnings: [],
  };
  return {
    kind: "setup-draft-bundle",
    sourceKind: "setup-module-session",
    sourceId: "diagnostic",
    drafts: [draft],
    blockers: [blocker],
    warnings: [],
    safeToApplyLater: false,
    metadata: {
      draftCount: 1,
      requiresReviewCount: 1,
      readOnlyCount: 1,
    },
  };
}

function blockerOnlyBundle(blocker: string): SetupDraftBundle {
  return {
    kind: "setup-draft-bundle",
    sourceKind: "setup-module-session",
    sourceId: `blocker:${blocker}`,
    drafts: [],
    blockers: [blocker],
    warnings: [],
    safeToApplyLater: true,
    metadata: {
      draftCount: 0,
      requiresReviewCount: 0,
      readOnlyCount: 0,
    },
  };
}

function providerModelRouteBundle(
  provider: string,
  model: string,
  values: Record<string, string | readonly string[] | boolean | number | undefined> = {}
): SetupDraftBundle {
  const draft: SetupDraft = {
    id: `provider-route.${provider}.${model}`,
    kind: "provider-model-route",
    source: {
      kind: "setup-editor",
      sectionId: "model-route",
      actionId: "repair-primary-provider",
    },
    riskSurface: "provider-selection",
    target: {
      kind: "config-scope",
      scope: ["provider.route"],
      path: "/tmp/home/.estacoda/config.json",
      preserveUnrelatedConfig: true,
    },
    review: {
      copyKey: "setupDrafts.review",
      summaryKey: "setupDrafts.providerModelRoute.summary",
      redacted: true,
      values: {
        provider,
        model,
        ...values,
      },
    },
    applyIntent: {
      kind: "dry-run-apply-intent",
      effect: "config-patch",
      dryRunOnly: true,
      writesConfig: false,
      writesTrustStore: false,
    },
    preserveUnrelatedConfig: true,
    requiresReview: true,
    readOnly: false,
    blockers: [],
    warnings: [],
  };
  return {
    kind: "setup-draft-bundle",
    sourceKind: "setup-editor-plan-session",
    sourceId: `provider-route:${provider}:${model}`,
    drafts: [draft],
    blockers: [],
    warnings: [],
    safeToApplyLater: true,
    metadata: {
      draftCount: 1,
      requiresReviewCount: 1,
      readOnlyCount: 0,
    },
  };
}

function oauthCredentialReferenceBundle(
  provider: string,
  authMethod: string,
  status: "ready" | "pending"
): SetupDraftBundle {
  const draft: SetupDraft = {
    id: `oauth-credential.${provider}.${authMethod}`,
    kind: "credential-reference",
    source: {
      kind: "setup-editor",
      sectionId: "credentials",
      actionId: "repair-missing-credential",
    },
    riskSurface: "credential-reference",
    target: {
      kind: "config-scope",
      scope: ["provider.credentialReference"],
      path: "/tmp/home/.estacoda/config.json",
      preserveUnrelatedConfig: true,
    },
    review: {
      copyKey: "setupDrafts.review",
      summaryKey: "setupDrafts.credentialReference.summary",
      redacted: true,
      values: {
        provider,
        credentialSurface: "oauth",
        authMethod,
        oauthCredentialStatus: status,
        credentialValuesIncluded: false,
      },
    },
    applyIntent: {
      kind: "dry-run-apply-intent",
      effect: "credential-reference",
      dryRunOnly: true,
      writesConfig: false,
      writesTrustStore: false,
    },
    preserveUnrelatedConfig: true,
    requiresReview: true,
    readOnly: false,
    blockers: [],
    warnings: [],
  };
  return {
    kind: "setup-draft-bundle",
    sourceKind: "setup-editor-plan-session",
    sourceId: `oauth-credential:${provider}:${authMethod}`,
    drafts: [draft],
    blockers: [],
    warnings: [],
    safeToApplyLater: true,
    metadata: {
      draftCount: 1,
      requiresReviewCount: 1,
      readOnlyCount: 0,
    },
  };
}

function credentialReferenceBundle(envVar: string, provider?: string): SetupDraftBundle {
  const draft: SetupDraft = {
    id: `credential.${envVar}`,
    kind: "credential-reference",
    source: {
      kind: "setup-editor",
      sectionId: "credentials",
      actionId: "repair-missing-credential",
    },
    riskSurface: "credential-reference",
    target: {
      kind: "config-scope",
      scope: ["provider.credentialReference"],
      path: "/tmp/home/.estacoda/config.json",
      preserveUnrelatedConfig: true,
    },
    review: {
      copyKey: "setupDrafts.review",
      summaryKey: "setupDrafts.credentialReference.summary",
      redacted: true,
      values: {
        provider,
        envVars: [envVar],
        credentialValuesIncluded: false,
      },
    },
    applyIntent: {
      kind: "dry-run-apply-intent",
      effect: "credential-reference",
      dryRunOnly: true,
      writesConfig: false,
      writesTrustStore: false,
    },
    preserveUnrelatedConfig: true,
    requiresReview: true,
    readOnly: false,
    blockers: [],
    warnings: [],
  };
  return {
    kind: "setup-draft-bundle",
    sourceKind: "setup-editor-plan-session",
    sourceId: `credential:${envVar}`,
    drafts: [draft],
    blockers: [],
    warnings: [],
    safeToApplyLater: true,
    metadata: {
      draftCount: 1,
      requiresReviewCount: 1,
      readOnlyCount: 0,
    },
  };
}

function rawSecretBundle(): SetupDraftBundle {
  const base = buildSetupModuleDraftBundle(moduleContext());
  const rawSecretDraft: SetupDraft = {
    ...base.drafts[0] as SetupDraft,
    id: "malicious.raw-secret",
    review: {
      copyKey: "setupDrafts.review",
      summaryKey: "setupDrafts.malicious.summary",
      redacted: true,
      values: {
        apiKey: "sk-do-not-render",
        botToken: "123456:do-not-render",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    },
  };
  return {
    ...base,
    drafts: [rawSecretDraft],
    blockers: [],
    safeToApplyLater: true,
  };
}

function assertNoRenderingFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoRenderingFields(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(key).not.toMatch(/^(terminal|rendered|renderedText|promptText|ansi|output)$/u);
    assertNoRenderingFields(child);
  }
}
