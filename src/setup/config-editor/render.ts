import type { SetupEditorPlanSession, SetupRouteAction, SetupRouteActionId, SetupRouteDecision } from "../setup-router.js";
import type { SetupEditorActionDraft, SetupEditorActionId } from "../setup-editor-actions.js";
import { formatSetupCopy, setupCopyText, setupTechnicalToken, type SetupPromptValue } from "../setup-prompts.js";
import type { SetupCopyLocale } from "../setup-copy.js";

export type ConfigEditorRenderedAction = {
  readonly id: SetupRouteActionId | SetupEditorActionId;
  readonly label: string;
  readonly description: string;
  readonly group?: "main" | "navigation";
  readonly readOnly: boolean;
  readonly source: "route" | "editor" | "synthetic";
  readonly editorAction?: SetupEditorActionDraft;
};

const PR4_ACTION_ORDER: readonly SetupRouteActionId[] = ["run-doctor", "exit"];
const PR6_EDITOR_ACTION_ORDER: readonly SetupEditorActionId[] = [
  "repair-primary-provider",
  "edit-primary-model-route",
  "repair-missing-credential",
  "edit-fallback-model-route",
  "edit-auxiliary-model-route",
  "configure-channels",
  "configure-voice",
  "configure-image-generation",
  "configure-web-search",
  "configure-browser",
  "repair-workspace-trust",
  "edit-security-mode",
  "edit-workflow-learning",
  "edit-spending-limit-for-task",
  "edit-spending-limit-for-session",
  "edit-language",
];

export function renderConfigEditor(input: {
  readonly decision: SetupRouteDecision;
  readonly session: SetupEditorPlanSession;
  readonly actions: readonly ConfigEditorRenderedAction[];
  readonly locale?: SetupCopyLocale;
}): string {
  const { decision, session } = input;
  const locale = input.locale ?? "en";
  const lines = [
    setupCopyText(locale, "setupEditor.shell.title"),
    decision.title,
    decision.summary,
    "",
    `${setupCopyText(locale, "setupEditor.shell.labels.state")}:`,
    `  ${setupCopyText(locale, "setupEditor.shell.labels.kind")}: ${decision.state.kind}`,
    `  ${setupCopyText(locale, "setupEditor.shell.labels.route")}: ${decision.kind}`,
    `  ${setupCopyText(locale, "setupEditor.shell.labels.editorMode")}: ${session.plan.mode}`,
    `  ${setupCopyText(locale, "setupEditor.shell.labels.recommended")}: ${decision.state.recommendedAction}`,
  ];

  if (decision.state.model !== undefined) {
    lines.push(`  ${setupCopyText(locale, "setupEditor.shell.labels.model")}: ${decision.state.model.provider}/${decision.state.model.id}`);
  }

  lines.push(
    `  ${setupCopyText(locale, "setupEditor.shell.labels.userConfig")}: ${decision.state.configPaths.profile}`
  );

  if (decision.state.kind === "state-not-writable") {
    lines.push(
      `  ${setupCopyText(locale, "setupEditor.shell.labels.stateWritable")}: ${decision.state.stateDirectoryWritable
        ? setupCopyText(locale, "setupEditor.shell.values.yes")
        : setupCopyText(locale, "setupEditor.shell.values.no")}`
    );
  }

  if (decision.blockers.length > 0) {
    lines.push("", `${setupCopyText(locale, "setupEditor.shell.labels.blockers")}:`, ...decision.blockers.map((blocker) => `  - ${blocker}`));
  }

  if (decision.warnings.length > 0) {
    lines.push("", `${setupCopyText(locale, "setupEditor.shell.labels.warnings")}:`, ...decision.warnings.map((warning) => `  - ${warning}`));
  }

  appendUnsafeStateGuidance(lines, decision, locale);

  lines.push("", `${setupCopyText(locale, "setupEditor.sections.heading")}:`);
  for (const section of session.activeSections) {
    lines.push(`  ${section.id} - ${setupCopyText(locale, section.copyKey)}`);
    lines.push(`    ${setupCopyText(locale, "setupEditor.shell.labels.status")}: ${section.status}`);
    if (section.blockers.length > 0) {
      lines.push(...section.blockers.map((blocker) => `    ${setupCopyText(locale, "setupEditor.shell.labels.blocker")}: ${blocker}`));
    }
    if (section.warnings.length > 0) {
      lines.push(...section.warnings.map((warning) => `    ${setupCopyText(locale, "setupEditor.shell.labels.warning")}: ${warning}`));
    }
  }

  lines.push("", `${setupCopyText(locale, "setupEditor.actions.heading")}:`);
  if (input.actions.length === 0) {
    lines.push(`  ${setupCopyText(locale, "setupEditor.shell.labels.none")}`);
  } else {
    for (const action of input.actions) {
      lines.push(`  ${action.id} - ${action.label}`);
      lines.push(`    ${action.description}`);
    }
  }

  return lines.join("\n");
}

export function renderConfigEditorDiagnostics(decision: SetupRouteDecision): string {
  return renderConfigEditorDiagnosticsForLocale(decision, "en");
}

