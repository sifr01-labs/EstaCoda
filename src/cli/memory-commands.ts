import { existsSync } from "node:fs";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { defaultProfileId, readActiveProfile } from "../config/profile-home.js";
import type { CliCommandResult, CliOptions } from "./cli.js";
import { MemoryIndex } from "../memory/memory-index.js";
import { MemoryIndexStore, resolveMemoryIndexStorePath } from "../memory/memory-index-store.js";
import { createMemoryIndexSync, type MemoryIndexSyncDiagnostics } from "../memory/memory-index-sync.js";
import {
  LocalMemoryRetrievalService,
  type LocalMemoryReadResult,
  type LocalMemoryRetrievalDiagnostics,
  type LocalMemoryRetrievalResult,
  type LocalMemorySearchResult
} from "../memory/memory-retrieval-service.js";
import { validateSharedMemoryKey } from "../memory/shared-memory.js";
import type { MemoryConfig } from "../config/memory-config.js";
import type { MemoryIndexedSourceType } from "../contracts/memory.js";
import { memoryOperatorHelp, runMemoryOperatorCommand } from "../memory/memory-operator-commands.js";

export async function memoryCommand(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  if (hasFlag(args, "--help", "-h") || args.length === 0) {
    return {
      handled: true,
      exitCode: 0,
      output: memoryHelp()
    };
  }

  const [action, ...actionArgs] = args;
  if (action === "index") {
    return memoryIndexCommand(options, actionArgs);
  }
  if (action === "search") {
    return memorySearchCommand(options, actionArgs);
  }
  if (action === "read") {
    return memoryReadCommand(options, actionArgs);
  }
  if (
    action === "mode" ||
    action === "recent" ||
    action === "review" ||
    action === "populate" ||
    action === "edit" ||
    action === "clear" ||
    action === "dashboard" ||
    action === "status"
  ) {
    const result = await runMemoryOperatorCommand({
      args,
      homeDir: options.homeDir,
      profileId: resolveCliProfileId(options),
      runtime: options.runtime
    });
    return {
      handled: true,
      exitCode: result.ok ? 0 : 1,
      output: result.output
    };
  }

  return {
    handled: true,
    exitCode: 1,
    output: `Unknown memory action: ${action}\n\n${memoryHelp()}`
  };
}

async function memoryIndexCommand(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [action] = args;
  const profileId = resolveCliProfileId(options);
  const path = resolveMemoryIndexStorePath({
    homeDir: options.homeDir,
    profileId
  });

  if (action === "path") {
    return {
      handled: true,
      exitCode: 0,
      output: [
        "Local memory index path",
        `profileId: ${profileId}`,
        `path: ${path}`,
        "authority: rebuildable mirror; authoritative memory files remain separate"
      ].join("\n")
    };
  }

  if (action !== "status" && action !== "rebuild") {
    return {
      handled: true,
      exitCode: 1,
      output: `Usage: estacoda memory index status|rebuild|path`
    };
  }

  const config = await loadMemoryConfig(options);
  const sync = createMemoryIndexSync({
    homeDir: options.homeDir,
    profileId,
    config
  });
  try {
    if (action === "status") {
      return {
        handled: true,
        exitCode: 0,
        output: renderIndexStatus({
          profileId,
          config,
          syncDiagnostics: sync.diagnostics()
        })
      };
    }

    const result = await sync.rebuild();
    return {
      handled: true,
      exitCode: 0,
      output: [
        "Local memory index rebuild",
        `profileId: ${profileId}`,
        `path: ${result.diagnostics.path}`,
        `indexedEntries: ${result.indexedEntries}`,
        `protectedEntries: ${result.diagnostics.protectedEntries}`,
        `lastRebuildAt: ${result.diagnostics.lastRebuildAt ?? "none"}`,
        `ftsHealthy: ${result.diagnostics.ftsHealthy}`,
        "authority: rebuilt from authoritative memory files; no authoritative memory files were deleted",
        renderSyncDiagnostics(result.diagnostics)
      ].filter((line) => line.length > 0).join("\n")
    };
  } finally {
    sync.dispose();
  }
}

async function memorySearchCommand(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const parsed = parseRetrievalFlags(args);
  const query = parsed.positionals.join(" ").trim();
  if (query.length === 0) {
    return {
      handled: true,
      exitCode: 1,
      output: "Usage: estacoda memory search <query> [--include-protected] [--max-results N] [--max-chars N]"
    };
  }

  const context = await createRetrievalContext(options);
  try {
    const result = await context.service.search({
      profileId: context.profileId,
      query,
      includeProtected: parsed.includeProtected,
      maxResults: parsed.maxResults,
      maxChars: parsed.maxChars
    });
    return {
      handled: true,
      exitCode: 0,
      output: renderSearchResult(query, result)
    };
  } finally {
    context.dispose();
  }
}

