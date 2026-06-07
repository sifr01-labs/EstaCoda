export interface BrowserSessionKeyContext {
  currentSessionId: () => string;
}

export function deriveBrowserSessionKey(
  ctx: BrowserSessionKeyContext,
  explicitSessionId?: string
): string {
  if (explicitSessionId !== undefined && explicitSessionId.trim() !== "") {
    return explicitSessionId;
  }

  const runtimeSessionId = ctx.currentSessionId();
  if (typeof runtimeSessionId !== "string" || runtimeSessionId.trim() === "") {
    throw new Error("Browser session key requires a current runtime session ID when no explicit browser sessionId is provided.");
  }

  return `${runtimeSessionId}:main`;
}
