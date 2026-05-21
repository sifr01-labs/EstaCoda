export type SessionRuntimeContext = {
  currentSessionId(): string;
  rotateSession(sessionId: string): void;
};

export function createSessionRuntimeContext(initialSessionId: string): SessionRuntimeContext {
  let activeSessionId = initialSessionId;

  return {
    currentSessionId() {
      return activeSessionId;
    },
    rotateSession(sessionId: string) {
      activeSessionId = sessionId;
    }
  };
}
