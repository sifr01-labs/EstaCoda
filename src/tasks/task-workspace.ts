import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { TaskWorkspaceBinding } from "../contracts/task.js";

/** Canonical workspace identity shared by Task creation and eligible supervisor hosts. */
export async function resolveTaskWorkspaceBinding(path: string): Promise<TaskWorkspaceBinding> {
  const canonicalPath = await realpath(resolve(path));
  return {
    canonicalPath,
    identityHash: createHash("sha256").update(canonicalPath).digest("hex")
  };
}
