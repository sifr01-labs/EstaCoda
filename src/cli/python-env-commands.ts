import { rm } from "node:fs/promises";
import type { CliCommandResult, CliOptions } from "./cli.js";
import { canRunInteractive, createReadlinePrompt } from "./readline-prompt.js";
import { resolveGlobalStateHome } from "../config/profile-home.js";
import {
  getRegisteredPythonCapabilitySpec,
  listRegisteredPythonCapabilitySpecs
} from "../python-env/capability-registry.js";
import { resolveManagedPythonCapabilityPaths } from "../python-env/capability-paths.js";
import {
  checkManagedPythonCapabilityStatus,
  installManagedPythonCapabilityEnvironment,
  verifyManagedPythonCapabilityEnvironment,
  type ManagedPythonCapabilityFailure,
  type ManagedPythonCapabilityInstallStatus
} from "../python-env/capability-manager.js";
import { boundDiagnostic } from "../python-env/diagnostics.js";
import { fingerprintManagedPythonCapabilitySpec } from "../python-env/spec-hash.js";

type ParsedPythonEnvFlags = {
  groups: string[];
  yes: boolean;
};

type ParsedPythonEnvArgs =
  | { ok: true; command: string; id?: string; flags: ParsedPythonEnvFlags }
  | { ok: false; error: string };

export async function runPythonEnvCommand(
  options: CliOptions,
  args: string[]
): Promise<CliCommandResult> {
  const parsed = parsePythonEnvArgs(args);
  if (!parsed.ok) {
    return { handled: true, exitCode: 1, output: parsed.error };
  }
  if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
    return { handled: true, exitCode: 0, output: renderPythonEnvHelp() };
  }

  const stateRoot = resolveGlobalStateHome({ homeDir: options.homeDir }).stateRoot;

  switch (parsed.command) {
    case "list":
      return {
        handled: true,
        exitCode: 0,
        output: await renderPythonEnvList(stateRoot)
      };
    case "status":
      return withCapabilityId(parsed.id, async (id) => {
        const valid = validateCapabilityGroups(id, parsed.flags.groups);
        if (!valid.ok) {
          return { handled: true, exitCode: 1, output: valid.output };
        }
        return {
          handled: true,
          exitCode: 0,
          output: await renderPythonEnvStatus(stateRoot, id, parsed.flags.groups)
        };
      });
    case "setup":
      return withCapabilityId(parsed.id, async (id) => {
        const approval = await approvePackageInstallIfNeeded(options, id, parsed.flags.groups, parsed.flags.yes, "setup");
        if (!approval.ok) {
          return { handled: true, exitCode: 1, output: approval.output };
        }
        const progress: string[] = [];
        const result = await installManagedPythonCapabilityEnvironment({
          stateRoot,
          capabilityId: id,
          groups: parsed.flags.groups,
          onProgress: (message) => progress.push(message)
        });
        return {
          handled: true,
          exitCode: result.ok ? 0 : 1,
          output: renderActionResult("setup", result, progress)
        };
      });
    case "verify":
      return withCapabilityId(parsed.id, async (id) => {
        const result = await verifyManagedPythonCapabilityEnvironment({
          stateRoot,
          capabilityId: id,
          groups: parsed.flags.groups
        });
        return {
          handled: true,
          exitCode: result.ok ? 0 : 1,
          output: renderActionResult("verify", result)
        };
      });
    case "upgrade":
      return withCapabilityId(parsed.id, async (id) => {
        const current = await checkManagedPythonCapabilityStatus({
          stateRoot,
          capabilityId: id,
          groups: parsed.flags.groups
        });
        if (current.ok && current.status === "verified") {
          return {
            handled: true,
            exitCode: 0,
            output: [
              `Managed Python capability '${id}' is current and verified.`,
              `Env path: ${current.envPath}`,
              `Spec hash: ${current.specHash}`
            ].join("\n")
          };
        }
        const approval = await approvePackageInstallIfNeeded(options, id, parsed.flags.groups, parsed.flags.yes, "upgrade");
        if (!approval.ok) {
          return { handled: true, exitCode: 1, output: approval.output };
        }
        const progress: string[] = [];
        const result = await installManagedPythonCapabilityEnvironment({
          stateRoot,
          capabilityId: id,
          groups: parsed.flags.groups,
          onProgress: (message) => progress.push(message)
        });
        return {
          handled: true,
          exitCode: result.ok ? 0 : 1,
          output: renderActionResult("upgrade", result, progress)
        };
      });
    case "reset":
      return withCapabilityId(parsed.id, async (id) => {
        let paths;
        try {
          paths = resolveManagedPythonCapabilityPaths({ stateRoot, capabilityId: id });
        } catch (error) {
          return unknownCapabilityResult(id, error);
        }
        const confirmed = await approveReset(options, id, paths.envPath, parsed.flags.yes);
        if (!confirmed.ok) {
          return { handled: true, exitCode: 1, output: confirmed.output };
        }
        await rm(paths.envPath, { recursive: true, force: true });
        return {
          handled: true,
          exitCode: 0,
          output: [
            `Removed managed Python capability environment '${id}'.`,
            `Deleted: ${paths.envPath}`,
            "No profile-local state or legacy faster-whisper environment was removed."
          ].join("\n")
        };
      });
    default:
      return {
        handled: true,
        exitCode: 1,
        output: [
          `Unknown python-env command: ${parsed.command}`,
          "",
          renderPythonEnvHelp()
        ].join("\n")
      };
  }
}

