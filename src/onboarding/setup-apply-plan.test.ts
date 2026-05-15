import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SetupDraft, SetupDraftBundle } from "./setup-drafts.js";
import { buildFirstRunDraftBundle } from "./setup-drafts.js";
import {
  buildSetupModuleDraftBundle,
  type SetupModuleContext,
} from "./setup-modules.js";
import {
  buildSetupReviewManifest,
  type SetupReviewManifest,
} from "./setup-review-manifest.js";
import type { FirstRunPlanSession } from "./setup-router.js";
import type { SetupVerificationReport } from "./verification.js";
import {
  executeSetupApplyPlan,
  planSetupApply,
  type SetupApplyExecutor,
} from "./setup-apply-plan.js";

function firstRunManifest(overrides: {
  readonly launchSelected?: boolean;
  readonly verifySelected?: boolean;
  readonly configPath?: string;
  readonly workspaceRoot?: string;
  readonly trustStorePath?: string;
} = {}): SetupReviewManifest {
  const workspaceRoot = overrides.workspaceRoot ?? "/tmp/workspace";
  const trustStorePath = overrides.trustStorePath ?? "/tmp/home/.estacoda/trust.json";
  return buildSetupReviewManifest([
    buildFirstRunDraftBundle({
      plan: {
        selections: {
          workspaceRoot,
          workspaceTrusted: true,
          primaryProvider: "openai",
          primaryModel: "gpt-4.1-mini",
          primaryCredential: { kind: "env", name: "OPENAI_API_KEY" },
          securityMode: "adaptive",
          workflowLearning: "suggest",
          optionalCapabilitiesSkipped: true,
          verifySelected: overrides.verifySelected ?? true,
          launchSelected: overrides.launchSelected ?? true,
        },
      },
    } as FirstRunPlanSession, {
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

describe("setup apply plan", () => {
  it("approved manifest produces a dry-run save/apply plan", () => {
    const result = planSetupApply({
      kind: "approved-review-result",
      manifest: firstRunManifest(),
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
      "launch-handoff",
    ]));
    expect(result.applyPlan.verificationRequest).toEqual(expect.objectContaining({
      kind: "post-save-verification-request",
      readOnly: true,
    }));
    expect(result.applyPlan.launchHandoffIntent).toEqual(expect.objectContaining({
      kind: "launch-handoff-intent",
      preference: "offer-after-verify",
      requiresVerifiedReadyOrAcceptedDegraded: true,
    }));
  });

  it("cancelled review produces no apply plan", () => {
    const result = planSetupApply({
      kind: "cancelled-review-result",
      manifest: firstRunManifest(),
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
      manifest: firstRunManifest(),
    });

    expect(result.kind).toBe("cancelled");
    expect(JSON.stringify(result)).not.toContain("workspace-trust-grant");
    expect(JSON.stringify(result)).not.toContain("trust-store");
  });

  it("save failure does not continue to verify or launch", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: firstRunManifest(),
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

  it("verified-ready can produce launch handoff intent", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: firstRunManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");

    const endState = await executeSetupApplyPlan(planned.applyPlan, executorWithVerification(verificationReport()));

    expect(endState.kind).toBe("launched");
    if (endState.kind !== "launched") throw new Error("expected launch");
    expect(endState.acceptedDegraded).toBe(false);
    expect(endState.launchHandoffIntent.preference).toBe("offer-after-verify");
  });

  it("verified-ready can defer launch handoff for an explicit editor choice", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: firstRunManifest(),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");

    const endState = await executeSetupApplyPlan(
      planned.applyPlan,
      executorWithVerification(verificationReport()),
      { allowAutomaticLaunch: false }
    );

    expect(endState.kind).toBe("verified-ready");
    if (endState.kind !== "verified-ready") throw new Error("expected verified ready");
    expect(endState.launchHandoffIntent?.preference).toBe("offer-after-verify");
  });

  it("verified-degraded requires explicit continue or limited-mode decision", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: firstRunManifest(),
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

  it("accepted degraded verification may launch in explicit limited mode", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: firstRunManifest(),
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

    expect(endState.kind).toBe("launched");
    if (endState.kind !== "launched") throw new Error("expected launch");
    expect(endState.acceptedDegraded).toBe(true);
  });

  it("degraded verification does not launch when automatic handoff is disabled", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: firstRunManifest(),
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
      manifest: firstRunManifest(),
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

  it("saved-not-launched state is represented", async () => {
    const planned = planSetupApply({
      kind: "approved-review-result",
      manifest: firstRunManifest({ launchSelected: false }),
    });
    if (planned.kind !== "apply-plan-ready") throw new Error("expected apply plan");

    const endState = await executeSetupApplyPlan(planned.applyPlan, executorWithVerification(verificationReport()));

    expect(endState.kind).toBe("saved-not-launched");
    if (endState.kind !== "saved-not-launched") throw new Error("expected saved-not-launched");
    expect(endState.launchHandoffIntent?.preference).toBe("skip-launch");
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
      manifest: firstRunManifest(),
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
      manifest: firstRunManifest(),
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
      manifest: firstRunManifest({ configPath, trustStorePath, workspaceRoot }),
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
      manifest: firstRunManifest(),
    });

    expect(JSON.stringify(result)).not.toContain("backupForMain");
  });
});

function executorWithVerification(report: SetupVerificationReport): SetupApplyExecutor {
  return {
    apply: (plan) => ({
      ok: true,
      appliedOperationIds: plan.operations.map((operation) => operation.id),
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

function credentialReferenceBundle(envVar: string, provider: string): SetupDraftBundle {
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
