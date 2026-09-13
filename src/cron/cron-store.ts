import {parseExecutionTargetBinding} from '../workspaces/execution-target.js';
import type {ExecutionTargetBinding} from '../contracts/workspace.js';
import { currentCronExecutionOrigin, parseCronExecutionOrigin, sameCronExecutionOrigin, type CronExecutionOrigin } from "./cron-origin.js";
import { randomUUID } from "node:crypto";
import { readJsonState, updateJsonState } from "../storage/json-state.js";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { resolveHomeDir } from "../config/home-dir.js";
import { assertCronPromptSafe } from "./cron-safety.js";

export type CronJobStatus = "active" | "paused" | "completed";
export type CronDelivery = "local" | "origin" | string;
export type CronScheduleKind = "once" | "interval" | "cron";

export type CronJob = {
  executionOrigin?: CronExecutionOrigin;
  localTarget?:{profileId:string;binding:ExecutionTargetBinding};
  id: string;
  name: string;
  prompt: string;
  noAgent?: boolean;
  contextFrom?: string[];
  modelOverride?: {
    provider?: string;
    model: string;
  };
  enabledToolsets?: string[];
  workdir?: string;
  script?: string;
  scriptArgs?: string[];
  scriptTimeoutMs?: number;
  schedule: string;
  scheduleKind: CronScheduleKind;
  skills: string[];
  delivery: CronDelivery;
  status: CronJobStatus;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: "succeeded" | "failed";
  runCount: number;
  repeat?: number;
  runRequested?: boolean;
  origin?: {
    channel?: string;
    chatId?: string;
    userId?: string;
    threadId?: string;
  };
};

export type CronStoreSnapshot = {
  jobs: CronJob[];
};

export class CronStore {
  readonly path: string;
  readonly outputRoot: string;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(options: {
    path?: string;
    outputRoot?: string;
    homeDir?: string;
    now?: () => Date;
    id?: () => string;
  } = {}) {
    const home = resolveHomeDir(options.homeDir);
    this.path = options.path ?? join(home, ".estacoda", "cron", "jobs.json");
    this.outputRoot = options.outputRoot ?? join(home, ".estacoda", "cron", "output");
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? (() => randomUUID());
  }

