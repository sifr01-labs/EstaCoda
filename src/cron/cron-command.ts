import { CronStore, type CronJob } from "./cron-store.js";
import type { CronExecutionStore } from "./cron-execution-store.js";
import { renderCronJobs } from "./cron-tools.js";
import { commandRegistry } from "../cli/command-registry.js";

export async function runCronCommand(input: {
  args: string[];
  store: CronStore;
  executionStore?: CronExecutionStore;
  tick?: () => Promise<string>;
  origin?: CronJob["origin"];
  defaultDelivery?: string;
}): Promise<{ ok: boolean; output: string }> {
  const [command, ...rest] = input.args;
  const resolved = command !== undefined ? commandRegistry.resolveSubcommand("cron", command) : undefined;
  const canonical = resolved?.name ?? command;

  if (command === undefined || canonical === "help") {
    const cronCommands = commandRegistry.list({ scope: "both", parent: "cron" });
    const maxWidth = Math.max(...cronCommands.map((c) => c.name.length), 6);
    return {
      ok: true,
      output: [
        "EstaCoda cron",
        ...cronCommands.map(
          (cmd) => `  cron ${cmd.name.padEnd(maxWidth)}  ${cmd.description}`
        ),
      ].join("\n"),
    };
  }

  if (canonical === "add") {
    const parsed = parseCronAddArgs(rest);
    if (parsed.schedule === undefined || parsed.prompt === undefined) {
      return { ok: false, output: "Usage: cron add <schedule> \"<prompt>\" [--name name] [--skill skill]" };
    }
    if (parsed.delivery === undefined) {
      parsed.delivery = input.defaultDelivery;
    }
    const job = await input.store.create({
      ...parsed,
      schedule: parsed.schedule,
      prompt: parsed.prompt,
      origin: input.origin
    });
    return { ok: true, output: renderCreated(job) };
  }

  if (canonical === "list") {
    return { ok: true, output: renderCronJobs(await input.store.list()) };
  }

  if (canonical === "show") {
    const id = rest[0];
    if (id === undefined) {
      return { ok: false, output: "Usage: cron show <job-id>" };
    }
    const job = await input.store.get(id);
    if (job === undefined) {
      return { ok: false, output: `Cron job not found: ${id}` };
    }
    const executions = input.executionStore !== undefined
      ? await input.executionStore.list({ jobId: id, limit: 5 })
      : [];
    return { ok: true, output: renderJobDetail(job, executions) };
  }

  if (canonical === "history") {
    const limit = parseHistoryLimit(rest);
    const jobId = rest.find((arg) => !arg.startsWith("--"));
    const executions = input.executionStore !== undefined
      ? await input.executionStore.list({ jobId, limit })
      : [];
    return { ok: true, output: renderExecutionHistory(executions, jobId) };
  }

  if (canonical === "tick") {
    return { ok: true, output: input.tick === undefined ? "Cron tick requires a runtime." : await input.tick() };
  }

  const id = rest[0];
  if (id === undefined) {
    return { ok: false, output: `Usage: cron ${command} <job-id>` };
  }

  if (canonical === "edit") {
    const existing = await input.store.get(id);
    if (existing === undefined) {
      return { ok: false, output: `Cron job not found: ${id}` };
    }
    const patch = parseCronEditArgs(rest.slice(1), existing.skills);
    const job = await input.store.update(id, patch);
    return job === undefined
      ? { ok: false, output: `Cron job not found: ${id}` }
      : { ok: true, output: `Updated cron job ${job.id}: ${job.name}` };
  }

  if (canonical === "pause") return renderMaybe("Paused", await input.store.pause(id), id);
  if (canonical === "resume") return renderMaybe("Resumed", await input.store.resume(id), id);
  if (canonical === "run") return renderMaybe("Queued", await input.store.requestRun(id), id);
  if (canonical === "remove") {
    const removed = await input.store.remove(id);
    return removed
      ? { ok: true, output: `Removed cron job ${id}.` }
      : { ok: false, output: `Cron job not found: ${id}` };
  }

  return { ok: false, output: `Unknown cron command: ${command}` };
}

