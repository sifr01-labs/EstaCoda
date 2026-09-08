export type SessionLaunchIntent =
  | { readonly kind: "new" }
  | { readonly kind: "continue" }
  | { readonly kind: "pick"; readonly includeOtherWorkspaces: boolean }
  | { readonly kind: "open"; readonly sessionId: string };

export function resolveSessionLaunchIntent(input: {
  readonly argv: readonly string[];
  readonly continueSession: boolean;
  readonly selectedSessionId?: string;
}): SessionLaunchIntent {
  if (input.selectedSessionId !== undefined) {
    return { kind: "open", sessionId: input.selectedSessionId };
  }
  if (input.continueSession) {
    return { kind: "continue" };
  }
  if (input.argv[0] === "sessions" && input.argv.length === 1) {
    return { kind: "pick", includeOtherWorkspaces: false };
  }
  if (input.argv[0] === "sessions" && input.argv[1] === "open" && input.argv[2] !== undefined) {
    return { kind: "open", sessionId: input.argv[2] };
  }
  return { kind: "new" };
}
