import { join, relative } from "node:path";
import { homedir } from "node:os";
import type { CliCommandResult, CliOptions } from "./cli.js";
import { MemoryStore } from "../memory/memory-store.js";
import { MemoryPromotionStore } from "../memory/memory-promotion-store.js";
import { MemoryInspector } from "../memory/memory-inspector.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";
import { loadIdentityContext } from "../memory/identity-loader.js";
import { listSharedMemory, type SharedMemoryEntry } from "../memory/shared-memory.js";
import { KnowledgeCache } from "../knowledge/knowledge-cache.js";
import { forwardDeps, reverseDeps, affectedFiles, graphSummary } from "../knowledge/code-dependency-graph.js";

export async function knowledge(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand, ...restArgs] = args;

  switch (subcommand) {
    case "memory":
      return knowledgeMemory(options, restArgs);
    case "code":
      return knowledgeCode(options, restArgs);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return {
        handled: true,
        exitCode: 0,
        output: knowledgeHelp()
      };
    default:
      return {
        handled: true,
        exitCode: 1,
        output: `Unknown knowledge subcommand: ${subcommand}\n\n${knowledgeHelp()}`
      };
  }
}

function knowledgeHelp(): string {
  return [
    "EstaCoda knowledge commands",
    "  estacoda knowledge memory list [--active-only] [--kind preference|fact] [--limit N]",
    "  estacoda knowledge memory inspect <id>",
    "  estacoda knowledge memory deactivate <id>",
    "",
    "  estacoda knowledge code deps <file-path>",
    "  estacoda knowledge code rdeps <file-path>",
    "  estacoda knowledge code affected <file-path>",
    "  estacoda knowledge code summary",
    "  estacoda knowledge code refresh"
  ].join("\n");
}

async function knowledgeMemory(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [action, ...actionArgs] = args;

  const inspector = await openMemoryInspector(options);

  if (inspector === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Memory inspector is not available. Ensure the workspace has a valid memory configuration."
    };
  }

  switch (action) {
    case "list":
      return memoryList(inspector, actionArgs);
    case "inspect":
      return memoryInspect(inspector, actionArgs);
    case "deactivate":
      return memoryDeactivate(inspector, actionArgs);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return {
        handled: true,
        exitCode: 0,
        output: knowledgeMemoryHelp()
      };
    default:
      return {
        handled: true,
        exitCode: 1,
        output: `Unknown knowledge memory action: ${action}\n\n${knowledgeMemoryHelp()}`
      };
  }
}

function knowledgeMemoryHelp(): string {
  return [
    "EstaCoda knowledge memory commands",
    "  estacoda knowledge memory list [--active-only] [--kind preference|fact] [--limit N]",
    "  estacoda knowledge memory inspect <id>",
    "  estacoda knowledge memory deactivate <id>"
  ].join("\n");
}

async function memoryList(
  inspector: MemoryInspector,
  args: string[]
): Promise<CliCommandResult> {
  const activeOnly = hasFlag(args, "--active-only");
  const kind = parseKind(valueAfter(args, "--kind"));
  const limit = parseLimit(valueAfter(args, "--limit"));

  const records = await inspector.list({ activeOnly, kind, limit });

  if (records.length === 0) {
    return {
      handled: true,
      exitCode: 0,
      output: "No memory promotions found."
    };
  }

  const lines = records.map((record) => {
    const status = record.active ? "active" : "inactive";
    const provenance = record.sourceTrajectoryId !== undefined ? "provenanced" : "legacy";
    const truncated = record.content.length > 80
      ? `${record.content.slice(0, 80)}...`
      : record.content;
    return `${record.id} | ${record.kind} | ${status} | ${provenance} | ${truncated}`;
  });

  return {
    handled: true,
    exitCode: 0,
    output: ["ID | Kind | Status | Provenance | Content", "-".repeat(60), ...lines].join("\n")
  };
}