function parseCronAddArgs(args: string[]): {
  schedule?: string;
  prompt?: string;
  name?: string;
  script?: string;
  scriptArgs?: string[];
  scriptTimeoutMs?: number;
  skills: string[];
  delivery?: string;
  repeat?: number;
} {
  const positional: string[] = [];
  const parsed: ReturnType<typeof parseCronAddArgs> = { skills: [], scriptArgs: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--name") {
      parsed.name = next;
      index += 1;
    } else if (arg === "--skill") {
      if (next !== undefined) parsed.skills.push(next);
      index += 1;
    } else if (arg === "--delivery") {
      parsed.delivery = next;
      index += 1;
    } else if (arg === "--script") {
      parsed.script = next;
      index += 1;
    } else if (arg === "--script-arg") {
      if (next !== undefined) parsed.scriptArgs?.push(next);
      index += 1;
    } else if (arg === "--script-timeout-ms") {
      parsed.scriptTimeoutMs = next === undefined ? undefined : Number(next);
      index += 1;
    } else if (arg === "--repeat") {
      parsed.repeat = next === undefined ? undefined : Number(next);
      index += 1;
    } else {
      positional.push(arg);
    }
  }

  if (positional[0]?.toLowerCase() === "every" && positional[1] !== undefined) {
    parsed.schedule = `${positional[0]} ${positional[1]}`;
    parsed.prompt = positional.slice(2).join(" ").trim() || undefined;
  } else {
    parsed.schedule = positional[0];
    parsed.prompt = positional.slice(1).join(" ").trim() || undefined;
  }
  return parsed;
}

function parseCronEditArgs(args: string[], currentSkills: string[]): {
  schedule?: string;
  prompt?: string;
  name?: string;
  script?: string;
  scriptArgs?: string[];
  scriptTimeoutMs?: number;
  skills?: string[];
  delivery?: string;
  repeat?: number;
} {
  const parsed: ReturnType<typeof parseCronEditArgs> = {};
  let skills = [...currentSkills];
  let replaceSkills = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--schedule") {
      parsed.schedule = next;
      index += 1;
    } else if (arg === "--prompt") {
      parsed.prompt = next;
      index += 1;
    } else if (arg === "--name") {
      parsed.name = next;
      index += 1;
    } else if (arg === "--delivery") {
      parsed.delivery = next;
      index += 1;
    } else if (arg === "--script") {
      parsed.script = next;
      index += 1;
    } else if (arg === "--script-arg") {
      parsed.scriptArgs = [...(parsed.scriptArgs ?? []), next].filter((value): value is string => value !== undefined);
      index += 1;
    } else if (arg === "--clear-script-args") {
      parsed.scriptArgs = [];
    } else if (arg === "--script-timeout-ms") {
      parsed.scriptTimeoutMs = next === undefined ? undefined : Number(next);
      index += 1;
    } else if (arg === "--clear-script") {
      parsed.script = undefined;
      parsed.scriptArgs = [];
      parsed.scriptTimeoutMs = undefined;
    } else if (arg === "--repeat") {
      parsed.repeat = next === undefined ? undefined : Number(next);
      index += 1;
    } else if (arg === "--skill") {
      if (!replaceSkills) {
        skills = [];
        replaceSkills = true;
      }
      if (next !== undefined) skills.push(next);
      index += 1;
    } else if (arg === "--add-skill") {
      if (next !== undefined && !skills.includes(next)) skills.push(next);
      index += 1;
    } else if (arg === "--remove-skill") {
      if (next !== undefined) skills = skills.filter((skill) => skill !== next);
      index += 1;
    } else if (arg === "--clear-skills") {
      skills = [];
      replaceSkills = true;
    }
  }

  if (replaceSkills || skills.join("\0") !== currentSkills.join("\0")) {
    parsed.skills = skills;
  }

  return parsed;
}

