import type {
  CommandRegistration,
  CommandRegistry,
} from "../contracts/command-registry.js";
import type { UiLocale } from "./cli-ui-copy.js";
import { chromeCopy } from "./cli-ui-copy.js";

const implementedSlashCommands = new Set([
  "help",
  "status",
  "model",
  "providers",
  "new",
  "tools",
  "browser",
  "memory",
  "skills",
  "reload-mcp",
  "resume",
  "approvals",
  "security",
  "yolo",
  "cron",
  "revoke",
  "sessions",
  "search",
  "compact",
  "switch",
  "trust",
  "untrust",
  "workspace.trust.status",
  "doctor",
  "workflow",
  "handoff",
  "clear",
  "exit",
  "interrupt",
  "steer",
]);

const completionPriority = new Map([
  ["help", 0],
  ["status", 1],
  ["model", 2],
  ["providers", 3],
  ["tools", 4],
  ["skills", 5],
  ["exit", 6],
  ["interrupt", 7],
  ["steer", 8],
]);

const activeTurnCompletionPriority = new Map([
  ["interrupt", 0],
  ["steer", 1],
  ["help", 2],
  ["status", 3],
  ["model", 4],
  ["providers", 5],
  ["tools", 6],
  ["skills", 7],
  ["exit", 8],
]);

export type SlashCompletionSourceOptions = {
  readonly includeActiveTurnCommands?: boolean;
};

export function isImplementedSlashCommand(commandName: string): boolean {
  return implementedSlashCommands.has(commandName);
}

export function listSlashCompletionCommands(
  registry: CommandRegistry,
  query = "/",
  options: SlashCompletionSourceOptions = {}
): readonly CommandRegistration[] {
  const normalizedFilter = normalizeSlashFilter(query);
  return registry
    .list({
      scope: "slash",
      visibility: "public",
      filter: normalizedFilter || undefined,
    })
    .filter((command) => isImplementedSlashCommand(command.name))
    .filter((command) => options.includeActiveTurnCommands === true || command.availability !== "active-turn")
    .sort((a, b) => compareSlashCompletionCommands(a, b, options));
}

export function normalizeSlashFilter(value: string): string {
  return value.trim().replace(/^\//u, "").toLowerCase();
}

export function slashCompletionDescription(commandName: string, locale: UiLocale): string | undefined {
  const copy = chromeCopy(locale);
  switch (commandName) {
    case "help":
      return copy.slashCommandHelpDescription;
    case "status":
      return copy.slashCommandStatusDescription;
    case "model":
      return copy.slashCommandModelDescription;
    case "tools":
      return copy.slashCommandToolsDescription;
    case "skills":
      return copy.slashCommandSkillsDescription;
    case "exit":
      return copy.slashCommandExitDescription;
    default:
      return undefined;
  }
}

function compareSlashCompletionCommands(
  a: CommandRegistration,
  b: CommandRegistration,
  options: SlashCompletionSourceOptions
): number {
  const priorityMap = options.includeActiveTurnCommands === true
    ? activeTurnCompletionPriority
    : completionPriority;
  const aPriority = priorityMap.get(a.name) ?? 100;
  const bPriority = priorityMap.get(b.name) ?? 100;
  if (aPriority !== bPriority) return aPriority - bPriority;
  return a.name.localeCompare(b.name);
}
