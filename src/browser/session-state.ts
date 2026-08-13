import type { BrowserSessionStateReason } from "../contracts/browser.js";

export class BrowserSessionStateError extends Error {
  readonly reason: Exclude<BrowserSessionStateReason, "backend_available">;

  constructor(
    reason: Exclude<BrowserSessionStateReason, "backend_available">,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "BrowserSessionStateError";
    this.reason = reason;
  }
}

export function browserSessionStateReason(error: unknown): BrowserSessionStateReason | undefined {
  if (error instanceof BrowserSessionStateError) {
    return error.reason;
  }
  if (!(error instanceof Error)) {
    return undefined;
  }
  return /(?:CDP WebSocket (?:closed|errored|connection failed)|Browser backend is closed)/iu.test(error.message)
    ? "browser_process_missing"
    : undefined;
}
