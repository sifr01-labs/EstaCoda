import type { ViewModel } from "../contracts/view-model.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import {
  approvalCardStateFromToolExecution,
  createApprovalFocusTarget,
  createInitialOperatorConsoleState,
  routeApprovalKey,
  type ApprovalCardState,
  type ApprovalIntent,
  type OperatorConsoleRuntimeHost,
} from "../ui/papyrus/operator-console/index.js";
import { parseKeypress, type ParsedKeypress } from "../ui/input/parseKeypress.js";
import {
  buildApprovalCardRenderRows,
  createApprovalCardState,
  type ApprovalCardAction,
  type ApprovalCardRenderRow,
} from "../ui/papyrus/widgets/approvalCardModel.js";
import { buildApprovalPromptViewModel } from "./tool-activity-view-models.js";

export type ApprovalPromptChrome = {
  readonly enabled: boolean;
  clearInlineSpinner(): void;
};

export type ApprovalPromptAdapterInput = {
  readonly prompt: (question: string) => Promise<string>;
  readonly input?: NodeJS.ReadStream;
  readonly output: Pick<NodeJS.WritableStream, "write">;
  readonly renderer: { render(viewModel: ViewModel): string };
  readonly chrome?: ApprovalPromptChrome;
  readonly execution: ToolExecutionRecord;
  readonly allowPersistentApproval: boolean;
  readonly operatorConsoleHost?: OperatorConsoleRuntimeHost;
};

export type ApprovalPromptAdapter = (input: ApprovalPromptAdapterInput) => Promise<string>;

export const papyrusApprovalPromptAdapter: ApprovalPromptAdapter = async (input) => {
  if (input.operatorConsoleHost !== undefined) {
    return await operatorConsoleApprovalPromptAdapter(input);
  }

  const promptText = "approval action > ";
  const cardText = renderPapyrusApprovalPromptCard(input.execution, input.allowPersistentApproval);
  input.chrome?.clearInlineSpinner();
  input.output.write(`${cardText}\n`);
  return mapPapyrusApprovalAnswer(await input.prompt(promptText), input.allowPersistentApproval);
};

async function operatorConsoleApprovalPromptAdapter(input: ApprovalPromptAdapterInput): Promise<string> {
  const host = input.operatorConsoleHost;
  if (host === undefined) {
    return mapPapyrusApprovalAnswer(await input.prompt("approval action > "), input.allowPersistentApproval);
  }

  const approval = approvalCardStateFromToolExecution(input.execution, { focused: true });
  if (input.input?.isTTY === true) {
    return await readInlineOperatorConsoleApproval({
      input: input.input,
      output: input.output,
      host,
      approval,
    });
  }

  host.setApprovals([approval]);
  const frame = host.render();
  input.output.write(`${frame.lines.join("\n")}\n`);

  const answer = await input.prompt("approval action > ");
  const intent = approvalIntentFromAnswer(answer, approval.id);
  if (intent !== undefined) {
    return mapOperatorConsoleApprovalIntent(intent);
  }
  return mapPapyrusApprovalAnswer(answer, input.allowPersistentApproval);
}

async function readInlineOperatorConsoleApproval(input: {
  readonly input: NodeJS.ReadStream;
  readonly output: Pick<NodeJS.WritableStream, "write">;
  readonly host: OperatorConsoleRuntimeHost;
  readonly approval: ApprovalCardState;
}): Promise<string> {
  let state = createInitialOperatorConsoleState({
    terminal: input.host.getState().terminal,
    status: input.host.getState().status,
    approvals: [input.approval],
    focus: {
      target: createApprovalFocusTarget(input.approval.id, input.approval.focusedControl ?? "approve"),
    },
  });
  let renderedRows = 0;
  const wasRaw = input.input.isRaw === true;

  const moveToFirstRenderedRow = () => {
    if (renderedRows > 1) input.output.write(`\x1b[${renderedRows - 1}A`);
    if (renderedRows > 0) input.output.write("\r");
  };
  const render = () => {
    input.host.clear();
    input.host.setApprovals(state.approvals);
    const frame = input.host.render();
    moveToFirstRenderedRow();
    const physicalRows = Math.max(renderedRows, frame.lines.length);
    for (let row = 0; row < physicalRows; row += 1) {
      input.output.write("\x1b[0K");
      if (row < frame.lines.length) input.output.write(frame.lines[row]!);
      if (row < physicalRows - 1) input.output.write("\n");
    }
    input.output.write("\r");
    renderedRows = frame.lines.length;
  };
  const clear = () => {
    if (renderedRows === 0) return;
    moveToFirstRenderedRow();
    for (let row = 0; row < renderedRows; row += 1) {
      input.output.write("\x1b[0K");
      if (row < renderedRows - 1) input.output.write("\n");
    }
    input.output.write("\r");
    renderedRows = 0;
  };

  return await new Promise<string>((resolve) => {
    let settled = false;
    const finish = (answer: string) => {
      if (settled) return;
      settled = true;
      input.input.off("data", onData);
      if (!wasRaw) {
        input.input.setRawMode?.(false);
      }
      clear();
      input.host.setApprovals([]);
      resolve(answer);
    };
    const handleKeypress = (event: ParsedKeypress) => {
      const result = routeApprovalKey(state, event);
      state = result.state;
      if (result.intent.type !== "none") {
        finish(mapOperatorConsoleApprovalIntent(result.intent));
        return;
      }
      render();
    };
    const onData = (chunk: string | Buffer | Uint8Array) => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      for (const keypress of parseKeypress(text)) {
        handleKeypress(keypress);
        if (settled) return;
      }
    };

    input.input.on("data", onData);
    input.input.setRawMode?.(true);
    input.input.resume();
    render();
  });
}

