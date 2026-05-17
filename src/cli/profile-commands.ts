import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import type { CliCommandResult, CliOptions } from "./cli.js";
import {
  defaultProfileId,
  normalizeProfileId,
  readActiveProfile,
  resolveGlobalStateHome,
  resolveProfileStateHome,
  writeActiveProfile
} from "../config/profile-home.js";
import { readConfig } from "../config/runtime-config.js";
import {
  ensureProfileSkeleton,
  parseProfileMemoryFiles,
  profileExists,
  removeProfileDirectory,
  renameProfileDirectory
} from "./profile-state.js";

export async function profileCommand(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "create":
      return createProfile(options, rest);
    case "list":
      return listProfiles(options);
    case "use":
      return useProfile(options, rest);
    case "show":
      return showProfile(options, rest);
    case "delete":
      return deleteProfile(options, rest);
    case "rename":
      return renameProfile(options, rest);
    default:
      return {
        handled: true,
        exitCode: subcommand === undefined || subcommand === "--help" || subcommand === "-h" ? 0 : 1,
        output: profileHelp()
      };
  }
}

async function createProfile(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const name = firstPositional(args);
  if (name === undefined) {
    return usage("Usage: estacoda profile create <name> [--blank] [--from <profile>] [--files user,memory,soul] [--contextualize <focus>]");
  }

  const profileId = normalizeProfileId(name);
  const sourceProfileId = normalizeProfileId(valueAfter(args, "--from") ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId());
  if (!hasFlag(args, "--blank") && !(await profileExists({ homeDir: options.homeDir, profileId: sourceProfileId }))) {
    return {
      handled: true,
      exitCode: 1,
      output: `Source profile not found: ${sourceProfileId}`
    };
  }

  let copyFiles;
  try {
    copyFiles = parseProfileMemoryFiles(valueAfter(args, "--files"));
  } catch (error) {
    return {
      handled: true,
      exitCode: 1,
      output: error instanceof Error ? error.message : String(error)
    };
  }

  const focus = valueAfter(args, "--contextualize");
  try {
    const profilePaths = await ensureProfileSkeleton({
      homeDir: options.homeDir,
      profileId,
      sourceProfileId,
      blank: hasFlag(args, "--blank"),
      copyFiles,
      contextualize: focus,
      contextualizer: options.profileContextualizer,
      failIfExists: true
    });
    return {
      handled: true,
      exitCode: 0,
      output: [
        `Created profile: ${profileId}`,
        `Config: ${profilePaths.configPath}`,
        `Secrets: ${profilePaths.envPath}`,
        `Skills: ${profilePaths.skillsPath}`,
        focus === undefined ? undefined : `Contextualized: ${focus}`
      ].filter((line): line is string => line !== undefined).join("\n")
    };
  } catch (error) {
    return {
      handled: true,
      exitCode: 1,
      output: error instanceof Error ? error.message : String(error)
    };
  }
}

async function listProfiles(options: CliOptions): Promise<CliCommandResult> {
  const globalPaths = resolveGlobalStateHome({ homeDir: options.homeDir });
  const active = readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  let entries: Dirent[];
  try {
    entries = await readdir(globalPaths.profilesRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      entries = [];
    } else {
      throw error;
    }
  }
  const profiles = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return {
    handled: true,
    exitCode: 0,
    output: profiles.length === 0
      ? "No profiles found."
      : profiles.map((profile) => `${profile === active ? "*" : " "} ${profile}`).join("\n")
  };
}

async function useProfile(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const name = firstPositional(args);
  if (name === undefined) {
    return usage("Usage: estacoda profile use <name>");
  }
  const profileId = normalizeProfileId(name);
  if (!(await profileExists({ homeDir: options.homeDir, profileId }))) {
    return {
      handled: true,
      exitCode: 1,
      output: `Profile not found: ${profileId}`
    };
  }

  writeActiveProfile(profileId, { homeDir: options.homeDir });
  const active = readActiveProfile({ homeDir: options.homeDir });
  return {
    handled: true,
    exitCode: 0,
    output: [
      `Active profile: ${active.profileId}`,
      `Previous profile: ${active.previousProfileId ?? "none"}`,
      `Switched at: ${active.lastSwitchedAt ?? "unknown"}`
    ].join("\n")
  };
}

async function showProfile(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const profileId = normalizeProfileId(firstPositional(args) ?? options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId());
  const profilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId });
  if (!(await profileExists({ homeDir: options.homeDir, profileId }))) {
    return {
      handled: true,
      exitCode: 1,
      output: `Profile not found: ${profileId}`
    };
  }

  const loaded = await readConfig(profilePaths.configPath);
  const envKeys = await readEnvKeys(profilePaths.envPath);
  const provider = loaded.config.model?.provider ?? "unconfigured";
  const model = loaded.config.model?.id ?? "unconfigured";

  return {
    handled: true,
    exitCode: 0,
    output: [
      `Profile: ${profileId}`,
      `Path: ${profilePaths.profileRoot}`,
      `Config: ${profilePaths.configPath}`,
      `Secrets: ${profilePaths.envPath}`,
      `Auth: ${profilePaths.authJsonPath}`,
      `Model: ${provider}/${model}`,
      envKeys.length === 0 ? "Secret keys: none" : "Secret keys:",
      ...envKeys.map((key) => `  ${key}=***`)
    ].join("\n")
  };
}

