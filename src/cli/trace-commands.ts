import type { CliCommandResult, CliOptions } from "./cli.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { resolveStateHome } from "../config/state-home.js";
import { defaultProfileId, readActiveProfile } from "../config/profile-home.js";
import type { Trajectory, TrajectoryEvent } from "../contracts/trajectory.js";
import { redactObject, redactJson } from "../utils/redaction.js";

export async function trace(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand, ...restArgs] = args;

  const openedDb = await openTraceDb(options);
  const db = openedDb.db;
  const profileId = selectedProfileId(options.homeDir);

  try {
    switch (subcommand) {
      case "list":
        return traceList(db, profileId, restArgs);
      case "dump":
        return traceDump(db, profileId, restArgs);
      case "timeline":
        return traceTimeline(db, profileId, restArgs);
      case "failures":
        return traceFailures(db, profileId, restArgs);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        return {
          handled: true,
          exitCode: 0,
          output: traceHelp()
        };
      default:
        return {
          handled: true,
          exitCode: 1,
          output: `Unknown trace subcommand: ${subcommand}\n\n${traceHelp()}`
        };
    }
  } finally {
    await openedDb.close();
  }
}

function selectedProfileId(homeDir?: string): string {
  return readActiveProfile({ homeDir }).profileId ?? defaultProfileId();
}

async function openTraceDb(options: CliOptions): Promise<{ db: SQLiteSessionDB; close: () => void }> {
  // Prefer runtime's sessionDb if it's a SQLiteSessionDB
  if (options.runtime?.sessionDb instanceof SQLiteSessionDB) {
    return { db: options.runtime.sessionDb, close: () => undefined };
  }

  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const db = await createSQLiteSessionDB({ path: stateHome.sessionsSqlitePath });
  return { db, close: () => db.close() };
}

function traceHelp(): string {
  return [
    "EstaCoda trace commands",
    "  estacoda trace list                 List recent trajectories",
    "  estacoda trace list --session <id>  List trajectories for a session",
    "  estacoda trace list --limit 20      Paginate results",
    "  estacoda trace dump <id>            Output trajectory JSON (redacted)",
    "  estacoda trace dump <id> --raw      Output trajectory JSON (unredacted)",
    "  estacoda trace timeline <id>        Human-readable event timeline",
    "  estacoda trace timeline <id> --raw  Show raw event data",
    "  estacoda trace failures <id>        List classified failures for a trajectory"
  ].join("\n");
}

async function traceList(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const sessionId = valueAfter(args, "--session");
  const limit = parseInt(valueAfter(args, "--limit") ?? "20", 10);

  let trajectories: Trajectory[];

  if (sessionId !== undefined) {
    trajectories = await db.listTrajectoriesForSession(sessionId, { profileId });
  } else {
    trajectories = await db.listTrajectoriesForProfile(profileId, { limit });
  }

  if (trajectories.length === 0) {
    return {
      handled: true,
      exitCode: 0,
      output: "No trajectories found."
    };
  }

  const lines = trajectories.map((t) => {
    const createdAt = t.events[0]?.timestamp ?? "?";
    const outcome = t.outcome?.success === true ? "✓" : t.outcome?.success === false ? "✗" : "?";
    return `${t.id}  ${outcome}  ${createdAt}  ${t.modelId}  events=${t.events.length}`;
  });

  return {
    handled: true,
    exitCode: 0,
    output: ["id  outcome  createdAt  model  events", ...lines].join("\n")
  };
}

async function traceDump(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const id = args[0];
  const raw = args.includes("--raw");

  if (id === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Usage: estacoda trace dump <id> [--raw]"
    };
  }

  const trajectory = await db.loadTrajectoryForProfile(id, profileId);

  if (trajectory === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: `Trajectory not found: ${id}`
    };
  }

  const output = raw ? JSON.stringify(trajectory, null, 2) : JSON.stringify(redactObject(trajectory), null, 2);

  return {
    handled: true,
    exitCode: 0,
    output
  };
}

