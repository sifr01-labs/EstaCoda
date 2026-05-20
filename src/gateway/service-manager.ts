import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, delimiter, isAbsolute, join, resolve } from "node:path";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { inspectGatewayLockState } from "./gateway-lock.js";
import { isStalePid, readGatewayPid } from "./pid-file.js";
import { resolveGatewayExec, type ExecMode, type ResolvedExec } from "./service-exec-resolver.js";

export type ServiceManagerKind = "systemd-user" | "systemd-system" | "launchd" | "none";
export type ServiceScope = "user" | "system";
export type ServiceActiveState = "active" | "inactive" | "failed" | "activating" | "unknown";

export type ServiceManagerState = {
  kind: ServiceManagerKind;
  installed: boolean;
  scope?: ServiceScope;
  activeState?: ServiceActiveState;
  subState?: string;
  unitName?: string;
  profileId: string;
};

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: number | null;
};

type ValidationResult = { ok: true } | { ok: false; error: string };
type HomeDirResult = { ok: true; homeDir: string } | { ok: false; error: string };

export function detectServiceManager(): ServiceManagerKind {
  if (process.platform === "linux" && commandExists("systemctl")) {
    return "systemd-user";
  }
  if (process.platform === "darwin" && commandExists("launchctl")) {
    return "launchd";
  }
  return "none";
}

export async function installService(options: {
  homeDir: string;
  serviceHomeDir?: string;
  workspaceRoot: string;
  profileId: string;
  system?: boolean;
  runAsUser?: string;
  force?: boolean;
}): Promise<{ ok: true; mode: ExecMode } | { ok: false; error: string }> {
  let homeDir = resolve(options.homeDir);
  const workspaceRoot = resolve(options.workspaceRoot);
  const kind = targetKind(options);

  if (kind === "none") {
    return { ok: false, error: "No supported service manager detected." };
  }
  if (options.system === true && !kind.startsWith("systemd")) {
    return { ok: false, error: "System service install is only supported with systemd." };
  }
  if (kind === "systemd-system") {
    if (process.geteuid?.() !== 0) {
      return { ok: false, error: "System service install requires root. Use sudo or omit --system." };
    }
    const runAsUser = options.runAsUser;
    if (runAsUser === undefined || runAsUser.trim().length === 0) {
      return { ok: false, error: "System service install requires --run-as-user <user> so HOME/profile state are explicit." };
    }
    const userValidation = validateSystemRunAsUser(runAsUser);
    if (!userValidation.ok) return userValidation;
    const userExists = await verifySystemUserExists(runAsUser);
    if (!userExists.ok) return userExists;
    const systemHome = options.serviceHomeDir === undefined
      ? await resolveSystemUserHome(runAsUser)
      : await validateExplicitSystemHome(options.serviceHomeDir);
    if (!systemHome.ok) return systemHome;
    homeDir = systemHome.homeDir;
  }
  const baseValidation = validateServiceRenderValues([
    { label: "profileId", value: options.profileId },
    { label: "homeDir", value: homeDir },
    ...(kind === "systemd-system" && options.runAsUser !== undefined
      ? [{ label: "runAsUser", value: options.runAsUser }]
      : []),
  ]);
  if (!baseValidation.ok) return baseValidation;

  const resolved = resolveGatewayExec({ workspaceRoot });
  if (!resolved.ok) {
    return resolved;
  }

  if (kind === "launchd") {
    return installLaunchd({ ...options, homeDir, workspaceRoot, resolved: resolved.resolved });
  }
  return installSystemd({ ...options, homeDir, workspaceRoot, kind, resolved: resolved.resolved });
}

