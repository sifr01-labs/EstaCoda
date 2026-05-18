import type { ChannelTextAction } from "../contracts/channel.js";

export type ApprovalActionDecision = "approved" | "denied";
export type ApprovalActionScope = "once" | "session" | "always";

const ACTION_PREFIX = "ecap1";
const DECISION_CODES: Record<ApprovalActionDecision, string> = {
  approved: "a",
  denied: "d"
};
const SCOPE_CODES: Record<ApprovalActionScope, string> = {
  once: "o",
  session: "s",
  always: "p"
};

const DECISIONS_BY_CODE: Record<string, ApprovalActionDecision> = {
  a: "approved",
  d: "denied"
};
const SCOPES_BY_CODE: Record<string, ApprovalActionScope> = {
  o: "once",
  s: "session",
  p: "always"
};

export function renderApprovalActions(approvalId: string): ChannelTextAction[][] {
  return [
    [
      { label: "Allow once", value: approvalActionValue(approvalId, "approved", "once") },
      { label: "Allow session", value: approvalActionValue(approvalId, "approved", "session") }
    ],
    [
      { label: "Allow always", value: approvalActionValue(approvalId, "approved", "always") },
      { label: "Deny", value: approvalActionValue(approvalId, "denied") }
    ]
  ];
}

export function parseApprovalAction(value: string):
  | { approvalId: string; decision: ApprovalActionDecision; scope?: ApprovalActionScope }
  | undefined {
  const parts = value.trim().split(":");
  if (parts.length !== 4 || parts[0] !== ACTION_PREFIX) {
    return undefined;
  }

  const decision = DECISIONS_BY_CODE[parts[1] ?? ""];
  if (decision === undefined) {
    return undefined;
  }

  const scopeCode = parts[2] ?? "";
  const scope = scopeCode === "-"
    ? undefined
    : SCOPES_BY_CODE[scopeCode];
  if (decision === "approved" && scope === undefined) {
    return undefined;
  }
  if (decision === "denied" && scope !== undefined) {
    return undefined;
  }

  let approvalId: string;
  try {
    approvalId = decodeURIComponent(parts[3] ?? "");
  } catch {
    return undefined;
  }

  if (approvalId.trim().length === 0) {
    return undefined;
  }

  return {
    approvalId,
    decision,
    scope
  };
}

function approvalActionValue(
  approvalId: string,
  decision: ApprovalActionDecision,
  scope?: ApprovalActionScope
): string {
  return [
    ACTION_PREFIX,
    DECISION_CODES[decision],
    scope === undefined ? "-" : SCOPE_CODES[scope],
    encodeURIComponent(approvalId)
  ].join(":");
}
