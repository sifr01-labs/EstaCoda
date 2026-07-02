import { collectSetupEntryState, type CollectSetupEntryStateOptions, type SetupEntryState } from "./setup-entry-state.js";
import { setupCopyText } from "./setup-prompts.js";
import { buildSetupEditorPlan, type SetupEditorPlan, type SetupEditorSection } from "./setup-editor-plan.js";

export type SetupRouterSelection =
  | "entry"
  | "verify"
  | "launch-agent"
  | "repair-setup"
  | "edit-config"
  | "run-first-run"
  | "exit";

export type SetupRouteKind =
  | "first-run-onboarding"
  | "configured-menu"
  | "configured-degraded-menu"
  | "repair-first-menu"
  | "verify-readonly";

export type SetupRouteActionId =
  | "launch-agent"
  | "review-edit-config"
  | "run-guided-onboarding"
  | "verify-setup"
  | "run-doctor"
  | "repair-setup"
  | "show-diagnostics"
  | "trust-workspace"
  | "exit";

export type SetupRouteAction = {
  readonly id: SetupRouteActionId;
  readonly label: string;
  readonly description: string;
  readonly mutatesConfig: boolean;
};

export type SetupEditorPlanSession = {
  readonly kind: "guided-setup-editor-session";
  readonly plan: SetupEditorPlan;
  readonly activeSections: readonly SetupEditorSection[];
  readonly metadata: {
    readonly source: "setup-router";
    readonly planKind: SetupEditorPlan["kind"];
    readonly mode: SetupEditorPlan["mode"];
    readonly sourceState: SetupEditorPlan["sourceState"];
    readonly sectionCount: number;
    readonly actionCount: number;
  };
};

export type SetupRouteDecision = {
  readonly kind: SetupRouteKind;
  readonly title: string;
  readonly summary: string;
  readonly state: SetupEntryState;
  readonly actions: readonly SetupRouteAction[];
  readonly warnings: readonly string[];
  readonly blockers: readonly string[];
  readonly readOnly: boolean;
  readonly setupEditorPlanSession?: SetupEditorPlanSession;
};

export type CollectSetupRouteOptions = CollectSetupEntryStateOptions & {
  readonly selection?: SetupRouterSelection;
};

export async function collectSetupRoute(options: CollectSetupRouteOptions): Promise<SetupRouteDecision> {
  const state = await collectSetupEntryState(options);
  return routeSetupEntryState(state, {
    selection: options.selection,
  });
}

export function routeSetupEntryState(
  state: SetupEntryState,
  options: {
    readonly selection?: SetupRouterSelection;
  } = {}
): SetupRouteDecision {
  if (options.selection === "verify") {
    return verifyDecision(state);
  }

  if (options.selection === "run-first-run") {
    return firstRunDecision(state);
  }

  switch (state.kind) {
    case "new-user":
      return firstRunDecision(state);
    case "configured-ready":
      return configuredDecision(state);
    case "configured-degraded":
      return configuredDegradedDecision(state);
    case "untrusted-workspace":
      return untrustedConfiguredDecision(state);
    case "partial-provider":
    case "missing-secret":
    case "broken-config":
    case "state-not-writable":
      return repairFirstDecision(state);
  }
}

export function renderSetupRouteDecision(decision: SetupRouteDecision): string {
  const lines = [
    decision.title,
    decision.summary,
    "",
    `State: ${decision.state.kind}`,
    `Recommended: ${decision.state.recommendedAction}`,
  ];

  if (decision.warnings.length > 0) {
    lines.push("", "Warnings:", ...decision.warnings.map((warning) => `- ${warning}`));
  }

  if (decision.blockers.length > 0) {
    lines.push("", "Blockers:", ...decision.blockers.map((blocker) => `- ${blocker}`));
  }

  if (decision.actions.length > 0) {
    lines.push("", "Actions:");
    for (const action of decision.actions) {
      lines.push(`- ${action.id}: ${action.label}`);
      lines.push(`  ${action.description}`);
    }
  }

  return lines.join("\n");
}

function firstRunDecision(
  state: SetupEntryState
): SetupRouteDecision {
  return {
    kind: "first-run-onboarding",
    title: setupCopyText("en", "setupRouter.firstRun.title"),
    summary: setupCopyText("en", "setupRouter.firstRun.summary"),
    state,
    actions: [
      action("run-guided-onboarding", "Start first-run setup", "Choose language, trust, provider, security, optional capabilities, review, verify, and launch.", true),
      doctorAction(),
      action("exit", setupCopyText("en", "setupRoute.action.exit"), "Leave setup without changing config.", false),
    ],
    warnings: state.warnings,
    blockers: state.blockers,
    readOnly: true,
  };
}

function configuredDecision(state: SetupEntryState): SetupRouteDecision {
  return {
    kind: "configured-menu",
    title: setupCopyText("en", "setupRouter.configured.title"),
    summary: setupCopyText("en", "setupRouter.configured.summary"),
    state,
    actions: configuredActions(),
    warnings: state.warnings,
    blockers: [],
    readOnly: true,
    setupEditorPlanSession: createSetupEditorPlanSession(state),
  };
}

