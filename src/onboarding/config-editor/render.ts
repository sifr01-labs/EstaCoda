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
  "edit-fallback-model-route",
  "edit-auxiliary-model-route",
  "configure-channels",
  "configure-voice",
  "configure-image-generation",
  "configure-browser",
  "repair-workspace-trust",
  "edit-security-mode",
  "edit-workflow-learning",
];

export function renderConfigEditor(input: {
  readonly decision: SetupRouteDecision;
  readonly session: SetupEditorPlanSession;
  readonly actions: readonly ConfigEditorRenderedAction[];
}): string {
  const { decision, session } = input;
  const lines = [
    setupCopyText("en", "setupEditor.shell.title"),
    decision.title,
    decision.summary,
    "",
    `${setupCopyText("en", "setupEditor.shell.labels.state")}:`,
    `  ${setupCopyText("en", "setupEditor.shell.labels.kind")}: ${decision.state.kind}`,
    `  ${setupCopyText("en", "setupEditor.shell.labels.route")}: ${decision.kind}`,
    `  ${setupCopyText("en", "setupEditor.shell.labels.editorMode")}: ${session.plan.mode}`,
    `  ${setupCopyText("en", "setupEditor.shell.labels.recommended")}: ${decision.state.recommendedAction}`,
  ];

  if (decision.state.model !== undefined) {
    lines.push(`  ${setupCopyText("en", "setupEditor.shell.labels.model")}: ${decision.state.model.provider}/${decision.state.model.id}`);
  }

  lines.push(
    `  Configuration: ${decision.state.configPaths.profile}`
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

  lines.push("", `${setupCopyText("en", "setupEditor.sections.heading")}:`);
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

  lines.push("", `${setupCopyText("en", "setupEditor.actions.heading")}:`);
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
    setupCopyText("en", "setupEditor.diagnostics.title"),
    `State: ${decision.state.kind}`,
    `Route: ${decision.kind}`,
    `Recommended: ${decision.state.recommendedAction}`,
    `Configuration: ${decision.state.configPaths.profile}`,
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
        label: setupCopyText("en", "setupRoute.action.verifySetup"),
        description: setupCopyText("en", "setupEditor.actions.runReadonlyVerification"),
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
        label: setupCopyText("en", "setupRoute.action.exit"),
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
      return setupCopyText("en", "setupEditor.actions.repairWorkspaceTrust.description");
    case "edit-security-mode":
      return setupCopyText("en", "setupEditor.actions.editSecurityMode.description");
    case "edit-workflow-learning":
      return setupCopyText("en", "setupEditor.actions.editWorkflowLearning.description");
    case "configure-channels":
      return setupCopyText("en", "setupEditor.actions.configureChannels.description");
    case "configure-voice":
      return setupCopyText("en", "setupEditor.actions.configureVoice.description");
    case "configure-image-generation":
      return setupCopyText("en", "setupEditor.actions.configureImageGeneration.description");
    case "configure-browser":
      return setupCopyText("en", "setupEditor.actions.configureBrowser.description");
    case "repair-primary-provider":
      return setupCopyText("en", "setupEditor.actions.repairPrimaryProvider.description");
    case "edit-primary-model-route":
      return setupCopyText("en", "setupEditor.actions.editPrimaryModelRoute.description");
    case "repair-missing-credential":
      return setupCopyText("en", "setupEditor.actions.repairMissingCredential.description");
    default:
      return setupCopyText("en", action.copyKey);
  }
}

function appendUnsafeStateGuidance(lines: string[], decision: SetupRouteDecision): void {
  if (decision.state.kind === "broken-config") {
    lines.push(
      "",
      "Manual repair guidance:",
      `- ${setupCopyText("en", "setupEditor.diagnostics.manualRepair.brokenConfig")}`,
      "- Only diagnostics, verification, and exit are available from this state."
    );
  }

  if (decision.state.kind === "state-not-writable") {
    lines.push(
      "",
      "Manual repair guidance:",
      `- ${setupCopyText("en", "setupEditor.diagnostics.manualRepair.stateNotWritable")}`,
      "- Only diagnostics, verification, and exit are available from this state."
    );
  }
}
