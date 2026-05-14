import type { Prompt } from "../../cli/readline-prompt.js";
import type {
  SetupApplyEndState,
  SetupApplyExecutor,
  SetupApplyFlowOptions,
  SetupApplyPlanningResult,
} from "../setup-apply-plan.js";
import type { SetupEditorActionId } from "../setup-editor-actions.js";
import type { SetupReviewManifest } from "../setup-review-manifest.js";
import {
  collectSetupRoute,
  type CollectSetupRouteOptions,
  type SetupRouteActionId,
  type SetupRouteDecision,
} from "../setup-router.js";
import { promptConfigEditorAction } from "./prompts.js";
import {
  isNonMutatingConfigEditorActionId,
  nonMutatingConfigEditorActions,
  renderConfigEditor,
  renderConfigEditorDiagnostics,
  type ConfigEditorRenderedAction,
} from "./render.js";

export type ConfigEditorRunnerOptions = CollectSetupRouteOptions & {
  readonly prompt: Prompt;
  readonly applyExecutor?: SetupApplyExecutor;
  readonly output?: { readonly write: (value: string) => void };
  readonly defaultActionId?: SetupEditorActionId | SetupRouteActionId;
  readonly applyFlowOptions?: SetupApplyFlowOptions;
};

export type ConfigEditorRunnerResult = {
  readonly completed: boolean;
  readonly exitCode: number;
  readonly output: string;
  readonly initialDecision: SetupRouteDecision;
  readonly finalDecision?: SetupRouteDecision;
  readonly selectedActionId?: string;
  readonly reviewManifest?: SetupReviewManifest;
  readonly applyPlanningResult?: SetupApplyPlanningResult;
  readonly applyEndState?: SetupApplyEndState;
};

export async function runConfigEditor(
  options: ConfigEditorRunnerOptions
): Promise<ConfigEditorRunnerResult> {
  const initialDecision = await collectSetupRoute(options);
  const session = initialDecision.setupEditorPlanSession;

  if (session === undefined) {
    const output = "Guided setup editor is available only for configured, degraded, or repair setup states.";
    write(options, `${output}\n`);
    return {
      completed: false,
      exitCode: 1,
      output,
      initialDecision,
    };
  }

  const actions = nonMutatingConfigEditorActions(initialDecision, session);
  const rendered = renderConfigEditor({ decision: initialDecision, session, actions });
  write(options, `${rendered}\n`);

  const selectedAction = await selectAction(options, actions);
  if (selectedAction === undefined) {
    const output = "No non-mutating setup editor actions are available.";
    write(options, `${output}\n`);
    return {
      completed: false,
      exitCode: 1,
      output,
      initialDecision,
    };
  }

  if (!isNonMutatingConfigEditorActionId(selectedAction.id, actions)) {
    const output = `Action ${selectedAction.id} is not available in the read-only setup editor skeleton.`;
    write(options, `${output}\n`);
    return {
      completed: false,
      exitCode: 1,
      output,
      initialDecision,
      selectedActionId: selectedAction.id,
    };
  }

  const allowedAction = actions.find((action) => action.id === selectedAction.id);
  if (allowedAction === undefined) {
    throw new Error(`Allowed setup editor action ${selectedAction.id} was not found.`);
  }

  return handleReadOnlyAction(options, initialDecision, allowedAction);
}

async function selectAction(
  options: ConfigEditorRunnerOptions,
  actions: readonly ConfigEditorRenderedAction[]
): Promise<ConfigEditorRenderedAction | { readonly id: string } | undefined> {
  if (options.defaultActionId !== undefined) {
    const normalizedActionId = normalizePr4ActionId(options.defaultActionId);
    return actions.find((action) => action.id === normalizedActionId) ?? { id: normalizedActionId };
  }

  return promptConfigEditorAction(options.prompt, actions);
}

async function handleReadOnlyAction(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  action: ConfigEditorRenderedAction
): Promise<ConfigEditorRunnerResult> {
  switch (action.id) {
    case "verify-setup": {
      const finalDecision = await collectSetupRoute({ ...options, selection: "verify" });
      const output = "Read-only setup verification route prepared.";
      write(options, `${output}\n`);
      return {
        completed: true,
        exitCode: 0,
        output,
        initialDecision,
        finalDecision,
        selectedActionId: action.id,
      };
    }
    case "show-diagnostics": {
      const output = renderConfigEditorDiagnostics(initialDecision);
      write(options, `${output}\n`);
      return {
        completed: true,
        exitCode: 0,
        output,
        initialDecision,
        selectedActionId: action.id,
      };
    }
    case "exit": {
      const output = "Exited setup editor without applying changes.";
      write(options, `${output}\n`);
      return {
        completed: true,
        exitCode: 0,
        output,
        initialDecision,
        selectedActionId: action.id,
      };
    }
    default: {
      const output = `Action ${action.id} is not implemented in PR4.`;
      write(options, `${output}\n`);
      return {
        completed: false,
        exitCode: 1,
        output,
        initialDecision,
        selectedActionId: action.id,
      };
    }
  }
}

function normalizePr4ActionId(id: SetupEditorActionId | SetupRouteActionId): string {
  switch (id) {
    case "run-readonly-verification":
      return "verify-setup";
    case "cancel-setup-editor":
      return "exit";
    case "repair-broken-config":
    case "repair-state-directory":
      return "show-diagnostics";
    default:
      return id;
  }
}

function write(options: ConfigEditorRunnerOptions, value: string): void {
  options.output?.write(value);
}

export const runConfigEditorSetup = runConfigEditor;