async function traceTimeline(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const id = args[0];
  const raw = args.includes("--raw");

  if (id === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Usage: estacoda trace timeline <id> [--raw]"
    };
  }

  const trajectory = await db.loadTrajectoryForProfile(id, profileId);

  if (trajectory === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: `Trajectory not found: ${id}`
    };
  }

  const lines: string[] = [
    `Trajectory: ${trajectory.id}`,
    `Session:    ${trajectory.sessionId}`,
    `Profile:    ${trajectory.profileId}`,
    `Model:      ${trajectory.modelId}`,
    `Events:     ${trajectory.events.length}`,
    `Outcome:    ${trajectory.outcome?.summary ?? "pending"} (${trajectory.outcome?.success ?? "?"})`,
    ""
  ];

  for (const event of trajectory.events) {
    const time = new Date(event.timestamp).toISOString().replace("T", " ").slice(0, 19);
    const summary = summarizeEvent(event);

    if (raw) {
      lines.push(`${time}  [${event.kind}]  ${event.id}`);
      lines.push(JSON.stringify(event.data, null, 2).split("\n").map((l) => "    " + l).join("\n"));
    } else {
      lines.push(`${time}  ${event.kind.padEnd(28)}  ${summary}`);
    }
  }

  return {
    handled: true,
    exitCode: 0,
    output: lines.join("\n")
  };
}

async function traceFailures(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const id = args[0];

  if (id === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Usage: estacoda trace failures <id>"
    };
  }

  const trajectory = await db.loadTrajectoryForProfile(id, profileId);

  if (trajectory === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: `Trajectory not found: ${id}`
    };
  }

  const failures = await db.listFailuresForTrajectory(id);

  if (failures.length === 0) {
    return {
      handled: true,
      exitCode: 0,
      output: "No failures recorded for this trajectory."
    };
  }

  const lines = failures.map((f) => {
    const time = new Date(f.timestamp).toISOString().replace("T", " ").slice(0, 19);
    const recoverable = f.recoverable ? "(recoverable)" : "(fatal)";
    return `${time}  ${f.class}  ${recoverable}\n  ${f.message}`;
  });

  return {
    handled: true,
    exitCode: 0,
    output: [`Failures for trajectory ${id}:`, ...lines].join("\n")
  };
}

function summarizeEvent(event: TrajectoryEvent): string {
  const d = event.data;

  switch (event.kind) {
    case "user-input":
      return typeof d.content === "string" ? truncate(d.content, 60) : "[input]";
    case "assistant-output":
      return typeof d.content === "string" ? truncate(d.content, 60) : "[output]";
    case "tool-call": {
      const tool = typeof d.tool === "string" ? d.tool : "?";
      const input = isRecord(d.input) ? d.input : {};
      return `${tool} (${Object.keys(input).join(", ") || "no args"})`;
    }
    case "tool-result":
      return typeof d.tool === "string" ? d.tool : "?";
    case "skill-selected":
      return typeof d.skill === "string" ? d.skill : "?";
    case "skill-playbook-planned": {
      const plan = isRecord(d.plan) ? d.plan : {};
      const steps = Array.isArray(plan.steps) ? plan.steps : [];
      return `${steps.length} steps`;
    }
    case "memory-write": {
      const provider = typeof d.provider === "string" ? d.provider : "?";
      const outcome = isRecord(d.outcome) ? d.outcome : {};
      const key = typeof outcome.key === "string" ? outcome.key : "?";
      return `${provider} → ${key}`;
    }
    case "provider-completion": {
      const attempts = Array.isArray(d.attempts) ? d.attempts : [];
      return d.ok === true ? "ok" : `failed (${attempts.length} attempts)`;
    }
    case "skill-route-usage":
      return summarizeSkillRouteUsage(d);
    case "skill-route-telemetry":
      return summarizeSkillRouteTelemetry(d);
    case "session-end": {
      const outcome = isRecord(d.outcome) ? d.outcome : {};
      return typeof outcome.summary === "string" ? outcome.summary : "ended";
    }
    default:
      return "";
  }
}