export async function uninstallService(options: {
  homeDir: string;
  profileId: string;
  system?: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const homeDir = resolve(options.homeDir);
  const kind = targetKind(options);
  if (kind === "none") {
    return { ok: false, error: "No supported service manager detected." };
  }
  if (options.system === true && !kind.startsWith("systemd")) {
    return { ok: false, error: "System service uninstall is only supported with systemd." };
  }

  if (kind === "launchd") {
    return uninstallLaunchd({ homeDir, profileId: options.profileId });
  }
  return uninstallSystemd({ homeDir, profileId: options.profileId, kind });
}

export async function probeServiceState(options: {
  homeDir: string;
  profileId: string;
  system?: boolean;
}): Promise<ServiceManagerState> {
  try {
    const homeDir = resolve(options.homeDir);
    const kind = targetKind(options);
    if (kind === "none") return fallbackState(options);
    if (kind === "launchd") return await probeLaunchd({ homeDir, profileId: options.profileId });
    return await probeSystemd({ homeDir, profileId: options.profileId, kind });
  } catch {
    return fallbackState(options);
  }
}

export function serviceSafeProfileId(profileId: string): string {
  const safePrefix = profileId
    .replace(/[^A-Za-z0-9_-]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 40) || "profile";
  const hash = createHash("sha256").update(profileId).digest("hex").slice(0, 8);
  return `${safePrefix}-${hash}`;
}

export function unitNameForProfile(profileId: string): string {
  return `estacoda-gateway-${serviceSafeProfileId(profileId)}.service`;
}

export function launchdLabelForProfile(profileId: string): string {
  return `com.estacoda.gateway.${serviceSafeProfileId(profileId)}`;
}

export function plistNameForProfile(profileId: string): string {
  return `${launchdLabelForProfile(profileId)}.plist`;
}

export function systemdUnitPath(options: { homeDir: string; profileId: string; system?: boolean }): string {
  const unitName = unitNameForProfile(options.profileId);
  return options.system === true
    ? join("/etc", "systemd", "system", unitName)
    : join(options.homeDir, ".config", "systemd", "user", unitName);
}

export function launchdPlistPath(options: { homeDir: string; profileId: string }): string {
  return join(options.homeDir, "Library", "LaunchAgents", plistNameForProfile(options.profileId));
}

function targetKind(options: { system?: boolean }): ServiceManagerKind {
  const detected = detectServiceManager();
  if (options.system === true && detected.startsWith("systemd")) {
    return "systemd-system";
  }
  return detected;
}

function fallbackKind(options: { system?: boolean }): ServiceManagerKind {
  const detected = detectServiceManager();
  if (options.system === true && detected.startsWith("systemd")) {
    return "systemd-system";
  }
  return detected;
}

function fallbackState(options: { profileId: string; system?: boolean }): ServiceManagerState {
  const kind = fallbackKind(options);
  const scope: ServiceScope = kind === "systemd-system" ? "system" : "user";
  return {
    kind,
    installed: false,
    scope,
    activeState: "unknown",
    unitName: kind === "launchd" ? plistNameForProfile(options.profileId) : unitNameForProfile(options.profileId),
    profileId: options.profileId,
  };
}

async function installSystemd(options: {
  homeDir: string;
  workspaceRoot: string;
  profileId: string;
  system?: boolean;
  runAsUser?: string;
  force?: boolean;
  kind: "systemd-user" | "systemd-system";
  resolved: ResolvedExec;
}): Promise<{ ok: true; mode: ExecMode } | { ok: false; error: string }> {
  const path = systemdUnitPath({ homeDir: options.homeDir, profileId: options.profileId, system: options.kind === "systemd-system" });
  const unitName = unitNameForProfile(options.profileId);
  const exists = await fileExists(path);
  if (exists && options.force !== true) {
    return { ok: false, error: `Service already installed for profile '${options.profileId}'. Use --force to replace.` };
  }
  const validation = validateSystemdUnitInput({
    homeDir: options.homeDir,
    profileId: options.profileId,
    runAsUser: options.kind === "systemd-system" ? options.runAsUser : undefined,
    resolved: options.resolved,
  });
  if (!validation.ok) return validation;

  if (exists && options.force === true) {
    const stop = await systemctl(options.kind, ["stop", unitName]);
    if (!stop.ok) return { ok: false, error: commandError("systemctl stop", stop) };
  }
  const liveEvidence = await assertNoLiveGatewayEvidence(options.homeDir, options.profileId);
  if (!liveEvidence.ok) return liveEvidence;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderSystemdUnit({
    homeDir: options.homeDir,
    profileId: options.profileId,
    runAsUser: options.kind === "systemd-system" ? options.runAsUser : undefined,
    resolved: options.resolved,
  }), { encoding: "utf8", mode: options.kind === "systemd-system" ? 0o644 : 0o600 });
  await chmod(path, options.kind === "systemd-system" ? 0o644 : 0o600);

  for (const args of [["daemon-reload"], ["enable", unitName], ["start", unitName]]) {
    const result = await systemctl(options.kind, args);
    if (!result.ok) return { ok: false, error: commandError(`systemctl ${args.join(" ")}`, result) };
  }
  return { ok: true, mode: options.resolved.mode };
}