export function renderConfigEditorDiagnosticsForLocale(
  decision: SetupRouteDecision,
  locale: SetupCopyLocale
): string {
  const lines = [
    setupCopyText(locale, "setupEditor.diagnostics.title"),
    `${setupCopyText(locale, "setupEditor.shell.labels.state")}: ${decision.state.kind}`,
    `${setupCopyText(locale, "setupEditor.shell.labels.route")}: ${decision.kind}`,
    `${setupCopyText(locale, "setupEditor.shell.labels.recommended")}: ${decision.state.recommendedAction}`,
    `${setupCopyText(locale, "setupEditor.shell.labels.userConfig")}: ${decision.state.configPaths.profile}`,
  ];

  if (decision.blockers.length > 0) {
    lines.push("", `${setupCopyText(locale, "setupEditor.shell.labels.blockers")}:`, ...decision.blockers.map((blocker) => `- ${blocker}`));
  }

  if (decision.warnings.length > 0) {
    lines.push("", `${setupCopyText(locale, "setupEditor.shell.labels.warnings")}:`, ...decision.warnings.map((warning) => `- ${warning}`));
  }

  if (decision.state.error !== undefined) {
    lines.push("", `${setupCopyText(locale, "setupEditor.diagnostics.labels.error")}: ${decision.state.error}`);
  }

  appendUnsafeStateGuidance(lines, decision, locale);

  return lines.join("\n");
}

export function configEditorActions(
  decision: SetupRouteDecision,
  session: SetupEditorPlanSession,
  copyValues: Record<string, SetupPromptValue> = {},
  locale: SetupCopyLocale = "en"
): readonly ConfigEditorRenderedAction[] {
  const routeActions = new Map(
    decision.actions
      .filter((action) => !action.mutatesConfig)
      .map((action) => [action.id, action])
  );
  const readOnlyActions = PR4_ACTION_ORDER.map((id) => {
    const routeAction = routeActions.get(id);
    return routeAction === undefined
      ? syntheticAction(id, locale)
      : renderRouteAction(routeAction, locale);
  });

  if (decision.state.kind === "broken-config" || decision.state.kind === "state-not-writable") {
    return readOnlyActions;
  }

  const editorActions = new Map(session.plan.actions.map((action) => [action.id, action]));
  const guidedActions = PR6_EDITOR_ACTION_ORDER
    .map((id) => editorActions.get(id))
    .filter((action): action is SetupEditorActionDraft => action !== undefined)
    .map((action) => renderEditorAction(action, copyValues, locale));

  return [...guidedActions, ...readOnlyActions];
}

export function isConfigEditorActionId(
  id: string,
  actions: readonly ConfigEditorRenderedAction[]
): id is ConfigEditorRenderedAction["id"] {
  return actions.some((action) => action.id === id);
}

export function configEditorHiddenDirectAction(
  session: SetupEditorPlanSession,
  id: string,
  copyValues: Record<string, SetupPromptValue> = {},
  locale: SetupCopyLocale = "en"
): ConfigEditorRenderedAction | undefined {
  if (id !== "add-custom-provider-route") {
    return undefined;
  }
  const action = session.plan.actions.find((candidate) => candidate.id === id);
  return action === undefined ? undefined : renderEditorAction(action, copyValues, locale);
}

function renderRouteAction(
  action: SetupRouteAction,
  locale: SetupCopyLocale
): ConfigEditorRenderedAction {
  const localized = routeActionCopy(action.id, locale);
  return {
    id: action.id,
    label: localized?.label ?? action.label,
    description: localized?.description ?? action.description,
    group: action.id === "exit" ? "navigation" : undefined,
    readOnly: !action.mutatesConfig,
    source: "route",
  };
}

function renderEditorAction(
  action: SetupEditorActionDraft,
  copyValues: Record<string, SetupPromptValue>,
  locale: SetupCopyLocale
): ConfigEditorRenderedAction {
  const baseLabel = formatSetupCopy(locale, action.copyKey, copyValues);
  return {
    id: action.id,
    label: spendingLimitActionLabel(action, baseLabel, locale),
    description: editorActionDescription(action, locale),
    group: action.effect === "exit" ? "navigation" : undefined,
    readOnly: action.readOnly,
    source: "editor",
    editorAction: action,
  };
}

function spendingLimitActionLabel(
  action: SetupEditorActionDraft,
  baseLabel: string,
  locale: SetupCopyLocale
): string {
  if (action.id !== "edit-spending-limit-for-task" && action.id !== "edit-spending-limit-for-session") {
    return baseLabel;
  }
  const maximum = action.reviewValues?.maxEstimatedCostUsd;
  const status = action.reviewValues?.enabled === true && typeof maximum === "number"
    ? setupTechnicalToken(locale, `$${maximum.toFixed(2)} USD`)
    : setupCopyText(locale, "setupEditor.budgets.off");
  return `${baseLabel} — ${status}`;
}

