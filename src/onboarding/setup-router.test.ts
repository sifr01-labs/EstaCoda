import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderDiagnostic } from "../config/provider-diagnostics.js";
import type { SetupVerificationReport } from "./verification.js";
import type { SetupEntryRecommendedAction, SetupEntryState, SetupEntryStateKind } from "./setup-entry-state.js";
import { collectSetupRoute, renderSetupRouteDecision, routeSetupEntryState, type SetupRouteKind } from "./setup-router.js";

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

describe("routeSetupEntryState", () => {
  const cases: Array<{
    kind: SetupEntryStateKind;
    route: SetupRouteKind;
    firstAction: string;
  }> = [
    { kind: "new-user", route: "first-run-onboarding", firstAction: "run-guided-onboarding" },
    { kind: "configured-ready", route: "configured-menu", firstAction: "launch-agent" },
    { kind: "configured-degraded", route: "configured-degraded-menu", firstAction: "repair-setup" },
    { kind: "partial-provider", route: "repair-first-menu", firstAction: "repair-setup" },
    { kind: "missing-secret", route: "repair-first-menu", firstAction: "repair-setup" },
    { kind: "broken-config", route: "repair-first-menu", firstAction: "repair-setup" },
    { kind: "state-not-writable", route: "repair-first-menu", firstAction: "repair-setup" },
    { kind: "untrusted-workspace", route: "configured-menu", firstAction: "trust-workspace" },
  ];

  it.each(cases)("routes $kind to $route", ({ kind, route, firstAction }) => {
    const decision = routeSetupEntryState(state(kind));

    expect(decision.kind).toBe(route);
    expect(decision.state.kind).toBe(kind);
    expect(decision.actions[0]?.id).toBe(firstAction);
    expect(decision.readOnly).toBe(true);
  });

  it("includes an initial first-run plan session for new-user routes", () => {
    const decision = routeSetupEntryState(state("new-user"));
    const session = decision.firstRunPlanSession;

    expect(decision.kind).toBe("first-run-onboarding");
    expect(session?.kind).toBe("first-run-plan-session");
    expect(session?.initialState.currentStepId).toBe("welcome");
    expect(session?.currentStep.id).toBe("welcome");
    expect(session?.selectedLocale).toBe("en");
    expect(session?.copyLocale).toBe("en");
    expect(session?.metadata).toEqual({
      source: "setup-router",
      planKind: "first-run-onboarding-plan",
      currentStepId: "welcome",
      totalStepCount: session?.plan.steps.length,
      activeStepCount: session?.activeSteps.length,
    });
  });

  it("respects local provider credential skip when first-run selections are seeded", () => {
    const decision = routeSetupEntryState(state("new-user"), {
      firstRunSelections: { primaryProvider: "local", primaryModel: "ollama/auto" },
    });
    const activeStepIds = decision.firstRunPlanSession?.activeSteps.map((candidate) => candidate.id);

    expect(activeStepIds).not.toContain("primary-credential");
    expect(decision.firstRunPlanSession?.plan.selections.primaryCredential).toEqual({ kind: "none" });
  });

  it("seeds Arabic locale into the first-run plan session", () => {
    const decision = routeSetupEntryState(state("new-user"), {
      firstRunSelections: { language: "ar" },
    });

    expect(decision.firstRunPlanSession?.selectedLocale).toBe("ar");
    expect(decision.firstRunPlanSession?.copyLocale).toBe("ar");
    expect(decision.firstRunPlanSession?.plan.steps.find((candidate) => candidate.id === "workspace-root")?.copyLocale).toBe("ar");
  });

  it("keeps configured, degraded, repair, and verify routes without first-run sessions by default", () => {
    const routeKinds: SetupEntryStateKind[] = [
      "configured-ready",
      "configured-degraded",
      "partial-provider",
      "missing-secret",
      "broken-config",
      "state-not-writable",
      "untrusted-workspace",
    ];

    for (const kind of routeKinds) {
      expect(routeSetupEntryState(state(kind)).firstRunPlanSession).toBeUndefined();
    }
    expect(routeSetupEntryState(state("new-user"), { selection: "verify" }).firstRunPlanSession).toBeUndefined();
  });

  it("offers existing configured users launch, review/edit, re-run, verify, or exit without forcing first-run", () => {
    const decision = routeSetupEntryState(state("configured-ready"));

    expect(decision.kind).toBe("configured-menu");
    expect(decision.firstRunPlanSession).toBeUndefined();
    expect(decision.actions.map((action) => action.id)).toEqual([
      "launch-agent",
      "review-edit-config",
      "run-guided-onboarding",
      "verify-setup",
      "exit",
    ]);
    expect(decision.actions.find((action) => action.id === "launch-agent")?.mutatesConfig).toBe(false);
    expect(decision.actions.find((action) => action.id === "verify-setup")?.mutatesConfig).toBe(false);
    expect(decision.actions.find((action) => action.id === "exit")?.mutatesConfig).toBe(false);
  });

  it("does not offer automatic launch for repair-first states", () => {
    for (const kind of ["partial-provider", "missing-secret", "broken-config", "state-not-writable"] as const) {
      const decision = routeSetupEntryState(state(kind));
      const actionIds = decision.actions.map((action) => action.id);

      expect(decision.kind).toBe("repair-first-menu");
      expect(actionIds).toContain("repair-setup");
      expect(actionIds).toContain("show-diagnostics");
      expect(actionIds).toContain("verify-setup");
      expect(actionIds).not.toContain("launch-agent");
    }
  });

  it("attaches setup editor sessions to configured, degraded, and repair routes", () => {
    const routeKinds: SetupEntryStateKind[] = [
      "configured-ready",
      "configured-degraded",
      "partial-provider",
      "missing-secret",
      "broken-config",
      "state-not-writable",
      "untrusted-workspace",
    ];

    for (const kind of routeKinds) {
      const decision = routeSetupEntryState(state(kind));
      expect(decision.setupEditorPlanSession?.kind).toBe("guided-setup-editor-session");
      expect(decision.setupEditorPlanSession?.metadata.sourceState).toBe(kind);
      expect(decision.firstRunPlanSession).toBeUndefined();
    }
  });

  it("keeps verify routes read-only and free of setup editor sessions", () => {
    const decision = routeSetupEntryState(state("configured-ready"), { selection: "verify" });

    expect(decision.kind).toBe("verify-readonly");
    expect(decision.setupEditorPlanSession).toBeUndefined();
    expect(decision.firstRunPlanSession).toBeUndefined();
    expect(decision.actions.every((action) => action.mutatesConfig === false)).toBe(true);
  });

  it("can attach first-run plan sessions for explicit internal run-first-run selections", () => {
    const decision = routeSetupEntryState(state("configured-ready"), {
      selection: "run-first-run",
      firstRunSelections: { language: "ar" },
    });

    expect(decision.kind).toBe("first-run-onboarding");
    expect(decision.firstRunPlanSession?.currentStep.id).toBe("welcome");
    expect(decision.firstRunPlanSession?.copyLocale).toBe("ar");
  });

  it("does not introduce terminal rendering fields in the first-run plan session", () => {
    const decision = routeSetupEntryState(state("new-user"), {
      firstRunSelections: { language: "ar", primaryProvider: "local" },
    });
    const session = decision.firstRunPlanSession;
    const json = JSON.stringify(session);

    expect(session).toBeDefined();
    expect(json).not.toContain("\u001b[");
    expect(json).not.toContain("Press Enter");
    expect(json).not.toContain("Use ↑/↓");
    assertNoRenderingFields(session);
  });

  it("does not introduce terminal rendering fields in setup editor sessions", () => {
    const decision = routeSetupEntryState(state("configured-ready"));
    const session = decision.setupEditorPlanSession;
    const json = JSON.stringify(session);

    expect(session).toBeDefined();
    expect(json).not.toContain("\u001b[");
    expect(json).not.toContain("Press Enter");
    expect(json).not.toContain("Use ↑/↓");
    assertNoRenderingFields(session);
  });

  it("adds an explicit trust warning for untrusted workspaces", () => {
    const decision = routeSetupEntryState(state("untrusted-workspace"));

    expect(decision.summary).toContain("not trusted");
    expect(decision.warnings).toContain("Workspace is not trusted.");
    expect(decision.actions.some((action) => action.id === "trust-workspace")).toBe(true);
  });

  it("routes any state to read-only verification when verify is selected", () => {
    for (const kind of cases.map((entry) => entry.kind)) {
      const decision = routeSetupEntryState(state(kind), { selection: "verify" });
      expect(decision.kind).toBe("verify-readonly");
      expect(decision.actions.every((action) => action.mutatesConfig === false)).toBe(true);
      expect(decision.summary).toContain("without changing config");
    }
  });

  it("renders deterministic noninteractive route output", () => {
    const decision = routeSetupEntryState(state("configured-degraded"));
    const first = renderSetupRouteDecision(decision);
    const second = renderSetupRouteDecision(decision);

    expect(first).toBe(second);
    expect(first).toContain("EstaCoda is configured with warnings");
    expect(first).toContain("State: configured-degraded");
    expect(first).toContain("- verify-setup: Verify setup");
  });
});

describe("collectSetupRoute", () => {
  it("collects setup state and routes beside the POC without mutating config", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-setup-router-"));
    const workspaceRoot = join(homeDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });

    const decision = await collectSetupRoute({ homeDir, workspaceRoot });

    expect(decision.kind).toBe("first-run-onboarding");
    expect(decision.state.kind).toBe("new-user");
    expect(decision.actions[0]?.id).toBe("run-guided-onboarding");
    expect(decision.firstRunPlanSession?.currentStep.id).toBe("welcome");
    expect(existsSync(join(homeDir, ".estacoda", "config.json"))).toBe(false);
  });
});

function assertNoRenderingFields(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    expect(["title", "body", "render", "terminal", "promptCard"].includes(key)).toBe(false);
    assertNoRenderingFields(nested);
  }
}
