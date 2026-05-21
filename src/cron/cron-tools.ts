import type { RegisteredTool, RuntimeToolProvider } from "../contracts/tool.js";
import { CronStore } from "./cron-store.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import { buildCronListViewModel, buildCronActionViewModel, buildCronNotFoundViewModel } from "./cron-view-models.js";

type CronjobToolInput = {
  action?: "create" | "list" | "update" | "pause" | "resume" | "run" | "remove";
  job_id?: string;
  jobId?: string;
  prompt?: string;
  script?: string;
  script_args?: string[];
  script_timeout_ms?: number;
  clear_script?: boolean;
  schedule?: string;
  name?: string;
  skill?: string;
  skills?: string[];
  add_skill?: string;
  remove_skill?: string;
  clear_skills?: boolean;
  delivery?: string;
  repeat?: number;
};

export function createCronTools(options: { store: CronStore }): RegisteredTool[] {
  return [{
    name: "cronjob",
    description: "Create and manage scheduled EstaCoda tasks.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "update", "pause", "resume", "run", "remove"] },
        job_id: { type: "string" },
        prompt: { type: "string" },
        script: { type: "string" },
        script_args: { type: "array", items: { type: "string" } },
        script_timeout_ms: { type: "number" },
        clear_script: { type: "boolean" },
        schedule: { type: "string" },
        name: { type: "string" },
        skill: { type: "string" },
        skills: { type: "array", items: { type: "string" } },
        add_skill: { type: "string" },
        remove_skill: { type: "string" },
        clear_skills: { type: "boolean" },
        delivery: { type: "string" },
        repeat: { type: "number" }
      },
      required: ["action"]
    },
    riskClass: "shared-state-mutation",
    toolsets: ["core", "cron"],
    progressLabel: "updating cron jobs",
    maxResultSizeChars: 4000,
    isAvailable: () => true,
    run: async (input: CronjobToolInput) => {
      const action = input.action ?? "list";
      const id = input.job_id ?? input.jobId;

      if (action === "create") {
        if (input.prompt === undefined || input.schedule === undefined) {
          return { ok: false, content: "cronjob create requires prompt and schedule." };
        }
        const job = await options.store.create({
          prompt: input.prompt,
          script: input.script,
          scriptArgs: input.script_args,
          scriptTimeoutMs: input.script_timeout_ms,
          schedule: input.schedule,
          name: input.name,
          skills: normalizeSkills(input),
          delivery: input.delivery ?? "local",
          repeat: input.repeat
        });
        return { ok: true, content: `Created cron job ${job.id}: ${job.name}\nNext run: ${job.nextRunAt ?? "none"}` };
      }

      if (action === "list") {
        return { ok: true, content: renderCronJobs(await options.store.list()) };
      }

      if (id === undefined) {
        return { ok: false, content: `cronjob ${action} requires job_id.` };
      }

      if (action === "update") {
        const existing = await options.store.get(id);
        if (existing === undefined) {
          return { ok: false, content: `Cron job not found: ${id}` };
        }
        const patch = omitUndefined({
          prompt: input.prompt,
          schedule: input.schedule,
          name: input.name,
          skills: resolveUpdatedSkills(existing.skills, input),
          delivery: input.delivery,
          repeat: input.repeat
        });
        const scriptPatch = input.clear_script === true
          ? { script: undefined, scriptArgs: [], scriptTimeoutMs: undefined }
          : {
              ...(input.script === undefined ? {} : { script: input.script }),
              ...(input.script_args === undefined ? {} : { scriptArgs: input.script_args }),
              ...(input.script_timeout_ms === undefined ? {} : { scriptTimeoutMs: input.script_timeout_ms })
            };
        const job = await options.store.update(id, { ...patch, ...scriptPatch });
        return job === undefined
          ? { ok: false, content: `Cron job not found: ${id}` }
          : { ok: true, content: `Updated cron job ${job.id}: ${job.name}` };
      }

      if (action === "pause") return renderMaybeJob("Paused", await options.store.pause(id), id);
      if (action === "resume") return renderMaybeJob("Resumed", await options.store.resume(id), id);
      if (action === "run") return renderMaybeJob("Queued", await options.store.requestRun(id), id);
      if (action === "remove") {
        const removed = await options.store.remove(id);
        return removed
          ? { ok: true, content: `Removed cron job ${id}.` }
          : { ok: false, content: `Cron job not found: ${id}` };
      }

      return { ok: false, content: `Unknown cron action: ${action}` };
    }
  }];
}

export const cronToolProvider: RuntimeToolProvider = {
  name: "cron",
  kind: "runtime",
  createTools(ctx) {
    if (ctx.disableCronTools === true) {
      return [];
    }
    return createCronTools({ store: ctx.cronStore });
  }
};

export function renderCronJobs(jobs: Awaited<ReturnType<CronStore["list"]>>): string {
  return renderPlain(buildCronListViewModel({ jobs }));
}

function renderMaybeJob(prefix: string, job: Awaited<ReturnType<CronStore["get"]>>, id: string) {
  return job === undefined
    ? { ok: false, content: renderPlain(buildCronNotFoundViewModel({ id })) }
    : { ok: true, content: renderPlain(buildCronActionViewModel({ action: prefix, job })) };
}

function normalizeSkills(input: CronjobToolInput): string[] {
  return input.skills ?? (input.skill === undefined ? [] : [input.skill]);
}

function resolveUpdatedSkills(current: string[], input: CronjobToolInput): string[] | undefined {
  if (input.clear_skills === true) return [];
  if (input.skills !== undefined) return input.skills;
  if (input.skill !== undefined) return [input.skill];
  if (input.add_skill !== undefined) return current.includes(input.add_skill) ? current : [...current, input.add_skill];
  if (input.remove_skill !== undefined) return current.filter((skill) => skill !== input.remove_skill);
  return undefined;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
