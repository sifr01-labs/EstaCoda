import { currentCronExecutionOrigin } from "./cron-origin.js";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CronStore } from "./cron-store.js";
import { redactCronDataContext } from "./cron-safety.js";

export type CronContextSource = {
  jobId: string;
  output?: string;
  outputPath?: string;
  skippedReason?: string;
};

export async function loadCronContextSources(input: {
  store: CronStore;
  jobIds: string[];
  maxCharsPerSource?: number;
}): Promise<CronContextSource[]> {
  const maxChars = input.maxCharsPerSource ?? 8_000;
  const sources: CronContextSource[] = [];

  for (const jobId of input.jobIds) {
    if (currentCronExecutionOrigin() && !await input.store.get(jobId)) {
      sources.push({ jobId, skippedReason: "job is outside the authorized origin" });
      continue;
    }
    const latest = await latestOutputPath(input.store, jobId);
    if ("skippedReason" in latest) {
      sources.push({ jobId, skippedReason: latest.skippedReason });
      continue;
    }

    const raw = await readFile(latest.path, "utf8");
    const truncated = raw.length <= maxChars ? raw : `${raw.slice(0, maxChars)}\n[truncated]`;
    sources.push({
      jobId,
      output: redactCronDataContext(truncated),
      outputPath: latest.path
    });
  }

  return sources;
}

async function latestOutputPath(
  store: CronStore,
  jobId: string
): Promise<{ path: string } | { skippedReason: string }> {
  const resolvedRoot = resolve(store.outputRoot);
  const jobDir = resolve(resolvedRoot, jobId);
  if (isUnsafeJobId(jobId) || !isInsidePath(resolvedRoot, jobDir)) {
    return { skippedReason: "unsafe job id" };
  }

  let names: string[];
  try {
    names = await readdir(jobDir);
  } catch {
    return { skippedReason: "no output found" };
  }

  const candidates = await Promise.all(names
    .filter((name) => name.endsWith(".md"))
    .map(async (name) => {
      const path = resolve(jobDir, name);
      if (!isInsidePath(jobDir, path) || !isInsidePath(resolvedRoot, path)) {
        return undefined;
      }
      try {
        const info = await lstat(path);
        if (!info.isFile()) {
          return undefined;
        }
        return { path, name, mtimeMs: info.mtimeMs };
      } catch {
        return undefined;
      }
    }));

  const latest = candidates
    .filter((candidate): candidate is { path: string; name: string; mtimeMs: number } => candidate !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))[0]?.path;
  return latest === undefined ? { skippedReason: "no output found" } : { path: latest };
}

function isUnsafeJobId(jobId: string): boolean {
  return jobId.trim().length === 0
    || isAbsolute(jobId)
    || jobId.includes("/")
    || jobId.includes("\\")
    || jobId.split(/[\\/]/u).includes("..")
    || jobId === "..";
}

function isInsidePath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
