import { currentCronExecutionOrigin } from "../cron/cron-origin.js";
import type { RegisteredTool, RuntimeToolProvider } from "../contracts/tool.js";
import { CronStore } from "../cron/cron-store.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import { buildCronListViewModel, buildCronActionViewModel, buildCronNotFoundViewModel } from "../cron/cron-view-models.js";
import { validateCronRuntimeControls } from "../cron/cron-runtime-validation.js";
import { resolveCronWorkdir } from "../cron/cron-workdir.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";

type CronjobToolInput = {
  action?: "create" | "list" | "update" | "pause" | "resume" | "run" | "remove";
  job_id?: string;
  jobId?: string;
  prompt?: string;
  script?: string;
  script_args?: string[];
  script_timeout_ms?: number;
  clear_script?: boolean;
  no_agent?: boolean;
  noAgent?: boolean;
  context_from?: string[];
  contextFrom?: string[];
  model?: { provider?: string; model: string } | string;
  enabled_toolsets?: string[];
  enabledToolsets?: string[];
  workdir?: string;
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

export function createCronTools(options: {
  store: CronStore;
  runtimeControls?: {
    config: LoadedRuntimeConfig;
    availableToolsets: () => string[];
  };
  workdirControls?: {
    defaultWorkspaceRoot: string;
    allowedRoots: string[];
    isWorkspaceTrusted: (path: string) => Promise<boolean>;
  };
}): RegisteredTool[] {
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
        no_agent: { type: "boolean" },
        noAgent: { type: "boolean" },
        context_from: { type: "array", items: { type: "string" } },
        contextFrom: { type: "array", items: { type: "string" } },
        model: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                provider: { type: "string" },
                model: { type: "string" }
              },
              required: ["model"]
            }
          ]
        },
        enabled_toolsets: { type: "array", items: { type: "string" } },
        enabledToolsets: { type: "array", items: { type: "string" } },
        workdir: { type: "string" },
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
        if ((input.no_agent ?? input.noAgent) === true && (input.script === undefined || input.script.trim().length === 0)) {
          return { ok: false, content: "no-agent cron jobs require script." };
        }
        const contextFrom = normalizeContextFrom(input);
        const contextError = await validateContextFrom(options.store, contextFrom);
        if (contextError !== undefined) {
          return { ok: false, content: contextError };
        }
        const controls = await validateToolRuntimeControls(options.runtimeControls, input);
        if (!controls.ok) {
          return { ok: false, content: controls.message };
        }
        const workdir = await validateToolWorkdir(options.workdirControls, input.workdir);
        if (!workdir.ok) {
          return { ok: false, content: workdir.message };
        }
        const job = await options.store.create({
          prompt: input.prompt,
          script: input.script,
          scriptArgs: input.script_args,
          scriptTimeoutMs: input.script_timeout_ms,
          noAgent: input.no_agent ?? input.noAgent,
          contextFrom,
          modelOverride: controls.normalized.modelOverride,
          enabledToolsets: controls.normalized.enabledToolsets,
          workdir: workdir.normalized.workdir,
          schedule: input.schedule,
          name: input.name,
          skills: normalizeSkills(input),
          delivery: input.delivery ?? (currentCronExecutionOrigin() ? "origin" : "local"),
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
          noAgent: input.no_agent ?? input.noAgent,
          contextFrom: normalizeContextFrom(input),
          modelOverride: normalizeModelOverrideInput(input),
          enabledToolsets: input.enabledToolsets ?? input.enabled_toolsets,
          workdir: input.workdir,
          skills: resolveUpdatedSkills(existing.skills, input),
          delivery: input.delivery,
          repeat: input.repeat
        });
        const finalScript = input.clear_script === true
          ? undefined
          : input.script ?? existing.script;
        const finalNoAgent = (input.no_agent ?? input.noAgent) ?? existing.noAgent;
        if (finalNoAgent === true && (finalScript === undefined || finalScript.trim().length === 0)) {
          return { ok: false, content: "no-agent cron jobs require script." };
        }
        const contextError = await validateContextFrom(options.store, patch.contextFrom as string[] | undefined);
        if (contextError !== undefined) {
          return { ok: false, content: contextError };
        }
        const controls = await validateToolRuntimeControls(options.runtimeControls, {
          model: patch.modelOverride as CronjobToolInput["model"],
          enabledToolsets: patch.enabledToolsets as string[] | undefined
        });
        if (!controls.ok) {
          return { ok: false, content: controls.message };
        }
        const workdir = await validateToolWorkdir(options.workdirControls, patch.workdir as string | undefined);
        if (!workdir.ok) {
          return { ok: false, content: workdir.message };
        }
        Object.assign(patch, controls.normalized);
        Object.assign(patch, workdir.normalized);
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
    return createCronTools({
      store: ctx.cronStore,
      runtimeControls: ctx.cronRuntimeControls,
      workdirControls: {
        defaultWorkspaceRoot: ctx.workspaceRoot,
        allowedRoots: [ctx.workspaceRoot],
        isWorkspaceTrusted: (path) => ctx.trustStore.isTrusted(path)
      }
    });
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

