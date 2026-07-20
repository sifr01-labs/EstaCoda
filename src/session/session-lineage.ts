import type { SessionDB, SessionRecord } from "../contracts/session.js";

const MAX_COMPRESSION_LINEAGE_DEPTH = 32;

/** Returns the current session followed only by structurally verified transcript-compression ancestors. */
export async function verifiedCompressionLineage(
  sessionDb: Pick<SessionDB, "getSession">,
  sessionId: string,
  profileId: string
): Promise<readonly SessionRecord[] | undefined> {
  const lineage: SessionRecord[] = [];
  const visited = new Set<string>();
  let currentId = sessionId;
  for (let depth = 0; depth < MAX_COMPRESSION_LINEAGE_DEPTH; depth++) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const current = await sessionDb.getSession(currentId);
    if (current === undefined || current.profileId !== profileId) return undefined;
    lineage.push(current);
    const parentId = current.parentSessionId;
    if (parentId === undefined || current.metadata?.compactedFromSessionId !== parentId) return lineage;
    const parent = await sessionDb.getSession(parentId);
    if (parent === undefined || parent.profileId !== profileId || parent.endReason !== "compression") return lineage;
    currentId = parent.id;
  }
  return undefined;
}