async function memoryReadCommand(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const parsed = parseRetrievalFlags(args);
  const [source, sharedKey] = parsed.positionals;
  if (source === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Usage: estacoda memory read <USER.md|MEMORY.md|SOUL.md|shared> [key] [--include-protected] [--max-chars N]"
    };
  }

  const sourceInput = parseReadSource(source, parsed.key ?? sharedKey);
  if (!sourceInput.ok) {
    return {
      handled: true,
      exitCode: 1,
      output: sourceInput.error
    };
  }

  const context = await createRetrievalContext(options);
  try {
    const result = await context.service.read({
      profileId: context.profileId,
      sourceType: sourceInput.sourceType,
      sourceId: sourceInput.sourceId,
      includeProtected: parsed.includeProtected,
      maxChars: parsed.maxChars
    });
    return {
      handled: true,
      exitCode: result.result === null ? 1 : 0,
      output: renderReadResult(sourceInput.label, result)
    };
  } finally {
    context.dispose();
  }
}

async function createRetrievalContext(options: CliOptions): Promise<{
  profileId: string;
  service: LocalMemoryRetrievalService;
  dispose(): void;
}> {
  const profileId = resolveCliProfileId(options);
  const config = await loadMemoryConfig(options);
  const path = resolveMemoryIndexStorePath({
    homeDir: options.homeDir,
    profileId
  });
  if (!config.index.enabled || !existsSync(path)) {
    return {
      profileId,
      service: new LocalMemoryRetrievalService({
        config,
        homeDir: options.homeDir
      }),
      dispose: () => {}
    };
  }

  const store = new MemoryIndexStore({ path });
  const index = new MemoryIndex({ store });
  return {
    profileId,
    service: new LocalMemoryRetrievalService({
      index,
      config,
      homeDir: options.homeDir
    }),
    dispose: () => store.dispose()
  };
}

async function loadMemoryConfig(options: CliOptions): Promise<MemoryConfig> {
  const loaded = await loadRuntimeConfig({
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir,
    profileId: resolveCliProfileId(options)
  });
  return loaded.memory;
}

function renderIndexStatus(input: {
  profileId: string;
  config: MemoryConfig;
  syncDiagnostics: MemoryIndexSyncDiagnostics;
}): string {
  return [
    "Local memory index status",
    `profileId: ${input.profileId}`,
    `enabled: ${input.syncDiagnostics.enabled}`,
    `path: ${input.syncDiagnostics.path}`,
    `backfillOnStartup: ${input.config.index.backfillOnStartup}`,
    `indexedEntries: ${input.syncDiagnostics.indexedEntries}`,
    `indexedProfiles: ${input.syncDiagnostics.indexedProfiles}`,
    `staleEntries: ${input.syncDiagnostics.staleEntries}`,
    `protectedEntries: ${input.syncDiagnostics.protectedEntries}`,
    `lastBackfillAt: ${input.syncDiagnostics.lastBackfillAt ?? "none"}`,
    `lastRebuildAt: ${input.syncDiagnostics.lastRebuildAt ?? "none"}`,
    `ftsHealthy: ${input.syncDiagnostics.ftsHealthy}`,
    `pendingRebuildReason: ${input.syncDiagnostics.pendingRebuildReason ?? "none"}`,
    `missingIndexFile: ${input.syncDiagnostics.missingIndexFile}`,
    renderSyncDiagnostics(input.syncDiagnostics)
  ].filter((line) => line.length > 0).join("\n");
}

function renderReadResult(source: string, result: LocalMemoryReadResult): string {
  const lines = [
    "Local memory read",
    `source: ${source}`,
    "contextLabel: local-memory-context",
    "instructionBoundary: context-not-instruction",
    `ok: ${result.result !== null}`
  ];
  if (result.result !== null) {
    lines.push(...renderRetrievalMetadata(result.result));
    lines.push("content:");
    lines.push(indent(result.result.content));
  }
  lines.push(renderRetrievalDiagnostics(result.diagnostics));
  return lines.filter((line) => line.length > 0).join("\n");
}

function renderSearchResult(query: string, result: LocalMemorySearchResult): string {
  const lines = [
    "Local memory search",
    `query: ${query}`,
    "contextLabel: local-memory-context",
    "instructionBoundary: context-not-instruction",
    `results: ${result.results.length}`
  ];
  if (result.results.length === 0) {
    lines.push("No local memory results.");
  }
  result.results.forEach((entry, index) => {
    lines.push(`result ${index + 1}:`);
    lines.push(indent(renderRetrievalMetadata(entry).join("\n")));
    lines.push(indent("content:"));
    lines.push(indent(indent(entry.content)));
  });
  lines.push(renderRetrievalDiagnostics(result.diagnostics));
  return lines.filter((line) => line.length > 0).join("\n");
}

