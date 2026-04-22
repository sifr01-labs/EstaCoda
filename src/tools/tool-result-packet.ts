import type { ToolResult } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "./tool-executor.js";

export type ToolResultPacket = {
  tool: string;
  decision?: string;
  ok?: boolean;
  chars: number;
  sentChars: number;
  truncated: boolean;
  excerpt: string;
  metadataSummary?: string;
};

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
  const excerpt = compactWhitespace(content).slice(0, maxChars);

  return {
    tool: input.tool,
    decision: input.decision,
    ok: input.result?.ok,
    chars: content.length,
    sentChars: excerpt.length,
    truncated: content.length > excerpt.length,
    excerpt,
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
    `Excerpt:\n${packet.excerpt}`
  ].filter((line) => line !== undefined).join("\n");
}

function compactWhitespace(value: string): string {
  return value
    .replace(/\r\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
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
