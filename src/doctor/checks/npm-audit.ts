import { spawn } from "node:child_process";

export type NpmAuditStatus = "not-run" | "ready" | "warning";
export type AuditSeverity = "info" | "low" | "moderate" | "high" | "critical";

export type AuditSeverityCounts = Record<AuditSeverity, number>;

export type NpmAuditDiagnostic = {
  readonly status: NpmAuditStatus;
  readonly command: readonly string[];
  readonly timeoutMs: number;
  readonly totalVulnerabilities: number;
  readonly severityCounts: AuditSeverityCounts;
  readonly runtimeVulnerabilities: number;
  readonly devVulnerabilities: number;
  readonly unknownVulnerabilities: number;
  readonly timedOut: boolean;
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
};

export type AuditCommandResult = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
};

export type AuditCommandRunner = (options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}) => Promise<AuditCommandResult>;

const AUDIT_COMMAND = ["pnpm", "audit", "--json"] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_AUDIT_OUTPUT_CHARS = 4_000_000;
const SEVERITIES: readonly AuditSeverity[] = ["info", "low", "moderate", "high", "critical"];
const SEVERITY_ORDER: readonly AuditSeverity[] = ["critical", "high", "moderate", "low", "info"];

export async function diagnoseNpmAudit(options: {
  readonly enabled: boolean;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly runAudit?: AuditCommandRunner;
}): Promise<NpmAuditDiagnostic> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!options.enabled) {
    return {
      status: "not-run",
      command: AUDIT_COMMAND,
      timeoutMs,
      totalVulnerabilities: 0,
      severityCounts: emptyCounts(),
      runtimeVulnerabilities: 0,
      devVulnerabilities: 0,
      unknownVulnerabilities: 0,
      timedOut: false,
      warnings: [],
      notes: ["Dependency audit not run."]
    };
  }

  const result = await (options.runAudit ?? defaultAuditCommandRunner)({
    command: AUDIT_COMMAND[0],
    args: AUDIT_COMMAND.slice(1),
    cwd: options.cwd,
    timeoutMs
  });

  if (result.timedOut === true) {
    return warningDiagnostic({
      timeoutMs,
      timedOut: true,
      warning: `Dependency audit timed out after ${Math.round(timeoutMs / 1000)}s.`
    });
  }

  if (result.errorCode === "ENOENT") {
    return warningDiagnostic({
      timeoutMs,
      warning: "Dependency audit could not run because pnpm was not found."
    });
  }

  if (result.errorMessage !== undefined && result.stdout.trim().length === 0) {
    return warningDiagnostic({
      timeoutMs,
      warning: `Dependency audit could not run: ${result.errorMessage}`
    });
  }

  const parsed = parseAuditJson(result.stdout);
  if (parsed === undefined) {
    return warningDiagnostic({
      timeoutMs,
      warning: "Dependency audit output could not be parsed."
    });
  }

  if (parsed.totalVulnerabilities === 0) {
    return {
      status: "ready",
      command: AUDIT_COMMAND,
      timeoutMs,
      totalVulnerabilities: 0,
      severityCounts: parsed.severityCounts,
      runtimeVulnerabilities: parsed.runtimeVulnerabilities,
      devVulnerabilities: parsed.devVulnerabilities,
      unknownVulnerabilities: parsed.unknownVulnerabilities,
      timedOut: false,
      warnings: [],
      notes: []
    };
  }

  return {
    status: "warning",
    command: AUDIT_COMMAND,
    timeoutMs,
    totalVulnerabilities: parsed.totalVulnerabilities,
    severityCounts: parsed.severityCounts,
    runtimeVulnerabilities: parsed.runtimeVulnerabilities,
    devVulnerabilities: parsed.devVulnerabilities,
    unknownVulnerabilities: parsed.unknownVulnerabilities,
    timedOut: false,
    warnings: [`Dependency audit found ${auditSummary(parsed)}.`],
    notes: []
  };
}

export function parseAuditJson(raw: string): Pick<
  NpmAuditDiagnostic,
  "totalVulnerabilities" | "severityCounts" | "runtimeVulnerabilities" | "devVulnerabilities" | "unknownVulnerabilities"
> | undefined {
  const jsonText = extractJsonObject(raw);
  if (jsonText === undefined) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;

  const severityCounts = parseSeverityCounts(payload);
  const totalFromMetadata = totalCount(severityCounts);
  const dependencyEntries = collectDependencyEntries(payload);
  const classified = classifyDependencyEntries(dependencyEntries);
  const totalVulnerabilities = totalFromMetadata > 0 ? totalFromMetadata : dependencyEntries.length;
  const classifiedTotal = classified.runtime + classified.dev + classified.unknown;
  const unknownVulnerabilities = classifiedTotal > 0
    ? classified.unknown + Math.max(0, totalVulnerabilities - classifiedTotal)
    : totalVulnerabilities;

  return {
    totalVulnerabilities,
    severityCounts,
    runtimeVulnerabilities: classified.runtime,
    devVulnerabilities: classified.dev,
    unknownVulnerabilities
  };
}

