import type { ToolExecutionRecord } from "../tools/tool-executor.js";

/** A collected process exit is evidence; missing settlement fields are not.
 * Keep both producer spellings for persisted terminal/Python receipts. */
export function settledLocalCommandExit(call: ToolExecutionRecord): number | undefined {
  if (!["terminal.run", "terminal.inspect", "execute_code"].includes(call.tool.name) ||
      call.decision !== "allow" || !call.result || call.settlement?.sideEffectState === "possible" ||
      call.settlement?.dispatchState === "unknown") return undefined;
  const metadata = call.result.metadata;
  const code = call.tool.name === "execute_code" ? metadata?.exitCode : metadata?.code;
  if (typeof code !== "number" || !Number.isInteger(code) || code < 0 ||
      metadata?.signal !== null || metadata.timedOut !== false || metadata.cancelled !== false ||
      metadata.running === true || metadata.cleanupUncertain === true || call.result.ok !== (code === 0)) return undefined;
  return code;
}
