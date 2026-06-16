import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCronCommand } from "./cron-command.js";
import { CronStore } from "./cron-store.js";
import { CronExecutionStore } from "./cron-execution-store.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";
import { createCronTools } from "../tools/cron-tools.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-cron-cmd-test-"));
}

async function setupExecutionStore(homeDir: string): Promise<CronExecutionStore> {
  const dbDir = join(homeDir, ".estacoda");
  await mkdir(dbDir, { recursive: true });
  const dbPath = join(dbDir, "sessions.sqlite");
  const db = openDefaultSQLiteDatabase({ path: dbPath });
  db.exec(`
    create table if not exists cron_executions (
      id text primary key,
      job_id text not null,
      session_id text,
      trajectory_id text,
      scheduled_at text,
      started_at text not null,
      completed_at text,
      status text not null,
      output_summary text,
      delivery_results_json text,
      failure_class text,
      failure_message text,
      created_at text not null
    )
  `);
  return new CronExecutionStore({ db });
}

describe("runCronCommand", () => {
  let tmpDir: string;
  let store: CronStore;
  let executionStore: CronExecutionStore;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    store = new CronStore({ homeDir: tmpDir });
    executionStore = await setupExecutionStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("adds a job with flag syntax", async () => {
    const result = await runCronCommand({
      args: ["add", "--name", "x", "--schedule", "*/5 * * * *", "--command", "echo test"],
      store,
      executionStore
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Created cron job");
    expect(result.output).toContain("x");
    expect(result.output).toContain("*/5 * * * *");
  });

  it("shows usage when flag syntax is missing required args", async () => {
    const result = await runCronCommand({ args: ["add", "--schedule", "*/5 * * * *"], store, executionStore });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("cron add --schedule");
  });

  it("keeps cronjob create requiring prompt and schedule in agent mode", async () => {
    const [tool] = createCronTools({ store });
    expect(tool).toBeDefined();

    await expect(tool!.run({ action: "create", prompt: "hello" })).resolves.toMatchObject({
      ok: false,
      content: "cronjob create requires prompt and schedule."
    });
    await expect(tool!.run({ action: "create", schedule: "1h" })).resolves.toMatchObject({
      ok: false,
      content: "cronjob create requires prompt and schedule."
    });
  });

  it("delegates cron tick to the supplied tick callback", async () => {
    const result = await runCronCommand({
      args: ["tick"],
      store,
      executionStore,
      tick: async () => "Cron tick complete. No due jobs."
    });

    expect(result).toEqual({
      ok: true,
      output: "Cron tick complete. No due jobs."
    });
  });

  it("lists jobs", async () => {
    await store.create({ schedule: "1h", prompt: "test" });
    const result = await runCronCommand({ args: ["list"], store, executionStore });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("test");
  });

  it("shows job detail with executions", async () => {
    const job = await store.create({ schedule: "1h", prompt: "test" });
    const record = await executionStore.create({ jobId: job.id });
    await executionStore.complete(record.id, { status: "success" });

    const result = await runCronCommand({ args: ["show", job.id], store, executionStore });
    expect(result.ok).toBe(true);
    expect(result.output).toContain(job.id);
    expect(result.output).toContain("Recent executions");
    expect(result.output).toContain("success");
  });

  it("returns error for missing job in show", async () => {
    const result = await runCronCommand({ args: ["show", "missing-id"], store, executionStore });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not found");
  });

  it("shows execution history", async () => {
    const job = await store.create({ schedule: "1h", prompt: "test" });
    const record = await executionStore.create({ jobId: job.id });
    await executionStore.complete(record.id, { status: "failed", failureClass: "timeout" });

    const result = await runCronCommand({ args: ["history", job.id], store, executionStore });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("failed");
    expect(result.output).toContain("timeout");
  });

  it("shows all history when no job id given", async () => {
    const job = await store.create({ schedule: "1h", prompt: "test" });
    const record = await executionStore.create({ jobId: job.id });
    await executionStore.complete(record.id, { status: "success" });

    const result = await runCronCommand({ args: ["history"], store, executionStore });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("success");
  });

  it("pauses a job", async () => {
    const job = await store.create({ schedule: "1h", prompt: "test" });
    const result = await runCronCommand({ args: ["pause", job.id], store, executionStore });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Paused");

    const updated = await store.get(job.id);
    expect(updated?.status).toBe("paused");
  });

  it("resumes a job", async () => {
    const job = await store.create({ schedule: "1h", prompt: "test" });
    await store.pause(job.id);
    const result = await runCronCommand({ args: ["resume", job.id], store, executionStore });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Resumed");

    const updated = await store.get(job.id);
    expect(updated?.status).toBe("active");
  });

  it("requests a run", async () => {
    const job = await store.create({ schedule: "1h", prompt: "test" });
    const result = await runCronCommand({ args: ["run", job.id], store, executionStore });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Queued");

    const updated = await store.get(job.id);
    expect(updated?.runRequested).toBe(true);
  });

  it("removes a job", async () => {
    const job = await store.create({ schedule: "1h", prompt: "test" });
    const result = await runCronCommand({ args: ["remove", job.id], store, executionStore });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Removed");

    const missing = await store.get(job.id);
    expect(missing).toBeUndefined();
  });

  it("returns error for missing job in pause", async () => {
    const result = await runCronCommand({ args: ["pause", "missing-id"], store, executionStore });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not found");
  });

  it("returns help when no args given", async () => {
    const result = await runCronCommand({ args: [], store, executionStore });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("cron add");
    expect(result.output).toContain("cron list");
    expect(result.output).toContain("cron show");
    expect(result.output).toContain("cron history");
    expect(result.output).toContain("cron pause");
    expect(result.output).toContain("cron resume");
    expect(result.output).toContain("cron run");
    expect(result.output).toContain("cron remove");
  });

  it("does not crash on show/history with a fresh execution store (auto-creates schema)", async () => {
    const freshDbDir = join(tmpDir, ".estacoda-fresh");
    await mkdir(freshDbDir, { recursive: true });
    const freshDbPath = join(freshDbDir, "sessions.sqlite");
    const freshDb = openDefaultSQLiteDatabase({ path: freshDbPath });
    const freshExecutionStore = new CronExecutionStore({ db: freshDb });
    const job = await store.create({ schedule: "1h", prompt: "test" });
    const resultShow = await runCronCommand({ args: ["show", job.id], store, executionStore: freshExecutionStore });
    expect(resultShow.ok).toBe(true);
    expect(resultShow.output).toContain(job.id);
    const resultHistory = await runCronCommand({ args: ["history", job.id], store, executionStore: freshExecutionStore });
    expect(resultHistory.ok).toBe(true);
    freshDb.close();
  });
});
