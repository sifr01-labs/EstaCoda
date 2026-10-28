import { createHash } from "node:crypto";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";

/** In-memory identities only: never persist raw command arguments or results. */
export function toolOperationFingerprint(call: ToolExecutionRecord): string {
  const input = call.input ?? {};
  const process = call.result?.metadata?.process as { cwd?: unknown } | undefined;
  const operation = call.tool.name === "terminal.run" ? { command: input.command, cwd: input.cwd ?? process?.cwd }
    : call.tool.name === "terminal.inspect" ? { argv: input.argv, cwd: input.cwd ?? process?.cwd }
    : call.tool.name.startsWith("browser.") && input.identity !== null && typeof input.identity === "object"
      ? { ...input, identity: { ...input.identity, observationId: undefined } } : input;
  return createHash("sha256").update(JSON.stringify({ tool: call.tool.name, input: operation }, (_key, value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value
  )).digest("hex");
}

export function toolResultFingerprint(call: ToolExecutionRecord): string {
  let content = call.result?.content ?? "";
  // Managed commands prepend a fresh PID on every dispatch. It is transport
  // bookkeeping, not a new diagnostic. Keep the actual diagnostic text intact.
  if (call.tool.name === "terminal.run" && call.result?.metadata?.process !== undefined) {
    content = content.replace(/^started pid \d+\r?\n/gmu, "");
  }
  content = content.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu, "[timestamp]");
  return createHash("sha256").update(JSON.stringify({ tool: call.tool.name, ok: call.result?.ok, content })).digest("hex");
}
