import type { ToolResult } from "../contracts/tool.js";

// An in-process attestation from reviewed handlers, never deserialized metadata.
// Use only before any external mutation or protected input delivery can occur.
const undispatched = new WeakSet<ToolResult>();
export function undispatchedResult(result: ToolResult): ToolResult {
  undispatched.add(result);
  return result;
}
export function isUndispatchedResult(result: ToolResult): boolean {
  return undispatched.has(result);
}
