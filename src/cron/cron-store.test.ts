import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CronStore } from "./cron-store.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-cron-store-test-"));
}

describe("CronStore", () => {
  let tmpDir: string;
  let store: CronStore;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    store = new CronStore({ homeDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("normalizes existing jobs with missing optional fields to safe defaults", async () => {
    await writeJobs(store.path, {
      jobs: [
        {
          id: "cron-legacy",
          name: "Legacy job",
          prompt: "Run the legacy task",
          schedule: "1h",
          scheduleKind: "interval",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          scriptArgs: "not-an-array"
        }
      ]
    });

    const [job] = await store.list();

    expect(job).toMatchObject({
      id: "cron-legacy",
      name: "Legacy job",
      prompt: "Run the legacy task",
      skills: [],
      runCount: 0,
      status: "active",
      delivery: "local"
    });
    expect(job?.scriptArgs).toBeUndefined();
  });

  it("keeps existing jobs loadable when future planned fields are absent", async () => {
    const created = await store.create({
      name: "Current shape",
      prompt: "Summarize the queue",
      schedule: "1h"
    });

    const reloaded = await new CronStore({ homeDir: tmpDir }).get(created.id);

    expect(reloaded).toEqual(created);
    expect("noAgent" in (reloaded ?? {})).toBe(false);
    expect("contextFrom" in (reloaded ?? {})).toBe(false);
    expect("modelOverride" in (reloaded ?? {})).toBe(false);
    expect("enabledToolsets" in (reloaded ?? {})).toBe(false);
    expect("workdir" in (reloaded ?? {})).toBe(false);
  });
});

async function writeJobs(path: string, snapshot: unknown): Promise<void> {
  await rm(dirname(path), { recursive: true, force: true });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}