async function defaultAuditCommandRunner(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}): Promise<AuditCommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ exitCode: null, stdout, stderr, timedOut: true });
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout,
        stderr,
        errorCode: error.code,
        errorMessage: error.message
      });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function warningDiagnostic(options: {
  readonly timeoutMs: number;
  readonly warning: string;
  readonly timedOut?: boolean;
}): NpmAuditDiagnostic {
  return {
    status: "warning",
    command: AUDIT_COMMAND,
    timeoutMs: options.timeoutMs,
    totalVulnerabilities: 0,
    severityCounts: emptyCounts(),
    runtimeVulnerabilities: 0,
    devVulnerabilities: 0,
    unknownVulnerabilities: 0,
    timedOut: options.timedOut === true,
    warnings: [options.warning],
    notes: []
  };
}

function parseSeverityCounts(payload: Record<string, unknown>): AuditSeverityCounts {
  const counts = emptyCounts();
  const metadata = isRecord(payload.metadata) ? payload.metadata : undefined;
  const vulnerabilities = metadata !== undefined && isRecord(metadata.vulnerabilities)
    ? metadata.vulnerabilities
    : undefined;
  if (vulnerabilities !== undefined) {
    for (const severity of SEVERITIES) {
      counts[severity] = numberValue(vulnerabilities[severity]);
    }
    return counts;
  }

  for (const entry of collectDependencyEntries(payload)) {
    const severity = severityValue(entry.severity);
    if (severity !== undefined) counts[severity] += 1;
  }
  return counts;
}

function collectDependencyEntries(payload: Record<string, unknown>): readonly Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const vulnerabilities = payload.vulnerabilities;
  if (isRecord(vulnerabilities)) {
    entries.push(...Object.values(vulnerabilities).filter(isRecord));
  }
  const advisories = payload.advisories;
  if (entries.length === 0 && isRecord(advisories)) {
    entries.push(...Object.values(advisories).filter(isRecord));
  }
  return entries;
}

function classifyDependencyEntries(entries: readonly Record<string, unknown>[]): {
  readonly runtime: number;
  readonly dev: number;
  readonly unknown: number;
} {
  let runtime = 0;
  let dev = 0;
  let unknown = 0;
  for (const entry of entries) {
    if (entry.dev === true || String(entry.dependencyType ?? "").toLowerCase() === "dev") {
      dev += 1;
    } else if (entry.dev === false || String(entry.dependencyType ?? "").toLowerCase() === "prod") {
      runtime += 1;
    } else {
      unknown += 1;
    }
  }
  return { runtime, dev, unknown };
}

function auditSummary(parsed: Pick<
  NpmAuditDiagnostic,
  "totalVulnerabilities" | "severityCounts" | "runtimeVulnerabilities" | "devVulnerabilities" | "unknownVulnerabilities"
>): string {
  const topSeverity = SEVERITY_ORDER.find((severity) => parsed.severityCounts[severity] > 0);
  const count = topSeverity === undefined
    ? parsed.totalVulnerabilities
    : parsed.severityCounts[topSeverity];
  const scope = dependencyScope(parsed);
  const noun = count === 1 ? "advisory" : "advisories";
  if (topSeverity === undefined) return `${count} ${scope}${noun}`.replace("  ", " ");
  return `${count} ${topSeverity} ${scope}${noun}`.replace("  ", " ");
}

function dependencyScope(parsed: Pick<
  NpmAuditDiagnostic,
  "totalVulnerabilities" | "runtimeVulnerabilities" | "devVulnerabilities" | "unknownVulnerabilities"
>): string {
  if (parsed.runtimeVulnerabilities === parsed.totalVulnerabilities && parsed.totalVulnerabilities > 0) {
    return "runtime ";
  }
  if (parsed.devVulnerabilities === parsed.totalVulnerabilities && parsed.totalVulnerabilities > 0) {
    return "dev ";
  }
  return "";
}

function emptyCounts(): AuditSeverityCounts {
  return {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0
  };
}

function extractJsonObject(raw: string): string | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return undefined;
  return raw.slice(start, end + 1);
}

function totalCount(counts: AuditSeverityCounts): number {
  return SEVERITIES.reduce((total, severity) => total + counts[severity], 0);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function severityValue(value: unknown): AuditSeverity | undefined {
  return typeof value === "string" && SEVERITIES.includes(value as AuditSeverity)
    ? value as AuditSeverity
    : undefined;
}

function appendCapped(value: string, chunk: string): string {
  if (value.length >= MAX_AUDIT_OUTPUT_CHARS) return value;
  return `${value}${chunk}`.slice(0, MAX_AUDIT_OUTPUT_CHARS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
