import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronStore } from "./cron-store.js";
import { CronExecutionStore } from "./cron-execution-store.js";
import { createFileCronJobLock } from "./cron-lock.js";
import { buildCronPrompt, createRuntimeCronRunner, tickCron, type CronRunner } from "./cron-runner.js";
import type { CronJob } from "./cron-store.js";
import { HookRegistry } from "../gateway/hook-registry.js";
import type { SQLiteDatabase } from "../storage/sqlite.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";

function mockOk(job: CronJob): ReturnType<CronRunner["runJob"]> {
  return Promise.resolve({
    job,
    ok: true,
    output: "done",
    delivered: true,
    deliveryResults: new Map()
  });
}

function mockFail(
  job: CronJob,
  failureClass: string,
  failureMessage: string
): ReturnType<CronRunner["runJob"]> {
  return Promise.resolve({
    job,
    ok: false,
    output: "error",
    delivered: false,
    deliveryResults: new Map(),
    failureClass,
    failureMessage
  });
}

function fakeCronJob(): CronJob {
  return {
    id: "cron-test-runtime",
    name: "Runtime job",
    prompt: "Summarize the queue.",
    schedule: "* * * * *",
    scheduleKind: "cron",
    skills: [],
    delivery: "local",
    status: "active",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    runCount: 0
  };
}

function fakeRuntime(text: string) {
  return {
    handle: vi.fn(async () => ({ text })),
    dispose: vi.fn(async () => undefined)
  };
}

describe("createRuntimeCronRunner", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "estacoda-cron-runtime-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("marks empty runtime responses as failures without attempting delivery", async () => {
    const job = fakeCronJob();
    const runtime = fakeRuntime("");
    const deliver = vi.fn();
    const runner = createRuntimeCronRunner({
      runtimeFactory: vi.fn(async () => runtime as never),
      deliver
    });

    const result = await runner.runJob(job, "exec-empty");

    expect(result.ok).toBe(false);
    expect(result.delivered).toBe(false);
    expect(result.deliveryResults.size).toBe(0);
    expect(result.failureClass).toBe("runtime_error");
    expect(result.output).toContain("Agent completed but produced empty response (model error, timeout, or misconfiguration)");
    expect(deliver).not.toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it("preserves delivery behavior for non-empty runtime responses", async () => {
    const job = fakeCronJob();
    const runtime = fakeRuntime("Cron completed.");
    const perTarget = new Map([["local", { success: true }]]);
    const deliver = vi.fn(async () => ({ success: true, perTarget }));
    const runner = createRuntimeCronRunner({
      runtimeFactory: vi.fn(async () => runtime as never),
      deliver
    });

    const result = await runner.runJob(job, "exec-ok");

    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(true);
    expect(result.deliveryResults).toBe(perTarget);
    expect(result.output).toContain("Cron completed.");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("preserves silent behavior for non-empty silent runtime responses", async () => {
    const job = fakeCronJob();
    const runtime = fakeRuntime("[SILENT] Cron completed.");
    const deliver = vi.fn();
    const runner = createRuntimeCronRunner({
      runtimeFactory: vi.fn(async () => runtime as never),
      deliver
    });

    const result = await runner.runJob(job, "exec-silent");

    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(true);
    expect(result.deliveryResults.size).toBe(0);
    expect(result.output).toContain("[SILENT] Cron completed.");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("injects script result into agent prompt and calls the runtime once", async () => {
    const scriptPath = join(tmpDir, "status.sh");
    await writeFile(scriptPath, "printf 'script-ok\\n'", "utf8");
    const job = { ...fakeCronJob(), script: "status.sh" };
    const runtime = fakeRuntime("Agent used script output.");
    const runtimeFactory = vi.fn(async () => runtime as never);
    const runner = createRuntimeCronRunner({
      runtimeFactory,
      workspaceRoot: tmpDir,
      wrapResponse: false
    });

    const result = await runner.runJob(job, "exec-script");

    expect(result.ok).toBe(true);
    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    expect(runtime.handle).toHaveBeenCalledTimes(1);
    expect(runtime.handle).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Cron script result:")
    }));
    expect(runtime.handle).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("script-ok")
    }));
  });

  it("keeps attached skills as labels only in the current cron prompt", () => {
    const prompt = buildCronPrompt({
      ...fakeCronJob(),
      skills: ["daily-reporting"],
      prompt: "Write the report."
    });

    expect(prompt).toContain("Attached skills: daily-reporting");
    expect(prompt).not.toContain("Follow these skill instructions");
    expect(prompt).not.toContain("## Attached Skill");
  });
});

