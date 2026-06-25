import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyApprovalCardKey,
  buildApprovalCardRenderRows,
  createApprovalCardState,
  selectFocusedApprovalCardAction,
  updateApprovalCardFeedback,
} from "./approvalCardModel.js";

describe("Papyrus approval card model", () => {
  it("creates generic approval card state with display-only risk metadata", () => {
    const state = createApprovalCardState({
      title: "Permission required",
      body: "Review this action before continuing.",
      severity: "warning",
      riskLabel: "workspace-write",
      details: [
        { kind: "detail", label: "Tool", value: "workspace.write" },
        { kind: "hint", text: "Core approval policy interprets this intent." },
      ],
      actions: [
        { value: "approve", label: "Approve" },
        { value: "reject", label: "Reject" },
        { value: "cancel", label: "Cancel" },
      ],
      keyboardHints: [{ key: "Enter", label: "Select" }],
    });

    expect(state).toMatchObject({
      title: "Permission required",
      body: "Review this action before continuing.",
      severity: "warning",
      riskLabel: "workspace-write",
      focusedAction: "approve",
      cancelable: true,
    });
    expect(state.details).toHaveLength(2);
    expect(state.keyboardHints).toEqual([{ key: "Enter", label: "Select" }]);
  });

  it("moves focus across enabled actions and skips disabled actions", () => {
    const state = createApprovalCardState({
      title: "Permission required",
      actions: [
        { value: "approve", label: "Approve" },
        { value: "always", label: "Always", disabled: true },
        { value: "reject", label: "Reject" },
      ],
    });

    const next = applyApprovalCardKey(state, { key: "arrowRight" }).state;
    expect(next.focusedAction).toBe("reject");
    expect(applyApprovalCardKey(next, { key: "arrowLeft" }).state.focusedAction).toBe("approve");
    expect(applyApprovalCardKey(next, { key: "home" }).state.focusedAction).toBe("approve");
    expect(applyApprovalCardKey(state, { key: "end" }).state.focusedAction).toBe("reject");
  });

  it("prevents disabled actions from receiving focus or selected intent", () => {
    const state = createApprovalCardState({
      title: "Permission required",
      focusedAction: "always",
      actions: [
        { value: "approve", label: "Approve" },
        { value: "always", label: "Always", disabled: true },
      ],
    });

    expect(state.focusedAction).toBe("approve");
    expect(selectFocusedApprovalCardAction({
      ...state,
      focusedAction: "always",
    })).toEqual({
      state: {
        ...state,
        focusedAction: "always",
      },
    });
  });

  it("returns selected action intent data only on enter", () => {
    const state = createApprovalCardState({
      title: "Permission required",
      focusedAction: "reject",
      actions: [
        { value: "approve", label: "Approve" },
        { value: "reject", label: "Reject" },
      ],
    });

    expect(applyApprovalCardKey(state, { key: "enter" }).intent).toEqual({
      type: "action",
      value: "reject",
    });
  });

  it("returns cancel intent only when cancelable", () => {
    const cancelable = createApprovalCardState({
      title: "Permission required",
      actions: [{ value: "approve", label: "Approve" }],
    });
    expect(applyApprovalCardKey(cancelable, { key: "escape" }).intent).toEqual({
      type: "cancel",
    });

    const required = createApprovalCardState({
      title: "Permission required",
      cancelable: false,
      actions: [{ value: "approve", label: "Approve" }],
    });
    expect(applyApprovalCardKey(required, { key: "escape" })).toEqual({ state: required });
  });

  it("builds inert render rows with action focus and disabled metadata", () => {
    const state = createApprovalCardState({
      title: "Permission required",
      body: "Run tool?",
      severity: "danger",
      riskLabel: "destructive-local",
      details: [{ kind: "detail", label: "Command", value: "rm -rf tmp" }],
      actions: [
        { value: "approve", label: "Approve", description: "Allow once" },
        { value: "reject", label: "Reject", disabled: true },
      ],
      keyboardHints: [{ key: "Esc", label: "Cancel" }],
    });

    expect(buildApprovalCardRenderRows(state)).toEqual([
      { kind: "title", text: "Permission required", severity: "danger", riskLabel: "destructive-local" },
      { kind: "body", text: "Run tool?" },
      { kind: "detail", label: "Command", value: "rm -rf tmp" },
      {
        kind: "action",
        value: "approve",
        label: "Approve",
        description: "Allow once",
        actionKind: undefined,
        focused: true,
        disabled: false,
      },
      {
        kind: "action",
        value: "reject",
        label: "Reject",
        description: undefined,
        actionKind: undefined,
        focused: false,
        disabled: true,
      },
      { kind: "keyboardHint", key: "Esc", label: "Cancel" },
    ]);
  });

  it("updates feedback input and returns trimmed feedback intent data", () => {
    const state = createApprovalCardState({
      title: "Permission required",
      feedbackInput: {
        label: "Feedback",
        placeholder: "Tell the agent what to change",
        value: "  use a safer command  ",
      },
      focusedAction: "feedback",
      actions: [
        { value: "approve", label: "Approve", intentKind: "approve-once" },
        { value: "feedback", label: "Give feedback", intentKind: "feedback" },
      ],
    });

    expect(state.feedbackInput).toMatchObject({
      label: "Feedback",
      placeholder: "Tell the agent what to change",
      value: "  use a safer command  ",
      disabled: false,
      emptyBehavior: "allow",
    });
    expect(applyApprovalCardKey(state, { key: "enter" }).intent).toEqual({
      type: "action",
      value: "feedback",
      actionKind: "feedback",
      feedbackText: "use a safer command",
    });

    const updated = updateApprovalCardFeedback(state, "  try read-only first  ");
    expect(updated.feedbackInput?.value).toBe("  try read-only first  ");
    expect(applyApprovalCardKey(updated, { key: "enter" }).intent).toEqual({
      type: "action",
      value: "feedback",
      actionKind: "feedback",
      feedbackText: "try read-only first",
    });
  });

  it("makes empty feedback behavior explicit", () => {
    const allowEmpty = createApprovalCardState({
      title: "Permission required",
      feedbackInput: { value: "   " },
      focusedAction: "feedback",
      actions: [{ value: "feedback", label: "Feedback", intentKind: "feedback" }],
    });
    expect(applyApprovalCardKey(allowEmpty, { key: "enter" }).intent).toEqual({
      type: "action",
      value: "feedback",
      actionKind: "feedback",
      feedbackText: "",
    });

    const blockEmpty = createApprovalCardState({
      title: "Permission required",
      feedbackInput: { emptyBehavior: "block", value: "   " },
      focusedAction: "feedback",
      actions: [{ value: "feedback", label: "Feedback", intentKind: "feedback" }],
    });
    expect(applyApprovalCardKey(blockEmpty, { key: "enter" }).intent).toEqual({
      type: "emptyFeedback",
      value: "feedback",
    });
  });

  it("returns amend, ask-user, and dont-ask-again as action data only", () => {
    const state = createApprovalCardState({
      title: "Permission required",
      actions: [
        { value: "amend", label: "Amend", intentKind: "amend" },
        { value: "ask", label: "Ask user", intentKind: "ask-user" },
        { value: "always", label: "Don't ask again", intentKind: "dont-ask-again" },
      ],
    });

    expect(applyApprovalCardKey(state, { key: "enter" }).intent).toEqual({
      type: "action",
      value: "amend",
      actionKind: "amend",
    });
    const askUser = applyApprovalCardKey(applyApprovalCardKey(state, { key: "arrowRight" }).state, { key: "enter" });
    expect(askUser.intent).toEqual({
      type: "action",
      value: "ask",
      actionKind: "ask-user",
    });
    const dontAskAgain = applyApprovalCardKey(applyApprovalCardKey(askUser.state, { key: "arrowRight" }).state, {
      key: "enter",
    });
    expect(dontAskAgain.intent).toEqual({
      type: "action",
      value: "always",
      actionKind: "dont-ask-again",
    });
  });

  it("does not synthesize absent rich actions", () => {
    const state = createApprovalCardState({
      title: "Permission required",
      actions: [{ value: "approve", label: "Approve", intentKind: "approve-once" }],
    });

    const missingFeedback = selectFocusedApprovalCardAction({
      ...state,
      focusedAction: "feedback",
    });
    expect(missingFeedback).toEqual({
      state: {
        ...state,
        focusedAction: "feedback",
      },
    });
  });

  it("keeps disabled rich actions unselectable", () => {
    const state = createApprovalCardState({
      title: "Permission required",
      focusedAction: "feedback",
      feedbackInput: { value: "please explain" },
      actions: [
        { value: "approve", label: "Approve", intentKind: "approve-once" },
        { value: "feedback", label: "Feedback", intentKind: "feedback", disabled: true },
      ],
    });

    expect(state.focusedAction).toBe("approve");
    expect(selectFocusedApprovalCardAction({
      ...state,
      focusedAction: "feedback",
    })).toEqual({
      state: {
        ...state,
        focusedAction: "feedback",
      },
    });
  });

  it("renders feedback input and rich action metadata as inert rows", () => {
    const state = createApprovalCardState({
      title: "Permission required",
      feedbackInput: {
        label: "Feedback",
        placeholder: "What should change?",
        value: "use a safer path",
      },
      actions: [
        { value: "feedback", label: "Give feedback", intentKind: "feedback" },
        { value: "amend", label: "Amend", intentKind: "amend" },
      ],
    });

    expect(buildApprovalCardRenderRows(state)).toEqual([
      { kind: "title", text: "Permission required", severity: undefined, riskLabel: undefined },
      {
        kind: "feedbackInput",
        label: "Feedback",
        placeholder: "What should change?",
        value: "use a safer path",
        disabled: false,
      },
      {
        kind: "action",
        value: "feedback",
        label: "Give feedback",
        description: undefined,
        actionKind: "feedback",
        focused: true,
        disabled: false,
      },
      {
        kind: "action",
        value: "amend",
        label: "Amend",
        description: undefined,
        actionKind: "amend",
        focused: false,
        disabled: false,
      },
    ]);
  });

  it("contains no security, approval grant, CLI, runtime, or provider imports", () => {
    const source = readFileSync(fileURLToPath(new URL("./approvalCardModel.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/\bsrc\/(security|runtime|providers|cli)\//u);
    expect(source).not.toMatch(/\.\.\/\.\.\/(security|runtime|providers|cli)\//u);
    expect(source).not.toMatch(/\bgrantApproval\b/u);
    expect(source).not.toMatch(/\bWorkspaceApproval/u);
  });
});
