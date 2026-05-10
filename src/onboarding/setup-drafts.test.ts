import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderDiagnostic } from "../config/provider-diagnostics.js";
import type { SetupEntryRecommendedAction, SetupEntryState, SetupEntryStateKind } from "./setup-entry-state.js";
import type { SetupVerificationReport } from "./verification.js";
import { routeSetupEntryState } from "./setup-router.js";
import { buildFirstRunDraftBundle, buildSetupEditorDraftBundle, type SetupDraftBundle } from "./setup-drafts.js";

function providerDiagnostic(status: ProviderDiagnostic["status"] = "ready"): ProviderDiagnostic {
  return {
    status,
    lines: ["Selected route: local/hermes-local"],
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
      user: "/tmp/home/.estacoda/config.json",
      project: "/tmp/workspace/.estacoda/config.json",
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
      id: kind === "new-user" ? "unconfigured" : "hermes-local",
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

function firstRunBundle(): SetupDraftBundle {
  const decision = routeSetupEntryState(state("new-user"), {
    firstRunSelections: {
      workspaceRoot: "/tmp/workspace",
      workspaceTrusted: true,
      primaryProvider: "openai",
      primaryModel: "gpt-4.1-mini",
      primaryCredential: { kind: "env", name: "OPENAI_API_KEY" },
      securityMode: "adaptive",
      workflowLearning: "suggest",
      optionalCapabilities: [],
      optionalCapabilitiesSkipped: true,
      verifySelected: true,
      launchSelected: false,
    },
  });
  if (decision.firstRunPlanSession === undefined) {
    throw new Error("Expected first-run plan session");
  }
  return buildFirstRunDraftBundle(decision.firstRunPlanSession, {
    configPath: "/tmp/home/.estacoda/config.json",
    workspaceRoot: "/tmp/workspace",
    trustStorePath: "/tmp/home/.estacoda/trust.json",
  });
}

describe("setup draft bundles", () => {
  it("builds first-run draft bundles without mutation", () => {
    const bundle = firstRunBundle();

    expect(bundle.kind).toBe("setup-draft-bundle");
    expect(bundle.sourceKind).toBe("first-run-plan-session");
    expect(bundle.drafts.map((draft) => draft.kind)).toEqual([
      "provider-model-route",
      "credential-reference",
      "security-mode",
      "workflow-learning",
      "workspace-trust",
      "optional-capability",
      "verification",
      "launch-handoff",
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

  it("creates provider/model drafts with scoped target and preserveUnrelatedConfig", () => {
    const draft = firstRunBundle().drafts.find((candidate) => candidate.kind === "provider-model-route");

    expect(draft?.target).toEqual({
      kind: "config-scope",
      scope: ["model.provider", "model.id"],
      path: "/tmp/home/.estacoda/config.json",
      preserveUnrelatedConfig: true,
    });
    expect(draft?.preserveUnrelatedConfig).toBe(true);
  });

  it("redacts credential drafts and shows env var refs only", () => {
    const draft = firstRunBundle().drafts.find((candidate) => candidate.kind === "credential-reference");
    const json = JSON.stringify(draft);

    expect(draft?.review.values.envVars).toEqual(["OPENAI_API_KEY"]);
    expect(draft?.review.values.credentialValuesIncluded).toBe(false);
    expect(json).not.toContain("sk-");
    expect(json).not.toContain("raw");
    expect(json).not.toContain("secretValue");
  });

  it("creates workspace trust drafts with exact paths without granting trust", () => {
    const draft = firstRunBundle().drafts.find((candidate) => candidate.kind === "workspace-trust");

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
    const bundle = firstRunBundle();
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

  it("keeps optional capability drafts independent and skippable", () => {
    const draft = firstRunBundle().drafts.find((candidate) => candidate.kind === "optional-capability");

    expect(draft?.requiresReview).toBe(false);
    expect(draft?.review.values.skipped).toBe(true);
    expect(draft?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["channels", "voice", "vision", "browser"],
      preserveUnrelatedConfig: true,
    }));
  });

  it("keeps verification drafts read-only", () => {
    const draft = firstRunBundle().drafts.find((candidate) => candidate.kind === "verification");

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

  it("does not reintroduce backupForMain", () => {
    expect(JSON.stringify(firstRunBundle())).not.toContain("backupForMain");
  });

  it("does not introduce terminal rendering fields", () => {
    const bundle = firstRunBundle();
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
    const decision = routeSetupEntryState(state("new-user"), {
      firstRunSelections: {
        workspaceRoot,
        workspaceTrusted: true,
        primaryProvider: "openai",
        primaryModel: "gpt-4.1-mini",
        primaryCredential: { kind: "env", name: "OPENAI_API_KEY" },
      },
    });

    if (decision.firstRunPlanSession === undefined) {
      throw new Error("Expected first-run plan session");
    }
    buildFirstRunDraftBundle(decision.firstRunPlanSession, {
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
