import type { ToolResult } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "./tool-executor.js";
import { DELEGATE_TASK_MAX_RESULT_CHARS } from "../contracts/delegation.js";

export type ToolResultPacket = {
  tool: string;
  decision?: string;
  ok?: boolean;
  chars: number;
  sentChars: number;
  truncated: boolean;
  excerpt: string;
  metadataSummary?: string;
  recoveryHint?: string;
};

/** Per-result ceilings; the prompt packer's aggregate context budget still applies. */
export function providerVisibleToolResultMaxChars(toolName: string, defaultMaxChars = 1_400): number {
  if (toolName === "delegate_task") return DELEGATE_TASK_MAX_RESULT_CHARS;
  return ["file.read", "terminal.run", "terminal.inspect", "process.logs", "execute_code"].includes(toolName)
    ? 16_000 : defaultMaxChars;
}

export function packetizeToolExecution(input: {
  execution: ToolExecutionRecord;
  maxChars?: number;
}): ToolResultPacket {
  return packetizeToolResult({
    tool: input.execution.tool.name,
    decision: input.execution.decision,
    result: input.execution.result,
    maxChars: Math.min(input.maxChars ?? input.execution.tool.maxResultSizeChars, input.execution.tool.maxResultSizeChars)
  });
}

export function packetizeToolResult(input: {
  tool: string;
  decision?: string;
  result?: ToolResult;
  maxChars?: number;
}): ToolResultPacket {
  const content = input.result?.content ?? "No tool result content.";
  const maxChars = Math.max(200, input.maxChars ?? 1_500);
  const truncated = content.length > maxChars;
  // Keep diagnostic tails and exact whitespace. Never silently present a prefix
  // as a complete file, or split a UTF-16 surrogate pair at a clipping boundary.
  let headEnd = safeBoundary(content, Math.floor((maxChars - 80) * 0.65));
  let tailStart = safeBoundary(content, content.length - Math.floor((maxChars - 80) * 0.35));
  // Never turn an observed URL into a different plausible URL at either edge.
  if (truncated) for (const match of content.matchAll(/https?:\/\/[^\s<>"'`|]+/gu)) {
    const end = match.index + match[0].length;
    if (match.index < headEnd && end > headEnd) headEnd = match.index;
    if (match.index < tailStart && end > tailStart) tailStart = end;
  }
  const excerpt = truncated
    ? `${content.slice(0, headEnd)}\n[... ${tailStart - headEnd} characters omitted ...]\n${content.slice(tailStart)}`
    : content;

  return {
    tool: input.tool,
    decision: input.decision,
    ok: input.result?.ok,
    chars: content.length,
    sentChars: excerpt.length,
    truncated,
    excerpt,
    ...(truncated ? { recoveryHint: input.tool === "file.read"
      ? "Read smaller ranges with file.read lineStart/lineEnd; do not repeat the whole-file read or treat this excerpt as full content."
      : "Inspect saved output files with bounded file.read ranges, or use process.logs tailChars for managed processes. Do not rerun a mutating command just to recover output." } : {}),
    metadataSummary: summarizeMetadata(input.result?.metadata)
  };
}

export function renderToolResultPacket(packet: ToolResultPacket): string {
  return [
    `Tool: ${packet.tool}`,
    packet.decision === undefined ? undefined : `Decision: ${packet.decision}`,
    `Result: ${packet.ok === true ? "ok" : packet.ok === false ? "error" : "unknown"}`,
    `Size: ${formatCount(packet.chars)} captured, ${formatCount(packet.sentChars)} sent${packet.truncated ? " (truncated)" : ""}`,
    packet.metadataSummary === undefined ? undefined : `Metadata: ${packet.metadataSummary}`,
    packet.recoveryHint === undefined ? undefined : `Recovery: ${packet.recoveryHint}`,
    `Excerpt:\n${packet.excerpt}`
  ].filter((line) => line !== undefined).join("\n");
}

function safeBoundary(value: string, index: number): number {
  return index > 0 && /[\uD800-\uDBFF]/u.test(value[index - 1]!) ? index - 1 : index;
}

function summarizeMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  const entries = Object.entries(metadata)
    .filter(([, value]) =>
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
    .slice(0, 8)
    .map(([key, value]) => `${key}=${String(value)}`);

  return entries.length === 0 ? undefined : entries.join(", ");
}

function formatCount(value: number): string {
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  }

  return String(value);
}
