import { describe, expect, it } from "vitest";
import type { ProviderDiagnostic } from "../config/provider-diagnostics.js";
import type { SetupEntryRecommendedAction, SetupEntryState, SetupEntryStateKind } from "./setup-entry-state.js";
import type { SetupVerificationReport } from "./verification.js";
import { buildSetupEditorPlan, type SetupEditorPlan, type SetupEditorSectionId } from "./setup-editor-plan.js";

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
    issueCodes: kind === "configured-degraded" ? ["small-context-window"] : [],
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
    missingCredentials: kind === "missing-secret" ? { envVars: ["OPENAI_API_KEY"], providers: ["openai"] } : { envVars: [], providers: [] },
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

function sectionIds(plan: SetupEditorPlan): SetupEditorSectionId[] {
  return plan.sections.map((section) => section.id);
}

function section(plan: SetupEditorPlan, id: SetupEditorSectionId) {
  const found = plan.sections.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`Missing setup editor section ${id}`);
  }
  return found;
}

describe("buildSetupEditorPlan", () => {
  it("builds configured-ready editor sections for existing setup review", () => {
    const plan = buildSetupEditorPlan(state("configured-ready"));

    expect(plan.kind).toBe("guided-setup-editor-plan");
    expect(plan.name).toBe("Guided Setup Editor Architecture");
    expect(plan.mode).toBe("configured");
    expect(sectionIds(plan)).toEqual([
      "config-summary",
      "model-route",
      "credentials",
      "security-mode",
      "workflow-learning",
      "workspace-trust",
      "optional-capabilities",
      "verification",
      "exit",
    ]);
  });

  it("includes warnings and repair-oriented actions for configured-degraded setup", () => {
    const plan = buildSetupEditorPlan(state("configured-degraded"));
    const route = section(plan, "model-route");

    expect(plan.mode).toBe("configured-degraded");
    expect(plan.warnings).toContain("Configured model context window is below 64K tokens.");
    expect(route.status).toBe("warning");
    expect(route.actions[0]?.id).toBe("repair-primary-provider");
    expect(route.actions[0]?.patch?.fields).toEqual(["provider.route"]);
    expect(plan.actions.some((action) => action.id === "edit-primary-model-route")).toBe(true);
    expect(section(plan, "verification").actions[0]?.id).toBe("run-readonly-verification");
  });

  it("prioritizes repair actions for partial-provider setup", () => {
    const plan = buildSetupEditorPlan(state("partial-provider"));
    const route = section(plan, "model-route");

    expect(plan.mode).toBe("repair-first");
    expect(route.status).toBe("repair-required");
    expect(route.actions[0]?.id).toBe("repair-primary-provider");
    expect(route.actions[0]?.patch?.fields).toEqual(["provider.route"]);
    expect(route.actions[0]?.patch?.preserveUnrelatedConfig).toBe(true);
  });

  it("surfaces missing credential refs without raw secret values", () => {
    const plan = buildSetupEditorPlan(state("missing-secret"));
    const credentials = section(plan, "credentials");
    const repair = credentials.actions.find((action) => action.id === "repair-missing-credential");

    expect(credentials.status).toBe("repair-required");
    expect(repair?.patch?.fields).toEqual(["provider.credentialReference"]);
    expect(repair?.credentialRefs).toContainEqual({ kind: "env", name: "OPENAI_API_KEY", value: "not-included" });
    expect(JSON.stringify(repair)).not.toContain("sk-");
    expect(JSON.stringify(repair)).not.toContain("secretValue");
    expect(JSON.stringify(repair)).not.toContain("providers.*.apiKeyEnv");
  });

  it("keeps workspace trust separate and repairable", () => {
    const plan = buildSetupEditorPlan(state("untrusted-workspace"));
    const trust = section(plan, "workspace-trust");

    expect(plan.configSummary.providerReadiness).toBe("ready");
    expect(trust.status).toBe("repair-required");
    expect(trust.actions).toContainEqual(expect.objectContaining({
      id: "repair-workspace-trust",
      effect: "draft-trust-repair",
      mutatesConfig: false,
    }));
  });

  it("does not assume normal config editing is safe for broken config", () => {
    const plan = buildSetupEditorPlan(state("broken-config", { error: "Unexpected token" }));

    expect(plan.safeForNormalConfigEditing).toBe(false);
    expect(sectionIds(plan)).toEqual(["config-summary", "config-safety", "verification", "exit"]);
    expect(plan.actions.some((action) => action.id === "edit-primary-model-route")).toBe(false);
    expect(section(plan, "config-safety").actions[0]?.id).toBe("repair-broken-config");
  });

  it("does not build normal editor sections for state-not-writable", () => {
    const plan = buildSetupEditorPlan(state("state-not-writable"));

    expect(plan.safeForNormalConfigEditing).toBe(false);
    expect(sectionIds(plan)).toEqual(["config-summary", "config-safety", "verification", "exit"]);
    expect(plan.actions.some((action) => action.patch !== undefined)).toBe(false);
    expect(plan.actions.map((action) => action.id)).toEqual([
      "repair-state-directory",
      "run-readonly-verification",
      "cancel-setup-editor",
    ]);
    expect(section(plan, "config-safety").copyKey).toBe("setupEditor.sections.stateSafety");
    expect(section(plan, "config-safety").actions[0]).toEqual(expect.objectContaining({
      id: "repair-state-directory",
      effect: "diagnostic-only",
      readOnly: true,
    }));
  });

  it("keeps verification read-only", () => {
    const verify = section(buildSetupEditorPlan(state("configured-ready")), "verification").actions[0];

    expect(verify).toEqual(expect.objectContaining({
      id: "run-readonly-verification",
      readOnly: true,
      mutatesConfig: false,
      effect: "read-only-verification",
    }));
  });

  it("keeps action drafts declarative and non-mutating", () => {
    const plan = buildSetupEditorPlan(state("configured-ready"));

    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.actions.every((action) => action.kind === "setup-editor-action-draft")).toBe(true);
    expect(plan.actions.every((action) => action.mutatesConfig === false)).toBe(true);
    expect(plan.actions.every((action) => action.preservesUnrelatedConfig === true)).toBe(true);
  });

  it("preserves unrelated config fields by design in edit intents", () => {
    const plan = buildSetupEditorPlan(state("configured-ready"));
    const scopedPatches = plan.actions.flatMap((action) => action.patch ?? []);

    expect(plan.preservesUnrelatedConfig).toBe(true);
    expect(scopedPatches.length).toBeGreaterThan(0);
    expect(scopedPatches.every((patch) => patch.kind === "scoped-config-patch-intent")).toBe(true);
    expect(scopedPatches.every((patch) => patch.preserveUnrelatedConfig === true)).toBe(true);
  });

  it("carries current security and workflow values for guided editor defaults", () => {
    const plan = buildSetupEditorPlan(state("configured-ready"));
    const security = plan.actions.find((action) => action.id === "edit-security-mode");
    const workflow = plan.actions.find((action) => action.id === "edit-workflow-learning");

    expect(security?.reviewValues).toEqual({ securityMode: "adaptive" });
    expect(workflow?.reviewValues).toEqual({ workflowLearning: "suggest" });
  });

  it("represents optional capabilities as independent placeholders", () => {
    const capabilities = section(buildSetupEditorPlan(state("configured-ready")), "optional-capabilities");

    expect(capabilities.required).toBe(false);
    expect(capabilities.status).toBe("skipped");
    expect(capabilities.data).toEqual({
      independentlyReviewable: true,
      capabilities: ["channels", "voice", "vision", "browser"],
    });
    expect(capabilities.actions.map((action) => action.id)).toEqual([
      "configure-channels",
      "configure-voice",
      "configure-image-generation",
      "configure-browser",
    ]);
    expect(capabilities.actions.map((action) => action.patch?.fields)).toEqual([
      ["channels"],
      ["voice"],
      ["vision"],
      ["browser"],
    ]);
    expect(capabilities.actions.some((action) => action.id === "review-optional-capabilities")).toBe(false);
  });

  it("keeps split optional capability action ordering stable", () => {
    const plan = buildSetupEditorPlan(state("configured-ready"));

    expect(plan.actions.map((action) => action.id)).toEqual([
      "edit-primary-model-route",
      "edit-fallback-model-route",
      "edit-auxiliary-model-route",
      "edit-primary-credential-reference",
      "edit-security-mode",
      "edit-workflow-learning",
      "configure-channels",
      "configure-voice",
      "configure-image-generation",
      "configure-browser",
      "run-readonly-verification",
      "cancel-setup-editor",
    ]);
  });

  it("exposes fallback route editing as a scoped reviewed model route action", () => {
    const plan = buildSetupEditorPlan(state("configured-ready"));
    const fallback = plan.actions.find((action) => action.id === "edit-fallback-model-route");

    expect(fallback).toEqual(expect.objectContaining({
      sectionId: "model-route",
      effect: "draft-config-patch",
      patch: expect.objectContaining({
        fields: ["model.fallbacks"],
        preserveUnrelatedConfig: true,
      }),
    }));
  });

  it("exposes auxiliary route editing as a scoped reviewed model route action", () => {
    const plan = buildSetupEditorPlan(state("configured-ready"));
    const auxiliary = plan.actions.find((action) => action.id === "edit-auxiliary-model-route");

    expect(auxiliary).toEqual(expect.objectContaining({
      sectionId: "model-route",
      effect: "draft-config-patch",
      patch: expect.objectContaining({
        fields: ["auxiliaryModels.*"],
        preserveUnrelatedConfig: true,
      }),
    }));
  });

  it("does not reintroduce backupForMain placeholders", () => {
    const plan = buildSetupEditorPlan(state("configured-ready"));

    expect(JSON.stringify(plan)).not.toContain("backupForMain");
  });

  it("keeps the setup editor plan free of terminal rendering fields", () => {
    const plan = buildSetupEditorPlan(state("configured-ready"));
    const json = JSON.stringify(plan);

    expect(json).not.toContain("\u001b[");
    expect(json).not.toContain("Press Enter");
    expect(json).not.toContain("Use ↑/↓");
    assertNoRenderingFields(plan);
  });
});

function assertNoRenderingFields(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    expect(["title", "body", "render", "terminal", "promptCard"].includes(key)).toBe(false);
    assertNoRenderingFields(nested);
  }
}
