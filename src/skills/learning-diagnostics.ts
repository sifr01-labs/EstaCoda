import type { ToolExecutionRecord } from "../tools/tool-executor.js";

/** Runtime observations only: no raw user text, outputs, commands or paths. */
export type LearningTurnDiagnostics = {
  limitReached?: boolean;
  completionRejected?: boolean;
  unresolvedCheckCount?: number;
  delegationAvailable?: boolean;
};
export type LearningFinding = {
  mechanism: "completion-repair-at-limit" | "output-retention-limit" | "repeated-check" | "delegation-unavailable" | "recovered-tool-failure";
  observed: string;
  correction: string;
  target: "runtime-regression" | "workflow-review";
  correctionVerified: false;
  callIds: string[];
};

export function learningFindings(calls: readonly ToolExecutionRecord[], turn: LearningTurnDiagnostics = {}): LearningFinding[] {
  const findings: LearningFinding[] = [];
  const add = (mechanism: LearningFinding["mechanism"], observed: string, correction: string,
    target: LearningFinding["target"], evidence: readonly ToolExecutionRecord[]) => findings.push({
      mechanism, observed, correction, target, correctionVerified: false,
      callIds: evidence.flatMap(call => call.toolCallId ? [call.toolCallId] : []).slice(-12)
    });
  if (turn.limitReached && turn.completionRejected) add("completion-repair-at-limit",
    "Completion validation rejected an answer and the run reached a limit.",
    "Reproduce the completion sequence; preserve delivery separately from verification, without accepting unsupported claims.", "runtime-regression", calls.slice(-4));
  const lost = calls.filter(call => call.result?.metadata?.retentionLimited === true || call.result?.metadata?.truncatedForStorage === true);
  if (lost.length) add("output-retention-limit", "At least one observation exceeded durable output retention.",
    "Test retention and paged recovery before changing context budgets; missing bytes cannot be recovered from a summary.", "runtime-regression", lost);
  const counts = new Map<string, ToolExecutionRecord[]>();
  for (const call of calls) {
    if (!["terminal.run", "execute_code"].includes(call.tool.name) || typeof call.input?.verification !== "string") continue;
    const list = counts.get(call.input.verification) ?? []; list.push(call); counts.set(call.input.verification, list);
  }
  const repeated = [...counts.values()].filter(group => group.length > 1).flat();
  if (repeated.length) add("repeated-check", "The same declared verification was started more than once; necessity is not established.",
    "Inspect intervening mutations and check input scopes before recommending another run. Do not assume a repeated check was unnecessary.", "workflow-review", repeated);
  if (turn.delegationAvailable === false) add("delegation-unavailable", "Delegation was unavailable in the session inventory.",
    "Inspect persistent Task prerequisites and exposure. Absence from this session is not a permanent capability limitation.", "runtime-regression", []);
  const recovered = calls.filter((call, index) => call.decision === "allow" && call.result?.ok === false &&
    calls.slice(index + 1).some(next => next.tool.name === call.tool.name && next.decision === "allow" && next.result?.ok));
  if (recovered.length) add("recovered-tool-failure", "A failed tool call was followed by a successful call of the same tool; task success is separate.",
    "Review the successful alternative and its evidence before proposing a reusable procedure. Do not persist a transient failure as tool unavailability.", "workflow-review", recovered);
  return findings;
}

export function learningLesson(findings: readonly LearningFinding[], fallback: string): string {
  return findings.length ? findings.map(finding => `${finding.observed} Proposed follow-up (not validated): ${finding.correction}`).join(" ") : fallback;
}

/** Reconstruct only known mechanism labels. Stored prose is not trusted input
 * to the proposal model, even when the original observation was internal. */
export function learningDraftEvidence(evidence: Record<string, unknown> | undefined): { runtimeOnly: boolean; lesson: string } {
  const lessons = {
    "completion-repair-at-limit": "Completion repair reached a run limit. Investigate the runtime delivery path; a skill edit is not an established correction.",
    "output-retention-limit": "Output exceeded durable retention. Investigate retention and recovery in the runtime before proposing a skill correction.",
    "repeated-check": "A declared check ran repeatedly. Inspect intervening mutations and dependency scopes; repetition may have been necessary.",
    "delegation-unavailable": "Delegation was absent from the session inventory. Inspect setup and exposure; do not describe it as a permanent limitation.",
    "recovered-tool-failure": "A tool failure was followed by success of the same tool. This does not establish the cause or prove the task succeeded."
  };
  const findings = Array.isArray(evidence?.findings) ? evidence.findings : [];
  const mechanisms = [...new Set(findings.flatMap(item => {
    const mechanism = item && typeof item === "object" ? item.mechanism : undefined;
    return typeof mechanism === "string" && Object.hasOwn(lessons, mechanism) ? [mechanism as keyof typeof lessons] : [];
  }))];
  return {
    runtimeOnly: mechanisms.some(key => ["completion-repair-at-limit", "output-retention-limit"].includes(key)) && mechanisms.every(key => ["completion-repair-at-limit", "output-retention-limit", "delegation-unavailable"].includes(key)),
    lesson: mechanisms.length ? mechanisms.map(key => lessons[key]).join(" ") + " Proposed corrections remain unverified; abstain without sufficient evidence."
      : "The selected skill did not complete this task successfully; the cause is unknown."
  };
}
