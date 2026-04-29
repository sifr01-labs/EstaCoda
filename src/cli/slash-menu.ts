import type { Runtime } from "../runtime/create-runtime.js";

export type SlashMenuCommand = {
  name: string;
  description: string;
  aliases?: string[];
};

export const SESSION_COMMANDS: readonly SlashMenuCommand[] = [
  { name: "help", description: "Show command help" },
  { name: "status", description: "Show runtime, model, context, trust, memory, and skill status", aliases: ["model"] },
  { name: "sessions", description: "List recent sessions" },
  { name: "switch", description: "Switch to an existing session" },
  { name: "search", description: "Search session history" },
  { name: "reset", description: "Start a fresh session and refresh the skill/config snapshot", aliases: ["new"] },
  { name: "memory", description: "Inspect promoted memory conclusions" },
  { name: "tools", description: "Browse available tools grouped by capability" },
  { name: "browser", description: "Manage local browser/CDP connection", aliases: ["browser status", "browser connect"] },
  { name: "skills", description: "Browse commands and available skills" },
  { name: "reload-mcp", description: "Reload MCP config and refresh MCP tools for this session" },
  { name: "resume", description: "Show the latest interrupted-turn resume note" },
  { name: "approvals", description: "Show current one-time, session, and persistent approvals" },
  { name: "revoke", description: "Revoke a persistent approval by id" },
  { name: "security", description: "Inspect recent security decisions", aliases: ["security debug"] },
  { name: "yolo", description: "Toggle session YOLO/open mode; hard safety blocks still apply" },
  { name: "cron", description: "Manage scheduled tasks" },
  { name: "trust", description: "Trust this workspace for proactive local work", aliases: ["workspace.trust.grant"] },
  { name: "untrust", description: "Revoke workspace trust", aliases: ["workspace.trust.revoke"] },
  { name: "workspace.trust.status", description: "Show whether the current workspace is trusted" },
  { name: "doctor", description: "Run a quick in-session health check" },
  { name: "clear", description: "Clear the terminal" },
  { name: "exit", description: "End the session", aliases: ["quit"] }
];

export function renderSlashMenu(runtime: Runtime, filter = ""): string {
  const normalizedFilter = normalizeFilter(filter);
  const commandRows = SESSION_COMMANDS
    .filter((command) => matchesCommand(command, normalizedFilter))
    .map((command) => ({
      left: `/${command.name}`,
      right: command.description
    }));
  const skillRows = runtime.skills()
    .filter((skill) => matches(normalizedFilter, skill.name, skill.description, skill.category, skill.sourceKind ?? "runtime"))
    .map((skill) => ({
      left: `/${skill.name}`,
      right: `${skill.description} [${skill.category}/${skill.sourceKind ?? "runtime"}]`
    }));

  return [
    renderSection("Commands", commandRows),
    renderSection("Skills", skillRows)
  ]
    .filter((section) => section.length > 0)
    .join("\n\n") || `No slash commands or skills match "/${normalizedFilter}".`;
}

export function renderToolsMenu(runtime: Runtime, filter = ""): string {
  const normalizedFilter = normalizeFilter(filter);
  const grouped = new Map<string, Array<{ left: string; right: string }>>();

  for (const tool of runtime.tools()) {
    if (!matches(normalizedFilter, tool.name, tool.description, ...tool.toolsets)) {
      continue;
    }

    for (const toolset of tool.toolsets) {
      grouped.set(toolset, [
        ...(grouped.get(toolset) ?? []),
        {
          left: tool.name,
          right: tool.description
        }
      ]);
    }
  }

  const sections = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([toolset, rows]) => renderSection(`${toolset} tools`, rows.sort((left, right) => left.left.localeCompare(right.left))));

  return [`Tools: ${runtime.tools().length}`, ...sections].join("\n\n");
}

function renderSection(title: string, rows: Array<{ left: string; right: string }>): string {
  if (rows.length === 0) {
    return "";
  }

  const leftWidth = Math.min(30, Math.max(...rows.map((row) => row.left.length), title.length));

  return [
    title,
    ...rows.map((row) =>
      `${row.left.padEnd(leftWidth + 2)}${truncate(row.right, 92)}`
    )
  ].join("\n");
}

function matchesCommand(command: SlashMenuCommand, filter: string): boolean {
  return matches(filter, command.name, command.description, ...(command.aliases ?? []));
}

function matches(filter: string, ...values: string[]): boolean {
  if (filter.length === 0) {
    return true;
  }

  return values.some((value) => value.toLowerCase().includes(filter));
}

function normalizeFilter(value: string): string {
  return value.trim().replace(/^\//u, "").toLowerCase();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
