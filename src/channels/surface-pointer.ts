/**
 * Surface pointer model.
 *
 * A surface is a user-facing interaction context (CLI workspace, Telegram chat,
 * Discord channel, WhatsApp conversation, Email inbox). A surface pointer
 * maps a stable surface identifier to a session id.
 *
 * This enables explicit attach/detach semantics across surfaces without
 * merging or migrating session state. The underlying session remains in the
 * session DB; only the mapping layer changes.
 */

export type SurfaceType = "cli" | "telegram" | "discord" | "whatsapp" | "email";

export type SurfacePointer = {
  surfaceType: SurfaceType;
  surfaceId: string;
  sessionId: string;
  attachedAt: string;
};

export type SurfacePointerRecord = {
  sessionId: string;
  attachedAt: string;
};

export type SurfacePointerFile = {
  version: 1;
  pointers: Record<string, SurfacePointerRecord>;
};

export function surfacePointerKey(surfaceType: SurfaceType, surfaceId: string): string {
  return `${surfaceType}:${surfaceId}`;
}

export function parseSurfacePointerKey(key: string): { surfaceType: SurfaceType; surfaceId: string } | undefined {
  const separatorIndex = key.indexOf(":");
  if (separatorIndex === -1) {
    return undefined;
  }
  const surfaceType = key.slice(0, separatorIndex) as SurfaceType;
  const surfaceId = key.slice(separatorIndex + 1);
  if (surfaceType.length === 0 || surfaceId.length === 0) {
    return undefined;
  }
  return { surfaceType, surfaceId };
}