function parsePythonEnvArgs(args: string[]): ParsedPythonEnvArgs {
  const [command = "help", id, ...rest] = args;
  const groups: string[] = [];
  let yes = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }
    if (arg === "--group") {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { ok: false, error: "--group requires a group name." };
      }
      groups.push(value);
      index++;
      continue;
    }
    if (arg.startsWith("--group=")) {
      groups.push(arg.slice("--group=".length));
      continue;
    }
    if (arg === "--groups") {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { ok: false, error: "--groups requires a comma-separated group list." };
      }
      groups.push(...splitGroups(value));
      index++;
      continue;
    }
    if (arg.startsWith("--groups=")) {
      groups.push(...splitGroups(arg.slice("--groups=".length)));
      continue;
    }
    return { ok: false, error: `Unknown python-env option: ${arg}` };
  }
  return {
    ok: true,
    command,
    id,
    flags: {
      groups: [...new Set(groups.map((group) => group.trim()).filter((group) => group.length > 0))].sort(),
      yes
    }
  };
}

function splitGroups(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

async function withCapabilityId(
  id: string | undefined,
  callback: (id: string) => Promise<CliCommandResult>
): Promise<CliCommandResult> {
  if (id === undefined || id.startsWith("-")) {
    return {
      handled: true,
      exitCode: 1,
      output: "Usage: estacoda python-env <status|setup|verify|upgrade|reset> <id>"
    };
  }
  return callback(id);
}

async function renderPythonEnvList(stateRoot: string): Promise<string> {
  const specs = listRegisteredPythonCapabilitySpecs();
  const lines = ["EstaCoda managed Python environments"];
  if (specs.length === 0) {
    lines.push("No managed Python capabilities are registered.");
    return lines.join("\n");
  }
  for (const spec of specs) {
    const status = await checkManagedPythonCapabilityStatus({
      stateRoot,
      capabilityId: spec.id
    });
    lines.push(`${spec.id.padEnd(18)} ${spec.version.padEnd(10)} ${statusLabel(status)}`);
  }
  return lines.join("\n");
}

async function renderPythonEnvStatus(
  stateRoot: string,
  capabilityId: string,
  groups: string[]
): Promise<string> {
  const spec = getRegisteredPythonCapabilitySpec(capabilityId);
  if (spec === undefined) {
    return `Unknown managed Python capability: ${capabilityId}`;
  }
  let paths;
  try {
    paths = resolveManagedPythonCapabilityPaths({ stateRoot, capabilityId });
  } catch (error) {
    return `Unknown managed Python capability: ${capabilityId}\n${boundDiagnostic(formatError(error))}`;
  }
  const expectedHash = fingerprintManagedPythonCapabilitySpec(spec, groups);
  const status = await checkManagedPythonCapabilityStatus({
    stateRoot,
    capabilityId,
    groups
  });
  const manifest = status.ok ? status.manifest : status.manifest;
  const lines = [
    `Capability: ${capabilityId}`,
    `Version: ${spec.version}`,
    `State: ${statusLabel(status)}`,
    `Env path: ${paths.envPath}`,
    `Python path: ${manifest?.pythonPath ?? paths.pythonPath}`,
    `Manifest: ${manifest === undefined ? "missing" : manifest.status}`,
    `Expected spec hash: ${expectedHash}`,
    `Manifest spec hash: ${manifest?.specHash ?? "none"}`,
    `Installed groups: ${manifest?.installedGroups.length ? manifest.installedGroups.join(", ") : "none"}`
  ];
  if (groups.length > 0) {
    lines.push(`Selected groups: ${groups.join(", ")}`);
  }
  if (!status.ok) {
    lines.push(`Reason: ${status.reason}`);
    lines.push(`Repair hint: ${repairHint(status.reason, capabilityId, groups)}`);
    if (status.diagnostic !== undefined) {
      lines.push(`Diagnostic: ${boundDiagnostic(status.diagnostic)}`);
    }
  } else if (status.status !== "verified") {
    lines.push(`Repair hint: ${commandWithGroups("estacoda python-env verify", capabilityId, groups)}`);
  }
  return lines.join("\n");
}

async function approvePackageInstallIfNeeded(
  options: CliOptions,
  capabilityId: string,
  groups: string[],
  yes: boolean,
  action: "setup" | "upgrade"
): Promise<{ ok: true } | { ok: false; output: string }> {
  const packages = packagesForCapability(capabilityId, groups);
  if (!packages.ok) {
    return { ok: false, output: packages.output };
  }
  if (packages.packages.length === 0 || yes) {
    return { ok: true };
  }
  const prompt = options.prompt ?? (options.interactive !== false && canRunInteractive() ? createReadlinePrompt() : undefined);
  if (prompt === undefined) {
    return {
      ok: false,
      output: [
        `The ${action} command would install pinned Python packages for '${capabilityId}'.`,
        "Run with --yes to confirm package installation.",
        `Packages: ${packages.packages.join(", ")}`
      ].join("\n")
    };
  }
  const closePrompt = options.prompt === undefined;
  try {
    const answer = (await prompt(`Install pinned Python packages for '${capabilityId}'? [y/N] `)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      return { ok: true };
    }
    return { ok: false, output: "Cancelled managed Python package installation." };
  } finally {
    if (closePrompt) {
      prompt.close?.();
    }
  }
}

async function approveReset(
  options: CliOptions,
  capabilityId: string,
  envPath: string,
  yes: boolean
): Promise<{ ok: true } | { ok: false; output: string }> {
  if (yes) {
    return { ok: true };
  }
  const prompt = options.prompt ?? (options.interactive !== false && canRunInteractive() ? createReadlinePrompt() : undefined);
  if (prompt === undefined) {
    return {
      ok: false,
      output: [
        `This will delete the managed Python capability environment '${capabilityId}'.`,
        `Path: ${envPath}`,
        "Run with --yes to confirm."
      ].join("\n")
    };
  }
  const closePrompt = options.prompt === undefined;
  try {
    const answer = (await prompt(`Delete managed Python environment '${capabilityId}'? Type '${capabilityId}' to confirm: `)).trim();
    if (answer === capabilityId) {
      return { ok: true };
    }
    return { ok: false, output: "Cancelled managed Python environment reset." };
  } finally {
    if (closePrompt) {
      prompt.close?.();
    }
  }
}

function packagesForCapability(
  capabilityId: string,
  groups: string[]
): { ok: true; packages: string[] } | { ok: false; output: string } {
  const spec = getRegisteredPythonCapabilitySpec(capabilityId);
  if (spec === undefined) {
    return { ok: false, output: `Unknown managed Python capability: ${capabilityId}` };
  }
  const packages = [...spec.packages];
  for (const groupId of groups) {
    const group = spec.optionalGroups?.[groupId];
    if (group === undefined) {
      return {
        ok: false,
        output: `Unknown optional group '${groupId}' for managed Python capability '${capabilityId}'.`
      };
    }
    packages.push(...group.packages);
  }
  return { ok: true, packages };
}

function validateCapabilityGroups(
  capabilityId: string,
  groups: string[]
): { ok: true } | { ok: false; output: string } {
  const packages = packagesForCapability(capabilityId, groups);
  return packages.ok ? { ok: true } : { ok: false, output: packages.output };
}

function statusLabel(status: ManagedPythonCapabilityInstallStatus): string {
  if (status.ok) {
    return status.status;
  }
  switch (status.reason) {
    case "install_required":
      return "missing";
    case "upgrade_required":
      return "upgrade-required";
    case "broken_env":
    case "broken_manifest":
    case "venv_missing":
    case "venv_create_failed":
    case "pip_install_failed":
    case "import_verify_failed":
      return "broken";
    default:
      return status.reason;
  }
}

function repairHint(reason: ManagedPythonCapabilityFailure["reason"], capabilityId: string, groups: string[]): string {
  switch (reason) {
    case "install_required":
      return `${commandWithGroups("estacoda python-env setup", capabilityId, groups)} --yes`;
    case "upgrade_required":
      return `${commandWithGroups("estacoda python-env upgrade", capabilityId, groups)} --yes`;
    case "broken_env":
    case "broken_manifest":
    case "venv_missing":
    case "import_verify_failed":
      return `${commandWithGroups("estacoda python-env verify", capabilityId, groups)} or ${commandWithGroups("estacoda python-env setup", capabilityId, groups)} --yes`;
    case "disk_insufficient":
      return "Free disk space before retrying setup.";
    case "python_missing":
      return "Install Python 3 before retrying setup.";
    default:
      return `Inspect the diagnostic, then retry ${commandWithGroups("estacoda python-env setup", capabilityId, groups)} --yes.`;
  }
}

function commandWithGroups(command: string, capabilityId: string, groups: string[]): string {
  return [command, capabilityId, ...groups.flatMap((group) => ["--group", group])].join(" ");
}

function renderActionResult(
  action: "setup" | "verify" | "upgrade",
  result: Awaited<ReturnType<typeof installManagedPythonCapabilityEnvironment>>,
  progress: string[] = []
): string {
  if (result.ok) {
    return [
      ...progress,
      `Managed Python capability '${result.capabilityId}' ${action} complete.`,
      `Env path: ${result.envPath}`,
      `Python path: ${result.pythonPath}`,
      `Spec hash: ${result.specHash}`,
      `Installed groups: ${result.installedGroups.length ? result.installedGroups.join(", ") : "none"}`
    ].join("\n");
  }
  return [
    ...progress,
    `Managed Python capability '${result.capabilityId}' ${action} failed.`,
    `Reason: ${result.reason}`,
    result.message,
    result.diagnostic === undefined ? undefined : `Diagnostic: ${boundDiagnostic(result.diagnostic)}`
  ].filter((line): line is string => line !== undefined).join("\n");
}

function unknownCapabilityResult(id: string, error: unknown): CliCommandResult {
  return {
    handled: true,
    exitCode: 1,
    output: [
      `Unknown managed Python capability: ${id}`,
      boundDiagnostic(formatError(error))
    ].join("\n")
  };
}

function renderPythonEnvHelp(): string {
  return [
    "EstaCoda managed Python environments",
    "  estacoda python-env list",
    "  estacoda python-env status <id> [--group <name>] [--groups <a,b>]",
    "  estacoda python-env setup <id> [--group <name>] [--groups <a,b>] [--yes]",
    "  estacoda python-env verify <id> [--group <name>] [--groups <a,b>]",
    "  estacoda python-env upgrade <id> [--group <name>] [--groups <a,b>] [--yes]",
    "  estacoda python-env reset <id> [--yes]"
  ].join("\n");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