function summarizeSkillRouteUsage(data: Record<string, unknown>): string {
  const skillName = typeof data.skillName === "string" ? data.skillName : "no-skill";
  const status = [
    data.selected === true ? "selected" : undefined,
    data.invoked === true ? "invoked" : undefined,
    data.deferred === true ? "deferred" : undefined
  ].filter((part): part is string => part !== undefined);
  const parts = [
    skillName,
    status.length > 0 ? status.join("+") : "candidate",
    typeof data.taskClass === "string" ? `task=${data.taskClass}` : undefined,
    typeof data.confidence === "number" ? `confidence=${formatConfidence(data.confidence)}` : undefined,
    formatStringList("labels", data.labels, 3),
    typeof data.deferReason === "string" ? `reason=${truncate(data.deferReason, 36)}` : undefined
  ];
  return compactParts(parts).join(" ");
}

function summarizeSkillRouteTelemetry(data: Record<string, unknown>): string {
  const candidates = arrayRecords(data.candidates);
  const selectedCandidate = candidates.find((candidate) => candidate.selected === true);
  const selectedSkill = stringValue(data.selectedSkill)
    ?? stringValue(selectedCandidate?.skillName)
    ?? "none";
  const primarySkill = stringValue(data.primarySkill);
  const supportingSkills = stringArray(data.supportingSkills);
  const candidateSkills = stringArray(data.candidateSkills);
  const candidatesShown = stringArray(data.candidatesShown);
  const rejectedCandidates = candidateReasons(data.rejectedCandidates ?? data.candidatesRejected);
  const deferredCandidates = candidateReasons(data.deferredCandidates);

  const parts = [
    stringValue(data.taskClass) !== undefined ? `task=${stringValue(data.taskClass)}` : undefined,
    `selected=${selectedSkill}`,
    primarySkill !== undefined ? `primary=${primarySkill}` : undefined,
    supportingSkills.length > 0 ? `supporting=${supportingSkills.slice(0, 3).join(",")}` : undefined,
    candidateSkills.length > 0 ? `candidates=${candidateSkills.slice(0, 4).join(",")}` : undefined,
    candidatesShown.length > 0 ? `shown=${candidatesShown.length}` : undefined,
    rejectedCandidates.length > 0 ? `rejected=${formatCandidateReasons(rejectedCandidates, 2)}` : undefined,
    deferredCandidates.length > 0 ? `deferred=${formatCandidateReasons(deferredCandidates, 2)}` : undefined,
    stringValue(data.finalSkillUsed) !== undefined ? `final=${stringValue(data.finalSkillUsed)}` : undefined,
    stringValue(data.finalOutcomeStatus) !== undefined ? `outcome=${stringValue(data.finalOutcomeStatus)}` : undefined,
    typeof data.routeConfidence === "number" ? `confidence=${formatConfidence(data.routeConfidence)}` : undefined
  ];

  return compactParts(parts).join(" ");
}

function compactParts(parts: Array<string | undefined>): string[] {
  return parts.filter((part): part is string => part !== undefined && part.length > 0);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function formatStringList(label: string, value: unknown, max: number): string | undefined {
  const values = stringArray(value);
  if (values.length === 0) return undefined;
  const suffix = values.length > max ? `,+${values.length - max}` : "";
  return `${label}=${values.slice(0, max).join(",")}${suffix}`;
}

function candidateReasons(value: unknown): Array<{ skillName: string; reason?: string }> {
  return arrayRecords(value)
    .flatMap((entry) => {
      const skillName = stringValue(entry.skillName);
      if (skillName === undefined) return [];
      const reason = stringValue(entry.reason);
      return reason === undefined ? [{ skillName }] : [{ skillName, reason }];
    });
}

function formatCandidateReasons(candidates: Array<{ skillName: string; reason?: string }>, max: number): string {
  const formatted = candidates.slice(0, max).map((candidate) =>
    candidate.reason === undefined
      ? candidate.skillName
      : `${candidate.skillName}(${truncate(candidate.reason, 28)})`
  );
  const suffix = candidates.length > max ? `,+${candidates.length - max}` : "";
  return `${formatted.join(",")}${suffix}`;
}

function formatConfidence(confidence: number): string {
  return Number.isFinite(confidence) ? confidence.toFixed(2) : "?";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}
