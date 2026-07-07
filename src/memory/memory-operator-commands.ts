import { existsSync } from "node:fs";
import type { MemoryConfig, MemoryCurationMode } from "../config/memory-config.js";
import { loadRuntimeConfig, readConfig, saveRuntimeConfig } from "../config/runtime-config.js";
import { resolveHomeDir } from "../config/home-dir.js";
import {
  defaultProfileId,
  readActiveProfile,
  resolveProfileStateHome
} from "../config/profile-home.js";
import type { MemoryPromotionRecord } from "../contracts/memory.js";
import type { MemoryCurationCheckpointResult } from "./memory-curation-service.js";
import {
  MemoryCurationStore,
  memoryCurationStorePath,
  type MemoryCurationRecord
} from "./memory-curation-store.js";
import { MemoryPersistenceService, isMemoryPersistenceDriftError } from "./memory-persistence-service.js";
import { createMemoryIndexSync } from "./memory-index-sync.js";

type MemoryOperatorRuntime = {
  sessionId: string;
  auditMemoryCuration?: (input: {
    trigger: "manual";
    sessionId?: string;
    signal?: AbortSignal;
  }) => Promise<MemoryCurationCheckpointResult | undefined>;
  inspectMemoryPromotions?: () => Promise<MemoryPromotionRecord[]>;
};

export type MemoryOperatorCommandResult = {
  ok: boolean;
  output: string;
};

export async function runMemoryOperatorCommand(input: {
  args: readonly string[];
  homeDir?: string;
  profileId?: string;
  runtime?: MemoryOperatorRuntime;
  signal?: AbortSignal;
}): Promise<MemoryOperatorCommandResult> {
  const args = [...input.args];
  const action = (args.shift() ?? "dashboard").toLowerCase();
  const homeDir = resolveHomeDir(input.homeDir);
  const profileId = input.profileId ?? readActiveProfile({ homeDir }).profileId ?? defaultProfileId();
  const context = { homeDir, profileId };

  if (action === "dashboard" || action === "status") {
    return { ok: true, output: await renderMemoryDashboard({ ...context, runtime: input.runtime }) };
  }
  if (action === "mode") {
    return await handleMemoryMode(context, args);
  }
  if (action === "recent") {
    return { ok: true, output: await renderRecentCurationRecords(context, parseLimit(args, 10)) };
  }
  if (action === "review") {
    return { ok: true, output: await renderReviewCurationRecords(context, parseLimit(args, 20)) };
  }
  if (action === "populate") {
    return await handleMemoryPopulate({
      ...context,
      runtime: input.runtime,
      signal: input.signal
    });
  }
  if (action === "edit") {
    return { ok: true, output: renderMemoryEditTargets(context) };
  }
  if (action === "clear") {
    return await handleMemoryClear(context, args);
  }
  if (action === "help" || action === "--help" || action === "-h") {
    return { ok: true, output: memoryOperatorHelp() };
  }

  return {
    ok: false,
    output: `Unknown memory action: ${action}\n\n${memoryOperatorHelp()}`
  };
}

export function memoryOperatorHelp(): string {
  return [
    "EstaCoda memory operator commands",
    "  memory mode [auto|review|manual]",
    "  memory recent [--limit N]",
    "  memory review [--limit N]",
    "  memory populate",
    "  memory edit",
    "  memory clear [USER.md|MEMORY.md|all] --yes"
  ].join("\n");
}

export function isMemoryCurationModeMutation(args: readonly string[]): boolean {
  if ((args[0] ?? "").toLowerCase() !== "mode") {
    return false;
  }
  const nextMode = args.slice(1).find((arg) => !arg.startsWith("-"));
  return nextMode !== undefined && isMemoryCurationMode(nextMode);
}

async function handleMemoryMode(
  context: { homeDir: string; profileId: string },
  args: readonly string[]
): Promise<MemoryOperatorCommandResult> {
  const nextMode = args.find((arg) => !arg.startsWith("-"));
  const config = await loadMemoryConfig(context);
  if (nextMode === undefined) {
    return {
      ok: true,
      output: [
        "Memory curation mode",
        `profileId: ${context.profileId}`,
        `mode: ${config.curation.mode}`,
        `autoApplyMaxRisk: ${config.curation.autoApplyMaxRisk}`,
        `autoApplyMinConfidence: ${config.curation.autoApplyMinConfidence}`,
        `checkpointEveryTurns: ${config.curation.checkpointEveryTurns}`,
        `autoWriteVisibility: ${config.curation.autoWriteVisibility}`
      ].join("\n")
    };
  }
  if (!isMemoryCurationMode(nextMode)) {
    return {
      ok: false,
      output: "Usage: memory mode [auto|review|manual]"
    };
  }

  const paths = resolveProfileStateHome({ homeDir: context.homeDir, profileId: context.profileId });
  const loaded = await readConfig(paths.configPath);
  const previous = config.curation.mode;
  const rawMemory = loaded.config.memory ?? {};
  loaded.config.memory = {
    ...rawMemory,
    curation: {
      ...(rawMemory.curation ?? {}),
      mode: nextMode
    }
  };
  await saveRuntimeConfig(paths.configPath, loaded.config);
  return {
    ok: true,
    output: [
      "Memory curation mode updated",
      `profileId: ${context.profileId}`,
      `previous: ${previous}`,
      `mode: ${nextMode}`,
      `path: ${paths.configPath}`,
      "activeRuntimeRefresh: required"
    ].join("\n")
  };
}

