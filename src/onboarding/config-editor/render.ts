import type { SetupEditorPlanSession, SetupRouteAction, SetupRouteActionId, SetupRouteDecision } from "../setup-router.js";
import type { SetupEditorActionDraft, SetupEditorActionId } from "../setup-editor-actions.js";
import { setupCopyText } from "../setup-prompts.js";

export type ConfigEditorRenderedAction = {
  readonly id: SetupRouteActionId | SetupEditorActionId;
  readonly label: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly source: "route" | "editor" | "synthetic";
  readonly editorAction?: SetupEditorActionDraft;
};

const PR4_ACTION_ORDER: readonly SetupRouteActionId[] = ["verify-setup", "show-diagnostics", "exit"];
const PR6_EDITOR_ACTION_ORDER: readonly SetupEditorActionId[] = [
  "repair-primary-provider",
  "edit-primary-model-route",
  "repair-missing-credential",
  "edit-primary-credential-reference",
  "repair-workspace-trust",
  "edit-security-mode",
  "edit-workflow-learning",
  "review-optional-capabilities",
];

export function renderConfigEditor(input: {
  readonly decision: SetupRouteDecision;
  readonly session: SetupEditorPlanSession;
  readonly actions: readonly ConfigEditorRenderedAction[];
}): string {
  const { decision, session } = input;
  const lines = [
    "EstaCoda guided setup editor",
    decision.title,
    decision.summary,
    "",
    "State:",
    `  kind: ${decision.state.kind}`,
    `  route: ${decision.kind}`,
    `  editor mode: ${session.plan.mode}`,
    `  recommended: ${decision.state.recommendedAction}`,
  ];

  if (decision.state.model !== undefined) {
    lines.push(`  model: ${decision.state.model.provider}/${decision.state.model.id}`);
  }

  lines.push(
    `  user config: ${decision.state.configPaths.user}`,
    `  project config: ${decision.state.configPaths.project}`
  );

  if (decision.state.kind === "state-not-writable") {
    lines.push(`  state writable: ${decision.state.stateDirectoryWritable ? "yes" : "no"}`);
  }

  if (decision.blockers.length > 0) {
    lines.push("", "Blockers:", ...decision.blockers.map((blocker) => `  - ${blocker}`));
  }

  if (decision.warnings.length > 0) {
    lines.push("", "Warnings:", ...decision.warnings.map((warning) => `  - ${warning}`));
  }

  appendUnsafeStateGuidance(lines, decision);

  lines.push("", "Sections:");
  for (const section of session.activeSections) {
    lines.push(`  ${section.id} - ${setupCopyText("en", section.copyKey)}`);
    lines.push(`    status: ${section.status}`);
    if (section.blockers.length > 0) {
      lines.push(...section.blockers.map((blocker) => `    blocker: ${blocker}`));
    }
    if (section.warnings.length > 0) {
      lines.push(...section.warnings.map((warning) => `    warning: ${warning}`));
    }
  }

  lines.push("", "Available setup actions:");
  if (input.actions.length === 0) {
    lines.push("  none");
  } else {
    for (const action of input.actions) {
      lines.push(`  ${action.id} - ${action.label}`);
      lines.push(`    ${action.description}`);
    }
  }

  return lines.join("\n");
}

export function renderConfigEditorDiagnostics(decision: SetupRouteDecision): string {
  const lines = [
    "Setup diagnostics",
    `State: ${decision.state.kind}`,
    `Route: ${decision.kind}`,
    `Recommended: ${decision.state.recommendedAction}`,
    `User config: ${decision.state.configPaths.user}`,
    `Project config: ${decision.state.configPaths.project}`,
  ];

  if (decision.blockers.length > 0) {
    lines.push("", "Blockers:", ...decision.blockers.map((blocker) => `- ${blocker}`));
  }

  if (decision.warnings.length > 0) {
    lines.push("", "Warnings:", ...decision.warnings.map((warning) => `- ${warning}`));
  }

  if (decision.state.error !== undefined) {
    lines.push("", `Error: ${decision.state.error}`);
  }

  appendUnsafeStateGuidance(lines, decision);

  return lines.join("\n");
}

