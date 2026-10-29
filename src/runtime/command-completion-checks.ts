import { posix } from "node:path";
import { settledLocalCommandExit } from "./local-command-result.js";
import { semanticMutationKey } from "../tools/execution-operation-ledger.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { ExecutionEvidenceRecord } from "../contracts/execution-plan.js";
import { commandFileObservation } from "./command-file-observation.js";

/** A check declaration can only add an obligation. Proof comes from the owned
 * command's collected exit, never its prose, tool-call success, or a new label.
 * A stable requirement label links different approaches to the same check. */
export function commandCompletionChecks(calls: readonly ToolExecutionRecord[], receipts: readonly ExecutionEvidenceRecord[]): {
  unresolved: boolean; unresolvedRequirements: string[]; passedRequirements: string[]; passed: boolean; recoveredCalls: Set<string>; lastPassedCallId?: string;
} {
  const records = new Map(receipts.map(receipt => [receipt.toolCallId, receipt]));
  const checks = new Map<string, boolean>();
  const filePredicates = new Map<string, string>();
  const failedChecks = new Map<string, string[]>();
  const requirements = new Map<string, string>();
  const deniedChecks: { id: string; turn: string; requirement: string; index: number }[] = [];
  const passingChecks: { key: string; turn: string; requirement: string; index: number }[] = [];
  let lastPassedCallId: string | undefined;
  const observed = new Set<string>();
  const processes = new Map<string, { turn: string; stale: boolean; collected: boolean }>();
  for (const [index, call] of calls.entries()) {
    const receipt = call.toolCallId ? records.get(call.toolCallId) : undefined;
    if (!receipt?.visibleTurnId || receipt.tool !== call.tool.name) continue;
    const command = commandCheckIdentity(call, receipt.visibleTurnId);
    // A refused local approach never ran. Only a later authorized check of the
    // same requirement can recover it; retain the denial receipt and authority.
    if (command && receipt.status === "blocked" && call.decision === "deny" &&
      ["terminal.run", "execute_code"].includes(call.tool.name) && call.executionEffect?.connector === undefined &&
      receipt.executionEffect?.connector === undefined && call.riskClass !== "external-side-effect" &&
      receipt.riskClass !== "external-side-effect" &&
      call.settlement?.dispatchState === "not_started" && call.settlement.sideEffectState === "none") {
      deniedChecks.push({ id: receipt.toolCallId, turn: receipt.visibleTurnId, requirement: command.requirement, index });
      continue;
    }
    const process = call.result?.metadata?.process as { id?: unknown; status?: unknown } | undefined;
    const processId = typeof process?.id === "string" ? process.id : undefined;
    if (call.tool.name === "terminal.run" && processId && !processes.has(processId)) {
      processes.set(processId, { turn: receipt.visibleTurnId, stale: false, collected: false });
    }
    const ownedProcess = processId ? processes.get(processId) : undefined;
    const observation = commandFileObservation(call, receipt.visibleTurnId);
    const changed = observation && !observed.has(observation.id) && observation.completed &&
      observation.files.some(file => file.after === undefined || file.before !== file.after);
    if (observation?.completed) observed.add(observation.id);
    // Invalidate observed edits, not every operation authorized to write. Shell
    // inspections and service starts share that risk class with actual edits.
    // Unobserved shell changes remain a limit of check coverage, not a guessed
    // new obligation. Interrupted effects are handled by the outcome ledger.
    const mutation = call.decision === "allow" && (
      changed || (["file.write", "file.patch"].includes(call.tool.name) && call.result?.metadata?.changed !== false)
    );
    if (mutation) {
      for (const key of checks.keys()) if (key.startsWith(`${receipt.visibleTurnId}:`)) {
        const target = filePredicates.get(key);
        // Only a literal existence/size predicate with an observed regular file
        // has a known dependency. Generic tests and shell mutations stay broad.
        const written = call.result?.metadata?.path;
        const independentWrite = target !== undefined && call.tool.name === "file.write" &&
          call.result?.ok === true && call.result.metadata?.materialized === true &&
          typeof written === "string" && !posix.isAbsolute(written) && !written.split("/").includes("..") &&
          posix.normalize(written) !== target && !target.startsWith(`${posix.normalize(written)}/`);
        if (!independentWrite) checks.set(key, false);
      }
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
    filePredicates.delete(command.key);
    const predicate = call.tool.name === "terminal.run" && typeof call.input?.command === "string"
      ? /^test\s+-(?:f|s)\s+([A-Za-z0-9_./-]+)\s*$/u.exec(call.input.command) : null;
    const path = predicate?.[1];
    if (passed && path && !posix.isAbsolute(path) && !path.split("/").includes("..") && observation?.completed &&
        observation.files.some(file => file.path === posix.normalize(path) && typeof file.after === "string" && file.before === file.after)) {
      filePredicates.set(command.key, posix.normalize(path));
    }
    requirements.set(command.key, command.requirement);
    if (passed && call.executionEffect?.connector === undefined && receipt.executionEffect?.connector === undefined &&
      call.riskClass !== "external-side-effect" && receipt.riskClass !== "external-side-effect") {
      passingChecks.push({ key: command.key, turn: receipt.visibleTurnId, requirement: command.requirement, index });
    }
    if (passed) lastPassedCallId = receipt.toolCallId;
    if (receipt.status === "failed") failedChecks.set(command.key, [...(failedChecks.get(command.key) ?? []), receipt.toolCallId]);
    if (ownedProcess && process?.status === "exited") ownedProcess.collected = true;
  }
  const recoveredCalls = new Set([...failedChecks].flatMap(([key, ids]) => checks.get(key) === true ? ids : []));
  const unresolvedRequirements = new Set([...checks].flatMap(([key, passed]) => passed ? [] : [requirements.get(key)!]));
  for (const denied of deniedChecks) {
    if (passingChecks.some(check => check.index > denied.index && check.turn === denied.turn &&
      check.requirement === denied.requirement && checks.get(check.key) === true)) recoveredCalls.add(denied.id);
    else unresolvedRequirements.add(denied.requirement);
  }
  const unresolved = unresolvedRequirements.size > 0;
  return { unresolved, unresolvedRequirements: [...unresolvedRequirements],
    passedRequirements: [...new Set([...checks].flatMap(([key, passed]) => passed ? [requirements.get(key)!] : []))].filter(label => !unresolvedRequirements.has(label)), passed: checks.size > 0 && !unresolved, recoveredCalls,
    ...(!unresolved && checks.size > 0 ? { lastPassedCallId } : {}) };
}

/** Give the model an opportunity to finish the exact outstanding checks through
 * the existing bounded completion-repair loop. Readback or a new label cannot
 * substitute for a successful validation, and no command is retried here. */
export function commandCompletionFeedback(calls: readonly ToolExecutionRecord[], receipts: readonly ExecutionEvidenceRecord[]): string | undefined {
  const { unresolvedRequirements } = commandCompletionChecks(calls, receipts);
  if (unresolvedRequirements.length === 0) return undefined;
  return `Declared checks remain unresolved: ${JSON.stringify(unresolvedRequirements.slice(0, 8))}${unresolvedRequirements.length > 8 ? ` (${unresolvedRequirements.length} total)` : ""}. Verify those requirements on the current result using an authorized command and reuse the exact verification label. A missing interpreter, crash, failed exit, or stale check is not a passing validation. Reading files or passing a differently named check does not settle these requirements. Do not retry denied actions, bypass permissions, or rerun uncertain side effects. If blocked, report what remains unverified.`;
}

export function declaresCommandCheck(call: ToolExecutionRecord): boolean {
  const process = call.result?.metadata?.process as { verification?: unknown } | undefined;
  return (["terminal.run", "execute_code"].includes(call.tool.name) && checkLabel(call.input?.verification) !== undefined) ||
    (["terminal.run", "process.logs"].includes(call.tool.name) && checkLabel(process?.verification) !== undefined);
}

function checkLabel(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,79}$/u.test(value) ? value : undefined;
}

