import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { inspectPlaintextCredentials } from "../security/plaintext-credential-guard.js";
import { stripInlineReasoning } from "../providers/provider-reasoning.js";
import { redactSensitiveText } from "../utils/redaction.js";

/** Recovery is disclosure of an unaccepted draft, never evidence acceptance. */
export function recoverableDraft(text: string, executions: readonly ToolExecutionRecord[]): string | undefined {
  if (!text.trim()) return undefined;
  if (executions.some(call => call.decision !== "allow") &&
      !executions.some(call => call.decision === "allow" && call.result?.ok === true)) return undefined;
  // Local execution uncertainty blocks replay/acceptance, not sanitized disclosure.
  // Do not infer disclosure authority for privileged activity or missing receipts.
  if (executions.some(call =>
      call.decision === "allow" && !["read-only-local", "read-only-network"].includes(call.riskClass) &&
      !(call.riskClass === "workspace-write" && call.settlement !== undefined &&
        (["none", "confirmed"].includes(call.settlement.sideEffectState) ||
          call.settlement.sideEffectState === "possible" && call.settlement.dispatchState === "finished")))) return undefined;
  const sanitized = redactSensitiveText(inspectPlaintextCredentials(stripInlineReasoning(text)).redactedText).trim();
  if (!sanitized) return undefined;
  return executions.some(call => call.settlement?.sideEffectState === "possible")
    ? `Unaccepted draft — local execution effects remain uncertain. This text does not establish successful completion or authorize retry.\n\n${sanitized}`
    : sanitized;
}