async function deleteProfile(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const name = firstPositional(args);
  if (name === undefined) {
    return usage("Usage: estacoda profile delete <name> [--force]");
  }
  const profileId = normalizeProfileId(name);
  const force = hasFlag(args, "--force", "-f");
  const active = readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  const profilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId });
  if (!existsSync(profilePaths.profileRoot)) {
    return {
      handled: true,
      exitCode: 1,
      output: `Profile not found: ${profileId}`
    };
  }
  if (profileId === active && !force) {
    return {
      handled: true,
      exitCode: 1,
      output: `Refusing to delete active profile ${profileId}. Use --force to override.`
    };
  }
  if (!force && await isNonEmptyDirectory(profilePaths.profileRoot)) {
    return {
      handled: true,
      exitCode: 1,
      output: `Refusing to delete non-empty profile ${profileId}. Use --force to override.`
    };
  }

  await removeProfileDirectory(profilePaths);
  if (profileId === active) {
    const fallbackProfileId = await resolveFallbackActiveProfile(options);
    writeActiveProfile(fallbackProfileId, { homeDir: options.homeDir });
  }
  return {
    handled: true,
    exitCode: 0,
    output: `Deleted profile: ${profileId}`
  };
}

async function renameProfile(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const oldName = firstPositional(args);
  const newName = secondPositional(args);
  if (oldName === undefined || newName === undefined) {
    return usage("Usage: estacoda profile rename <old> <new>");
  }
  const oldProfileId = normalizeProfileId(oldName);
  const newProfileId = normalizeProfileId(newName);
  if (!(await profileExists({ homeDir: options.homeDir, profileId: oldProfileId }))) {
    return {
      handled: true,
      exitCode: 1,
      output: `Profile not found: ${oldProfileId}`
    };
  }
  if (await profileExists({ homeDir: options.homeDir, profileId: newProfileId })) {
    return {
      handled: true,
      exitCode: 1,
      output: `Profile already exists: ${newProfileId}`
    };
  }

  await renameProfileDirectory({ homeDir: options.homeDir, oldProfileId, newProfileId });
  const active = readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  if (active === oldProfileId) {
    writeActiveProfile(newProfileId, { homeDir: options.homeDir });
  }
  return {
    handled: true,
    exitCode: 0,
    output: `Renamed profile: ${oldProfileId} -> ${newProfileId}`
  };
}

function profileHelp(): string {
  return [
    "Usage: estacoda profile <command>",
    "",
    "Commands:",
    "  create <name>        Create a profile",
    "  list                 List profiles",
    "  use <name>           Switch the active profile",
    "  show [name]          Show profile paths and model summary",
    "  delete <name>        Delete a profile",
    "  rename <old> <new>   Rename a profile"
  ].join("\n");
}

function usage(output: string): CliCommandResult {
  return { handled: true, exitCode: 1, output };
}

function firstPositional(args: readonly string[]): string | undefined {
  return args.find((arg, index) => !arg.startsWith("-") && (index === 0 || !flagTakesValue(args[index - 1])));
}

function secondPositional(args: readonly string[]): string | undefined {
  const positionals = args.filter((arg, index) => !arg.startsWith("-") && (index === 0 || !flagTakesValue(args[index - 1])));
  return positionals[1];
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function hasFlag(args: readonly string[], ...flags: string[]): boolean {
  return flags.some((flag) => args.includes(flag));
}

function flagTakesValue(flag: string | undefined): boolean {
  return flag === "--from" || flag === "--files" || flag === "--contextualize";
}

async function isNonEmptyDirectory(path: string): Promise<boolean> {
  const entries = await readdir(path);
  return entries.length > 0;
}

async function resolveFallbackActiveProfile(options: CliOptions): Promise<string> {
  const globalPaths = resolveGlobalStateHome({ homeDir: options.homeDir });
  let entries: Dirent[];
  try {
    entries = await readdir(globalPaths.profilesRoot, { withFileTypes: true });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    entries = [];
  }

  const remainingProfile = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()[0];
  if (remainingProfile !== undefined) {
    return normalizeProfileId(remainingProfile);
  }

  const fallbackProfileId = defaultProfileId();
  await ensureProfileSkeleton({
    homeDir: options.homeDir,
    profileId: fallbackProfileId,
    blank: true
  });
  return fallbackProfileId;
}

async function readEnvKeys(path: string): Promise<string[]> {
  try {
    const content = await readFile(path, "utf8");
    return content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.split("=")[0]?.trim())
      .filter((key): key is string => key !== undefined && key.length > 0)
      .sort();
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