async function memoryInspect(
  inspector: MemoryInspector,
  args: string[]
): Promise<CliCommandResult> {
  const id = args[0];

  if (id === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Usage: estacoda knowledge memory inspect <id>"
    };
  }

  const record = await inspector.inspect(id);

  if (record === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: `No promotion record found with id: ${id}`
    };
  }

  const lines = [
    `ID: ${record.id}`,
    `Kind: ${record.kind}`,
    `Active: ${record.active}`,
    `Content: ${record.content}`,
    `Confidence: ${record.confidence}`,
    `Occurrences: ${record.occurrences}`,
    `Source: ${record.source}`,
    `Source sessions: ${record.sourceSessionIds.join(", ") || "none"}`,
    `Created at: ${record.createdAt ?? "unknown (legacy)"}`,
    `Updated at: ${record.updatedAt}`,
    `Source trajectory: ${record.sourceTrajectoryId ?? "none (legacy)"}`,
    `Source event: ${record.sourceEventId ?? "none (legacy)"}`,
    record.supersededBy === undefined ? undefined : `Superseded by: ${record.supersededBy}`,
    record.forgottenAt === undefined ? undefined : `Forgotten at: ${record.forgottenAt} (${record.forgottenReason ?? ""})`
  ].filter((line) => line !== undefined);

  return {
    handled: true,
    exitCode: 0,
    output: lines.join("\n")
  };
}

async function memoryDeactivate(
  inspector: MemoryInspector,
  args: string[]
): Promise<CliCommandResult> {
  const id = args[0];

  if (id === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Usage: estacoda knowledge memory deactivate <id>"
    };
  }

  const result = await inspector.deactivate(id);

  if (!result.ok) {
    return {
      handled: true,
      exitCode: 1,
      output: `Failed to deactivate: ${result.reason}`
    };
  }

  return {
    handled: true,
    exitCode: 0,
    output: `Deactivated ${result.record.id}. File removed: ${result.fileRemoved ? "yes" : "no (suppressed by renderer)"}`
  };
}

async function openMemoryInspector(options: CliOptions): Promise<MemoryInspector | undefined> {
  const homeDir = options.homeDir ?? process.env.HOME ?? homedir();
  const profileId = readActiveProfile({ homeDir }).profileId ?? defaultProfileId();
  const profilePaths = resolveProfileStateHome({ homeDir, profileId });
  const identityContext = await loadIdentityContext({ profilePaths });
  const sharedMemoryContent = renderSharedMemory(await listSharedMemory({ homeDir }));

  const memoryStore = new MemoryStore();
  if (sharedMemoryContent !== undefined) {
    memoryStore.write("SHARED.md", sharedMemoryContent);
  }
  if (identityContext.user !== undefined) {
    memoryStore.write("USER.md", identityContext.user);
  }
  if (identityContext.soul !== undefined) {
    memoryStore.write("SOUL.md", identityContext.soul);
  }
  if (identityContext.memory !== undefined) {
    memoryStore.write("MEMORY.md", identityContext.memory);
  }

  const promotionStore = new MemoryPromotionStore({ path: profilePaths.promotionsPath });

  return new MemoryInspector({
    promotionStore,
    memoryStore
  });
}

function renderSharedMemory(entries: SharedMemoryEntry[]): string | undefined {
  const sections = entries
    .filter((entry) => entry.content.trim().length > 0)
    .map((entry) => `## ${entry.key}\n${entry.content.trim()}`);

  return sections.length === 0 ? undefined : sections.join("\n\n");
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return flags.some((flag) => args.includes(flag));
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 || index + 1 >= args.length ? undefined : args[index + 1];
}