function approvalIntentFromAnswer(answer: string, approvalId: string): ApprovalIntent | undefined {
  const normalized = answer.trim().toLowerCase().replace(/\s+/gu, " ");
  const key = normalized === "1" || normalized === "approve" || normalized === "approve once" || normalized === "approve-once"
    ? "enter"
    : normalized === "2" || normalized === "reject" || normalized === "deny"
      ? "enter"
      : normalized === "3" || normalized === "inspect"
        ? "enter"
        : normalized === "escape" || normalized === "esc" || normalized === "cancel"
          ? "escape"
          : undefined;
  if (key === undefined) return undefined;

  const focusedControl = normalized === "2" || normalized === "reject" || normalized === "deny"
    ? "reject"
    : normalized === "3" || normalized === "inspect"
      ? "inspect"
      : "approve";
  const state = createInitialOperatorConsoleState({
    approvals: [{
      id: approvalId,
      status: "pending",
      action: "approval",
      target: "approval",
      focusedControl,
    }],
    focus: {
      target: createApprovalFocusTarget(approvalId, focusedControl),
    },
  });
  return routeApprovalKey(state, { type: "key", key }).intent;
}

function mapOperatorConsoleApprovalIntent(intent: ApprovalIntent): string {
  switch (intent.type) {
    case "approve":
      return "once";
    case "reject":
      return "deny";
    case "inspect":
      return "inspect";
    case "none":
      return "";
  }
}

function renderPapyrusApprovalPromptCard(
  execution: ToolExecutionRecord,
  allowPersistentApproval: boolean
): string {
  const vm = buildApprovalPromptViewModel(execution, { allowPersistentApproval });
  const actions: Array<ApprovalCardAction<"once" | "session" | "always" | "deny" | "cancel">> = [
    { value: "once", label: "Allow once", intentKind: "approve-once" },
    { value: "session", label: "Allow for this session", intentKind: "custom" },
  ];
  if (allowPersistentApproval) {
    actions.push({ value: "always", label: "Always allow", intentKind: "custom" });
  }
  actions.push(
    { value: "deny", label: "Deny", intentKind: "reject" },
    { value: "cancel", label: "Cancel", intentKind: "cancel" }
  );

  const state = createApprovalCardState({
    title: `Approval required: ${vm.toolName}`,
    body: vm.targetSummary,
    severity: vm.severity === "error" ? "danger" : vm.severity === "warn" ? "warning" : "info",
    riskLabel: vm.riskClass,
    details: (vm.details ?? []).map((detail) => ({ kind: "detail" as const, label: "Detail", value: detail })),
    actions,
    keyboardHints: [
      { key: "1", label: "once" },
      { key: "2", label: "session" },
      ...(allowPersistentApproval ? [{ key: "3", label: "always" }] : []),
      { key: "deny", label: "reject" },
    ],
  });
  return renderPapyrusApprovalRows(buildApprovalCardRenderRows(state));
}

function renderPapyrusApprovalRows(rows: readonly ApprovalCardRenderRow[]): string {
  return rows.map((row) => {
    switch (row.kind) {
      case "title":
        return `[Approval] ${row.text}${row.riskLabel === undefined ? "" : ` (${row.riskLabel})`}`;
      case "body":
        return row.text;
      case "detail":
        return `${row.label}: ${row.value}`;
      case "hint":
        return row.text;
      case "feedbackInput":
        return `${row.label ?? "Feedback"}: ${row.value.length > 0 ? row.value : row.placeholder ?? ""}`;
      case "action":
        return `${row.focused ? ">" : " "} ${row.label}${row.disabled ? " (disabled)" : ""}`;
      case "keyboardHint":
        return `  ${row.key}: ${row.label}`;
    }
  }).join("\n");
}

function mapPapyrusApprovalAnswer(answer: string, allowPersistentApproval: boolean): string {
  const normalized = answer.trim().toLowerCase().replace(/\s+/gu, " ");
  if (normalized === "approve-once" || normalized === "allow once" || normalized === "1") return "once";
  if (normalized === "session" || normalized === "allow session" || normalized === "2") return "session";
  if (allowPersistentApproval && (normalized === "always" || normalized === "persist" || normalized === "3")) {
    return "always";
  }
  if (
    normalized === "reject" ||
    normalized === "deny" ||
    normalized === "no" ||
    normalized === "n" ||
    normalized === "4"
  ) {
    return "deny";
  }
  if (normalized === "cancel" || normalized === "escape" || normalized === "esc") return "cancel";
  return answer;
}