function renderRetrievalMetadata(result: LocalMemoryRetrievalResult): string[] {
  return [
    `source: ${result.source}`,
    `sourceType: ${result.sourceType}`,
    result.sourceKey === undefined ? undefined : `sourceKey: ${result.sourceKey}`,
    result.memoryFileKind === undefined ? undefined : `memoryFileKind: ${result.memoryFileKind}`,
    `authority: ${result.authority}`,
    `protectedClass: ${result.protectedClass}`,
    `trusted: ${result.trusted}`
  ].filter((line): line is string => line !== undefined);
}

function renderRetrievalDiagnostics(diagnostics: LocalMemoryRetrievalDiagnostics): string {
  return [
    "diagnostics:",
    `  mode: ${diagnostics.mode}`,
    `  profileId: ${diagnostics.profileId}`,
    `  indexEnabled: ${diagnostics.indexEnabled}`,
    `  indexAvailable: ${diagnostics.indexAvailable}`,
    `  fallbackUsed: ${diagnostics.fallbackUsed}`,
    `  includeProtected: ${diagnostics.includeProtected}`,
    `  resultCount: ${diagnostics.resultCount}`,
    `  truncated: ${diagnostics.truncated}`,
    `  redactionApplied: ${diagnostics.redactionApplied}`,
    ...diagnostics.diagnostics.map((diagnostic) =>
      `  - ${diagnostic.code}: ${diagnostic.message}`
    )
  ].join("\n");
}

function renderSyncDiagnostics(diagnostics: MemoryIndexSyncDiagnostics): string {
  if (diagnostics.diagnostics.length === 0 && diagnostics.warnings.length === 0) {
    return "";
  }
  return [
    "diagnostics:",
    ...diagnostics.diagnostics.map((diagnostic) => `  - ${diagnostic.code}: ${diagnostic.message}`),
    ...diagnostics.warnings.map((warning) => `  - warning: ${warning}`)
  ].join("\n");
}

function parseReadSource(source: string, key: string | undefined): (
  | { ok: true; sourceType: MemoryIndexedSourceType; sourceId: string; label: string }
  | { ok: false; error: string }
) {
  if (source === "USER.md" || source === "MEMORY.md" || source === "SOUL.md") {
    return {
      ok: true,
      sourceType: "memory_file",
      sourceId: source,
      label: source
    };
  }
  if (source === "shared") {
    const sourceKey = key?.trim();
    if (sourceKey === undefined || sourceKey.length === 0) {
      return { ok: false, error: "Usage: estacoda memory read shared <key>" };
    }
    try {
      validateSharedMemoryKey(sourceKey);
    } catch {
      return { ok: false, error: "Shared memory key is invalid." };
    }
    return {
      ok: true,
      sourceType: "shared_memory",
      sourceId: sourceKey,
      label: `shared:${sourceKey}`
    };
  }
  return {
    ok: false,
    error: "Source must be USER.md, MEMORY.md, SOUL.md, or shared."
  };
}

function parseRetrievalFlags(args: string[]): {
  positionals: string[];
  includeProtected: boolean;
  maxResults?: number;
  maxChars?: number;
  key?: string;
} {
  const positionals: string[] = [];
  let includeProtected = false;
  let maxResults: number | undefined;
  let maxChars: number | undefined;
  let key: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--include-protected") {
      includeProtected = true;
      continue;
    }
    if (arg === "--max-results") {
      maxResults = parseOptionalInteger(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-results=")) {
      maxResults = parseOptionalInteger(arg.slice("--max-results=".length));
      continue;
    }
    if (arg === "--max-chars") {
      maxChars = parseOptionalInteger(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-chars=")) {
      maxChars = parseOptionalInteger(arg.slice("--max-chars=".length));
      continue;
    }
    if (arg === "--key") {
      key = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--key=")) {
      key = arg.slice("--key=".length);
      continue;
    }
    positionals.push(arg);
  }
  return {
    positionals,
    includeProtected,
    maxResults,
    maxChars,
    key
  };
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveCliProfileId(options: CliOptions): string {
  return options.profileId ?? readActiveProfile({ homeDir: options.homeDir })?.profileId ?? defaultProfileId();
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg));
}

function indent(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}

function memoryHelp(): string {
  return [
    "EstaCoda memory commands",
    "  estacoda memory index path",
    "  estacoda memory index status",
    "  estacoda memory index rebuild",
    "  estacoda memory search <query> [--include-protected] [--max-results N] [--max-chars N]",
    "  estacoda memory read <USER.md|MEMORY.md|SOUL.md|shared> [key] [--include-protected] [--max-chars N]",
    "",
    memoryOperatorHelp().replace(/^EstaCoda memory operator commands\n/u, "Memory curation controls\n")
  ].join("\n");
}
