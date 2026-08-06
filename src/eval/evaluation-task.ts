import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const EVALUATION_METRICS = [
  "accuracy_percent",
  "hallucination_count",
  "latency_ms",
  "cost_usd",
  "fallback_count",
  "approval_frequency_percent"
] as const;

export type EvaluationMetric = typeof EVALUATION_METRICS[number];

export type EvaluationTask = {
  id: string;
  title: string;
  channel: "cli" | "telegram" | "provider" | "cross-cutting";
  evidence: "live-proven" | "smoke-tested" | "eval-tested" | "implemented but not live-proven" | "intended but not implemented";
  goal: string;
  prompt?: string;
  prerequisites: string[];
  steps: string[];
  assertions: string[];
  notes: string[];
  optIn: boolean;
  fixtures: string[];
  metrics: EvaluationMetric[];
};

const CHANNELS = new Set<EvaluationTask["channel"]>([
  "cli",
  "telegram",
  "provider",
  "cross-cutting"
]);
const EVIDENCE_LEVELS = new Set<EvaluationTask["evidence"]>([
  "live-proven",
  "smoke-tested",
  "eval-tested",
  "implemented but not live-proven",
  "intended but not implemented"
]);
const METRICS = new Set<EvaluationMetric>(EVALUATION_METRICS);

export async function loadEvaluationTasks(tasksDir: string): Promise<{
  taskFiles: string[];
  tasks: EvaluationTask[];
}> {
  const taskFiles = (await readdir(tasksDir))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const tasks = await Promise.all(taskFiles.map(async (file) =>
    parseEvaluationTask(await readFile(join(tasksDir, file), "utf8"), file)
  ));
  return { taskFiles, tasks };
}

export function parseEvaluationTask(raw: string, file: string): EvaluationTask {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in eval task ${file}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Invalid eval task schema in ${file}: expected an object`);
  }

  const channel = requiredString(parsed, "channel", file);
  const evidence = requiredString(parsed, "evidence", file);
  if (!CHANNELS.has(channel as EvaluationTask["channel"])) {
    throw new Error(`Invalid eval task channel in ${file}: ${channel}`);
  }
  if (!EVIDENCE_LEVELS.has(evidence as EvaluationTask["evidence"])) {
    throw new Error(`Invalid eval task evidence in ${file}: ${evidence}`);
  }

  const optIn = parsed.optIn ?? false;
  if (typeof optIn !== "boolean") {
    throw new Error(`Invalid eval task optIn flag in ${file}`);
  }
  const metrics = optionalStringArray(parsed, "metrics", file) as EvaluationMetric[];
  const unsupportedMetric = metrics.find((metric) => !METRICS.has(metric));
  if (unsupportedMetric !== undefined) {
    throw new Error(`Unsupported eval metric in ${file}: ${unsupportedMetric}`);
  }

  return {
    id: requiredString(parsed, "id", file),
    title: requiredString(parsed, "title", file),
    channel: channel as EvaluationTask["channel"],
    evidence: evidence as EvaluationTask["evidence"],
    goal: requiredString(parsed, "goal", file),
    prompt: optionalString(parsed, "prompt", file),
    prerequisites: optionalStringArray(parsed, "prerequisites", file),
    steps: requiredStringArray(parsed, "steps", file),
    assertions: requiredStringArray(parsed, "assertions", file),
    notes: optionalStringArray(parsed, "notes", file),
    optIn,
    fixtures: optionalStringArray(parsed, "fixtures", file),
    metrics
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(input: Record<string, unknown>, key: string, file: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid eval task ${key} in ${file}`);
  }
  return value;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  file: string
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid eval task ${key} in ${file}`);
  }
  return value;
}

function requiredStringArray(
  input: Record<string, unknown>,
  key: string,
  file: string
): string[] {
  if (input[key] === undefined) {
    throw new Error(`Missing eval task ${key} in ${file}`);
  }
  return stringArray(input[key], key, file);
}

function optionalStringArray(
  input: Record<string, unknown>,
  key: string,
  file: string
): string[] {
  if (input[key] === undefined) return [];
  return stringArray(input[key], key, file);
}

function stringArray(value: unknown, key: string, file: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`Invalid eval task ${key} in ${file}`);
  }
  return [...new Set(value)];
}