  async list(): Promise<CronJob[]> {
    const origin = currentCronExecutionOrigin();
    return (await this.#load()).jobs.filter((job) => !origin || sameCronExecutionOrigin(origin, job.executionOrigin));
  }

  async get(id: string): Promise<CronJob | undefined> {
    return (await this.list()).find((job) => job.id === id);
  }

  async create(input: {
    prompt: string;
    schedule: string;
    name?: string;
    script?: string;
    scriptArgs?: string[];
    scriptTimeoutMs?: number;
    noAgent?: boolean;
    contextFrom?: string[];
    modelOverride?: CronJob["modelOverride"];
    enabledToolsets?: string[];
    workdir?: string;
    skills?: string[];
    delivery?: CronDelivery;
    repeat?: number;
    origin?: CronJob["origin"];
    localTarget?:CronJob["localTarget"];
  }): Promise<CronJob> {
    const executionOrigin = currentCronExecutionOrigin();
    if(executionOrigin&&input.localTarget)throw new Error("Channel jobs cannot substitute local authority.");
    if (executionOrigin && input.delivery !== undefined && !["local", "origin"].includes(input.delivery)) throw new Error("Channel recurring work can deliver only locally or to its authorized origin. Configure other recipients through the local operator flow.");
    if (executionOrigin && input.workdir !== undefined && input.workdir !== executionOrigin.target.workspace.canonicalPath) throw new Error("Recurring work must keep its authorized workspace.");
    if (executionOrigin) input = { ...input, workdir: executionOrigin.target.workspace.canonicalPath,
      origin: { channel: executionOrigin.sessionKey.platform, chatId: executionOrigin.sessionKey.chatId,
        userId: executionOrigin.principalId, threadId: executionOrigin.sessionKey.threadId } };
    assertCronPromptSafe(input.prompt);
    validateCronJobShape(input);
    validateLocalCronTarget(input);
    const now = this.#now().toISOString();
    const parsed = parseCronSchedule(input.schedule, this.#now());
    const job: CronJob = {
      id: `cron-${this.#id()}`,
      ...(executionOrigin ? { executionOrigin } : {}),
      ...(input.localTarget?{localTarget:structuredClone(input.localTarget)}:{}),
      name: input.name ?? summarizePrompt(input.prompt),
      prompt: input.prompt,
      ...(input.noAgent === true ? { noAgent: true } : {}),
      ...(input.contextFrom === undefined ? {} : { contextFrom: input.contextFrom }),
      ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
      ...(input.enabledToolsets === undefined ? {} : { enabledToolsets: input.enabledToolsets }),
      ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
      script: input.script,
      scriptArgs: input.scriptArgs,
      scriptTimeoutMs: input.scriptTimeoutMs,
      schedule: input.schedule,
      scheduleKind: parsed.kind,
      skills: input.skills ?? [],
      delivery: input.delivery ?? "local",
      status: "active",
      createdAt: now,
      updatedAt: now,
      nextRunAt: parsed.nextRunAt?.toISOString(),
      runCount: 0,
      repeat: input.repeat,
      origin: input.origin
    };
    await this.#mutate((jobs) => [...jobs, job]);
    return structuredClone(job);
  }

  async update(id: string, patch: Partial<Pick<CronJob, "name" | "prompt" | "noAgent" | "contextFrom" | "modelOverride" | "enabledToolsets" | "workdir" | "script" | "scriptArgs" | "scriptTimeoutMs" | "schedule" | "skills" | "delivery" | "repeat" | "localTarget">>): Promise<CronJob | undefined> {
    if (patch.prompt !== undefined) {
      assertCronPromptSafe(patch.prompt);
    }
    let updated: CronJob | undefined;
    await this.#mutate((jobs) => jobs.map((job) => {
      if (job.id !== id) return job;
      const schedule = patch.schedule ?? job.schedule;
      const parsed = patch.schedule === undefined ? undefined : parseCronSchedule(schedule, this.#now());
      const candidate = { ...job, ...patch, schedule };
      validateCronJobShape(candidate);
      validateLocalCronTarget(candidate);
      updated = {
        ...candidate,
        schedule,
        scheduleKind: parsed?.kind ?? job.scheduleKind,
        nextRunAt: parsed?.nextRunAt?.toISOString() ?? job.nextRunAt,
        updatedAt: this.#now().toISOString()
      };
      return updated;
    }));
    return updated === undefined ? undefined : structuredClone(updated);
  }

  async pause(id: string): Promise<CronJob | undefined> {
    return this.#setStatus(id, "paused");
  }

