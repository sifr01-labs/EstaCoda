import type { BrowserStateProjection } from "../contracts/browser.js";

export type SessionRuntimeContext = {
  currentSessionId(): string;
  rotateSession(sessionId: string): void;
  browserState(): BrowserStateProjection | undefined;
  setBrowserState(state: BrowserStateProjection | undefined): void;
};

export function createSessionRuntimeContext(initialSessionId: string): SessionRuntimeContext {
  let activeSessionId = initialSessionId;
  const browserStates = new Map<string, BrowserStateProjection>();

  return {
    currentSessionId() {
      return activeSessionId;
    },
    rotateSession(sessionId: string) {
      activeSessionId = sessionId;
    },
    browserState() {
      return browserStates.get(activeSessionId);
    },
    setBrowserState(state) {
      if (state === undefined) {
        browserStates.delete(activeSessionId);
        return;
      }
      browserStates.set(activeSessionId, state);
    }
  };
}
