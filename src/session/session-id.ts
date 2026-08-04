import { randomUUID } from "node:crypto";

export function createSessionId(): string {
  return randomUUID();
}

export function formatSessionDisplayId(sessionId: string): string {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

export function resolveStartupSessionId(
  restoredSessionId: string | undefined,
  createId: () => string = createSessionId,
  requestedSessionId?: string
): string {
  return requestedSessionId ?? restoredSessionId ?? createId();
}
