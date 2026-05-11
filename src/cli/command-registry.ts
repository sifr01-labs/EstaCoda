import type {
  CommandRegistration,
  CommandRegistry,
  CommandScope,
  CommandVisibility,
} from "../contracts/command-registry.js";

class InMemoryCommandRegistry implements CommandRegistry {
  private readonly commands = new Map<string, CommandRegistration>();

  private key(cmd: CommandRegistration): string {
    return cmd.parent !== undefined ? `${cmd.parent}.${cmd.name}` : cmd.name;
  }

  private keyName(name: string, parent?: string): string {
    return parent !== undefined ? `${parent}.${name}` : name;
  }

  register(command: CommandRegistration): void {
    this.commands.set(this.key(command), command);
  }

  resolve(name: string): CommandRegistration | undefined {
    const normalized = name.toLowerCase();
    for (const cmd of this.commands.values()) {
      if (cmd.parent !== undefined) continue;
      if (cmd.name.toLowerCase() === normalized) return cmd;
      if (cmd.aliases.some((a) => a.toLowerCase() === normalized)) return cmd;
    }
    return undefined;
  }

  resolveSubcommand(parent: string, name: string): CommandRegistration | undefined {
    const normalized = name.toLowerCase();
    for (const cmd of this.commands.values()) {
      if (cmd.parent !== parent) continue;
      if (cmd.name.toLowerCase() === normalized) return cmd;
      if (cmd.aliases.some((a) => a.toLowerCase() === normalized)) return cmd;
    }
    return undefined;
  }

  list(options?: {
    scope?: CommandScope;
    visibility?: CommandVisibility;
    filter?: string;
    parent?: string | null;
  }): readonly CommandRegistration[] {
    let results = Array.from(this.commands.values());

    if (options?.parent !== undefined) {
      if (options.parent === null) {
        results = results.filter((cmd) => cmd.parent === undefined);
      } else {
        results = results.filter((cmd) => cmd.parent === options.parent);
      }
    } else {
      // Default: exclude parented commands from top-level listings
      results = results.filter((cmd) => cmd.parent === undefined);
    }

    if (options?.scope) {
      results = results.filter(
        (cmd) => cmd.scope === options.scope || cmd.scope === "both"
      );
    }

    if (options?.visibility) {
      results = results.filter((cmd) => cmd.visibility === options.visibility);
    }

    if (options?.filter) {
      const filter = options.filter.toLowerCase();
      results = results.filter(
        (cmd) =>
          cmd.name.includes(filter) ||
          cmd.description.toLowerCase().includes(filter) ||
          cmd.category.toLowerCase().includes(filter) ||
          cmd.aliases.some((a) => a.toLowerCase().includes(filter))
      );
    }

    return results;
  }

  getCategories(scope?: CommandScope): readonly string[] {
    const cmds = scope
      ? Array.from(this.commands.values()).filter(
          (cmd) =>
            (cmd.scope === scope || cmd.scope === "both") &&
            cmd.parent === undefined
        )
      : Array.from(this.commands.values()).filter(
          (cmd) => cmd.parent === undefined
        );
    return [...new Set(cmds.map((cmd) => cmd.category))].sort();
  }
}

export function createCommandRegistry(): CommandRegistry {
  return new InMemoryCommandRegistry();
}

// Global singleton registry for the application.
export const commandRegistry = createCommandRegistry();

