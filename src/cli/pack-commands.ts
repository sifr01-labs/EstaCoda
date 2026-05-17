import { PackRegistry } from "../packs/pack-registry.js";
import {
  installPack,
  enablePack,
  disablePack,
  uninstallPack
} from "../packs/pack-installer.js";
import type { CliOptions, CliCommandResult } from "./cli.js";
import { createReadlinePrompt } from "./readline-prompt.js";

export async function packCommand(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const subcommand = args[0];
  const subArgs = args.slice(1);
  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  const actor = process.env.USER ?? "cli";

  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    return {
      handled: true,
      exitCode: 0,
      output: renderPackUsage()
    };
  }

  switch (subcommand) {
    case "list":
      return listPacks(homeDir, subArgs);
    case "install":
      return installCommand(homeDir, subArgs, actor, options);
    case "inspect":
      return inspectCommand(homeDir, subArgs);
    case "enable":
      return enableCommand(homeDir, subArgs, actor, options);
    case "disable":
      return disableCommand(homeDir, subArgs);
    case "uninstall":
      return uninstallCommand(homeDir, subArgs, actor);
    default:
      return {
        handled: true,
        exitCode: 1,
        output: renderPackUsage()
      };
  }
}

function renderPackUsage(): string {
  return [
    "Usage: estacoda packs <subcommand>",
    "",
    "Subcommands:",
    "  list                       List installed packs",
    "  install <path> [--force]   Install a pack from a local path",
    "  inspect <id>               Show full manifest and metadata",
    "  enable <id> [--force]      Enable a pack",
    "  disable <id>               Disable a pack",
    "  uninstall <id> [--keep-files]  Uninstall a pack",
    ""
  ].join("\n");
}

async function listPacks(homeDir: string, args: string[]): Promise<CliCommandResult> {
  const registry = new PackRegistry({ homeDir });
  const entries = await registry.list();

  const statusFilter = valueAfter(args, "--status");
  const originFilter = valueAfter(args, "--origin");

  const filtered = entries.filter((e) => {
    if (statusFilter !== undefined && e.status !== statusFilter) return false;
    if (originFilter !== undefined && e.manifest.provenance.origin !== originFilter) return false;
    return true;
  });

  if (filtered.length === 0) {
    return {
      handled: true,
      exitCode: 0,
      output: "No packs installed."
    };
  }

  const lines: string[] = [];
  lines.push("id\tname\tversion\torigin\trisk\tstatus");
  for (const entry of filtered) {
    const risk = entry.manifest.provenance.trustLevel;
    lines.push(
      `${entry.manifest.id}\t${entry.manifest.name}\t${entry.manifest.version}\t${entry.manifest.provenance.origin}\t${risk}\t${entry.status}`
    );
  }

  return {
    handled: true,
    exitCode: 0,
    output: lines.join("\n")
  };
}

async function installCommand(
  homeDir: string,
  args: string[],
  actor: string,
  options: CliOptions
): Promise<CliCommandResult> {
  const path = args[0];
  if (path === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda packs install <path> [--force]" };
  }

  const prompt = options.interactive !== false ? options.prompt ?? createReadlinePrompt() : undefined;
  const result = await installPack({
    homeDir,
    sourcePath: path,
    actor,
    force: hasFlag(args, "--force"),
    prompt
  });

  return {
    handled: true,
    exitCode: result.exitCode,
    output: result.output
  };
}

async function inspectCommand(homeDir: string, args: string[]): Promise<CliCommandResult> {
  const id = args[0];
  if (id === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda packs inspect <id>" };
  }

  const registry = new PackRegistry({ homeDir });
  const entry = await registry.find(id);
  if (entry === undefined) {
    return { handled: true, exitCode: 1, output: `pack not found: ${id}` };
  }

  const output = JSON.stringify(
    {
      manifest: entry.manifest,
      status: entry.status,
      installedAt: entry.installedAt,
      installedBy: entry.installedBy,
      evalNote:
        entry.manifest.evals !== undefined && entry.manifest.evals.length > 0
          ? "Eval hooks are not executed in EstaCoda v0.1.0"
          : undefined
    },
    null,
    2
  );

  return { handled: true, exitCode: 0, output };
}

async function enableCommand(
  homeDir: string,
  args: string[],
  actor: string,
  options: CliOptions
): Promise<CliCommandResult> {
  const id = args[0];
  if (id === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda packs enable <id> [--force]" };
  }

  const prompt = options.interactive !== false ? options.prompt ?? createReadlinePrompt() : undefined;
  const result = await enablePack({
    homeDir,
    id,
    actor,
    force: hasFlag(args, "--force"),
    prompt
  });

  return {
    handled: true,
    exitCode: result.exitCode,
    output: result.output
  };
}

async function disableCommand(homeDir: string, args: string[]): Promise<CliCommandResult> {
  const id = args[0];
  if (id === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda packs disable <id>" };
  }

  const result = await disablePack({ homeDir, id });

  return {
    handled: true,
    exitCode: result.exitCode,
    output: result.output
  };
}

async function uninstallCommand(homeDir: string, args: string[], actor: string): Promise<CliCommandResult> {
  const id = args[0];
  if (id === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda packs uninstall <id> [--keep-files]" };
  }

  const result = await uninstallPack({
    homeDir,
    id,
    actor,
    keepFiles: hasFlag(args, "--keep-files")
  });

  return {
    handled: true,
    exitCode: result.exitCode,
    output: result.output
  };
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1];
  }
  return undefined;
}
