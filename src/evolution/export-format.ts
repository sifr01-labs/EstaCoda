import type { EvolutionChangeManifest } from "../contracts/evolution.js";
import type { SessionDB, SessionEvent } from "../contracts/session.js";
import { stripInlineReasoning } from "../providers/provider-reasoning.js";

export type OptimizationDataset = {
  version: "v0.7";
  generatedAt: string;
  meta: {
    skillCount: number;
    proposalCount: number;
    manifestCount: number;
    observationCount: number;
    evalRunCount: number;
  };
  traces: Array<{
    id: string;
    sessionId: string;
    events: Array<{
      kind: string;
      timestamp: string;
      metadata: Record<string, unknown>;
    }>;
    outcome: "success" | "failure" | "cancelled";
    failureClass?: string;
  }>;
  skillEvalRuns: Array<{
    skillName: string;
    evalId: string;
    score: number;
    passed: boolean;
    details: Record<string, boolean>;
  }>;
  observations: Array<{
    id: string;
    skillName: string;
    type: string;
    lesson: string;
    outcome: string;
    toolsAttempted: string[];
  }>;
  proposals: Array<{
    id: string;
    skillName: string;
    status: string;
    hypothesis?: string;
    predictedImpact?: string;
    riskLevel?: string;
  }>;
  manifests: Array<{
    id: string;
    target: string;
    status: string;
    hypothesis: string;
    predictedImpact: string;
    riskLevel: string;
    filesChanged: string[];
    evidenceTraces: string[];
    constraintGates: string[];
    rollbackPlan: string;
    createdAt: string;
  }>;
};

export type ExportFilter = {
  since?: Date;
  skillName?: string;
  target?: string;
};

const MAX_TOOL_OUTPUT_CHARS = 4096;
const UNSAFE_REASONING_EXPORT_FIELDS = new Set([
  "reasoning",
  "reasoning_content",
  "reasoning_details",
  "reasoningMetadata",
  "runtimeMetadata",
  "providerLoopRuntimeMetadata"
]);

export async function populateTraces(
  manifests: EvolutionChangeManifest[],
  sessionDb?: SessionDB
): Promise<OptimizationDataset["traces"]> {
  if (sessionDb === undefined) {
    return [];
  }

  const traces: OptimizationDataset["traces"] = [];

  for (const manifest of manifests) {
    for (const traceId of manifest.evidence.traces) {
      try {
        const events = await sessionDb.listEvents(traceId);
        const mappedEvents = events.map((event) => mapSessionEvent(event));

        if (mappedEvents.length > 0) {
          traces.push({
            id: traceId,
            sessionId: traceId,
            events: mappedEvents,
            outcome: "success"
          });
        }
      } catch {
        // Best-effort: skip unresolved trace IDs
      }
    }
  }

  return traces;
}

function mapSessionEvent(
  event: SessionEvent
): { kind: string; timestamp: string; metadata: Record<string, unknown> } {
  const timestamp = extractTimestamp(event) ?? new Date().toISOString();
  const metadata = redactEvent(event);

  return {
    kind: event.kind,
    timestamp,
    metadata
  };
}

function extractTimestamp(event: SessionEvent): string | undefined {
  if ("timestamp" in event && typeof event.timestamp === "string") {
    return event.timestamp;
  }
  return undefined;
}

function redactEvent(event: SessionEvent): Record<string, unknown> {
  const plain = event as Record<string, unknown>;

  if (event.kind === "tool-result") {
    const result = plain.result as Record<string, unknown> | undefined;
    if (result !== undefined && typeof result.content === "string") {
      const redactedContent = redactEnvContent(result.content);
      return {
        ...sanitizeExportObject(plain),
        result: {
          ...sanitizeExportObject(result),
          content: truncate(redactedContent, MAX_TOOL_OUTPUT_CHARS)
        }
      };
    }
  }

  return sanitizeExportObject(plain);
}

function sanitizeExportObject(value: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (UNSAFE_REASONING_EXPORT_FIELDS.has(key)) {
      continue;
    }
    const sanitized = sanitizeExportValue(nested);
    if (sanitized !== undefined) {
      redacted[key] = sanitized;
    }
  }
  return redacted;
}

function sanitizeExportValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactEnvContent(value);
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry) => !isReasoningOutputItem(entry))
      .map((entry) => sanitizeExportValue(entry));
  }
  if (typeof value === "object" && value !== null) {
    if (isReasoningOutputItem(value)) {
      return undefined;
    }
    return sanitizeExportObject(value as Record<string, unknown>);
  }
  return value;
}

function isReasoningOutputItem(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && (type === "reasoning" || type === "thinking");
}

function redactEnvContent(value: string): string {
  // Simple heuristic: redact lines that look like .env key=value pairs
  return stripInlineReasoning(value)
    .split("\n")
    .map((line) => {
      if (/^\s*[A-Z_]+\s*=\s*.+$/u.test(line)) {
        const eq = line.indexOf("=");
        return `${line.slice(0, eq + 1)}[REDACTED]`;
      }
      return line;
    })
    .join("\n");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + "\n...[truncated]";
}
