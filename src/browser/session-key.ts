export interface BrowserSessionKeyContext {
  currentSessionId: () => string;
}

export function deriveBrowserSessionKey(
  ctx: BrowserSessionKeyContext,
  explicitSessionId?: string
): string {
  const runtimeSessionId = ctx.currentSessionId();
  if (explicitSessionId !== undefined && explicitSessionId.trim() !== "") {
    if (isRuntimeSessionId(runtimeSessionId) && explicitSessionId.trim() === runtimeSessionId.trim()) {
      return `${runtimeSessionId.trim()}:main`;
    }
    return explicitSessionId;
  }

  if (!isRuntimeSessionId(runtimeSessionId)) {
    throw new Error("Browser session key requires a current runtime session ID when no explicit browser sessionId is provided.");
  }

  return `${runtimeSessionId.trim()}:main`;
}

function isRuntimeSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
