import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { OpenAICompatibleToolSchema, ProviderToolSchemaCatalog } from "../tools/tool-schema.js";

export type RuntimeCapabilityState = { tool: string; exposure: "exposed" | "not_selected" | "provider_restricted"; readiness: string; observation?: string };

/** Current-turn executor records only. No transcript, memory, URL or raw error text. */
export function projectCapabilityState(input: {
  catalog?: ProviderToolSchemaCatalog;
  exposed: readonly OpenAICompatibleToolSchema[];
  executions: readonly ToolExecutionRecord[];
  required?: readonly string[];
}): RuntimeCapabilityState[] {
  const exposed = new Set(input.exposed.map((schema) => input.catalog?.aliases.get(schema.function.name) ?? schema.function.name));
  const latest = new Map<string, ToolExecutionRecord>();
  for (const record of input.executions) if (record.toolCallId !== undefined) latest.set(record.tool.name, record);
  const names = [...new Set([...latest.keys()].reverse().concat(input.required ?? [], [...exposed].sort()))].slice(0, 12);
  return names.flatMap((tool) => {
    const registered = input.catalog?.inventory.find((entry) => entry.name === tool);
    if (!registered && !exposed.has(tool)) return [];
    const record = latest.get(tool);
    const observation = record === undefined ? undefined : record.decision !== "allow" ? `action_${record.decision}`
      : record.result?.ok !== true ? "call_failed"
      : record.result.metadata?.available === false ? "reported_unavailable"
      : record.result.metadata?.available === true ? "reported_available" : "call_succeeded";
    return [{ tool, exposure: registered?.schemaEligible === false ? "provider_restricted" as const : exposed.has(tool) ? "exposed" as const : "not_selected" as const,
      readiness: observation === "call_succeeded" ? "observed_callable" : observation === "reported_available" ? "observed_available" : observation === "reported_unavailable" ? "observed_unavailable"
        : registered?.availability === "temporarily_unavailable" ? "catalog_unavailable" : "registered; execution readiness unverified",
      ...(observation === undefined ? {} : { observation }) }];
  });
}

export function renderCapabilityState(state: readonly RuntimeCapabilityState[]): string | undefined {
  if (state.length === 0) return undefined;
  return ["Current runtime capability evidence (bounded; this is not authorization):", JSON.stringify(state),
    "Current tool observations supersede contradictory historical availability claims in memory or conversation. A successful status call reporting available=false means unavailable; a registered/exposed tool alone proves neither setup readiness nor action success.",
    "Keep user preferences such as do not browse, current provider restrictions, approval requirements and action denials authoritative. A denied action does not mean its whole capability is missing. Inspect exposed status/discovery tools when readiness is unknown; never infer missing configuration from memory alone."
  ].join("\n");
}

/** Correct only direct blanket availability denials contradicted by current owned receipts.
 * A newer failed/denied call or registered provider restriction defeats the correction. */
export function correctContradictedCapabilityClaim(text: string, executions: readonly ToolExecutionRecord[], catalog?: ProviderToolSchemaCatalog): string | undefined {
  const latest = new Map<string, ToolExecutionRecord>();
  for (const execution of executions) if (execution.toolCallId !== undefined) latest.set(execution.tool.name, execution);
  const browser = [...executions].reverse().find((execution) => execution.tool.name.startsWith("browser.") && execution.toolCallId !== undefined);
  const browserClaim = /^(?:sorry[, :]*|unfortunately[, :]*|عذرًا[، :]*|عذرا[، :]*)?\s*(?:I\s+(?:cannot|can't|can’t)\s+browse(?:\s+the\s+(?:web|internet))?|(?:the\s+)?browser(?:\s+tools?)?\s+(?:is|are)\s+(?:unavailable|not\s+available)|لا أستطيع التصفح|المتصفح غير متاح)[.!\s]*$/imu;
  if (browserClaim.test(text) && browser?.tool.name === "browser.status" && browser.decision === "allow" && browser.result?.ok === true && browser.result.metadata?.available === true &&
    catalog?.inventory.find((tool) => tool.name === "browser.status")?.schemaEligible !== false) {
    return text.replace(browserClaim, "The current browser status reports an available backend. This does not authorize a browser action or override your browsing preferences; the requested action still needs its normal checks.");
  }
  for (const [name, record] of latest) {
    if (record.decision !== "allow" || record.result?.ok !== true || record.result.metadata?.available === false ||
      catalog?.inventory.find((tool) => tool.name === name)?.schemaEligible === false || !/^[a-z][a-z0-9_.-]{0,79}$/iu.test(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (new RegExp(`^(?:The\\s+)?${escaped}\\s+(?:tool\\s+)?is\\s+(?:unavailable|not\\s+available)[.!\\s]*$`, "imu").test(text)) {
      return `The current ${name} call succeeded. That observation contradicts a blanket unavailability claim; future actions still require current setup, policy and approval checks.`;
    }
  }
  return undefined;
}
