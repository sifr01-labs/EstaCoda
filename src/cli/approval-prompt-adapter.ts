import type { ViewModel } from "../contracts/view-model.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
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
  suspendChromeForTranscript<T>(fn: () => T | Promise<T>): Promise<T>;
  suspendForPrompt?<T>(fn: () => T | Promise<T>): Promise<T>;
};

export type ApprovalPromptAdapterInput = {
  readonly prompt: (question: string) => Promise<string>;
  readonly output: Pick<NodeJS.WritableStream, "write">;
  readonly renderer: { render(viewModel: ViewModel): string };
  readonly chrome: ApprovalPromptChrome;
  readonly execution: ToolExecutionRecord;
  readonly allowPersistentApproval: boolean;
};

export type ApprovalPromptAdapter = (input: ApprovalPromptAdapterInput) => Promise<string>;

export const papyrusApprovalPromptAdapter: ApprovalPromptAdapter = async (input) => {
  const promptText = "approval action > ";
  const cardText = renderPapyrusApprovalPromptCard(input.execution, input.allowPersistentApproval);
  if (input.chrome.suspendForPrompt !== undefined) {
    return await input.chrome.suspendForPrompt(async () => {
      input.output.write(`${cardText}\n`);
      return mapPapyrusApprovalAnswer(await input.prompt(promptText), input.allowPersistentApproval);
    });
  }

  input.chrome.clearInlineSpinner();
  if (input.chrome.enabled) {
    await input.chrome.suspendChromeForTranscript(() => {
      input.output.write(`${cardText}\n`);
    });
  } else {
    input.output.write(`${cardText}\n`);
  }
  return mapPapyrusApprovalAnswer(await input.prompt(promptText), input.allowPersistentApproval);
};

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
