import type { Runtime } from "../runtime/create-runtime.js";
import { commandRegistry } from "./command-registry.js";
import {
  buildTableViewModel,
  buildListViewModel,
  buildCommandResultViewModel,
  buildSlashMenuViewModel as buildSlashCompletionListViewModel,
  listItem,
  slashMenuOption,
} from "../ui/view-models/builders.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import type { SlashMenuViewModel, ViewModel } from "../contracts/view-model.js";
import type { UiLocale } from "../ui/cli-ui-copy.js";
import { chromeCopy } from "../ui/cli-ui-copy.js";

// ─────────────────────────────────────────────────────────────
// ViewModel builders (pure data, no rendering)
// ─────────────────────────────────────────────────────────────

const DEFAULT_COMPLETION_LIMIT = 6;

const implementedSlashCommands = new Set([
  "help",
  "status",
  "model",
  "reset",
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
  "flow",
  "handoff",
  "clear",
  "exit",
]);

export function isImplementedSlashCommand(commandName: string): boolean {
  return implementedSlashCommands.has(commandName);
}

const completionPriority = new Map([
  ["help", 0],
  ["status", 1],
  ["model", 2],
  ["tools", 3],
  ["skills", 4],
  ["exit", 5],
]);

export function buildSlashCompletionViewModel(
  runtime: Runtime,
  query = "/",
  options: { readonly limit?: number } = {}
): SlashMenuViewModel {
  const normalizedFilter = normalizeFilter(query);
  const limit = Math.max(1, options.limit ?? DEFAULT_COMPLETION_LIMIT);
  const commands = commandRegistry
    .list({
      scope: "slash",
      visibility: "public",
      filter: normalizedFilter || undefined,
    })
    .filter((command) => implementedSlashCommands.has(command.name))
    .sort((a, b) => {
      const aPriority = completionPriority.get(a.name) ?? 100;
      const bPriority = completionPriority.get(b.name) ?? 100;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);

  void runtime;

  return buildSlashCompletionListViewModel({
    query: query.startsWith("/") ? query : `/${query}`,
    options: commands.map((command) =>
      slashMenuOption(command.name, `/${command.name}`, {
        description: completionDescription(command.name, "en") ?? command.description,
      })
    ),
    selectedIndex: 0,
  });
}

export function buildSlashMenuViewModel(runtime: Runtime, filter = ""): ViewModel {
  const normalizedFilter = normalizeFilter(filter);
  const commands = commandRegistry.list({
    scope: "slash",
    filter: normalizedFilter || undefined,
  });

  const commandRows = commands.map((command) => ({
    name: `/${command.name}`,
    description: command.description,
  }));

  const skillRows = runtime
    .skills()
    .filter((skill) =>
      matches(
        normalizedFilter,
        skill.name,
        skill.description,
        skill.category,
        skill.sourceKind ?? "runtime"
      )
    )
    .map((skill) => ({
      name: `/${skill.name}`,
      description: `${skill.description} [${skill.category}/${skill.sourceKind ?? "runtime"}]`,
    }));

  const blocks: ViewModel[] = [];

  if (commandRows.length > 0) {
    blocks.push(
      buildTableViewModel({
        title: "Commands",
        columns: [
          { key: "name", header: "Name", alignment: "left" },
          { key: "description", header: "Description", alignment: "left" },
        ],
        rows: commandRows,
      })
    );
  }

  if (skillRows.length > 0) {
    blocks.push(
      buildTableViewModel({
        title: "Skills",
        columns: [
          { key: "name", header: "Name", alignment: "left" },
          { key: "description", header: "Description", alignment: "left" },
        ],
        rows: skillRows,
      })
    );
  }

  if (blocks.length === 0) {
    return buildListViewModel({
      items: [listItem(`No slash commands or skills match "/${normalizedFilter}".`)],
    });
  }

  return buildCommandResultViewModel({
    ok: true,
    title: "",
    blocks,
  });
}

export function buildToolsMenuViewModel(runtime: Runtime, filter = ""): ViewModel {
  const normalizedFilter = normalizeFilter(filter);
  const grouped = new Map<string, Array<{ name: string; description: string }>>();

  for (const tool of runtime.tools()) {
    if (!matches(normalizedFilter, tool.name, tool.description, ...tool.toolsets)) {
      continue;
    }

    for (const toolset of tool.toolsets) {
      grouped.set(toolset, [
        ...(grouped.get(toolset) ?? []),
        { name: tool.name, description: tool.description },
      ]);
    }
  }

  const blocks: ViewModel[] = [];

  for (const [toolset, rows] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    blocks.push(
      buildTableViewModel({
        title: `${toolset} tools`,
        columns: [
          { key: "name", header: "Name", alignment: "left" },
          { key: "description", header: "Description", alignment: "left" },
        ],
        rows: rows.sort((a, b) => a.name.localeCompare(b.name)),
      })
    );
  }

  if (blocks.length === 0) {
    return buildListViewModel({
      items: [listItem(`No tools match "${normalizedFilter}".`)],
    });
  }

  return buildCommandResultViewModel({
    ok: true,
    title: `Tools: ${runtime.tools().length}`,
    blocks,
  });
}

// ─────────────────────────────────────────────────────────────
// Backward-compatible string wrappers
// ─────────────────────────────────────────────────────────────

export function renderSlashMenu(runtime: Runtime, filter = ""): string {
  return renderPlain(buildSlashMenuViewModel(runtime, filter));
}

export function renderSlashCompletion(runtime: Runtime, query = "/", locale: UiLocale = "en"): string {
  return renderPlain(buildSlashCompletionViewModel(runtime, query), locale);
}

export function renderToolsMenu(runtime: Runtime, filter = ""): string {
  return renderPlain(buildToolsMenuViewModel(runtime, filter));
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function matches(filter: string, ...values: string[]): boolean {
  if (filter.length === 0) {
    return true;
  }

  return values.some((value) => value.toLowerCase().includes(filter));
}

function normalizeFilter(value: string): string {
  return value.trim().replace(/^\//u, "").toLowerCase();
}

export function completionDescription(commandName: string, locale: UiLocale): string | undefined {
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
