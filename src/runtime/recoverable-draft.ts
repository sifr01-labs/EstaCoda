import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { inspectPlaintextCredentials } from "../security/plaintext-credential-guard.js";
import { stripInlineReasoning } from "../providers/provider-reasoning.js";
import { redactSensitiveText } from "../utils/redaction.js";

/** Recovery is disclosure of an unaccepted draft, never evidence acceptance. */
export function recoverableDraft(text: string, executions: readonly ToolExecutionRecord[]): string | undefined {
  if (!text.trim()) return undefined;
  if (executions.some(call => call.decision !== "allow") &&
      !executions.some(call => call.decision === "allow" && call.result?.ok === true)) return undefined;
  // Match the worker disclosure boundary: privileged output and uncertain effects
  // cannot be republished merely by adding a disclaimer.
  if (executions.some(call => call.settlement?.sideEffectState === "possible" ||
      call.decision === "allow" && !["read-only-local", "read-only-network"].includes(call.riskClass) &&
      !(call.riskClass === "workspace-write" && call.settlement !== undefined &&
        ["none", "confirmed"].includes(call.settlement.sideEffectState)))) return undefined;
  const sanitized = redactSensitiveText(inspectPlaintextCredentials(stripInlineReasoning(text)).redactedText).trim();
  return sanitized || undefined;
}