async function handleMemoryPopulate(input: {
  homeDir: string;
  profileId: string;
  runtime?: MemoryOperatorRuntime;
  signal?: AbortSignal;
}): Promise<MemoryOperatorCommandResult> {
  if (input.runtime?.auditMemoryCuration === undefined) {
    return {
      ok: false,
      output: "Memory populate requires an active runtime session. Run /memory populate inside a session or an attached channel."
    };
  }
  const result = await input.runtime.auditMemoryCuration({
    trigger: "manual",
    sessionId: input.runtime.sessionId,
    signal: input.signal
  });
  if (result === undefined) {
    return {
      ok: false,
      output: "Memory populate is not available in this runtime."
    };
  }
  return {
    ok: result.status !== "failed",
    output: renderCheckpointResult("Memory populate", result)
  };
}

async function handleMemoryClear(
  context: { homeDir: string; profileId: string },
  args: readonly string[]
): Promise<MemoryOperatorCommandResult> {
  const confirmed = args.includes("--yes");
  const target = args.find((arg) => !arg.startsWith("-")) ?? "all";
  const files = target === "all"
    ? ["USER.md", "MEMORY.md"] as const
    : target === "USER.md" || target === "MEMORY.md"
      ? [target] as const
      : undefined;

  if (files === undefined) {
    return { ok: false, output: "Usage: memory clear [USER.md|MEMORY.md|all] --yes" };
  }
  if (!confirmed) {
    return {
      ok: false,
      output: [
        "Refusing to clear durable memory without confirmation.",
        "Run: memory clear [USER.md|MEMORY.md|all] --yes",
        "SOUL.md and shared memory are never cleared by this command."
      ].join("\n")
    };
  }

  const paths = resolveProfileStateHome({ homeDir: context.homeDir, profileId: context.profileId });
  const persistence = new MemoryPersistenceService();
  const config = await loadMemoryConfig(context);
  const sync = createMemoryIndexSync({
    homeDir: context.homeDir,
    profileId: context.profileId,
    config
  });
  const lines = [
    "Memory files cleared",
    `profileId: ${context.profileId}`
  ];
  const warnings: string[] = [];
  try {
    for (const file of files) {
      const path = file === "USER.md" ? paths.userMdPath : paths.memoryMdPath;
      await persistence.readFile({ path, kind: file });
      const result = await persistence.writeFile({
        path,
        kind: file,
        content: "",
        policy: { createBackup: existsSync(path) }
      });
      try {
        const syncResult = await sync.syncMemoryFile({ file, content: "", sourcePath: path });
        if (syncResult.warning !== undefined) {
          warnings.push(syncResult.warning);
        }
      } catch (error) {
        warnings.push(`memory index sync failed for ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      lines.push(`${file}: cleared`);
      if (result.backupPath !== undefined) {
        lines.push(`${file}Backup: ${result.backupPath}`);
      }
    }
  } catch (error) {
    return {
      ok: false,
      output: isMemoryPersistenceDriftError(error)
        ? `Memory clear refused because ${error.kind} changed on disk. Re-run after reviewing ${error.path}.`
        : `Memory clear failed: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    sync.dispose();
  }
  lines.push(...warnings.map((warning) => `warning: ${warning}`));
  lines.push("Current sessions may need /new or restart to refresh loaded prompt memory.");
  return { ok: true, output: lines.join("\n") };
}

async function renderMemoryDashboard(input: {
  homeDir: string;
  profileId: string;
  runtime?: MemoryOperatorRuntime;
}): Promise<string> {
  const [config, records, promotions] = await Promise.all([
    loadMemoryConfig(input),
    loadCurationStore(input).list({ limit: 50 }),
    input.runtime?.inspectMemoryPromotions?.() ?? Promise.resolve([])
  ]);
  const pending = records.filter((record) => record.status === "pending-review").length;
  const autoApplied = records.filter((record) => record.status === "auto-applied").length;
  const failed = records.filter((record) => record.status === "failed").length;
  const latest = records[0];
  return [
    "Memory dashboard",
    `profileId: ${input.profileId}`,
    `mode: ${config.curation.mode}`,
    `checkpointEveryTurns: ${config.curation.checkpointEveryTurns}`,
    `recentAutoApplied: ${autoApplied}`,
    `pendingReview: ${pending}`,
    `failedAudits: ${failed}`,
    `promotedConclusions: ${promotions.length}`,
    latest === undefined ? "latestAudit: none" : `latestAudit: ${latest.status} ${latest.trigger} ${latest.createdAt}`,
    "",
    "Commands: memory populate, memory review, memory recent, memory mode [auto|review|manual], memory edit"
  ].join("\n");
}

async function renderRecentCurationRecords(
  context: { homeDir: string; profileId: string },
  limit: number
): Promise<string> {
  const records = await loadCurationStore(context).list({ limit });
  if (records.length === 0) {
    return "No memory curation records found.";
  }
  return [
    "Recent memory curation",
    ...records.map((record, index) => `${index + 1}. ${renderCurationRecord(record)}`)
  ].join("\n");
}

async function renderReviewCurationRecords(
  context: { homeDir: string; profileId: string },
  limit: number
): Promise<string> {
  const records = (await loadCurationStore(context).list({ limit: Math.max(limit, 50) }))
    .filter((record) => record.status === "pending-review")
    .slice(0, limit);
  if (records.length === 0) {
    return "No pending memory review records.";
  }
  return [
    "Pending memory review",
    ...records.map((record, index) => `${index + 1}. ${renderCurationRecord(record)}`),
    "Candidate diffs are intentionally not shown unless stored by a reviewed candidate queue."
  ].join("\n");
}

function renderMemoryEditTargets(context: { homeDir: string; profileId: string }): string {
  const paths = resolveProfileStateHome({ homeDir: context.homeDir, profileId: context.profileId });
  return [
    "Memory edit targets",
    `profileId: ${context.profileId}`,
    `USER.md: ${paths.userMdPath}`,
    `MEMORY.md: ${paths.memoryMdPath}`,
    "SOUL.md is protected safety/identity memory and is not part of learned memory editing.",
    "After editing, run: estacoda memory index rebuild"
  ].join("\n");
}

function renderCheckpointResult(title: string, result: MemoryCurationCheckpointResult): string {
  return [
    title,
    `status: ${result.status}`,
    `trigger: ${result.trigger}`,
    `sessionId: ${result.sessionId}`,
    `reviewedMessages: ${result.reviewedMessageCount}`,
    `extractedFacts: ${result.extractedFactCount}`,
    `candidates: ${result.candidateCount}`,
    `autoApplied: ${result.autoAppliedCount}`,
    `pendingReview: ${result.pendingReviewCount}`,
    `ignored: ${result.ignoredCount}`,
    `failed: ${result.failedCount}`,
    ...result.warnings.slice(0, 6).map((warning) => `warning: ${warning}`)
  ].join("\n");
}

function renderCurationRecord(record: MemoryCurationRecord): string {
  const operations = record.operations.length === 0
    ? "operations:0"
    : `operations:${record.operations.map((operation) => `${operation.file}:${operation.kind}`).join(",")}`;
  const sourceMessages = record.sourceMessageCount === undefined
    ? "sourceMessages:unknown"
    : `sourceMessages:${record.sourceMessageCount}`;
  return [
    record.id,
    `[${record.status}]`,
    `trigger:${record.trigger}`,
    sourceMessages,
    `facts:${record.extractedFactIds.length}`,
    operations,
    `reason:${record.reason}`,
    `at:${record.createdAt}`
  ].join(" ");
}

async function loadMemoryConfig(context: { homeDir: string; profileId: string }): Promise<MemoryConfig> {
  const loaded = await loadRuntimeConfig({
    workspaceRoot: context.homeDir,
    homeDir: context.homeDir,
    profileId: context.profileId
  });
  return loaded.memory;
}

function loadCurationStore(context: { homeDir: string; profileId: string }): MemoryCurationStore {
  const paths = resolveProfileStateHome({ homeDir: context.homeDir, profileId: context.profileId });
  return new MemoryCurationStore({ path: memoryCurationStorePath(paths.profileRoot) });
}

function parseLimit(args: readonly string[], fallback: number): number {
  const flagIndex = args.findIndex((arg) => arg === "--limit");
  const flagValue = flagIndex === -1 ? undefined : args[flagIndex + 1];
  const inline = args.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length);
  const parsed = Number.parseInt(inline ?? flagValue ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(100, Math.max(1, Math.trunc(parsed)));
}

function isMemoryCurationMode(value: string): value is MemoryCurationMode {
  return value === "auto" || value === "review" || value === "manual";
}