async function uninstallSystemd(options: {
  homeDir: string;
  profileId: string;
  kind: "systemd-user" | "systemd-system";
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const unitName = unitNameForProfile(options.profileId);
  const path = systemdUnitPath({ homeDir: options.homeDir, profileId: options.profileId, system: options.kind === "systemd-system" });
  if (!(await fileExists(path))) return { ok: true };

  for (const args of [["stop", unitName], ["disable", unitName]]) {
    const result = await systemctl(options.kind, args);
    if (!result.ok) return { ok: false, error: commandError(`systemctl ${args.join(" ")}`, result) };
  }
  await rm(path, { force: true });
  const reload = await systemctl(options.kind, ["daemon-reload"]);
  if (!reload.ok) return { ok: false, error: commandError("systemctl daemon-reload", reload) };
  return { ok: true };
}

async function installLaunchd(options: {
  homeDir: string;
  workspaceRoot: string;
  profileId: string;
  force?: boolean;
  resolved: ResolvedExec;
}): Promise<{ ok: true; mode: ExecMode } | { ok: false; error: string }> {
  const path = launchdPlistPath({ homeDir: options.homeDir, profileId: options.profileId });
  const exists = await fileExists(path);
  if (exists && options.force !== true) {
    return { ok: false, error: `Service already installed for profile '${options.profileId}'. Use --force to replace.` };
  }
  const validation = validateLaunchdPlistInput({
    homeDir: options.homeDir,
    profileId: options.profileId,
    resolved: options.resolved,
  });
  if (!validation.ok) return validation;

  if (exists && options.force === true) {
    const unload = await runCommand("launchctl", ["unload", "-w", path]);
    if (!unload.ok) return { ok: false, error: commandError("launchctl unload", unload) };
  }
  const liveEvidence = await assertNoLiveGatewayEvidence(options.homeDir, options.profileId);
  if (!liveEvidence.ok) return liveEvidence;

  const profilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId: options.profileId });
  await mkdir(dirname(path), { recursive: true });
  await mkdir(profilePaths.logsPath, { recursive: true });
  await writeFile(path, renderLaunchdPlist({
    homeDir: options.homeDir,
    profileId: options.profileId,
    resolved: options.resolved,
  }), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);

  const load = await runCommand("launchctl", ["load", "-w", path]);
  if (!load.ok) return { ok: false, error: commandError("launchctl load", load) };
  return { ok: true, mode: options.resolved.mode };
}