describe("tickCron with execution store and job lock", () => {
  let tmpDir: string;
  let store: CronStore;
  let db: SQLiteDatabase;
  let executionStore: CronExecutionStore;
  let lockDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "estacoda-cron-runner-test-"));
    store = new CronStore({ homeDir: tmpDir });
    db = openDefaultSQLiteDatabase({ path: join(tmpDir, "test.db") });
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
      );
      create index if not exists idx_cron_executions_job on cron_executions(job_id, started_at desc);
      create index if not exists idx_cron_executions_status on cron_executions(status, started_at desc);
    `);
    executionStore = new CronExecutionStore({ db });
    lockDir = join(tmpDir, "locks");
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records execution history for a successful job", async () => {
    await store.create({
      name: "Test job",
      schedule: "* * * * *",
      prompt: "hello",
      delivery: "local"
    });

    const runner: CronRunner = { runJob: async (job) => mockOk(job) };

    const now = new Date("2030-01-01T00:00:00Z");
    const results = await tickCron({
      store,
      runner,
      executionStore,
      jobLock: createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 }),
      now
    });

    expect(results.length).toBe(1);
    expect(results[0].ok).toBe(true);

    const history = await executionStore.list();
    expect(history.length).toBe(1);
    expect(history[0].status).toBe("success");
    expect(history[0].jobId).toBe(results[0].job.id);
  });

  it("currently completes runner-backed executions without session or trajectory linkage", async () => {
    await store.create({
      name: "Evidence baseline job",
      schedule: "* * * * *",
      prompt: "hello",
      delivery: "local"
    });
    const runtime = {
      ...fakeRuntime("done"),
      sessionId: "cron-session-baseline",
      trajectoryId: "trajectory-baseline"
    };
    const runner = createRuntimeCronRunner({
      runtimeFactory: vi.fn(async () => runtime as never),
      wrapResponse: false
    });

    const now = new Date("2030-01-01T00:00:00Z");
    await tickCron({
      store,
      runner,
      executionStore,
      jobLock: createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 }),
      now
    });

    const [record] = await executionStore.list();
    expect(record?.status).toBe("success");
    expect(record?.sessionId).toBeUndefined();
    expect(record?.trajectoryId).toBeUndefined();
  });

  it("records execution history for a failed job", async () => {
    await store.create({
      name: "Failing job",
      schedule: "* * * * *",
      prompt: "fail",
      delivery: "local"
    });

    const runner: CronRunner = {
      runJob: async (job) => mockFail(job, "script_error", "Exit code 1")
    };

    const now = new Date("2030-01-01T00:00:00Z");
    const results = await tickCron({
      store,
      runner,
      executionStore,
      jobLock: createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 }),
      now
    });

    expect(results[0].ok).toBe(false);

    const history = await executionStore.list();
    expect(history.length).toBe(1);
    expect(history[0].status).toBe("failed");
    expect(history[0].failureClass).toBe("script_error");
  });

  it("skips a due job if the lock is already held", async () => {
    await store.create({
      name: "Locked job",
      schedule: "* * * * *",
      prompt: "hello",
      delivery: "local"
    });

    let runnerCalled = false;
    const runner: CronRunner = {
      runJob: async (job) => {
        runnerCalled = true;
        return mockOk(job);
      }
    };

    // Use a mock lock that simulates an already-held lock
    let acquireCalled = false;
    const mockLock: import("./cron-lock.js").CronJobLock = {
      acquire: async () => {
        acquireCalled = true;
        return { acquired: false, stale: false };
      },
      release: async () => {},
      isLocked: async () => true,
      staleSince: async () => undefined
    };

    const now = new Date("2030-01-01T00:00:00Z");

    const results = await tickCron({ store, runner, executionStore, jobLock: mockLock, now });
    expect(results.length).toBe(1);
    expect(results[0].skipped).toBe(true);
    expect(acquireCalled).toBe(true);
    expect(runnerCalled).toBe(false);
  });

  it("allows re-execution after lock release", async () => {
    await store.create({
      name: "Re-runnable job",
      schedule: "* * * * *",
      prompt: "hello",
      delivery: "local"
    });

    let callCount = 0;
    const runner: CronRunner = {
      runJob: async (job) => {
        callCount++;
        return mockOk(job);
      }
    };

    const jobLock = createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 });
    const now = new Date("2030-01-01T00:00:00Z");

    const results1 = await tickCron({ store, runner, executionStore, jobLock, now });
    expect(results1.length).toBe(1);
    expect(callCount).toBe(1);

    // Simulate the job finishing and lock being released
    await jobLock.release(results1[0].job.id);

    // Run again at a future time when the job is due again
    // First run set nextRunAt to 00:01:00, so 00:01:01 makes it due
    const later = new Date("2030-01-01T00:01:01Z");

    const results2 = await tickCron({ store, runner, executionStore, jobLock, now: later });
    expect(results2.length).toBe(1);
    expect(callCount).toBe(2);
  });
  it("records delivery results per target", async () => {
    await store.create({
      name: "Delivery job",
      schedule: "* * * * *",
      prompt: "hello",
      delivery: "local"
    });

    const runner: CronRunner = {
      runJob: async (job) => ({
        job,
        ok: true,
        output: "done",
        delivered: true,
        deliveryResults: new Map([
          ["telegram:123", { success: true }],
          ["email:a@b.com", { success: false, error: "SMTP down" }]
        ])
      })
    };

    const now = new Date("2030-01-01T00:00:00Z");
    const results = await tickCron({
      store,
      runner,
      executionStore,
      jobLock: createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 }),
      now
    });

    expect(results[0].ok).toBe(true);

    const history = await executionStore.list();
    expect(history[0].deliveryResults.size).toBe(2);
    expect(history[0].deliveryResults.get("telegram:123")?.success).toBe(true);
    expect(history[0].deliveryResults.get("email:a@b.com")?.success).toBe(false);
  });

  it("classifies timeout failures", async () => {
    await store.create({
      name: "Timeout job",
      schedule: "* * * * *",
      prompt: "hello",
      delivery: "local"
    });

    const runner: CronRunner = {
      runJob: async (job) => mockFail(job, "timeout", "Script exceeded 30000ms")
    };

    const now = new Date("2030-01-01T00:00:00Z");
    const results = await tickCron({
      store,
      runner,
      executionStore,
      jobLock: createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 }),
      now
    });

    const history = await executionStore.list();
    expect(history[0].failureClass).toBe("timeout");
  });

  it("handles runner exceptions with runtime_error classification", async () => {
    await store.create({
      name: "Exploding job",
      schedule: "* * * * *",
      prompt: "hello",
      delivery: "local"
    });

    const runner: CronRunner = {
      runJob: async () => {
        throw new Error("Boom");
      }
    };

    const now = new Date("2030-01-01T00:00:00Z");
    const results = await tickCron({
      store,
      runner,
      executionStore,
      jobLock: createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 }),
      now
    });

    expect(results[0].ok).toBe(false);

    const history = await executionStore.list();
    expect(history[0].status).toBe("failed");
    expect(history[0].failureClass).toBe("runtime_error");
  });

  it("advances nextRunAt under lock before execution to prevent duplicates", async () => {
    await store.create({
      name: "Advance job",
      schedule: "* * * * *",
      prompt: "hello",
      delivery: "local"
    });

    let callCount = 0;
    const runner: CronRunner = {
      runJob: async (job) => {
        callCount++;
        return mockOk(job);
      }
    };

    const jobLock = createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 });
    const now = new Date("2030-01-01T00:00:00Z");

    // First tick - job runs and nextRunAt is advanced before execution
    const results1 = await tickCron({ store, runner, executionStore, jobLock, now });
    expect(results1.length).toBe(1);
    expect(callCount).toBe(1);

    // Second tick at same time - job should NOT be due because nextRunAt was advanced
    const results2 = await tickCron({ store, runner, executionStore, jobLock, now });
    expect(results2.length).toBe(0);
    expect(callCount).toBe(1); // no additional call
  });

  it("recovers stale global tick lock so crashes cannot block all future ticks", async () => {
    await store.create({
      name: "Tick lock job",
      schedule: "* * * * *",
      prompt: "hello",
      delivery: "local"
    });

    const runner: CronRunner = { runJob: async (job) => mockOk(job) };
    const tickLockPath = join(lockDir, "stale-tick.lock");

    // Write a stale tick lock file (old format, past timeout)
    await mkdir(lockDir, { recursive: true });
    await writeFile(tickLockPath, "2020-01-01T00:00:00.000Z", "utf8");

    const now = new Date("2030-01-01T00:00:00Z");
    const results = await tickCron({
      store,
      runner,
      executionStore,
      jobLock: createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 }),
      lockPath: tickLockPath,
      now
    });

    expect(results.length).toBe(1);
    expect(results[0].ok).toBe(true);
  });

  it("respects fresh global tick lock and skips tick", async () => {
    await store.create({
      name: "Fresh tick lock job",
      schedule: "* * * * *",
      prompt: "hello",
      delivery: "local"
    });

    let callCount = 0;
    const runner: CronRunner = {
      runJob: async (job) => {
        callCount++;
        return mockOk(job);
      }
    };
    const tickLockPath = join(lockDir, "fresh-tick.lock");

    // Write a fresh tick lock file (new format, within timeout)
    await mkdir(lockDir, { recursive: true });
    const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    await writeFile(tickLockPath, content, "utf8");

    const now = new Date("2030-01-01T00:00:00Z");
    const results = await tickCron({
      store,
      runner,
      executionStore,
      jobLock: createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 }),
      lockPath: tickLockPath,
      now
    });

    expect(results.length).toBe(0);
    expect(callCount).toBe(0);
  });

  it("classifies provider_error failures", async () => {
    await store.create({
      name: "Provider job",
      schedule: "* * * * *",
      prompt: "hello",
      delivery: "local"
    });

    const runner: CronRunner = {
      runJob: async (job) => mockFail(job, "provider_error", "Provider rate limit")
    };

    const now = new Date("2030-01-01T00:00:00Z");
    const results = await tickCron({
      store,
      runner,
      executionStore,
      jobLock: createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 }),
      now
    });

    const history = await executionStore.list();
    expect(history[0].failureClass).toBe("provider_error");
  });

  it("works without executionStore and jobLock (backward compat)", async () => {
    await store.create({
      name: "Compat job",
      schedule: "* * * * *",
      prompt: "hello",
      delivery: "local"
    });

    const runner: CronRunner = { runJob: async (job) => mockOk(job) };

    const now = new Date("2030-01-01T00:00:00Z");
    const results = await tickCron({ store, runner, now });
    expect(results.length).toBe(1);
    expect(results[0].ok).toBe(true);
  });

  describe("hook emissions", () => {
    let events: Array<{ name: string; payload: unknown }> = [];
    let originalEmit: typeof HookRegistry.prototype.emit;

    beforeEach(() => {
      events = [];
      originalEmit = HookRegistry.prototype.emit;
      HookRegistry.prototype.emit = async function (name: string, payload: unknown) {
        events.push({ name, payload });
        return originalEmit.call(this, name as any, payload as any);
      };
    });

    afterEach(() => {
      HookRegistry.prototype.emit = originalEmit;
    });

    it("cron:tick:start emitted with correct dueCount", async () => {
      await store.create({ name: "Job A", schedule: "* * * * *", prompt: "a", delivery: "local" });
      await store.create({ name: "Job B", schedule: "* * * * *", prompt: "b", delivery: "local" });

      const runner: CronRunner = { runJob: async (job) => mockOk(job) };
      const hookRegistry = new HookRegistry();
      const now = new Date("2030-01-01T00:00:00Z");
      await tickCron({ store, runner, executionStore, jobLock: createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 }), hookRegistry, now });

      const startEvents = events.filter((e) => e.name === "cron:tick:start");
      expect(startEvents).toHaveLength(1);
      expect((startEvents[0].payload as Record<string, unknown>).dueCount).toBe(2);
    });

    it("cron:tick:complete emitted with correct totals after mixed results", async () => {
      await store.create({ name: "Ok job", schedule: "* * * * *", prompt: "ok", delivery: "local" });
      await store.create({ name: "Fail job", schedule: "* * * * *", prompt: "fail", delivery: "local" });
      await store.create({ name: "Skip job", schedule: "* * * * *", prompt: "skip", delivery: "local" });

      let callCount = 0;
      const runner: CronRunner = {
        runJob: async (job) => {
          callCount++;
          if (job.name === "Fail job") return mockFail(job, "provider_error", "bad response");
          return mockOk(job);
        }
      };

      const hookRegistry = new HookRegistry();
      let acquireCount = 0;
      const mockLock: import("./cron-lock.js").CronJobLock = {
        acquire: async () => {
          acquireCount++;
          if (acquireCount === 3) return { acquired: false, stale: false };
          return { acquired: true, stale: false };
        },
        release: async () => {},
        isLocked: async () => true,
        staleSince: async () => undefined
      };

      const now = new Date("2030-01-01T00:00:00Z");
      const results = await tickCron({ store, runner, executionStore, jobLock: mockLock, hookRegistry, now });

      expect(results.filter((r) => r.ok && !r.skipped).length).toBe(1);
      expect(results.filter((r) => !r.ok && !r.skipped).length).toBe(1);
      expect(results.filter((r) => r.skipped).length).toBe(1);

      const completeEvents = events.filter((e) => e.name === "cron:tick:complete");
      expect(completeEvents).toHaveLength(1);
      const payload = completeEvents[0].payload as Record<string, unknown>;
      expect(payload.total).toBe(3);
      expect(payload.passed).toBe(1);
      expect(payload.failed).toBe(1);
      expect(payload.skipped).toBe(1);
    });

    it("cron:job:fail emitted when runner returns ok: false", async () => {
      await store.create({ name: "Fail job", schedule: "* * * * *", prompt: "fail", delivery: "local" });

      const runner: CronRunner = {
        runJob: async (job) => mockFail(job, "provider_error", "bad response")
      };

      const hookRegistry = new HookRegistry();
      const now = new Date("2030-01-01T00:00:00Z");
      await tickCron({ store, runner, executionStore, jobLock: createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 }), hookRegistry, now });

      const failEvents = events.filter((e) => e.name === "cron:job:fail");
      expect(failEvents).toHaveLength(1);
      const payload = failEvents[0].payload as Record<string, unknown>;
      expect(payload.failureClass).toBe("provider_error");
      expect(payload.delivered).toBe(false);
    });

    it("cron:job:fail emitted when runner throws", async () => {
      await store.create({ name: "Exploding job", schedule: "* * * * *", prompt: "boom", delivery: "local" });

      const runner: CronRunner = {
        runJob: async () => {
          throw new Error("boom");
        }
      };

      const hookRegistry = new HookRegistry();
      const now = new Date("2030-01-01T00:00:00Z");
      await tickCron({ store, runner, executionStore, jobLock: createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 }), hookRegistry, now });

      const failEvents = events.filter((e) => e.name === "cron:job:fail");
      expect(failEvents).toHaveLength(1);
      const payload = failEvents[0].payload as Record<string, unknown>;
      expect(payload.failureClass).toBe("runtime_error");
      expect(payload.delivered).toBe(false);
    });

    it("cron:job:fail is NOT emitted for skipped jobs", async () => {
      await store.create({ name: "Skip job", schedule: "* * * * *", prompt: "skip", delivery: "local" });

      const runner: CronRunner = { runJob: async (job) => mockOk(job) };

      const hookRegistry = new HookRegistry();
      const mockLock: import("./cron-lock.js").CronJobLock = {
        acquire: async () => ({ acquired: false, stale: false }),
        release: async () => {},
        isLocked: async () => true,
        staleSince: async () => undefined
      };

      const now = new Date("2030-01-01T00:00:00Z");
      await tickCron({ store, runner, executionStore, jobLock: mockLock, hookRegistry, now });

      const failEvents = events.filter((e) => e.name === "cron:job:fail");
      expect(failEvents).toHaveLength(0);
    });

    it("cron:tick:start and cron:tick:complete ordering", async () => {
      await store.create({ name: "Job A", schedule: "* * * * *", prompt: "a", delivery: "local" });

      const runner: CronRunner = { runJob: async (job) => mockOk(job) };
      const hookRegistry = new HookRegistry();
      const now = new Date("2030-01-01T00:00:00Z");
      await tickCron({ store, runner, executionStore, jobLock: createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 }), hookRegistry, now });

      const startIdx = events.findIndex((e) => e.name === "cron:tick:start");
      const completeIdx = events.findIndex((e) => e.name === "cron:tick:complete");
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(completeIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeLessThan(completeIdx);
    });

    it("hook failure does not affect execution store, locks, or markRunResult", async () => {
      const originalEmit = HookRegistry.prototype.emit;
      try {
        HookRegistry.prototype.emit = async function (name: string, payload: unknown) {
          if (name === "cron:job:fail") {
            throw new Error("hook boom");
          }
          return originalEmit.call(this, name as any, payload as any);
        };

        await store.create({ name: "Fail job", schedule: "* * * * *", prompt: "fail", delivery: "local" });

        const runner: CronRunner = {
          runJob: async (job) => mockFail(job, "provider_error", "bad response")
        };

        const hookRegistry = new HookRegistry();
        const jobLock = createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 });
        const now = new Date("2030-01-01T00:00:00Z");
        const results = await tickCron({ store, runner, executionStore, jobLock, hookRegistry, now });

        expect(results[0].ok).toBe(false);

        const history = await executionStore.list();
        expect(history.length).toBe(1);
        expect(history[0].status).toBe("failed");

        // Lock should be released
        const locked = await jobLock.isLocked(results[0].job.id);
        expect(locked).toBe(false);
      } finally {
        HookRegistry.prototype.emit = originalEmit;
      }
    });

    it("no hooks emitted when hookRegistry is omitted", async () => {
      await store.create({ name: "Job A", schedule: "* * * * *", prompt: "a", delivery: "local" });

      const runner: CronRunner = { runJob: async (job) => mockOk(job) };
      const now = new Date("2030-01-01T00:00:00Z");
      await tickCron({ store, runner, executionStore, jobLock: createFileCronJobLock({ lockDir, staleTimeoutMs: 60_000 }), now });

      expect(events).toHaveLength(0);
    });
  });
});
