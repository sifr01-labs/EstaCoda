import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { Trajectory } from "../contracts/trajectory.js";
import type { BenchmarkMetrics, BenchmarkRunSummary } from "./schema.js";
import { redactBenchmarkArtifact, stripBenchmarkAnsi } from "./redaction.js";

export type BenchmarkArtifactWriteOptions = {
  redact?: boolean;
};

export async function writeBenchmarkSummaryArtifact(
  path: string,
  summary: BenchmarkRunSummary,
  options: BenchmarkArtifactWriteOptions = {}
): Promise<void> {
  await writeJsonArtifact(path, maybeRedact(summary, options));
}

export async function writeBenchmarkEventLogArtifact(
  path: string,
  events: readonly RuntimeEvent[],
  options: BenchmarkArtifactWriteOptions = {}
): Promise<void> {
  const records = maybeRedact(events, options);
  const content = records.map((event) => JSON.stringify(event)).join("\n");
  await writeTextArtifact(path, content.length === 0 ? "" : `${content}\n`);
}

export async function writeBenchmarkEventArtifact(
  path: string,
  event: RuntimeEvent,
  options: BenchmarkArtifactWriteOptions = {}
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const record = maybeRedact(event, options);
  await writeFile(path, `${stripBenchmarkAnsi(JSON.stringify(record))}\n`, { encoding: "utf8", flag: "a" });
}

export type BenchmarkTrajectorySummary = {
  id: string;
  profileId: string;
  sessionId: string;
  modelId: string;
  eventCount: number;
  outcome: Trajectory["outcome"] | null;
  eventKinds: Record<string, number>;
  recall: {
    sourceSessionIds: string[];
    warningCount: number;
    snippets: string[];
  };
  memory: {
    snippets: string[];
  };
  metrics: BenchmarkMetrics;
};

export function buildBenchmarkTrajectorySummary(
  trajectory: Trajectory,
  metrics: BenchmarkMetrics
): BenchmarkTrajectorySummary {
  const eventKinds: Record<string, number> = {};
  const recallSourceSessionIds = new Set<string>();
  let recallWarningCount = 0;
  const recallSnippets: string[] = [];
  const memorySnippets: string[] = [];
  for (const event of trajectory.events) {
    eventKinds[event.kind] = (eventKinds[event.kind] ?? 0) + 1;
    if (event.kind === "session-recall-decision") {
      readStringArray(event.data.sourceSessionIds).forEach((sessionId) => recallSourceSessionIds.add(sessionId));
      recallWarningCount += readNonNegativeInteger(event.data.warningCount);
      collectSummarySnippets(event.data, recallSnippets);
    } else if (event.kind === "memory-write" || event.kind === "memory-promotion" || event.kind === "external-memory-recall") {
      collectSummarySnippets(event.data, memorySnippets);
    }
  }

  return {
    id: trajectory.id,
    profileId: trajectory.profileId,
    sessionId: trajectory.sessionId,
    modelId: trajectory.modelId,
    eventCount: trajectory.events.length,
    outcome: trajectory.outcome ?? null,
    eventKinds,
    recall: {
      sourceSessionIds: Array.from(recallSourceSessionIds).sort(),
      warningCount: recallWarningCount,
      snippets: recallSnippets.slice(0, 8)
    },
    memory: {
      snippets: memorySnippets.slice(0, 8)
    },
    metrics
  };
}

export async function writeBenchmarkTrajectoryArtifact(
  path: string,
  trajectory: Trajectory,
  options: BenchmarkArtifactWriteOptions = {}
): Promise<void> {
  const records = maybeRedact(trajectory.events, options);
  const content = records.map((event) => JSON.stringify(event)).join("\n");
  await writeTextArtifact(path, content.length === 0 ? "" : `${content}\n`);
}

export async function writeBenchmarkTrajectorySummaryArtifact(
  path: string,
  summary: BenchmarkTrajectorySummary,
  options: BenchmarkArtifactWriteOptions = {}
): Promise<void> {
  await writeJsonArtifact(path, maybeRedact(summary, options));
}

async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await writeTextArtifact(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextArtifact(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  await writeFile(tempPath, stripBenchmarkAnsi(content), "utf8");
  await rename(tempPath, path);
}

function maybeRedact<T>(value: T, options: BenchmarkArtifactWriteOptions): T {
  return options.redact === false ? value : redactBenchmarkArtifact(value);
}

function collectSummarySnippets(value: unknown, snippets: string[]): void {
  if (snippets.length >= 8) {
    return;
  }
  if (typeof value === "string") {
    if (value.trim().length > 0) {
      snippets.push(value.length > 240 ? `${value.slice(0, 237)}...` : value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSummarySnippets(item, snippets);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectSummarySnippets(item, snippets);
    }
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
