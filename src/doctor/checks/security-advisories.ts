import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BUNDLED_SECURITY_ADVISORIES, type SecurityAdvisory, type SecurityAdvisorySeverity } from "../advisory-db.js";
import type { AdvisoryAckStore } from "../advisory-store.js";

export type SecurityAdvisoryStatus = "ready" | "warning" | "blocked";

export type ActiveSecurityAdvisory = {
  readonly id: string;
  readonly packageName: string;
  readonly installedVersion: string;
  readonly affectedVersions: string;
  readonly severity: SecurityAdvisorySeverity;
  readonly title: string;
  readonly titleAr?: string;
  readonly recommendation: string;
  readonly recommendationAr?: string;
};

export type SecurityAdvisoryDiagnostic = {
  readonly status: SecurityAdvisoryStatus;
  readonly active: readonly ActiveSecurityAdvisory[];
  readonly acknowledgedCount: number;
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
};

export async function diagnoseSecurityAdvisories(options: {
  readonly workspaceRoot: string;
  readonly ackStore: AdvisoryAckStore;
  readonly advisories?: readonly SecurityAdvisory[];
}): Promise<SecurityAdvisoryDiagnostic> {
  const advisories = options.advisories ?? BUNDLED_SECURITY_ADVISORIES;
  const installed = await readInstalledPackages(options.workspaceRoot);
  let acknowledgedIds: Set<string>;
  try {
    acknowledgedIds = new Set((await options.ackStore.list()).map((ack) => ack.id));
  } catch {
    return {
      status: "warning",
      active: [],
      acknowledgedCount: 0,
      warnings: ["Security advisory acknowledgements could not be read."],
      notes: []
    };
  }

  const matched = advisories.flatMap((advisory) => {
    const installedVersion = installed.get(advisory.packageName);
    if (installedVersion === undefined || !versionSatisfies(installedVersion, advisory.affectedVersions)) {
      return [];
    }
    if (acknowledgedIds.has(advisory.id)) {
      return [];
    }
    return [{
      id: advisory.id,
      packageName: advisory.packageName,
      installedVersion,
      affectedVersions: advisory.affectedVersions,
      severity: advisory.severity,
      title: advisory.title,
      titleAr: advisory.titleAr,
      recommendation: advisory.recommendation,
      recommendationAr: advisory.recommendationAr
    }];
  }).sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id));
  const acknowledgedCount = advisories.filter((advisory) => acknowledgedIds.has(advisory.id)).length;

  return {
    status: matched.some((advisory) => advisory.severity === "critical")
      ? "blocked"
      : matched.length > 0
        ? "warning"
        : "ready",
    active: matched,
    acknowledgedCount,
    warnings: matched.map((advisory) => advisoryWarning(advisory)),
    notes: acknowledgedCount > 0 ? [`${acknowledgedCount} security advisory acknowledgement(s) active.`] : []
  };
}

async function readInstalledPackages(workspaceRoot: string): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  await readPackageJsonVersions(join(workspaceRoot, "package.json"), versions);
  await readPnpmLockVersions(join(workspaceRoot, "pnpm-lock.yaml"), versions);
  return versions;
}

async function readPackageJsonVersions(path: string, versions: Map<string, string>): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (!isRecord(parsed)) return;
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const dependencies = isRecord(parsed[section]) ? parsed[section] : undefined;
    if (dependencies === undefined) continue;
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec === "string") {
        const version = normalizeVersionSpec(spec);
        if (version !== undefined) versions.set(name, version);
      }
    }
  }
}

async function readPnpmLockVersions(path: string, versions: Map<string, string>): Promise<void> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
  for (const rawLine of content.split(/\r?\n/u)) {
    const packageEntry = /^\s{2}'?(.+@[^']+)'?:\s*$/u.exec(rawLine);
    if (packageEntry === null) continue;
    const parsed = parsePackageEntry(packageEntry[1]!);
    if (parsed !== undefined && !versions.has(parsed.name)) {
      versions.set(parsed.name, parsed.version);
    }
  }
}

function parsePackageEntry(entry: string): { readonly name: string; readonly version: string } | undefined {
  const cleanEntry = entry.replace(/\(.+$/u, "");
  const separator = cleanEntry.lastIndexOf("@");
  if (separator <= 0) return undefined;
  const name = cleanEntry.slice(0, separator);
  const version = normalizeVersionSpec(cleanEntry.slice(separator + 1));
  if (version === undefined) return undefined;
  return { name, version };
}

function normalizeVersionSpec(spec: string): string | undefined {
  const trimmed = spec.trim();
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/u.exec(trimmed);
  return match?.[1];
}

function versionSatisfies(version: string, range: string): boolean {
  return range.split("||").some((clause) => {
    const comparators = clause.trim().split(/\s+/u).filter((part) => part.length > 0);
    if (comparators.length === 0) return false;
    return comparators.every((comparator) => compareComparator(version, comparator));
  });
}

function compareComparator(version: string, comparator: string): boolean {
  if (comparator === "*") return true;
  const match = /^(<=|>=|<|>|=)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(comparator);
  if (match === null) return false;
  const operator = match[1] ?? "=";
  const comparison = compareVersions(version, match[2]!);
  switch (operator) {
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
    case "=":
      return comparison === 0;
  }
  return false;
}

function compareVersions(left: string, right: string): number {
  const leftParts = numericVersionParts(left);
  const rightParts = numericVersionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = leftParts[index]! - rightParts[index]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

function numericVersionParts(version: string): readonly [number, number, number] {
  const [major = "0", minor = "0", patch = "0"] = version.split(/[.-]/u);
  return [
    Number.parseInt(major, 10) || 0,
    Number.parseInt(minor, 10) || 0,
    Number.parseInt(patch, 10) || 0
  ];
}

function advisoryWarning(advisory: ActiveSecurityAdvisory): string {
  return `Security advisory ${advisory.id} (${advisory.severity}) affects ${advisory.packageName}@${advisory.installedVersion}: ${advisory.title}. Recommendation: ${advisory.recommendation}`;
}

function severityRank(severity: SecurityAdvisorySeverity): number {
  switch (severity) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "moderate":
      return 2;
    case "low":
      return 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
