export const APPROVAL_FOCUS_CONTROLS = ["approve", "reject", "inspect"] as const;

export type ApprovalFocusControl = typeof APPROVAL_FOCUS_CONTROLS[number];

export type FocusTarget =
  | { readonly kind: "prompt" }
  | { readonly kind: "attachment"; readonly attachmentId: string }
  | { readonly kind: "taskCard"; readonly taskId: string }
  | { readonly kind: "taskSubagent"; readonly taskId: string; readonly stepId: string }
  | { readonly kind: "activeWork"; readonly toolEventId: string }
  | {
      readonly kind: "approval";
      readonly approvalId: string;
      readonly control: ApprovalFocusControl;
    }
  | { readonly kind: "slashMenu"; readonly itemId: string }
  | { readonly kind: "steer" }
  | { readonly kind: "setup"; readonly controlId: string };

export type FocusState = {
  readonly target: FocusTarget;
  readonly previous?: FocusTarget;
};

export function createInitialFocusState(target: FocusTarget = { kind: "prompt" }): FocusState {
  return { target };
}

export function setFocus(state: FocusState, target: FocusTarget): FocusState {
  if (isSameFocusTarget(state.target, target)) return state;
  return {
    target,
    previous: state.target,
  };
}

export function restorePreviousFocus(state: FocusState): FocusState {
  if (state.previous === undefined) return state;
  return {
    target: state.previous,
    previous: state.target,
  };
}

export function isPromptFocused(state: FocusState): boolean {
  return state.target.kind === "prompt";
}

export function createApprovalFocusTarget(
  approvalId: string,
  control: ApprovalFocusControl
): FocusTarget {
  if (!isApprovalFocusControl(control)) {
    throw new Error(`Unsupported approval focus control: ${String(control)}`);
  }
  return { kind: "approval", approvalId, control };
}

export function isApprovalFocusControl(value: string): value is ApprovalFocusControl {
  return (APPROVAL_FOCUS_CONTROLS as readonly string[]).includes(value);
}

function isSameFocusTarget(left: FocusTarget, right: FocusTarget): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "prompt":
    case "steer":
      return true;
    case "attachment":
      return left.attachmentId === (right as Extract<FocusTarget, { kind: "attachment" }>).attachmentId;
    case "taskCard":
      return left.taskId === (right as Extract<FocusTarget, { kind: "taskCard" }>).taskId;
    case "taskSubagent": {
      const subagent = right as Extract<FocusTarget, { kind: "taskSubagent" }>;
      return left.taskId === subagent.taskId && left.stepId === subagent.stepId;
    }
    case "activeWork":
      return left.toolEventId === (right as Extract<FocusTarget, { kind: "activeWork" }>).toolEventId;
    case "approval": {
      const approval = right as Extract<FocusTarget, { kind: "approval" }>;
      return left.approvalId === approval.approvalId && left.control === approval.control;
    }
    case "slashMenu":
      return left.itemId === (right as Extract<FocusTarget, { kind: "slashMenu" }>).itemId;
    case "setup":
      return left.controlId === (right as Extract<FocusTarget, { kind: "setup" }>).controlId;
  }
}
