import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve, parse } from "node:path";
import { fileURLToPath } from "node:url";

export type InstallMethod =
  | "managed-source"
  | "manual-source"
  | "homebrew"
  | "docker"
  | "npm-global"
  | "pnpm-global"
  | "unknown";

export type InstallMethodInfo = {
  method: InstallMethod;
  source: "stamp" | "container" | "path" | "package-manager" | "unknown";
  installDir?: string;
  sourceUrl?: string;
  branch?: string;
  expectedBranch?: string;
  stampPath?: string;
  recommendedUpdateCommand: string;
  canSelfUpdate: boolean;
  reason: string;
};

export type DetectInstallMethodOptions = {
  cwd?: string;
  includeCwd?: boolean;
  includeRuntimeHints?: boolean;
  entrypointPath?: string;
  moduleUrl?: string;
  pathHints?: readonly string[];
  containerProbe?: {
    dockerEnvPath?: string;
    containerEnvPath?: string;
    cgroupPath?: string;
  };
};

type SourceStamp = {
  method: "managed-source" | "manual-source";
  sourceUrl?: string;
  branch?: string;
  expectedBranch?: string;
  installDir?: string;
};

type StampLookupResult =
  | { kind: "valid"; path: string; root: string; value: SourceStamp }
  | { kind: "invalid"; path: string }
  | { kind: "missing" };

const INSTALL_STAMP = ".install-method.json";
const DEFAULT_MANAGED_SOURCE_COMMAND = "estacoda update";
const DEFAULT_MANUAL_SOURCE_COMMAND = "git fetch origin && git status";
const DEFAULT_HOMEBREW_COMMAND = "brew upgrade kemetresearch/tap/estacoda";
const DEFAULT_DOCKER_COMMAND = "docker pull ghcr.io/sifr01-labs/estacoda:latest";
const DEFAULT_NPM_COMMAND = "npm install -g estacoda@latest";
const DEFAULT_PNPM_COMMAND = "pnpm add -g estacoda@latest";
const DEFAULT_UNKNOWN_COMMAND = "reinstall using documented install path";

export async function detectInstallMethod(options: DetectInstallMethodOptions = {}): Promise<InstallMethodInfo> {
  const hints = collectPathHints(options);
  const roots = collectCandidateRoots(options, hints);
  const stamp = await readFirstStamp(roots);

  if (stamp.kind === "valid") {
    return infoForStamp(stamp);
  }

  if (await isContainer(options.containerProbe)) {
    return infoFor("docker", "container", {
      reason: "Container runtime markers were detected."
    });
  }

  const homebrewPath = hints.find(isHomebrewPath);
  if (homebrewPath !== undefined) {
    return infoFor("homebrew", "path", {
      installDir: homebrewPath,
      reason: "EstaCoda appears to be installed under a Homebrew-managed path."
    });
  }

  const packageManagerMethod = detectPackageManagerMethod(hints);
  if (packageManagerMethod !== undefined) {
    return infoFor(packageManagerMethod.method, "package-manager", {
      installDir: packageManagerMethod.path,
      reason: packageManagerMethod.reason
    });
  }

  const gitRoot = await findFirstGitRoot(roots);
  if (gitRoot !== undefined) {
    return infoFor("manual-source", "path", {
      installDir: gitRoot,
      reason: "A git checkout was detected without a managed-source install stamp."
    });
  }

  return infoFor("unknown", "unknown", {
    reason: stamp.kind === "invalid"
      ? `Invalid install method stamp at ${stamp.path} was ignored; EstaCoda could not determine how this installation is managed.`
      : "EstaCoda could not determine how this installation is managed."
  });
}

function infoForStamp(stamp: { path: string; root: string; value: SourceStamp }): InstallMethodInfo {
  const branch = stamp.value.branch ?? stamp.value.expectedBranch;
  const expectedBranch = stamp.value.expectedBranch ?? branch;
  const installDir = stamp.value.installDir ?? stamp.root;

  return infoFor(stamp.value.method, "stamp", {
    installDir,
    sourceUrl: stamp.value.sourceUrl,
    branch,
    expectedBranch,
    stampPath: stamp.path,
    reason: `Install method stamp declares ${stamp.value.method}.`
  });
}

function infoFor(
  method: InstallMethod,
  source: InstallMethodInfo["source"],
  details: Partial<Omit<InstallMethodInfo, "method" | "source" | "recommendedUpdateCommand" | "canSelfUpdate">>
): InstallMethodInfo {
  return {
    method,
    source,
    recommendedUpdateCommand: recommendedUpdateCommand(method),
    canSelfUpdate: method === "managed-source",
    reason: details.reason ?? "Install method detected.",
    installDir: details.installDir,
    sourceUrl: details.sourceUrl,
    branch: details.branch,
    expectedBranch: details.expectedBranch,
    stampPath: details.stampPath
  };
}

function recommendedUpdateCommand(method: InstallMethod): string {
  switch (method) {
    case "managed-source":
      return DEFAULT_MANAGED_SOURCE_COMMAND;
    case "manual-source":
      return DEFAULT_MANUAL_SOURCE_COMMAND;
    case "homebrew":
      return DEFAULT_HOMEBREW_COMMAND;
    case "docker":
      return DEFAULT_DOCKER_COMMAND;
    case "npm-global":
      return DEFAULT_NPM_COMMAND;
    case "pnpm-global":
      return DEFAULT_PNPM_COMMAND;
    case "unknown":
      return DEFAULT_UNKNOWN_COMMAND;
  }
}

