import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorkspaceIdentity } from "../contracts/workspace.js";

/** Preserves the original Task canonical-path SHA-256 identity exactly. */
export async function resolveWorkspaceIdentity(path: string): Promise<WorkspaceIdentity> {
  const canonicalPath = await realpath(resolve(path));
  return { canonicalPath, identityHash: createHash("sha256").update(canonicalPath).digest("hex") };
}
