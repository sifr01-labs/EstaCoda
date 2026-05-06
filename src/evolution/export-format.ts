import type { EvolutionChangeManifest } from "../contracts/evolution.js";
import type { SessionDB, SessionEvent } from "../contracts/session.js";

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
        ...plain,
        result: {
          ...result,
          content: truncate(redactedContent, MAX_TOOL_OUTPUT_CHARS)
        }
      };
    }
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plain)) {
    if (typeof value === "string") {
      redacted[key] = redactEnvContent(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

function redactEnvContent(value: string): string {
  // Simple heuristic: redact lines that look like .env key=value pairs
  return value
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