function normalizeContextFrom(input: CronjobToolInput): string[] | undefined {
  return input.contextFrom ?? input.context_from;
}

function normalizeModelOverrideInput(input: CronjobToolInput): { provider?: string; model: string } | undefined {
  if (input.model === undefined) {
    return undefined;
  }
  return typeof input.model === "string" ? { model: input.model } : input.model;
}

async function validateToolRuntimeControls(
  runtimeControls: { config: LoadedRuntimeConfig; availableToolsets: () => string[] } | undefined,
  input: Pick<CronjobToolInput, "model" | "enabled_toolsets" | "enabledToolsets">
): Promise<{ ok: true; normalized: { modelOverride?: { provider?: string; model: string }; enabledToolsets?: string[] } } | { ok: false; message: string }> {
  const modelOverride = normalizeModelOverrideInput(input);
  const enabledToolsets = input.enabledToolsets ?? input.enabled_toolsets;
  if (modelOverride === undefined && enabledToolsets === undefined) {
    return { ok: true, normalized: {} };
  }
  if (modelOverride === undefined && enabledToolsets !== undefined && enabledToolsets.length === 0) {
    return { ok: true, normalized: { enabledToolsets: [] } };
  }
  if (runtimeControls === undefined) {
    return { ok: false, message: "cronjob model/toolset controls require runtime config validation." };
  }
  return validateCronRuntimeControls({
    modelOverride,
    enabledToolsets,
    config: runtimeControls.config,
    availableToolsets: runtimeControls.availableToolsets
  });
}

async function validateToolWorkdir(
  workdirControls: {
    defaultWorkspaceRoot: string;
    allowedRoots: string[];
    isWorkspaceTrusted: (path: string) => Promise<boolean>;
  } | undefined,
  workdir: string | undefined
): Promise<{ ok: true; normalized: { workdir?: string } } | { ok: false; message: string }> {
  if (workdir === undefined) {
    return { ok: true, normalized: {} };
  }
  if (workdirControls === undefined) {
    return { ok: false, message: "cronjob workdir requires workspace trust validation context." };
  }
  const resolved = await resolveCronWorkdir({
    requestedWorkdir: workdir,
    ...workdirControls
  });
  if (!resolved.ok) {
    return { ok: false, message: resolved.message };
  }
  return { ok: true, normalized: { workdir: resolved.workdir } };
}

async function validateContextFrom(store: CronStore, jobIds: string[] | undefined): Promise<string | undefined> {
  if (jobIds === undefined) {
    return undefined;
  }
  for (const jobId of jobIds) {
    if (await store.get(jobId) === undefined) {
      return `Unknown contextFrom job id: ${jobId}`;
    }
  }
  return undefined;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
