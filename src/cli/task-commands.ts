import { defaultProfileId, readActiveProfile, resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import { resolveHomeDir } from "../config/home-dir.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { readGatewayState } from "../gateway/supervisor-state.js";
import { isStalePid } from "../gateway/pid-file.js";
import { SQLiteTaskStore } from "../workflow/sqlite-task-store.js";
import {
  normalizeTaskOperatorObjective,
  TaskOperatorService,
  type TaskStatusProjection
} from "../workflow/task-operator-service.js";
import { resolveTaskWorkspaceBinding } from "../workflow/task-workspace.js";
import { readConfig } from "../config/runtime-config.js";
import { isolateLtr } from "../ui/bidi.js";
import type { CliCommandResult, CliOptions } from "./cli.js";

type TaskCommandLocale = "en" | "ar";

export type TaskCommandContext = {
  args: readonly string[];
  service: TaskOperatorService;
  authorizedSessionId?: string;
  begin?: (objective: string, creatorSessionId?: string) => Promise<TaskBeginOutcome>;
  workspaceTrusted?: (projection: TaskStatusProjection) => Promise<boolean>;
  backgroundHost?: () => Promise<"active" | "inactive">;
  locale?: TaskCommandLocale;
};

export type TaskBeginOutcome = {
  task: TaskStatusProjection;
  creatorSessionId: string;
};

export async function taskCommand(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const homeDir = resolveHomeDir(options.homeDir);
  const profileId = options.profileId ?? readActiveProfile({ homeDir }).profileId ?? defaultProfileId();
  const paths = resolveGlobalStateHome({ homeDir });
  let db: Awaited<ReturnType<typeof createSQLiteSessionDB>> | undefined;
  let locale: TaskCommandLocale = "en";
  try {
    db = await createSQLiteSessionDB({ path: paths.sessionsSqlitePath });
    const store = new SQLiteTaskStore({ db: db.db, profileId });
    const service = new TaskOperatorService({ store });
    const profilePaths = resolveProfileStateHome({ homeDir, profileId });
    locale = (await readConfig(profilePaths.configPath)).config.ui?.language === "ar" ? "ar" : "en";
    const trust = new WorkspaceTrustStore({ homeDir });
    const result = await executeTaskCommand({
      args,
      service,
      locale,
      begin: async (objective, creatorSessionId) => {
        if (!(await trust.isTrusted(options.workspaceRoot))) {
          throw new Error("Task creation requires a trusted workspace.");
        }
        const workspace = await resolveTaskWorkspaceBinding(options.workspaceRoot);
        const normalizedObjective = normalizeTaskOperatorObjective(objective);
        const existingSession = creatorSessionId === undefined
          ? undefined
          : await db!.getSessionForProfile(creatorSessionId, profileId);
        if (creatorSessionId !== undefined && existingSession === undefined) {
          throw new Error(`Session ${creatorSessionId} was not found in this profile.`);
        }
        const creatorSession = existingSession ?? await db!.createSession({
          profileId,
          title: taskCreatorSessionTitle(normalizedObjective),
          metadata: { kind: "task-operator-origin", source: "cli" }
        });
        try {
          return {
            task: service.begin({ objective: normalizedObjective, workspace, creatorSessionId: creatorSession.id }),
            creatorSessionId: creatorSession.id
          };
        } catch (error) {
          if (existingSession === undefined) {
            await db!.endSession(creatorSession.id, "task-creation-failed").catch(() => undefined);
          }
          throw error;
        }
      },
      workspaceTrusted: async (projection) => {
        const task = store.getTask(projection.taskId);
        return task !== null && await trust.isTrusted(task.workspace.canonicalPath);
      },
      backgroundHost: async () => detectTaskBackgroundHost({ homeDir, profileId })
    });
    return { handled: true, exitCode: result.ok ? 0 : 1, output: result.output };
  } catch {
    return {
      handled: true,
      exitCode: 1,
      output: copy(locale,
        "Durable Task storage or workspace validation is unavailable for the selected profile.",
        "تخزين المهام الدائمة أو التحقق من مساحة العمل غير متاح للملف الشخصي المحدد.")
    };
  } finally {
    db?.close();
  }
}

export async function detectTaskBackgroundHost(input: {
  homeDir?: string;
  profileId: string;
}): Promise<"active" | "inactive"> {
  try {
    const paths = resolveProfileStateHome({ homeDir: resolveHomeDir(input.homeDir), profileId: input.profileId });
    const state = await readGatewayState(paths);
    return state?.lifecycle === "running" && state.backgroundServices?.tasks === "running" &&
      !(await isStalePid(paths)) ? "active" : "inactive";
  } catch {
    return "inactive";
  }
}

export async function executeTaskCommand(context: TaskCommandContext): Promise<{ ok: boolean; output: string }> {
  const [subcommand = "help", ...rest] = context.args;
  const locale = context.locale ?? "en";
  try {
    switch (subcommand) {
      case "help":
      case "":
        return { ok: true, output: taskHelp(locale, context.authorizedSessionId !== undefined) };
      case "begin": {
        if (context.begin === undefined) return fail(copy(locale,
          "Task creation is unavailable in this runtime.",
          "إنشاء المهام غير متاح في بيئة التشغيل هذه."));
        const parsed = parseBegin(rest, locale, context.authorizedSessionId === undefined);
        if (!parsed.ok) return fail(parsed.message);
        const created = await context.begin(parsed.objective, parsed.sessionId ?? context.authorizedSessionId);
        const task = created.task;
        const host = await context.backgroundHost?.() ?? "unknown";
        return ok([
          `${copy(locale, "Created Task", "تم إنشاء المهمة")}: ${technical(locale, task.taskId)}`,
          context.authorizedSessionId === undefined
            ? `${copy(locale, "Creator session", "جلسة المنشئ")}: ${technical(locale, created.creatorSessionId)}`
            : undefined,
          `${copy(locale, "Status", "الحالة")}: ${technical(locale, task.status)}`,
          `${copy(locale, "Steps", "الخطوات")}: ${task.progress.total}`,
          `${copy(locale, "Background host", "المضيف الخلفي")}: ${technical(locale, host)}`,
          host === "inactive" ? copy(locale,
            "The Task is durable and queued, but no active background host was detected.",
            "المهمة محفوظة ودائمة وفي قائمة الانتظار، لكن لم يُكتشف مضيف خلفي نشط.") : undefined
        ].filter((line): line is string => line !== undefined).join("\n"));
      }
      case "list": {
        const limit = parseLimit(rest, locale);
        if (!limit.ok) return fail(limit.message);
        const tasks = context.service.list({ authorizedSessionId: context.authorizedSessionId, limit: limit.value });
        if (tasks.length === 0) return ok(copy(locale, "No Tasks found.", "لم يتم العثور على مهام."));
        return ok(tasks.map((task) => [
          technical(locale, task.taskId),
          technical(locale, task.status),
          `${task.progress.completed}/${task.progress.total}`,
          oneLine(task.objective)
        ].join("\t")).join("\n"));
      }
      case "show":
      case "status": {
        const taskId = rest[0];
        if (taskId === undefined) return fail(`${copy(locale, "Usage", "الاستخدام")}: ${commandPrefix(context)} show <task-id>`);
        const task = context.service.status(taskId, context.authorizedSessionId);
        const trusted = await context.workspaceTrusted?.(task);
        const host = await context.backgroundHost?.();
        return ok(renderTask(task, trusted, host, locale));
      }
      case "pause":
      case "resume":
      case "cancel": {
        const taskId = rest[0];
        if (taskId === undefined) return fail(`${copy(locale, "Usage", "الاستخدام")}: ${commandPrefix(context)} ${subcommand} <task-id>`);
        const task = context.service[subcommand](taskId, context.authorizedSessionId);
        return ok(`${copy(locale, "Task", "المهمة")} ${technical(locale, task.taskId)}: ${technical(locale, task.status)}`);
      }
      case "retry": {
        const taskId = rest[0];
        if (taskId === undefined) return fail(`${copy(locale, "Usage", "الاستخدام")}: ${commandPrefix(context)} retry <task-id> [step-id]`);
        const task = context.service.retry(taskId, rest[1], context.authorizedSessionId);
        return ok(`${copy(locale, "Task", "المهمة")} ${technical(locale, task.taskId)}: ${copy(locale, "queued for retry", "أُدرجت في قائمة إعادة المحاولة")}`);
      }
      case "result": {
        const taskId = rest[0];
        if (taskId === undefined) return fail(`${copy(locale, "Usage", "الاستخدام")}: ${commandPrefix(context)} result <task-id>`);
        const results = context.service.results(taskId, context.authorizedSessionId);
        if (results.length === 0) return ok(copy(locale,
          `Task ${taskId} has no available results.`,
          `لا توجد نتائج متاحة للمهمة ${taskId}.`));
        return ok(results.map((result) => [
          technical(locale, result.id),
          technical(locale, result.status),
          technical(locale, result.kind),
          `${result.byteLength} bytes`,
          technical(locale, result.handle),
          result.summary === undefined ? undefined : oneLine(result.summary)
        ].filter((field): field is string => field !== undefined).join("\t")).join("\n"));
      }
      default:
        return fail(`${copy(locale, "Unknown Task command", "أمر مهمة غير معروف")}: ${subcommand}\n${taskHelp(locale, context.authorizedSessionId !== undefined)}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(localizeKnownError(message, locale));
  }
}

export function taskHelp(locale: TaskCommandLocale = "en", inSession = false): string {
  const prefix = inSession ? "/task" : "task";
  return [
    copy(locale, "Durable Task commands", "أوامر المهام الدائمة"),
    `  ${technical(locale, `${prefix} begin${inSession ? "" : " [--session <id>]"} <objective>`)}`,
    `  ${technical(locale, `${prefix} list [limit]`)}`,
    `  ${technical(locale, `${prefix} show <task-id>`)}`,
    `  ${technical(locale, `${prefix} pause <task-id>`)}`,
    `  ${technical(locale, `${prefix} resume <task-id>`)}`,
    `  ${technical(locale, `${prefix} cancel <task-id>`)}`,
    `  ${technical(locale, `${prefix} retry <task-id> [step-id]`)}`,
    `  ${technical(locale, `${prefix} result <task-id>`)}`
  ].join("\n");
}

function renderTask(
  task: TaskStatusProjection,
  workspaceTrusted: boolean | undefined,
  backgroundHost: "active" | "inactive" | undefined,
  locale: TaskCommandLocale
): string {
  const waiting = task.progress.waiting_for_input + task.progress.waiting_for_approval;
  const lines = [
    `${copy(locale, "Task", "المهمة")} ${technical(locale, task.taskId)} · ${oneLine(task.objective)}`,
    "",
    `${copy(locale, "Status", "الحالة")}: ${technical(locale, task.status)}`,
    copy(locale,
      `Progress: ${task.progress.completed} of ${task.progress.total} Steps complete`,
      `التقدم: اكتملت ${task.progress.completed} من ${task.progress.total} خطوة`),
    `${copy(locale, "Running", "قيد التنفيذ")}: ${task.progress.running}`,
    `${copy(locale, "Waiting", "قيد الانتظار")}: ${waiting}`,
    `${copy(locale, "Estimated cost", "التكلفة التقديرية")}: $${task.usage.estimatedCostUsd.toFixed(4)}${task.usage.pricingComplete ? "" : copy(locale, " (incomplete)", " (غير مكتمل)")}`,
    `${copy(locale, "Usage", "الاستخدام")}: ${task.usage.totalTokens} ${copy(locale, "tokens", "رمزًا")}${task.usage.usageComplete ? "" : copy(locale, " (incomplete)", " (غير مكتمل)")}`,
    `${copy(locale, "Results", "النتائج")}: ${task.results.length}`,
    workspaceTrusted === undefined ? undefined : `${copy(locale, "Workspace", "مساحة العمل")}: ${workspaceTrusted ? copy(locale, "trusted", "موثوقة") : copy(locale, "not trusted", "غير موثوقة")}`,
    backgroundHost === undefined ? undefined : `${copy(locale, "Background host", "المضيف الخلفي")}: ${technical(locale, backgroundHost)}`,
    task.waitReason === undefined ? undefined : `${copy(locale, "Waiting reason", "سبب الانتظار")}: ${oneLine(task.waitReason)}`,
    task.failure === undefined ? undefined : `${copy(locale, "Failure", "الفشل")}: ${technical(locale, task.failure.class)}`
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function parseBegin(
  args: readonly string[],
  locale: TaskCommandLocale,
  allowSession: boolean
): { ok: true; objective: string; sessionId?: string } | { ok: false; message: string } {
  let sessionId: string | undefined;
  const objective: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--session") {
      if (!allowSession) return { ok: false, message: copy(locale,
        "--session is available only from the top-level task command.",
        "يتوفر --session فقط من أمر task في المستوى الأعلى.") };
      const next = args[index + 1];
      if (next === undefined || next.startsWith("-")) return { ok: false, message: copy(locale, "--session requires a session ID.", "يتطلب --session معرّف جلسة.") };
      sessionId = next;
      index += 1;
    } else if (value.startsWith("-")) {
      return { ok: false, message: `${copy(locale, "Unknown task begin option", "خيار غير معروف لأمر task begin")}: ${value}` };
    } else objective.push(value);
  }
  const text = objective.join(" ").trim();
  return text.length === 0
    ? { ok: false, message: `${copy(locale, "Usage", "الاستخدام")}: task begin [--session <id>] <objective>` }
    : { ok: true, objective: text, ...(sessionId === undefined ? {} : { sessionId }) };
}

function parseLimit(args: readonly string[], locale: TaskCommandLocale): { ok: true; value: number } | { ok: false; message: string } {
  if (args.length === 0) return { ok: true, value: 20 };
  if (args.length !== 1 || !/^\d+$/u.test(args[0]!)) return { ok: false, message: `${copy(locale, "Usage", "الاستخدام")}: task list [limit]` };
  const value = Number(args[0]);
  return value >= 1 && value <= 100
    ? { ok: true, value }
    : { ok: false, message: copy(locale, "Task list limit must be between 1 and 100.", "يجب أن يكون حد قائمة المهام بين 1 و100.") };
}

function commandPrefix(context: TaskCommandContext): string {
  return context.authorizedSessionId === undefined ? "task" : "/task";
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function taskCreatorSessionTitle(objective: string): string {
  const summary = [...oneLine(objective)].slice(0, 120).join("");
  return `Task: ${summary}`;
}

function copy(locale: TaskCommandLocale, english: string, arabic: string): string {
  return locale === "ar" ? arabic : english;
}

function technical(locale: TaskCommandLocale, value: string): string {
  return locale === "ar" ? isolateLtr(value) : value;
}

function localizeKnownError(message: string, locale: TaskCommandLocale): string {
  if (locale === "en") return message;
  if (message === "Task creation requires a trusted workspace.") {
    return "يتطلب إنشاء المهمة مساحة عمل موثوقة.";
  }
  const missingSession = /^Session (.+) was not found in this profile\.$/u.exec(message);
  if (missingSession !== null) return `لم يتم العثور على الجلسة ${missingSession[1]} في هذا الملف الشخصي.`;
  const missingTask = /^Task (.+) was not found(?: in this profile| for this session)?\.$/u.exec(message);
  if (missingTask !== null) return `لم يتم العثور على المهمة ${missingTask[1]} ضمن النطاق المصرح به.`;
  return message;
}

function ok(output: string) {
  return { ok: true, output } as const;
}

function fail(output: string) {
  return { ok: false, output } as const;
}