// Register all known commands. Called once at module load.
function registerAll(): void {
  // ── Slash commands ──
  commandRegistry.register({
    name: "help",
    aliases: ["--help", "-h"],
    category: "System",
    description: "Show command help",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "status",
    aliases: [],
    category: "Info",
    description: "Show runtime, model, context, trust, memory, and skill status",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "model",
    aliases: [],
    category: "Info",
    description: "Show the active model and provider without changing saved setup state.",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "sessions",
    aliases: [],
    category: "Session",
    description: "List recent sessions",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "switch",
    aliases: [],
    category: "Session",
    description: "Switch to an existing session",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "search",
    aliases: ["find"],
    category: "Session",
    description: "Search session history",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "reset",
    aliases: ["new"],
    category: "Session",
    description: "Start a fresh session and refresh the skill/config snapshot",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "memory",
    aliases: [],
    category: "Info",
    description: "Inspect promoted memory conclusions",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "tools",
    aliases: [],
    category: "Info",
    description: "Browse available tools grouped by toolset",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "browser",
    aliases: [],
    category: "Tools",
    description: "Manage local browser/CDP connection",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "skills",
    aliases: [],
    category: "Info",
    description: "Browse commands and available skills",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "packs",
    aliases: [],
    category: "Skills",
    description: "Manage packs (install, enable, disable, uninstall)",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "reload-mcp",
    aliases: [],
    category: "System",
    description: "Reload MCP config and refresh MCP tools for this session",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "resume",
    aliases: ["continue"],
    category: "Info",
    description: "Show the latest interrupted-turn resume note",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "approvals",
    aliases: [],
    category: "Security",
    description: "Show current one-time, session, and persistent approvals",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "revoke",
    aliases: [],
    category: "Security",
    description: "Revoke a persistent approval by id",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "security",
    aliases: [],
    category: "Security",
    description: "Inspect recent security decisions",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "yolo",
    aliases: [],
    category: "Security",
    description: "Toggle session YOLO/open mode; hard safety blocks still apply",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "cron",
    aliases: [],
    category: "System",
    description: "Manage scheduled tasks",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "trust",
    aliases: ["workspace.trust.grant"],
    category: "Workspace",
    description: "Trust this workspace for proactive local work",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "untrust",
    aliases: ["workspace.trust.revoke"],
    category: "Workspace",
    description: "Revoke workspace trust",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "workspace.trust.status",
    aliases: [],
    category: "Workspace",
    description: "Show whether the current workspace is trusted",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "doctor",
    aliases: [],
    category: "System",
    description: "Run a quick in-session health check",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "flow",
    aliases: [],
    category: "TaskFlow",
    description: "TaskFlow operator commands (status, pause, resume, steer, trace, etc.)",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "handoff",
    aliases: [],
    category: "Channels",
    description: "Generate a handoff code to share this session with Telegram",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "clear",
    aliases: ["cls"],
    category: "System",
    description: "Clear the terminal",
    visibility: "public",
    scope: "slash",
  });
  commandRegistry.register({
    name: "exit",
    aliases: ["quit"],
    category: "System",
    description: "End the session",
    visibility: "public",
    scope: "slash",
  });

  // ── CLI-only commands ──
  commandRegistry.register({
    name: "setup",
    aliases: [],
    category: "Setup",
    description: "Run the guided setup wizard",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "init",
    aliases: [],
    category: "Setup",
    description: "Bootstrap state directories and default config",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "update",
    aliases: [],
    category: "System",
    description: "Check for updates and optionally apply them",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "version",
    aliases: ["--version", "-v"],
    category: "System",
    description: "Show the installed version",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "web",
    aliases: [],
    category: "Setup",
    description: "Configure web extraction",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "local",
    aliases: [],
    category: "Setup",
    description: "Configure local Ollama/OpenAI-compatible models",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "voice",
    aliases: [],
    category: "Setup",
    description: "Configure TTS/STT voice tools",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "image",
    aliases: [],
    category: "Setup",
    description: "Configure image generation",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "security",
    aliases: [],
    category: "Setup",
    description: "View or configure approval mode",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "mcp",
    aliases: [],
    category: "Setup",
    description: "Configure MCP servers",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "acp",
    aliases: [],
    category: "System",
    description: "Start the ACP stdio server",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "telegram",
    aliases: [],
    category: "Channels",
    description: "Configure Telegram channel",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "gateway",
    aliases: [],
    category: "Channels",
    description: "Start channel gateway",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "verify",
    aliases: [],
    category: "Setup",
    description: "Check setup readiness",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "settings",
    aliases: [],
    category: "Setup",
    description: "View setup categories",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "profile",
    aliases: [],
    category: "Setup",
    description: "View or set agent profile",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "trace",
    aliases: [],
    category: "Development",
    description: "List, inspect, and timeline trajectories",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "eval",
    aliases: [],
    category: "Development",
    description: "Run deterministic eval fixtures",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "proposal",
    aliases: [],
    category: "Development",
    description: "Create and manage proposals",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "manifest",
    aliases: [],
    category: "Development",
    description: "Manage skill manifests",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "curator",
    aliases: [],
    category: "Development",
    description: "Curator commands",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "evolution",
    aliases: [],
    category: "Development",
    description: "Evolution commands",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "knowledge",
    aliases: [],
    category: "Development",
    description: "Knowledge commands",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "channels",
    aliases: [],
    category: "Channels",
    description: "List and inspect channels",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "sessions",
    aliases: [],
    category: "Session",
    description: "List and manage sessions",
    visibility: "public",
    scope: "cli",
  });

  // ── pack subcommands (namespaced under "packs") ──
  commandRegistry.register({
    name: "list",
    aliases: [],
    parent: "packs",
    category: "Skills",
    description: "List installed packs",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "install",
    aliases: [],
    parent: "packs",
    category: "Skills",
    description: "Install a pack from a local path",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "inspect",
    aliases: [],
    parent: "packs",
    category: "Skills",
    description: "Show full manifest and metadata for a pack",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "enable",
    aliases: [],
    parent: "packs",
    category: "Skills",
    description: "Enable a pack",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "disable",
    aliases: [],
    parent: "packs",
    category: "Skills",
    description: "Disable a pack",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "uninstall",
    aliases: ["remove"],
    parent: "packs",
    category: "Skills",
    description: "Uninstall a pack",
    visibility: "public",
    scope: "cli",
  });

  // ── skill subcommands (namespaced under "skills") ──
  commandRegistry.register({
    name: "list",
    aliases: [],
    parent: "skills",
    category: "Skills",
    description: "List available skills from enabled packs",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "inspect",
    aliases: [],
    parent: "skills",
    category: "Skills",
    description: "Show metadata for a skill",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "view",
    aliases: [],
    parent: "skills",
    category: "Skills",
    description: "View the full SKILL.md content for a skill",
    visibility: "public",
    scope: "cli",
  });

  // ── Cron subcommands (namespaced under "cron") ──
  commandRegistry.register({
    name: "add",
    aliases: ["create"],
    parent: "cron",
    category: "Cron",
    description: "Add a scheduled job",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "list",
    aliases: [],
    parent: "cron",
    category: "Cron",
    description: "List scheduled jobs",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "show",
    aliases: [],
    parent: "cron",
    category: "Cron",
    description: "Show job detail with execution history",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "history",
    aliases: [],
    parent: "cron",
    category: "Cron",
    description: "Show execution history",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "tick",
    aliases: [],
    parent: "cron",
    category: "Cron",
    description: "Trigger a cron tick manually",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "edit",
    aliases: ["update"],
    parent: "cron",
    category: "Cron",
    description: "Edit an existing job",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "pause",
    aliases: [],
    parent: "cron",
    category: "Cron",
    description: "Pause a job",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "resume",
    aliases: [],
    parent: "cron",
    category: "Cron",
    description: "Resume a paused job",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "run",
    aliases: [],
    parent: "cron",
    category: "Cron",
    description: "Request a manual run of a job",
    visibility: "public",
    scope: "both",
  });
  commandRegistry.register({
    name: "remove",
    aliases: ["delete"],
    parent: "cron",
    category: "Cron",
    description: "Remove a job",
    visibility: "public",
    scope: "both",
  });

  // ── Evolution subcommands ──
  commandRegistry.register({
    name: "test",
    aliases: [],
    parent: "evolution",
    category: "Development",
    description: "Run constraint gates for a manifest",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "approve",
    aliases: [],
    parent: "evolution",
    category: "Development",
    description: "Approve a tested manifest",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "reject",
    aliases: [],
    parent: "evolution",
    category: "Development",
    description: "Reject a manifest",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "promote",
    aliases: [],
    parent: "evolution",
    category: "Development",
    description: "Promote an approved manifest",
    visibility: "public",
    scope: "cli",
  });
  commandRegistry.register({
    name: "rollback",
    aliases: [],
    parent: "evolution",
    category: "Development",
    description: "Rollback a promoted manifest",
    visibility: "public",
    scope: "cli",
  });

  // ── Manifest subcommands ──
  commandRegistry.register({
    name: "diff",
    aliases: [],
    parent: "manifest",
    category: "Development",
    description: "Show read-only diff of manifest filesChanged",
    visibility: "public",
    scope: "cli",
  });
}

registerAll();