function configuredDegradedDecision(state: SetupEntryState): SetupRouteDecision {
  return {
    kind: "configured-degraded-menu",
    title: setupCopyText("en", "setupRouter.degraded.title"),
    summary: setupCopyText("en", "setupRouter.degraded.summary"),
    state,
    actions: [
      action("repair-setup", "Fix now", "Open the guided repair path for the reported warnings.", true),
      doctorAction(),
      action("launch-agent", setupCopyText("en", "setupRoute.action.acceptLimitedMode"), "Launch the agent while accepting the current degraded state.", false),
      action("review-edit-config", "Review/edit config", "Inspect guided configuration sections.", true),
      action("exit", setupCopyText("en", "setupRoute.action.exit"), "Leave setup without changing config.", false),
    ],
    warnings: state.warnings,
    blockers: state.blockers,
    readOnly: true,
    setupEditorPlanSession: createSetupEditorPlanSession(state),
  };
}

function repairFirstDecision(state: SetupEntryState): SetupRouteDecision {
  return {
    kind: "repair-first-menu",
    title: setupCopyText("en", "setupRouter.repair.title"),
    summary: repairSummary(state),
    state,
    actions: repairFirstActions(state),
    warnings: state.warnings,
    blockers: state.blockers,
    readOnly: true,
    setupEditorPlanSession: createSetupEditorPlanSession(state),
  };
}

function repairFirstActions(state: SetupEntryState): SetupRouteAction[] {
  if (state.kind === "broken-config" || state.kind === "state-not-writable") {
    return [
      doctorAction(),
      action("exit", setupCopyText("en", "setupRoute.action.exit"), "Leave setup without changing config.", false),
    ];
  }

  return [
    action("repair-setup", "Repair setup", "Start the guided repair path for the current blockers.", true),
    action("review-edit-config", "Open config editor", "Inspect or edit guided configuration sections.", true),
    action("run-guided-onboarding", "Run full onboarding", "Restart the guided setup flow from the beginning.", true),
    doctorAction(),
    action("exit", setupCopyText("en", "setupRoute.action.exit"), "Leave setup without changing config.", false),
  ];
}

function untrustedConfiguredDecision(state: SetupEntryState): SetupRouteDecision {
  return {
    kind: "configured-menu",
    title: "Workspace trust required",
    summary: "Provider setup is usable, but this workspace is not trusted yet. Trust repair is available before launch.",
    state,
    actions: [
      action("trust-workspace", "Trust workspace", "Grant explicit trust for this workspace before local file or terminal work.", true),
      ...configuredActions(),
    ],
    warnings: [...new Set(state.warnings)],
    blockers: state.blockers,
    readOnly: true,
    setupEditorPlanSession: createSetupEditorPlanSession(state),
  };
}

function createSetupEditorPlanSession(state: SetupEntryState): SetupEditorPlanSession {
  const plan = buildSetupEditorPlan(state);
  return {
    kind: "guided-setup-editor-session",
    plan,
    activeSections: plan.sections,
    metadata: {
      source: "setup-router",
      planKind: plan.kind,
      mode: plan.mode,
      sourceState: plan.sourceState,
      sectionCount: plan.sections.length,
      actionCount: plan.actions.length,
    },
  };
}

function verifyDecision(state: SetupEntryState): SetupRouteDecision {
  return {
    kind: "verify-readonly",
    title: setupCopyText("en", "setupRoute.action.verifySetup"),
    summary: "Run setup verification without changing config.",
    state,
    actions: [
      action("verify-setup", setupCopyText("en", "setupRoute.action.verifySetup"), "Collect structured setup, provider, trust, state, and tool readiness diagnostics.", false),
      action("exit", setupCopyText("en", "setupRoute.action.exit"), "Leave setup without changing config.", false),
    ],
    warnings: state.warnings,
    blockers: state.blockers,
    readOnly: true,
  };
}

function configuredActions(): SetupRouteAction[] {
  return [
    action("launch-agent", setupCopyText("en", "setupRoute.action.launchAgent"), "Start the interactive EstaCoda agent session.", false),
    action("review-edit-config", "Review/edit config", "Inspect guided configuration sections.", true),
    action("run-guided-onboarding", "Run guided onboarding again", "Run guided setup again intentionally.", true),
    doctorAction(),
    action("exit", setupCopyText("en", "setupRoute.action.exit"), "Leave setup without changing config.", false),
  ];
}

function doctorAction(): SetupRouteAction {
  return action("run-doctor", "EstaCoda Doctor", "Check setup health and show required fixes.", false);
}

function action(
  id: SetupRouteActionId,
  label: string,
  description: string,
  mutatesConfig: boolean
): SetupRouteAction {
  return { id, label, description, mutatesConfig };
}

function repairSummary(state: SetupEntryState): string {
  switch (state.kind) {
    case "partial-provider":
      return "Provider configuration is incomplete. Repair provider setup before launch.";
    case "missing-secret":
      return "A configured provider is missing required credentials. Repair secrets before launch.";
    case "broken-config":
      return "Config could not be loaded. Repair config syntax or replace the broken file before launch.";
    case "state-not-writable":
      return "EstaCoda state is not writable. Fix state directory permissions before setup can continue.";
    default:
      return "Setup is incomplete. Repair before launch.";
  }
}