export function configEditorActions(
  decision: SetupRouteDecision,
  session: SetupEditorPlanSession
): readonly ConfigEditorRenderedAction[] {
  const routeActions = new Map(
    decision.actions
      .filter((action) => !action.mutatesConfig)
      .map((action) => [action.id, action])
  );
  const readOnlyActions = PR4_ACTION_ORDER.map((id) => {
    const routeAction = routeActions.get(id);
    return routeAction === undefined
      ? syntheticAction(id)
      : renderRouteAction(routeAction);
  });

  if (decision.state.kind === "broken-config" || decision.state.kind === "state-not-writable") {
    return readOnlyActions;
  }

  const editorActions = new Map(session.plan.actions.map((action) => [action.id, action]));
  const guidedActions = PR6_EDITOR_ACTION_ORDER
    .map((id) => editorActions.get(id))
    .filter((action): action is SetupEditorActionDraft => action !== undefined)
    .map((action) => renderEditorAction(action));

  return [...guidedActions, ...readOnlyActions];
}

export function isConfigEditorActionId(
  id: string,
  actions: readonly ConfigEditorRenderedAction[]
): id is ConfigEditorRenderedAction["id"] {
  return actions.some((action) => action.id === id);
}

function renderRouteAction(action: SetupRouteAction): ConfigEditorRenderedAction {
  return {
    id: action.id,
    label: action.label,
    description: action.description,
    readOnly: !action.mutatesConfig,
    source: "route",
  };
}

function renderEditorAction(action: SetupEditorActionDraft): ConfigEditorRenderedAction {
  return {
    id: action.id,
    label: setupCopyText("en", action.copyKey),
    description: editorActionDescription(action),
    readOnly: action.readOnly,
    source: "editor",
    editorAction: action,
  };
}

function syntheticAction(id: SetupRouteActionId): ConfigEditorRenderedAction {
  switch (id) {
    case "verify-setup":
      return {
        id,
        label: "Verify setup",
        description: "Run read-only setup verification.",
        readOnly: true,
        source: "synthetic",
      };
    case "show-diagnostics":
      return {
        id,
        label: "Show diagnostics",
        description: "Show structured blockers and warnings without changing config.",
        readOnly: true,
        source: "synthetic",
      };
    case "exit":
      return {
        id,
        label: setupCopyText("en", "setupEditor.actions.cancelSetupEditor"),
        description: "Leave setup without changing config.",
        readOnly: true,
        source: "synthetic",
      };
    default:
      throw new Error(`Cannot synthesize unsupported PR4 setup editor action ${id}.`);
  }
}

function editorActionDescription(action: SetupEditorActionDraft): string {
  switch (action.id) {
    case "repair-workspace-trust":
      return "Draft an explicit workspace trust grant for review before applying.";
    case "edit-security-mode":
      return "Choose strict, adaptive, or open approval mode and review the scoped config patch.";
    case "edit-workflow-learning":
      return "Choose workflow learning behavior and review the scoped config patch.";
    case "review-optional-capabilities":
      return "Review Telegram, voice, vision/image generation, and browser capability settings independently.";
    case "repair-primary-provider":
      return "Repair the primary provider/model route through the shared setup flow.";
    case "edit-primary-model-route":
      return "Choose a primary provider/model route through the shared setup flow.";
    case "repair-missing-credential":
      return "Repair the primary provider credential reference through the shared setup flow.";
    case "edit-primary-credential-reference":
      return "Choose a primary provider credential reference through the shared setup flow.";
    default:
      return setupCopyText("en", action.copyKey);
  }
}

function appendUnsafeStateGuidance(lines: string[], decision: SetupRouteDecision): void {
  if (decision.state.kind === "broken-config") {
    lines.push(
      "",
      "Manual repair guidance:",
      "- Normal config edits are blocked until the config file can be parsed.",
      "- Open the listed config path, fix the parse/load error, then run read-only verification again.",
      "- Only diagnostics, verification, and exit are available from this state."
    );
  }

  if (decision.state.kind === "state-not-writable") {
    lines.push(
      "",
      "Manual repair guidance:",
      "- EstaCoda cannot safely apply setup changes while its state/config path is not writable.",
      "- Normal writes are blocked until state write permissions are restored.",
      "- Restore write permission for the state/config path above, then run read-only verification again.",
      "- Only diagnostics, verification, and exit are available from this state."
    );
  }
}