function renderCreated(job: CronJob): string {
  return [
    `Created cron job ${job.id}: ${job.name}`,
    `Schedule: ${job.schedule}`,
    `Next run: ${job.nextRunAt ?? "none"}`,
    job.script === undefined ? undefined : `Script: ${job.script}`,
    `Delivery: ${job.delivery}`
  ].filter((line) => line !== undefined).join("\n");
}

function renderMaybe(prefix: string, job: CronJob | undefined, id: string): { ok: boolean; output: string } {
  return job === undefined
    ? { ok: false, output: `Cron job not found: ${id}` }
    : { ok: true, output: `${prefix} cron job ${job.id}: ${job.name}` };
}

function renderJobDetail(job: CronJob, executions: Awaited<ReturnType<CronExecutionStore["list"]>>): string {
  const lines = [
    `Cron job: ${job.id}`,
    `Name: ${job.name}`,
    `Status: ${job.status}`,
    `Schedule: ${job.schedule}`,
    `Next run: ${job.nextRunAt ?? "none"}`,
    `Last run: ${job.lastRunAt ?? "never"}`,
    `Runs: ${job.runCount}`,
    job.script === undefined ? undefined : `Script: ${job.script}`,
    `Delivery: ${job.delivery}`,
    job.skills.length === 0 ? undefined : `Skills: ${job.skills.join(", ")}`,
    "",
    `Recent executions (${executions.length} shown):`
  ].filter((line) => line !== undefined);

  if (executions.length === 0) {
    lines.push("  No execution history recorded.");
  } else {
    for (const ex of executions) {
      const duration = ex.completedAt !== undefined
        ? ` (${Math.round((new Date(ex.completedAt).getTime() - new Date(ex.startedAt).getTime()) / 1000)}s)`
        : "";
      lines.push(`  ${ex.id} [${ex.status}] ${ex.startedAt}${duration}`);
      if (ex.failureClass !== undefined) {
        lines.push(`    failure: ${ex.failureClass} — ${ex.failureMessage ?? ""}`);
      }
      if (ex.deliveryResults.size > 0) {
        const targets = Array.from(ex.deliveryResults.entries())
          .map(([target, result]) => `${target}:${result.success ? "ok" : "fail"}`)
          .join(", ");
        lines.push(`    delivery: ${targets}`);
      }
    }
  }

  return lines.join("\n");
}

function parseHistoryLimit(args: string[]): number {
  const index = args.indexOf("--limit");
  if (index === -1 || args[index + 1] === undefined) return 20;
  const parsed = Number(args[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
}

function renderExecutionHistory(
  executions: Awaited<ReturnType<CronExecutionStore["list"]>>,
  jobId?: string
): string {
  if (executions.length === 0) {
    return jobId === undefined
      ? "No cron execution history."
      : `No execution history for job ${jobId}.`;
  }

  const lines = [
    jobId === undefined ? "Cron execution history" : `Execution history for ${jobId}`,
    ...executions.map((ex) => {
      const duration = ex.completedAt !== undefined
        ? ` (${Math.round((new Date(ex.completedAt).getTime() - new Date(ex.startedAt).getTime()) / 1000)}s)`
        : "";
      const base = `${ex.id} [${ex.status}] ${ex.startedAt}${duration}`;
      if (ex.failureClass !== undefined) {
        return `${base}\n  failure: ${ex.failureClass} — ${ex.failureMessage ?? ""}`;
      }
      if (ex.deliveryResults.size > 0) {
        const targets = Array.from(ex.deliveryResults.entries())
          .map(([target, result]) => `${target}:${result.success ? "ok" : "fail"}`)
          .join(", ");
        return `${base}\n  delivery: ${targets}`;
      }
      return base;
    })
  ];

  return lines.join("\n");
}