function syntheticAction(id: SetupRouteActionId, locale: SetupCopyLocale): ConfigEditorRenderedAction {
  const localized = routeActionCopy(id, locale);
  switch (id) {
    case "run-doctor":
      return {
        id,
        label: localized.label,
        description: localized.description,
        readOnly: true,
        source: "synthetic",
      };
    case "verify-setup":
      return {
        id,
        label: localized.label,
        description: localized.description,
        readOnly: true,
        source: "synthetic",
      };
    case "show-diagnostics":
      return {
        id,
        label: localized.label,
        description: localized.description,
        readOnly: true,
        source: "synthetic",
      };
    case "exit":
      return {
        id,
        label: localized.label,
        description: localized.description,
        group: "navigation",
        readOnly: true,
        source: "synthetic",
      };
    default:
      throw new Error(`Cannot synthesize unsupported PR4 setup editor action ${id}.`);
  }
}

function routeActionCopy(
  id: SetupRouteActionId,
  locale: SetupCopyLocale
): { readonly label: string; readonly description: string } {
  switch (id) {
    case "run-doctor":
      return {
        label: setupCopyText(locale, "setupEditor.actions.runDoctor"),
        description: setupCopyText(locale, "setupEditor.actions.runDoctor.description"),
      };
    case "verify-setup":
      return {
        label: setupCopyText(locale, "setupEditor.actions.runReadonlyVerification"),
        description: setupCopyText(locale, "setupEditor.actions.runReadonlyVerification.description"),
      };
    case "show-diagnostics":
      return {
        label: setupCopyText(locale, "setupEditor.actions.showDiagnostics"),
        description: setupCopyText(locale, "setupEditor.actions.showDiagnostics.description"),
      };
    case "exit":
      return {
        label: setupCopyText(locale, "setupEditor.actions.exitWithoutChanges"),
        description: setupCopyText(locale, "setupEditor.actions.exitWithoutChanges.description"),
      };
    default:
      return {
        label: setupCopyText(locale, "setupReview.itemFallback"),
        description: setupCopyText(locale, "setupReview.itemFallback"),
      };
  }
}

function editorActionDescription(action: SetupEditorActionDraft, locale: SetupCopyLocale): string {
  switch (action.id) {
    case "repair-workspace-trust":
      return setupCopyText(locale, "setupEditor.actions.repairWorkspaceTrust.description");
    case "edit-security-mode":
      return setupCopyText(locale, "setupEditor.actions.editSecurityMode.description");
    case "edit-workflow-learning":
      return setupCopyText(locale, "setupEditor.actions.editWorkflowLearning.description");
    case "edit-spending-limit-for-task":
      return setupCopyText(locale, "setupEditor.actions.editTaskSpendingLimit.description");
    case "edit-spending-limit-for-session":
      return setupCopyText(locale, "setupEditor.actions.editSessionSpendingLimit.description");
    case "edit-language":
      return setupCopyText(locale, "setupEditor.actions.chooseLanguage.description");
    case "configure-channels":
      return setupCopyText(locale, "setupEditor.actions.configureChannels.description");
    case "configure-voice":
      return setupCopyText(locale, "setupEditor.actions.configureVoice.description");
    case "configure-image-generation":
      return setupCopyText(locale, "setupEditor.actions.configureImageGeneration.description");
    case "configure-web-search":
      return setupCopyText(locale, "setupEditor.actions.configureWebSearch.description");
    case "configure-browser":
      return setupCopyText(locale, "setupEditor.actions.configureBrowser.description");
    case "repair-primary-provider":
      return setupCopyText(locale, "setupEditor.actions.repairPrimaryProvider.description");
    case "edit-primary-model-route":
      return setupCopyText(locale, "setupEditor.actions.editPrimaryModelRoute.description");
    case "add-custom-provider-route":
      return setupCopyText(locale, "setupEditor.actions.addCustomProviderRoute.description");
    case "edit-fallback-model-route":
      return setupCopyText(locale, "setupEditor.actions.editFallbackModelRoute.description");
    case "edit-auxiliary-model-route":
      return setupCopyText(locale, "setupEditor.actions.editAuxiliaryModelRoute.description");
    case "repair-missing-credential":
      return setupCopyText(locale, "setupEditor.actions.repairMissingCredential.description");
    default:
      return setupCopyText(locale, action.copyKey);
  }
}

function appendUnsafeStateGuidance(lines: string[], decision: SetupRouteDecision, locale: SetupCopyLocale): void {
  if (decision.state.kind === "broken-config") {
    lines.push(
      "",
      `${setupCopyText(locale, "setupEditor.diagnostics.manualRepair.heading")}:`,
      `- ${setupCopyText(locale, "setupEditor.diagnostics.manualRepair.brokenConfig")}`,
      `- ${setupCopyText(locale, "setupEditor.diagnostics.manualRepair.availableActions")}`
    );
  }

  if (decision.state.kind === "state-not-writable") {
    lines.push(
      "",
      `${setupCopyText(locale, "setupEditor.diagnostics.manualRepair.heading")}:`,
      `- ${setupCopyText(locale, "setupEditor.diagnostics.manualRepair.stateNotWritable")}`,
      `- ${setupCopyText(locale, "setupEditor.diagnostics.manualRepair.availableActions")}`
    );
  }
}