function commandCheckIdentity(call: ToolExecutionRecord, turn: string): { key: string; requirement: string; declared: boolean } | undefined {
  if (!["terminal.run", "execute_code", "process.logs"].includes(call.tool.name)) return undefined;
  const metadata = call.result?.metadata;
  const process = metadata?.process as { verification?: unknown; cwd?: unknown } | undefined;
  const requirement = checkLabel(call.input?.verification) ?? checkLabel(process?.verification);
  if (!requirement) return undefined;
  return { key: `${turn}:${semanticMutationKey("command-check", { requirement, cwd: process?.cwd ?? metadata?.cwd ?? call.input?.cwd })}`,
    requirement, declared: declaresCommandCheck(call) };
}

function commandSucceeded(call: ToolExecutionRecord): boolean {
  if (call.decision !== "allow" || call.result?.ok !== true || call.settlement?.sideEffectState === "possible") return false;
  const metadata = call.result.metadata;
  const process = metadata?.process as { status?: unknown; exitCode?: unknown; signal?: unknown } | undefined;
  if (process) return process.status === "exited" && process.exitCode === 0 && process.signal == null;
  return settledLocalCommandExit(call) === 0;
}


/** Bound the fallback check to the current execution turn, never an earlier
 * successful task. Step delivery may omit originTurnId but retains receipts. */
export function hasFileOutputCoverage(calls: readonly ToolExecutionRecord[], receipts: readonly ExecutionEvidenceRecord[], originTurnId?: string): boolean {
  const turn = originTurnId ?? receipts.at(-1)?.visibleTurnId;
  return turn !== undefined && commandCompletionChecks(calls, receipts.filter(receipt => receipt.visibleTurnId === turn))
    .passedRequirements.includes("file-output-coverage");
}