function collectPathHints(options: DetectInstallMethodOptions): string[] {
  const hints = new Set<string>();

  for (const hint of options.pathHints ?? []) {
    addPathHint(hints, hint);
  }

  if (options.includeRuntimeHints !== false) {
    addPathHint(hints, options.entrypointPath ?? process.argv[1]);
    addPathHint(hints, pathFromFileUrl(options.moduleUrl));
  }

  return [...hints];
}

function addPathHint(hints: Set<string>, hint: string | undefined): void {
  if (hint === undefined || hint.trim().length === 0) {
    return;
  }

  hints.add(resolve(hint));
}

function pathFromFileUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value.startsWith("file:")) {
    return value;
  }

  try {
    return fileURLToPath(value);
  } catch {
    return undefined;
  }
}

function collectCandidateRoots(options: DetectInstallMethodOptions, hints: readonly string[]): string[] {
  const roots = new Set<string>();

  for (const hint of hints) {
    for (const root of ancestors(dirname(hint))) {
      roots.add(root);
    }
  }

  if (options.includeCwd !== false) {
    const cwd = resolve(options.cwd ?? process.cwd());
    for (const root of ancestors(cwd)) {
      roots.add(root);
    }
  }

  return [...roots];
}

function ancestors(start: string): string[] {
  const result: string[] = [];
  let current = resolve(start);
  const root = parse(current).root;

  while (true) {
    result.push(current);
    if (current === root) {
      return result;
    }
    current = dirname(current);
  }
}

async function readFirstStamp(roots: readonly string[]): Promise<StampLookupResult> {
  let firstInvalidPath: string | undefined;

  for (const root of roots) {
    const stampPath = resolve(root, INSTALL_STAMP);
    const stamp = await readStamp(stampPath);
    if (stamp.kind === "valid") {
      return { kind: "valid", path: stampPath, root, value: stamp.value };
    }

    if (stamp.kind === "invalid" && firstInvalidPath === undefined) {
      firstInvalidPath = stampPath;
    }
  }

  return firstInvalidPath === undefined
    ? { kind: "missing" }
    : { kind: "invalid", path: firstInvalidPath };
}

async function readStamp(path: string): Promise<{ kind: "valid"; value: SourceStamp } | { kind: "invalid" } | { kind: "missing" }> {
  let content: string;

  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { kind: "missing" };
    }
    return { kind: "invalid" };
  }

  try {
    const parsed = JSON.parse(content);
    const value = validateStamp(parsed);

    return value === undefined ? { kind: "invalid" } : { kind: "valid", value };
  } catch {
    return { kind: "invalid" };
  }
}

function validateStamp(value: unknown): SourceStamp | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.method !== "managed-source" && value.method !== "manual-source") {
    return undefined;
  }

  const sourceUrl = nonEmptyString(value.sourceUrl);
  const branch = nonEmptyString(value.branch);
  const expectedBranch = nonEmptyString(value.expectedBranch);
  const installDir = nonEmptyString(value.installDir);

  if (value.installDir !== undefined && installDir === undefined) {
    return undefined;
  }

  if (value.method === "managed-source" && (sourceUrl === undefined || (branch === undefined && expectedBranch === undefined))) {
    return undefined;
  }

  return {
    method: value.method,
    sourceUrl,
    branch,
    expectedBranch,
    installDir
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function isContainer(probe?: DetectInstallMethodOptions["containerProbe"]): Promise<boolean> {
  const dockerEnvPath = probe?.dockerEnvPath ?? "/.dockerenv";
  const containerEnvPath = probe?.containerEnvPath ?? "/run/.containerenv";
  const cgroupPath = probe?.cgroupPath ?? "/proc/1/cgroup";

  if (await exists(dockerEnvPath) || await exists(containerEnvPath)) {
    return true;
  }

  try {
    const cgroup = await readFile(cgroupPath, "utf8");
    return /docker|containerd|kubepods|podman|lxc/i.test(cgroup);
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isHomebrewPath(path: string): boolean {
  const normalized = slash(path);
  return (
    normalized.startsWith("/opt/homebrew/") ||
    normalized.startsWith("/home/linuxbrew/.linuxbrew/") ||
    normalized.includes("/usr/local/Cellar/")
  );
}

function detectPackageManagerMethod(paths: readonly string[]): { method: "npm-global" | "pnpm-global"; path: string; reason: string } | undefined {
  for (const path of paths) {
    const normalized = slash(path);
    if (
      normalized.includes("/node_modules/.pnpm/estacoda@") ||
      normalized.includes("/pnpm-global/") ||
      normalized.includes("/pnpm/global/") ||
      normalized.includes("/share/pnpm/global/")
    ) {
      return {
        method: "pnpm-global",
        path,
        reason: "EstaCoda appears to be installed from a pnpm global package path."
      };
    }
  }

  for (const path of paths) {
    const normalized = slash(path);
    if (
      !normalized.includes("/node_modules/.pnpm/") &&
      normalized.includes("/lib/node_modules/estacoda/")
    ) {
      return {
        method: "npm-global",
        path,
        reason: "EstaCoda appears to be installed from an npm global package path."
      };
    }
  }

  return undefined;
}

function slash(path: string): string {
  return path.replace(/\\/g, "/");
}

async function findFirstGitRoot(roots: readonly string[]): Promise<string | undefined> {
  for (const root of roots) {
    if (await exists(resolve(root, ".git"))) {
      return root;
    }
  }

  return undefined;
}
