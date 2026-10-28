import { semanticMutationKey } from "../tools/execution-operation-ledger.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { ExecutionEvidenceRecord } from "../contracts/execution-plan.js";
import { commandFileObservation } from "./file-output-evidence.js";

/** A check declaration can only add an obligation. Proof comes from the owned
 * command's collected exit, never its prose, tool-call success, or a new label.
 * A stable requirement label links different approaches to the same check. */
export function commandCompletionChecks(calls: readonly ToolExecutionRecord[], receipts: readonly ExecutionEvidenceRecord[]): {
  unresolved: boolean; passed: boolean; recoveredCalls: Set<string>; lastPassedCallId?: string;
} {
  const records = new Map(receipts.map(receipt => [receipt.toolCallId, receipt]));
  const checks = new Map<string, boolean>();
  const failedChecks = new Map<string, string[]>();
  let lastPassedCallId: string | undefined;
  const observed = new Set<string>();
  const processes = new Map<string, { turn: string; stale: boolean; collected: boolean }>();
  for (const call of calls) {
    const receipt = call.toolCallId ? records.get(call.toolCallId) : undefined;
    if (!receipt?.visibleTurnId || receipt.tool !== call.tool.name) continue;
    const command = commandCheckIdentity(call, receipt.visibleTurnId);
    const process = call.result?.metadata?.process as { id?: unknown; status?: unknown } | undefined;
    const processId = typeof process?.id === "string" ? process.id : undefined;
    if (call.tool.name === "terminal.run" && processId && !processes.has(processId)) {
      processes.set(processId, { turn: receipt.visibleTurnId, stale: false, collected: false });
    }
    const ownedProcess = processId ? processes.get(processId) : undefined;
    const observation = commandFileObservation(call, receipt.visibleTurnId);
    const changed = observation && !observed.has(observation.id) && observation.completed &&
      observation.files.some(file => file.before !== file.after);
    if (observation?.completed) observed.add(observation.id);
    // Invalidate observed edits, not every operation authorized to write. Shell
    // inspections and service starts share that risk class with actual edits.
    // Unobserved shell changes remain a limit of check coverage, not a guessed
    // new obligation. Interrupted effects are handled by the outcome ledger.
    const mutation = call.decision === "allow" && (
      changed || (["file.write", "file.patch"].includes(call.tool.name) && call.result?.metadata?.changed !== false)
    );
    if (mutation) {
      for (const key of checks.keys()) if (key.startsWith(`${receipt.visibleTurnId}:`)) checks.set(key, false);
      for (const [id, state] of processes) {
        if (state.turn === receipt.visibleTurnId && id !== processId) state.stale = true;
      }
    }
    // A later poll must not turn an old exit into fresh validation after an edit.
    // Only processes started by this turn can provide command-check evidence.
    if (call.tool.name === "process.logs" && (!ownedProcess || ownedProcess.turn !== receipt.visibleTurnId || ownedProcess.collected)) continue;
    if (!command || (!command.declared && !checks.has(command.key))) continue;
    const passed = receipt.status === "success" && !ownedProcess?.stale && commandSucceeded(call);
    checks.set(command.key, passed);
    if (passed) lastPassedCallId = receipt.toolCallId;
    if (receipt.status === "failed") failedChecks.set(command.key, [...(failedChecks.get(command.key) ?? []), receipt.toolCallId]);
    if (ownedProcess && process?.status === "exited") ownedProcess.collected = true;
  }
  const unresolved = [...checks.values()].some(passed => !passed);
  const recoveredCalls = new Set([...failedChecks].flatMap(([key, ids]) => checks.get(key) === true ? ids : []));
  return { unresolved, passed: checks.size > 0 && !unresolved, recoveredCalls,
    ...(!unresolved && checks.size > 0 ? { lastPassedCallId } : {}) };
}

export function declaresCommandCheck(call: ToolExecutionRecord): boolean {
  const process = call.result?.metadata?.process as { verification?: unknown } | undefined;
  return (call.tool.name === "terminal.run" && checkLabel(call.input?.verification) !== undefined) ||
    (["terminal.run", "process.logs"].includes(call.tool.name) && checkLabel(process?.verification) !== undefined);
}

function checkLabel(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,79}$/u.test(value) ? value : undefined;
}

function commandCheckIdentity(call: ToolExecutionRecord, turn: string): { key: string; declared: boolean } | undefined {
  if (!["terminal.run", "process.logs"].includes(call.tool.name)) return undefined;
  const metadata = call.result?.metadata;
  const process = metadata?.process as { verification?: unknown; cwd?: unknown } | undefined;
  const requirement = checkLabel(call.input?.verification) ?? checkLabel(process?.verification);
  if (!requirement) return undefined;
  return { key: `${turn}:${semanticMutationKey("command-check", { requirement, cwd: process?.cwd ?? metadata?.cwd ?? call.input?.cwd })}`,
    declared: declaresCommandCheck(call) };
}

function commandSucceeded(call: ToolExecutionRecord): boolean {
  if (call.decision !== "allow" || call.result?.ok !== true || call.settlement?.sideEffectState === "possible") return false;
  const metadata = call.result.metadata;
  const process = metadata?.process as { status?: unknown; exitCode?: unknown; signal?: unknown } | undefined;
  if (process) return process.status === "exited" && process.exitCode === 0 && process.signal == null;
  return call.tool.name === "terminal.run" && metadata?.code === 0 && metadata.signal === null &&
    metadata.timedOut === false && metadata.cancelled === false && metadata.running !== true;
}
