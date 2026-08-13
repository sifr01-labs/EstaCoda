import type { ChannelTextAction } from "../contracts/channel.js";

export type ApprovalActionDecision = "approved" | "denied";
export type ApprovalActionScope = "once" | "session" | "always";

const ACTION_PREFIX = "ecap1";
const SECURE_INPUT_ACTION_PREFIX = "ecsi1";
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

export function renderSetupApprovalActions(approvalId: string): ChannelTextAction[][] {
  const actions = renderApprovalActions(approvalId);
  return [
    [
      { label: "Install", value: actions[0]?.[0]?.value ?? approvalActionValue(approvalId, "approved", "once") },
      { label: "Deny", value: actions[1]?.[1]?.value ?? approvalActionValue(approvalId, "denied") }
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

export type SecureInputAction = "arm" | "trusted-device" | "destination-entry" | "cancel";

const SECURE_INPUT_ACTION_CODES: Record<SecureInputAction, string> = {
  arm: "a",
  "trusted-device": "t",
  "destination-entry": "d",
  cancel: "c"
};

const SECURE_INPUT_ACTIONS_BY_CODE: Record<string, SecureInputAction> = {
  a: "arm",
  t: "trusted-device",
  d: "destination-entry",
  c: "cancel"
};

export function renderSecureInputActions(
  actionId: string,
  mode: "protected-handoff" | "direct-dm"
): ChannelTextAction[][] {
  return mode === "direct-dm"
    ? [
        [{ label: "Use next message", value: secureInputActionValue(actionId, "arm") }],
        [{ label: "Continue on trusted device", value: secureInputActionValue(actionId, "trusted-device") }],
        [{ label: "Cancel", value: secureInputActionValue(actionId, "cancel") }]
      ]
    : [
        [{ label: "Continue on trusted device", value: secureInputActionValue(actionId, "trusted-device") }],
        [{ label: "I'll enter it in the destination", value: secureInputActionValue(actionId, "destination-entry") }],
        [{ label: "Cancel", value: secureInputActionValue(actionId, "cancel") }]
      ];
}

export function parseSecureInputAction(value: string):
  | { actionId: string; action: SecureInputAction }
  | undefined {
  const parts = value.trim().split(":");
  if (parts.length !== 3 || parts[0] !== SECURE_INPUT_ACTION_PREFIX) return undefined;
  const action = SECURE_INPUT_ACTIONS_BY_CODE[parts[1] ?? ""];
  if (action === undefined) return undefined;
  let actionId: string;
  try {
    actionId = decodeURIComponent(parts[2] ?? "");
  } catch {
    return undefined;
  }
  return actionId.trim().length === 0 ? undefined : { actionId, action };
}

function secureInputActionValue(actionId: string, action: SecureInputAction): string {
  return [SECURE_INPUT_ACTION_PREFIX, SECURE_INPUT_ACTION_CODES[action], encodeURIComponent(actionId)].join(":");
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