function parseKind(value: string | undefined): "user-preference" | "project-fact" | undefined {
  if (value === "preference") {
    return "user-preference";
  }
  if (value === "fact") {
    return "project-fact";
  }
  return undefined;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

async function knowledgeCode(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [action, ...actionArgs] = args;

  switch (action) {
    case "deps":
      return codeDeps(options, actionArgs);
    case "rdeps":
      return codeRdeps(options, actionArgs);
    case "affected":
      return codeAffected(options, actionArgs);
    case "summary":
      return codeSummary(options);
    case "refresh":
      return codeRefresh(options);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return {
        handled: true,
        exitCode: 0,
        output: knowledgeCodeHelp()
      };
    default:
      return {
        handled: true,
        exitCode: 1,
        output: `Unknown knowledge code action: ${action}\n\n${knowledgeCodeHelp()}`
      };
  }
}

function knowledgeCodeHelp(): string {
  return [
    "EstaCoda knowledge code commands",
    "  estacoda knowledge code deps <file-path>      # forward dependencies",
    "  estacoda knowledge code rdeps <file-path>     # reverse dependencies",
    "  estacoda knowledge code affected <file-path>  # transitive affected files",
    "  estacoda knowledge code summary               # graph summary",
    "  estacoda knowledge code refresh               # force regeneration"
  ].join("\n");
}

async function openKnowledgeCache(options: CliOptions): Promise<KnowledgeCache> {
  return new KnowledgeCache({ workspaceRoot: options.workspaceRoot });
}

function resolveModuleId(workspaceRoot: string, filePath: string): string {
  // If already relative from workspace root, use as-is
  if (!filePath.startsWith("/")) {
    return filePath;
  }
  return relative(workspaceRoot, filePath);
}

async function codeDeps(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const filePath = args[0];
  if (filePath === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda knowledge code deps <file-path>" };
  }
  const cache = await openKnowledgeCache(options);
  const graph = await cache.getGraph();
  const moduleId = resolveModuleId(options.workspaceRoot, filePath);
  const deps = forwardDeps(graph, moduleId);

  if (deps.length === 0) {
    return { handled: true, exitCode: 0, output: `No forward dependencies for ${moduleId}` };
  }

  const lines = deps.map((dep) => `  ${dep}`);
  return { handled: true, exitCode: 0, output: [`Forward dependencies for ${moduleId}:`, ...lines].join("\n") };
}

async function codeRdeps(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const filePath = args[0];
  if (filePath === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda knowledge code rdeps <file-path>" };
  }
  const cache = await openKnowledgeCache(options);
  const graph = await cache.getGraph();
  const moduleId = resolveModuleId(options.workspaceRoot, filePath);
  const rdeps = reverseDeps(graph, moduleId);

  if (rdeps.length === 0) {
    return { handled: true, exitCode: 0, output: `No reverse dependencies for ${moduleId}` };
  }

  const lines = rdeps.map((dep) => `  ${dep}`);
  return { handled: true, exitCode: 0, output: [`Reverse dependencies for ${moduleId}:`, ...lines].join("\n") };
}

async function codeAffected(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const filePath = args[0];
  if (filePath === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda knowledge code affected <file-path>" };
  }
  const cache = await openKnowledgeCache(options);
  const graph = await cache.getGraph();
  const moduleId = resolveModuleId(options.workspaceRoot, filePath);
  const affected = affectedFiles(graph, moduleId);

  if (affected.length === 0) {
    return { handled: true, exitCode: 0, output: `No affected files for ${moduleId}` };
  }

  const lines = affected.map((dep) => `  ${dep}`);
  return { handled: true, exitCode: 0, output: [`Affected files for ${moduleId}:`, ...lines].join("\n") };
}

async function codeSummary(options: CliOptions): Promise<CliCommandResult> {
  const cache = await openKnowledgeCache(options);
  const graph = await cache.getGraph();
  const summary = graphSummary(graph);

  const lines = [
    `Nodes: ${summary.nodeCount}`,
    `Edges: ${summary.edgeCount}`,
    `Isolated files: ${summary.isolatedFiles.length}`,
    `Highly connected: ${summary.highlyConnected.length}`,
    `External dependencies: ${summary.externalDependencies.length}`,
    ...(summary.externalDependencies.length > 0 ? ["  " + summary.externalDependencies.join(", ")] : [])
  ];

  return { handled: true, exitCode: 0, output: lines.join("\n") };
}

async function codeRefresh(options: CliOptions): Promise<CliCommandResult> {
  const cache = await openKnowledgeCache(options);
  await cache.invalidate();
  const graph = await cache.getGraph({ forceRefresh: true });
  return {
    handled: true,
    exitCode: 0,
    output: `Dependency graph refreshed. ${graph.nodes.size} nodes, ${graph.edges.length} edges. Generated at ${graph.generatedAt}`
  };
}