  async resume(id: string): Promise<CronJob | undefined> {
    const parsedJob = await this.get(id);
    if (parsedJob === undefined) return undefined;
    const parsed = parseCronSchedule(parsedJob.schedule, this.#now());
    let updated: CronJob | undefined;
    await this.#mutate((jobs) => jobs.map((job) => {
      if (job.id !== id) return job;
      updated = {
        ...job,
        status: "active",
        nextRunAt: parsed.nextRunAt?.toISOString(),
        updatedAt: this.#now().toISOString()
      };
      return updated;
    }));
    return updated === undefined ? undefined : structuredClone(updated);
  }

  async requestRun(id: string): Promise<CronJob | undefined> {
    let updated: CronJob | undefined;
    await this.#mutate((jobs) => jobs.map((job) => {
      if (job.id !== id) return job;
      updated = {
        ...job,
        status: job.status === "completed" ? "active" : job.status,
        runRequested: true,
        updatedAt: this.#now().toISOString()
      };
      return updated;
    }));
    return updated === undefined ? undefined : structuredClone(updated);
  }

  async remove(id: string): Promise<boolean> {
    let removed = false;
    await this.#mutate((jobs) => {
      const next = jobs.filter((job) => job.id !== id);
      removed = next.length !== jobs.length;
      return next;
    });
    return removed;
  }

  async advanceNextRun(id: string, now = this.#now()): Promise<CronJob | undefined> {
    let updated: CronJob | undefined;
    await this.#mutate((jobs) => jobs.map((job) => {
      if (job.id !== id) return job;
      const exhausted = job.repeat !== undefined && job.runCount >= job.repeat;
      const next = exhausted || job.scheduleKind === "once"
        ? undefined
        : computeNextRun(job.schedule, now)?.toISOString();
      updated = {
        ...job,
        nextRunAt: next,
        runRequested: false,
        updatedAt: now.toISOString()
      };
      return updated;
    }));
    return updated === undefined ? undefined : structuredClone(updated);
  }

  async markRunResult(id: string, input: { ok: boolean; output: string }, now = this.#now()): Promise<CronJob | undefined> {
    await this.writeOutput(id, now, input.output);
    let updated: CronJob | undefined;
    await this.#mutate((jobs) => jobs.map((job) => {
      if (job.id !== id) return job;
      const runCount = job.runCount + 1;
      const exhausted = job.repeat !== undefined && runCount >= job.repeat;
      // Preserve already-advanced nextRunAt if it is still in the future.
      const currentNext = job.nextRunAt !== undefined ? new Date(job.nextRunAt) : undefined;
      const alreadyAdvanced = currentNext !== undefined && currentNext.getTime() > now.getTime();
      const next = exhausted || job.scheduleKind === "once"
        ? undefined
        : (alreadyAdvanced ? job.nextRunAt : computeNextRun(job.schedule, now)?.toISOString());
      updated = {
        ...job,
        runCount,
        runRequested: false,
        lastRunAt: now.toISOString(),
        lastStatus: input.ok ? "succeeded" : "failed",
        status: exhausted || job.scheduleKind === "once" ? "completed" : job.status,
        nextRunAt: next,
        updatedAt: now.toISOString()
      };
      return updated;
    }));
    return updated === undefined ? undefined : structuredClone(updated);
  }

  async due(now = this.#now()): Promise<CronJob[]> {
    return (await this.list()).filter((job) =>
      job.runRequested === true ||
      (job.status === "active" && job.nextRunAt !== undefined && new Date(job.nextRunAt).getTime() <= now.getTime())
    );
  }

  async writeOutput(jobId: string, timestamp: Date, output: string): Promise<string> {
    const safeTimestamp = timestamp.toISOString().replace(/[:.]/gu, "-");
    const path = join(this.outputRoot, jobId, `${safeTimestamp}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, output, "utf8");
    return path;
  }

  async #setStatus(id: string, status: CronJobStatus): Promise<CronJob | undefined> {
    let updated: CronJob | undefined;
    await this.#mutate((jobs) => jobs.map((job) => {
      if (job.id !== id) return job;
      updated = {
        ...job,
        status,
        runRequested: status === "paused" ? false : job.runRequested,
        updatedAt: this.#now().toISOString()
      };
      return updated;
    }));
    return updated === undefined ? undefined : structuredClone(updated);
  }

  #read(): CronStoreSnapshot {
    return readJsonState(this.path, () => ({ jobs: [] }), (value) => {
      const file = value as CronStoreSnapshot;
      if (!file || !Array.isArray(file.jobs)) throw new Error("Unsupported or corrupt cron store. Restore compatible state.");
      return { jobs: file.jobs.map(normalizeJob) };
    });
  }
  async #load(): Promise<CronStoreSnapshot> { return this.#read(); }

  async #mutate(fn: (jobs: CronJob[]) => CronJob[]): Promise<void> {
    updateJsonState(this.path, () => this.#read(), (snapshot) => {
    const next = fn(structuredClone(snapshot.jobs)).map((job) => structuredClone(job));
    const origin = currentCronExecutionOrigin();
    if (origin) {
      for (const job of snapshot.jobs) {
        if (!sameCronExecutionOrigin(origin, job.executionOrigin) && JSON.stringify(next.find((candidate) => candidate.id === job.id)) !== JSON.stringify(job)) throw new Error("Recurring job belongs to another authorized surface or workspace.");
      }
    }
    for (const job of next) if (job.executionOrigin) {
      if (job.workdir !== job.executionOrigin.target.workspace.canonicalPath) throw new Error("Recurring work cannot change its execution target. Create new work explicitly.");
      if (!["local", "origin"].includes(job.delivery)) throw new Error("Recurring delivery exceeds its authorized origin.");
    }
    snapshot.jobs = next;
    });
  }
}

export function parseCronSchedule(value: string, now = new Date()): { kind: CronScheduleKind; nextRunAt?: Date } {
  const nextRunAt = computeNextRun(value, now);
  if (nextRunAt === undefined) {
    throw new Error(`Unsupported cron schedule: ${value}`);
  }
  return {
    kind: scheduleKind(value),
    nextRunAt
  };
}

export function computeNextRun(value: string, now = new Date()): Date | undefined {
  const trimmed = value.trim();
  const every = /^every\s+(\d+)(m|h|d)$/iu.exec(trimmed);
  if (every !== null) {
    return new Date(now.getTime() + durationMs(Number(every[1]), every[2]));
  }

  const relative = /^(\d+)(m|h|d)$/iu.exec(trimmed);
  if (relative !== null) {
    return new Date(now.getTime() + durationMs(Number(relative[1]), relative[2]));
  }

  if (/^(\S+\s+){4}\S+$/u.test(trimmed)) {
    return nextCronExpressionRun(trimmed, now);
  }

  const timestamp = Date.parse(trimmed);
  if (!Number.isNaN(timestamp)) {
    return new Date(timestamp);
  }

  return undefined;
}

function scheduleKind(value: string): CronScheduleKind {
  const trimmed = value.trim();
  if (/^every\s+\d+(m|h|d)$/iu.test(trimmed)) return "interval";
  if (/^(\S+\s+){4}\S+$/u.test(trimmed)) return "cron";
  return "once";
}

function durationMs(amount: number, unit: string): number {
  const minute = 60_000;
  if (unit.toLowerCase() === "m") return amount * minute;
  if (unit.toLowerCase() === "h") return amount * 60 * minute;
  return amount * 24 * 60 * minute;
}

function nextCronExpressionRun(expression: string, now: Date): Date | undefined {
  const fields = expression.trim().split(/\s+/u);
  const start = new Date(now.getTime() + 60_000);
  start.setUTCSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    const candidate = new Date(start.getTime() + i * 60_000);
    if (
      cronFieldMatches(fields[0]!, candidate.getUTCMinutes(), 0, 59) &&
      cronFieldMatches(fields[1]!, candidate.getUTCHours(), 0, 23) &&
      cronFieldMatches(fields[2]!, candidate.getUTCDate(), 1, 31) &&
      cronFieldMatches(fields[3]!, candidate.getUTCMonth() + 1, 1, 12) &&
      cronFieldMatches(fields[4]!, candidate.getUTCDay(), 0, 7)
    ) {
      return candidate;
    }
  }
  return undefined;
}

function cronFieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((part) => {
    if (part === "*") return true;
    const step = /^\*\/(\d+)$/u.exec(part);
    if (step !== null) return value % Number(step[1]) === 0;
    const range = /^(\d+)-(\d+)$/u.exec(part);
    if (range !== null) return value >= Number(range[1]) && value <= Number(range[2]);
    const numeric = Number(part);
    if (!Number.isInteger(numeric)) return false;
    const normalized = max === 7 && numeric === 7 ? 0 : numeric;
    return normalized >= min && normalized <= max && normalized === value;
  });
}

function normalizeJob(job: CronJob): CronJob {
  validateLocalCronTarget(job);
  if (job.executionOrigin !== undefined) parseCronExecutionOrigin(job.executionOrigin);
  const normalized = {
    ...job,
    scriptArgs: Array.isArray(job.scriptArgs) ? job.scriptArgs : undefined,
    skills: Array.isArray(job.skills) ? job.skills : [],
    runCount: Number.isFinite(job.runCount) ? job.runCount : 0,
    status: job.status ?? "active",
    delivery: job.delivery ?? "local"
  };
  if (job.noAgent === true) {
    normalized.noAgent = true;
  } else {
    delete normalized.noAgent;
  }
  if (Array.isArray(job.contextFrom)) {
    normalized.contextFrom = job.contextFrom.filter((value): value is string => typeof value === "string");
  } else {
    delete normalized.contextFrom;
  }
  if (isCronModelOverride(job.modelOverride)) {
    normalized.modelOverride = normalizeCronModelOverride(job.modelOverride);
  } else {
    delete normalized.modelOverride;
  }
  if (Array.isArray(job.enabledToolsets)) {
    normalized.enabledToolsets = normalizeStringList(job.enabledToolsets);
  } else {
    delete normalized.enabledToolsets;
  }
  if (typeof job.workdir === "string" && job.workdir.trim().length > 0) {
    normalized.workdir = job.workdir.trim();
  } else {
    delete normalized.workdir;
  }
  return normalized;
}

function validateCronJobShape(input: {
  noAgent?: boolean;
  contextFrom?: unknown;
  modelOverride?: unknown;
  enabledToolsets?: unknown;
  workdir?: unknown;
  script?: string;
}): void {
  if (input.noAgent === true && (input.script === undefined || input.script.trim().length === 0)) {
    throw new Error("Cron noAgent jobs require a script.");
  }
  if (input.contextFrom !== undefined && !Array.isArray(input.contextFrom)) {
    throw new Error("Cron contextFrom must be an array of job ids.");
  }
  if (Array.isArray(input.contextFrom) && input.contextFrom.some((value) => typeof value !== "string")) {
    throw new Error("Cron contextFrom must be an array of job ids.");
  }
  if (input.modelOverride !== undefined && !isCronModelOverride(input.modelOverride)) {
    throw new Error("Cron modelOverride must include a model string and optional provider string.");
  }
  if (input.enabledToolsets !== undefined && !Array.isArray(input.enabledToolsets)) {
    throw new Error("Cron enabledToolsets must be an array of toolset names.");
  }
  if (Array.isArray(input.enabledToolsets) && input.enabledToolsets.some((value: unknown) => typeof value !== "string")) {
    throw new Error("Cron enabledToolsets must be an array of toolset names.");
  }
  if (input.workdir !== undefined && (typeof input.workdir !== "string" || input.workdir.trim().length === 0)) {
    throw new Error("Cron workdir must be a non-empty string.");
  }
}

function isCronModelOverride(value: unknown): value is NonNullable<CronJob["modelOverride"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.model === "string" &&
    record.model.trim().length > 0 &&
    (record.provider === undefined || typeof record.provider === "string");
}

function normalizeCronModelOverride(value: NonNullable<CronJob["modelOverride"]>): NonNullable<CronJob["modelOverride"]> {
  return {
    ...(value.provider === undefined || value.provider.trim().length === 0 ? {} : { provider: value.provider.trim() }),
    model: value.model.trim()
  };
}

function normalizeStringList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function summarizePrompt(prompt: string): string {
  const single = prompt.trim().replace(/\s+/gu, " ");
  return single.length <= 48 ? single : `${single.slice(0, 45)}...`;
}

function validateLocalCronTarget(job:{localTarget?:CronJob['localTarget'];executionOrigin?:CronExecutionOrigin;workdir?:string}){
 if(job.localTarget===undefined)return;
 if(!job.localTarget||job.executionOrigin||typeof job.localTarget.profileId!=='string'||!job.localTarget.profileId)throw new Error('Invalid local recurring authority.');
 const binding=parseExecutionTargetBinding(job.localTarget.binding);
 if(job.workdir!==binding.workspace.canonicalPath)throw new Error('A bound schedule must retain its reviewed target.');
}