async function uninstallLaunchd(options: {
  homeDir: string;
  profileId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const path = launchdPlistPath({ homeDir: options.homeDir, profileId: options.profileId });
  if (!(await fileExists(path))) return { ok: true };
  const unload = await runCommand("launchctl", ["unload", "-w", path]);
  if (!unload.ok) return { ok: false, error: commandError("launchctl unload", unload) };
  await rm(path, { force: true });
  return { ok: true };
}

function renderSystemdUnit(options: {
  homeDir: string;
  profileId: string;
  runAsUser?: string;
  resolved: ResolvedExec;
}): string {
  const argv = [
    options.resolved.command,
    ...options.resolved.args,
    "gateway",
    "start",
    "--profile",
    options.profileId,
  ];
  const path = servicePath(options.resolved.command);
  const serviceLines = [
    "[Service]",
    "Type=simple",
    options.runAsUser === undefined ? undefined : `User=${systemdEscapeScalar(options.runAsUser)}`,
    `ExecStart=${argv.map(systemdEscapeArg).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    "TimeoutStopSec=35",
    "KillMode=mixed",
    `Environment="${systemdEscapeEnvAssignment("HOME", options.homeDir)}"`,
    `Environment="${systemdEscapeEnvAssignment("PATH", path)}"`,
    `WorkingDirectory=${systemdEscapeArg(options.resolved.cwd)}`,
  ].filter((line): line is string => line !== undefined);

  return [
    "[Unit]",
    `Description=EstaCoda Gateway Supervisor (profile: ${systemdEscapeScalar(options.profileId)})`,
    "After=network-online.target",
    "Wants=network-online.target",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    "",
    ...serviceLines,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function renderLaunchdPlist(options: {
  homeDir: string;
  profileId: string;
  resolved: ResolvedExec;
}): string {
  const profilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId: options.profileId });
  const argv = [
    options.resolved.command,
    ...options.resolved.args,
    "gateway",
    "start",
    "--profile",
    options.profileId,
  ];
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(launchdLabelForProfile(options.profileId))}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...argv.map((arg) => `    <string>${xmlEscape(arg)}</string>`),
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key>",
    "  <dict><key>SuccessfulExit</key><false/></dict>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(options.resolved.cwd)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>HOME</key>",
    `    <string>${xmlEscape(options.homeDir)}</string>`,
    "    <key>PATH</key>",
    `    <string>${xmlEscape(servicePath(options.resolved.command))}</string>`,
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(join(profilePaths.logsPath, "gateway.stdout"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(join(profilePaths.logsPath, "gateway.stderr"))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

async function probeSystemd(options: {
  homeDir: string;
  profileId: string;
  kind: "systemd-user" | "systemd-system";
}): Promise<ServiceManagerState> {
  const unitName = unitNameForProfile(options.profileId);
  const result = await systemctl(options.kind, ["show", unitName, "--property=ActiveState,SubState,LoadState"]);
  if (!result.ok) return fallbackState({ profileId: options.profileId, system: options.kind === "systemd-system" });
  const values = parseSystemdShow(result.stdout);
  const loadState = values.get("LoadState");
  return {
    kind: options.kind,
    installed: loadState === "loaded",
    scope: options.kind === "systemd-system" ? "system" : "user",
    activeState: normalizeActiveState(values.get("ActiveState")),
    subState: values.get("SubState"),
    unitName,
    profileId: options.profileId,
  };
}

async function probeLaunchd(options: {
  homeDir: string;
  profileId: string;
}): Promise<ServiceManagerState> {
  const label = launchdLabelForProfile(options.profileId);
  const result = await runCommand("launchctl", ["list"]);
  if (!result.ok) return fallbackState({ profileId: options.profileId });
  const match = result.stdout.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.endsWith(label));
  if (match === undefined) {
    return {
      kind: "launchd",
      installed: false,
      scope: "user",
      activeState: "unknown",
      unitName: plistNameForProfile(options.profileId),
      profileId: options.profileId,
    };
  }
  const [pid, status] = match.split(/\s+/u);
  return {
    kind: "launchd",
    installed: true,
    scope: "user",
    activeState: pid !== undefined && pid !== "-" ? "active" : status === "0" ? "inactive" : "failed",
    subState: status,
    unitName: plistNameForProfile(options.profileId),
    profileId: options.profileId,
  };
}

function parseSystemdShow(output: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    values.set(line.slice(0, index), line.slice(index + 1));
  }
  return values;
}

function normalizeActiveState(value: string | undefined): ServiceActiveState {
  if (value === "active" || value === "inactive" || value === "failed" || value === "activating") return value;
  return "unknown";
}

function validateSystemdUnitInput(options: {
  homeDir: string;
  profileId: string;
  runAsUser?: string;
  resolved: ResolvedExec;
}): ValidationResult {
  const inputValidation = validateServiceRenderValues([
    { label: "profileId", value: options.profileId },
    ...(options.runAsUser === undefined ? [] : [{ label: "runAsUser", value: options.runAsUser }]),
    { label: "homeDir", value: options.homeDir },
    { label: "resolved.command", value: options.resolved.command },
    ...options.resolved.args.map((arg, index) => ({ label: `resolved.args[${index}]`, value: arg })),
    { label: "resolved.cwd", value: options.resolved.cwd },
  ]);
  if (!inputValidation.ok) return inputValidation;

  return validateServiceRenderValues([
    { label: "PATH", value: servicePath(options.resolved.command) },
  ]);
}

function validateLaunchdPlistInput(options: {
  homeDir: string;
  profileId: string;
  resolved: ResolvedExec;
}): ValidationResult {
  const profilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId: options.profileId });
  const inputValidation = validateServiceRenderValues([
    { label: "profileId", value: options.profileId },
    { label: "homeDir", value: options.homeDir },
    { label: "resolved.command", value: options.resolved.command },
    ...options.resolved.args.map((arg, index) => ({ label: `resolved.args[${index}]`, value: arg })),
    { label: "resolved.cwd", value: options.resolved.cwd },
  ]);
  if (!inputValidation.ok) return inputValidation;

  return validateServiceRenderValues([
    { label: "PATH", value: servicePath(options.resolved.command) },
    { label: "StandardOutPath", value: join(profilePaths.logsPath, "gateway.stdout") },
    { label: "StandardErrorPath", value: join(profilePaths.logsPath, "gateway.stderr") },
  ]);
}

function validateServiceRenderValues(values: Array<{ label: string; value: string | undefined }>): ValidationResult {
  for (const { label, value } of values) {
    if (value === undefined) continue;
    if (/[\u0000-\u001F\u007F]/u.test(value)) {
      return { ok: false, error: `Invalid service manager value for ${label}: control characters are not allowed.` };
    }
  }
  return { ok: true };
}

async function assertNoLiveGatewayEvidence(homeDir: string, profileId: string): Promise<ValidationResult> {
  const profilePaths = resolveProfileStateHome({ homeDir, profileId });
  const lock = await inspectGatewayLockState(profilePaths);
  if (lock.state === "active") {
    return {
      ok: false,
      error: `Gateway already appears to be running for profile '${profileId}'; stop it before installing/starting the service.`,
    };
  }
  const pid = await readGatewayPid(profilePaths);
  if (pid !== undefined && !(await isStalePid(profilePaths))) {
    return {
      ok: false,
      error: `Gateway already appears to be running for profile '${profileId}'; stop it before installing/starting the service.`,
    };
  }
  return { ok: true };
}

function validateSystemRunAsUser(value: string): ValidationResult {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*[$]?$/u.test(value)) {
    return {
      ok: false,
      error: "Invalid --run-as-user value. Expected a local username matching ^[A-Za-z_][A-Za-z0-9_-]*[$]?$",
    };
  }
  return { ok: true };
}

async function verifySystemUserExists(user: string): Promise<ValidationResult> {
  const result = await runCommand("id", ["-u", user]);
  if (result.ok) return { ok: true };
  return { ok: false, error: `System service user '${user}' does not exist or cannot be resolved.` };
}

async function resolveSystemUserHome(user: string): Promise<HomeDirResult> {
  const result = await runCommand("getent", ["passwd", user]);
  if (!result.ok) {
    return { ok: false, error: `Could not resolve home directory for system service user '${user}'. Pass --home <absolute-dir>.` };
  }
  const line = result.stdout.split(/\r?\n/u).find((entry) => entry.trim().length > 0);
  if (line === undefined) {
    return { ok: false, error: `Could not resolve home directory for system service user '${user}'. Pass --home <absolute-dir>.` };
  }
  const fields = line.split(":");
  if (fields.length < 7 || fields[0] !== user || fields[5] === undefined || fields[5].length === 0) {
    return { ok: false, error: `Malformed passwd entry for system service user '${user}'. Pass --home <absolute-dir>.` };
  }
  return validateSystemHomeDir(fields[5], "Resolved home directory");
}

async function validateExplicitSystemHome(homeDir: string): Promise<HomeDirResult> {
  return validateSystemHomeDir(homeDir, "--home");
}

async function validateSystemHomeDir(homeDir: string, label: string): Promise<HomeDirResult> {
  const controlValidation = validateServiceRenderValues([{ label, value: homeDir }]);
  if (!controlValidation.ok) return controlValidation;
  if (!isAbsolute(homeDir)) {
    return { ok: false, error: `${label} for system service install must be an absolute path.` };
  }
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(homeDir);
  } catch {
    return { ok: false, error: `${label} for system service install must exist and be a directory.` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, error: `${label} for system service install must exist and be a directory.` };
  }
  return { ok: true, homeDir };
}

async function systemctl(kind: "systemd-user" | "systemd-system", args: string[]): Promise<CommandResult> {
  return runCommand("systemctl", kind === "systemd-user" ? ["--user", ...args] : args);
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      resolveCommand({ ok: false, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolveCommand({ ok: code === 0, stdout, stderr, code });
    });
  });
}

function commandError(label: string, result: CommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code ?? "unknown"}`;
  return `${label} failed: ${detail}`;
}

function commandExists(command: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // try next PATH entry
    }
  }
  return false;
}

function servicePath(command: string): string {
  const entries = [
    dirname(command),
    ...(process.env.PATH ?? "").split(delimiter),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
  ].filter((entry) => entry.length > 0);
  return Array.from(new Set(entries)).join(":");
}

function systemdEscapeArg(value: string): string {
  return `"${systemdEscapeScalar(value)}"`;
}

function systemdEscapeScalar(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"").replace(/%/gu, "%%");
}

function systemdEscapeEnvAssignment(name: string, value: string): string {
  return systemdEscapeScalar(`${name}=${value}`);
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
