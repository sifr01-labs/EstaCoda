import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { BenchmarkRunSummary } from "./schema.js";
import { redactBenchmarkArtifact } from "./redaction.js";

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
  await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
}

async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await writeTextArtifact(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextArtifact(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
}

function maybeRedact<T>(value: T, options: BenchmarkArtifactWriteOptions): T {
  return options.redact === false ? value : redactBenchmarkArtifact(value);
}
