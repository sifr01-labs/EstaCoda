import { existsSync } from "node:fs";
import type { MemoryConfig, MemoryCurationMode } from "../config/memory-config.js";
import { loadRuntimeConfig, readConfig, saveRuntimeConfig } from "../config/runtime-config.js";
import { resolveHomeDir } from "../config/home-dir.js";
import {
  defaultProfileId,
  readActiveProfile,
  resolveProfileStateHome
} from "../config/profile-home.js";
import type { MemoryFileKind, MemoryOperation, MemoryPromotionRecord } from "../contracts/memory.js";
import { truncate } from "../utils/formatting.js";
import { redactSensitiveText } from "../utils/redaction.js";
import type { MemoryCurationCheckpointResult } from "./memory-curation-service.js";
import {
  MemoryCurationStore,
  type MemoryCurationCandidateRecord,
  type MemoryCurationStatus,
  memoryCurationStorePath,
  type MemoryCurationRecord,
  type StoredMemoryOperation,
  summarizeMemoryOperation
} from "./memory-curation-store.js";
import { MemoryPersistenceService, isMemoryPersistenceDriftError } from "./memory-persistence-service.js";
import { createMemoryIndexSync } from "./memory-index-sync.js";
import { MemoryStore } from "./memory-store.js";
import { MemoryMutationService } from "./memory-mutation-service.js";

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
  if (action === "apply") {
    return await handleMemoryApply(context, args);
  }
  if (action === "reject") {
    return await handleMemoryReject(context, args);
  }
  if (action === "undo") {
    return await handleMemoryUndo(context, args);
  }
  if (action === "forget") {
    return await handleMemoryForget(context, args);
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
    "  memory apply <record-id> [candidate-id|all]",
    "  memory reject <record-id> [candidate-id|all]",
    "  memory undo <record-id>",
    "  memory forget <USER.md|MEMORY.md> <exact text>",
    "  memory populate",
    "  memory edit",
    "  memory clear [USER.md|MEMORY.md|all] --yes"
  ].join("\n");
}

async function handleMemoryApply(
  context: { homeDir: string; profileId: string },
  args: readonly string[]
): Promise<MemoryOperatorCommandResult> {
  const recordId = args.find((arg) => !arg.startsWith("-"));
  const candidateSelector = args.slice(1).find((arg) => !arg.startsWith("-")) ?? "all";
  if (recordId === undefined) {
    return { ok: false, output: "Usage: memory apply <record-id> [candidate-id|all]" };
  }
  const store = loadCurationStore(context);
  const record = await store.get(recordId);
  if (record === undefined) {
    return { ok: false, output: `Memory curation record not found: ${recordId}` };
  }
  const candidates = selectPendingCandidates(record, candidateSelector);
  if (candidates.length === 0) {
    return { ok: false, output: `No pending applyable memory candidates found for ${recordId}.` };
  }
  const missingOperation = candidates.find((candidate) => candidate.operation === undefined);
  if (missingOperation !== undefined) {
    return { ok: false, output: `Candidate ${missingOperation.id} does not store an applyable operation.` };
  }

  const operations = candidates.map((candidate) => toMemoryOperation(candidate.operation!));
  const mutation = await createOperatorMutationContext(context, record.sessionId);
  const applied: MemoryCurationCandidateRecord[] = [];
  const warnings: string[] = [];
  try {
    const preflightStore = cloneMemoryStore(mutation.memoryStore);
    try {
      for (const operation of operations) {
        preflightStore.apply(operation);
      }
    } catch (error) {
      return {
        ok: false,
        output: `Memory apply failed before writing: ${formatOperatorError(error)}`
      };
    }

    for (const [index, candidate] of candidates.entries()) {
      const result = await mutation.service.apply(operations[index], { source: "memory.operator" });
      if (!result.ok) {
        if (applied.length > 0) {
          await markAppliedReviewCandidates({
            store,
            recordId: record.id,
            applied,
            operations: operations.slice(0, applied.length),
            reason: `operator applied ${applied.length} memory candidate${applied.length === 1 ? "" : "s"} before failure`
          });
        }
        return { ok: false, output: `Memory apply failed for ${candidate.id}: ${result.message}` };
      }
      applied.push(candidate);
      warnings.push(...result.warnings);
    }
  } finally {
    mutation.sync.dispose();
  }

  await markAppliedReviewCandidates({
    store,
    recordId: record.id,
    applied,
    operations,
    reason: `operator applied ${applied.length} memory candidate${applied.length === 1 ? "" : "s"}`
  });

  return {
    ok: true,
    output: [
      "Memory review candidates applied",
      `recordId: ${record.id}`,
      `applied: ${applied.map((candidate) => candidate.id).join(",")}`,
      ...warnings.map((warning) => `warning: ${warning}`)
    ].join("\n")
  };
}

async function handleMemoryReject(
  context: { homeDir: string; profileId: string },
  args: readonly string[]
): Promise<MemoryOperatorCommandResult> {
  const recordId = args.find((arg) => !arg.startsWith("-"));
  const candidateSelector = args.slice(1).find((arg) => !arg.startsWith("-")) ?? "all";
  if (recordId === undefined) {
    return { ok: false, output: "Usage: memory reject <record-id> [candidate-id|all]" };
  }
  const store = loadCurationStore(context);
  const record = await store.get(recordId);
  if (record === undefined) {
    return { ok: false, output: `Memory curation record not found: ${recordId}` };
  }
  const candidates = selectPendingCandidates(record, candidateSelector);
  if (candidates.length === 0) {
    return { ok: false, output: `No pending memory candidates found for ${recordId}.` };
  }
  await store.update(record.id, (current) => {
    const rejectedIds = new Set(candidates.map((candidate) => candidate.id));
    const nextCandidates = (current.candidates ?? []).map((candidate) => rejectedIds.has(candidate.id)
      ? { ...candidate, reviewStatus: "rejected" as const }
      : candidate);
    return {
      ...current,
      status: statusForReviewCandidates(nextCandidates),
      candidates: nextCandidates,
      reason: `operator rejected ${candidates.length} memory candidate${candidates.length === 1 ? "" : "s"}`
    };
  });
  return {
    ok: true,
    output: [
      "Memory review candidates rejected",
      `recordId: ${record.id}`,
      `rejected: ${candidates.map((candidate) => candidate.id).join(",")}`
    ].join("\n")
  };
}

async function handleMemoryUndo(
  context: { homeDir: string; profileId: string },
  args: readonly string[]
): Promise<MemoryOperatorCommandResult> {
  const recordId = args.find((arg) => !arg.startsWith("-"));
  if (recordId === undefined) {
    return { ok: false, output: "Usage: memory undo <record-id>" };
  }
  const store = loadCurationStore(context);
  const record = await store.get(recordId);
  if (record === undefined) {
    return { ok: false, output: `Memory curation record not found: ${recordId}` };
  }
  if (record.status === "undone") {
    return { ok: false, output: `Memory curation record is already undone: ${recordId}` };
  }
  const operations = record.operations.flatMap((operation) => operation.operation === undefined ? [] : [operation.operation]);
  if (operations.length === 0) {
    return { ok: false, output: `Memory curation record has no reversible operations: ${recordId}` };
  }
  const mutation = await createOperatorMutationContext(context, record.sessionId);
  const warnings: string[] = [];
  try {
    for (const operation of [...operations].reverse()) {
      const result = await mutation.service.apply(invertMemoryOperation(operation), { source: "memory.operator" });
      if (!result.ok) {
        return { ok: false, output: `Memory undo failed for ${recordId}: ${result.message}` };
      }
      warnings.push(...result.warnings);
    }
  } finally {
    mutation.sync.dispose();
  }
  await store.update(record.id, (current) => ({
    ...current,
    status: "undone",
    reason: "operator undid applied memory operations"
  }));
  return {
    ok: true,
    output: [
      "Memory curation record undone",
      `recordId: ${record.id}`,
      `operations: ${operations.length}`,
      ...warnings.map((warning) => `warning: ${warning}`)
    ].join("\n")
  };
}

async function handleMemoryForget(
  context: { homeDir: string; profileId: string },
  args: readonly string[]
): Promise<MemoryOperatorCommandResult> {
  const file = args[0];
  const match = args.slice(1).join(" ").trim();
  if ((file !== "USER.md" && file !== "MEMORY.md") || match.length === 0) {
    return { ok: false, output: "Usage: memory forget <USER.md|MEMORY.md> <exact text>" };
  }
  const operation: MemoryOperation = {
    kind: "remove",
    file,
    match
  };
  const mutation = await createOperatorMutationContext(context, undefined);
  try {
    const result = await mutation.service.apply(operation, { source: "memory.operator" });
    if (!result.ok) {
      return { ok: false, output: `Memory forget failed: ${result.message}` };
    }
    await loadCurationStore(context).append({
      profileId: context.profileId,
      sessionId: "operator",
      trigger: "manual",
      status: "applied",
      extractedFactIds: [],
      operations: [summarizeMemoryOperation(operation)],
      candidates: [],
      reason: "operator removed exact memory text"
    });
    return {
      ok: true,
      output: [
        "Memory text forgotten",
        `file: ${file}`,
        ...result.warnings.map((warning) => `warning: ${warning}`)
      ].join("\n")
    };
  } finally {
    mutation.sync.dispose();
  }
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
    "Commands: memory populate, memory review, memory apply, memory reject, memory undo, memory forget, memory recent, memory mode [auto|review|manual], memory edit, memory clear"
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
    ...records.flatMap((record, index) => [
      `${index + 1}. ${renderCurationRecord(record)}`,
      ...renderReviewCandidates(record).map((line) => `   ${line}`)
    ]),
    "Run: memory apply <record-id> [candidate-id|all]",
    "Run: memory reject <record-id> [candidate-id|all]"
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

function renderReviewCandidates(record: MemoryCurationRecord): string[] {
  const candidates = (record.candidates ?? []).filter((candidate) => candidate.reviewStatus === "pending");
  if (candidates.length === 0) {
    return ["pendingCandidates: none"];
  }
  return candidates.map((candidate) => [
    `candidate:${candidate.id}`,
    `status:${candidate.reviewStatus}`,
    `target:${candidate.target}`,
    `risk:${candidate.risk}`,
    `operation:${candidate.operation?.kind ?? "not-stored"}`,
    `reason:${candidate.reason}`,
    candidate.operation === undefined ? undefined : `preview:${renderStoredOperationPreview(candidate.operation)}`
  ].filter((part): part is string => part !== undefined).join(" "));
}

function renderStoredOperationPreview(operation: StoredMemoryOperation): string {
  if (operation.kind === "append") {
    return truncate(redactSensitiveText(operation.content.replace(/\s+/gu, " ")), 160);
  }
  if (operation.kind === "replace") {
    return truncate(redactSensitiveText(operation.replacement.replace(/\s+/gu, " ")), 160);
  }
  return truncate(redactSensitiveText(operation.match.replace(/\s+/gu, " ")), 160);
}

function selectPendingCandidates(
  record: MemoryCurationRecord,
  selector: string
): MemoryCurationCandidateRecord[] {
  const pending = (record.candidates ?? []).filter((candidate) => candidate.reviewStatus === "pending");
  if (selector === "all") {
    return pending;
  }
  return pending.filter((candidate) => candidate.id === selector);
}

async function markAppliedReviewCandidates(input: {
  store: MemoryCurationStore;
  recordId: string;
  applied: readonly MemoryCurationCandidateRecord[];
  operations: readonly MemoryOperation[];
  reason: string;
}): Promise<void> {
  await input.store.update(input.recordId, (current) => {
    const appliedIds = new Set(input.applied.map((candidate) => candidate.id));
    const nextCandidates = (current.candidates ?? []).map((candidate) => appliedIds.has(candidate.id)
      ? { ...candidate, reviewStatus: "applied" as const }
      : candidate);
    const nextOperations = [
      ...current.operations,
      ...input.operations.map((operation) => summarizeMemoryOperation(operation))
    ];
    return {
      ...current,
      status: statusForReviewCandidates(nextCandidates),
      candidates: nextCandidates,
      operations: nextOperations,
      reason: input.reason
    };
  });
}

async function createOperatorMutationContext(
  context: { homeDir: string; profileId: string },
  sessionId: string | undefined
): Promise<{
  service: MemoryMutationService;
  memoryStore: MemoryStore;
  sync: ReturnType<typeof createMemoryIndexSync>;
}> {
  const paths = resolveProfileStateHome({ homeDir: context.homeDir, profileId: context.profileId });
  const persistence = new MemoryPersistenceService();
  const memoryStore = new MemoryStore();
  await Promise.all([
    loadMemoryFileIntoStore({
      persistence,
      memoryStore,
      path: paths.userMdPath,
      file: "USER.md"
    }),
    loadMemoryFileIntoStore({
      persistence,
      memoryStore,
      path: paths.memoryMdPath,
      file: "MEMORY.md"
    })
  ]);
  const config = await loadMemoryConfig(context);
  const sync = createMemoryIndexSync({
    homeDir: context.homeDir,
    profileId: context.profileId,
    config
  });
  return {
    service: new MemoryMutationService({
      memoryStore,
      profileId: context.profileId,
      sessionId,
      persistence,
      persistencePaths: {
        "USER.md": paths.userMdPath,
        "MEMORY.md": paths.memoryMdPath
      },
      memoryIndexSync: sync
    }),
    memoryStore,
    sync
  };
}

function cloneMemoryStore(source: MemoryStore): MemoryStore {
  const snapshot = source.snapshot();
  const clone = new MemoryStore({ budgets: snapshot.budgets });
  for (const [file, content] of snapshot.files.entries()) {
    clone.write(file, content);
  }
  return clone;
}

function statusForReviewCandidates(candidates: readonly MemoryCurationCandidateRecord[]): MemoryCurationStatus {
  if (candidates.some((candidate) => candidate.reviewStatus === "pending")) {
    return "pending-review";
  }
  if (candidates.some((candidate) => candidate.reviewStatus === "applied")) {
    return "applied";
  }
  return "rejected";
}

function formatOperatorError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncate(redactSensitiveText(message), 240);
}

async function loadMemoryFileIntoStore(input: {
  persistence: MemoryPersistenceService;
  memoryStore: MemoryStore;
  path: string;
  file: Extract<MemoryFileKind, "USER.md" | "MEMORY.md">;
}): Promise<void> {
  const content = await input.persistence.readFile({ path: input.path, kind: input.file });
  input.memoryStore.write(input.file, content ?? "");
}

function toMemoryOperation(operation: StoredMemoryOperation): MemoryOperation {
  if (operation.kind === "append") {
    return {
      kind: "append",
      file: operation.file,
      content: operation.content
    };
  }
  if (operation.kind === "replace") {
    return {
      kind: "replace",
      file: operation.file,
      match: operation.match,
      replacement: operation.replacement
    };
  }
  return {
    kind: "remove",
    file: operation.file,
    match: operation.match
  };
}

function invertMemoryOperation(operation: StoredMemoryOperation): MemoryOperation {
  if (operation.kind === "append") {
    return {
      kind: "remove",
      file: operation.file,
      match: operation.content
    };
  }
  if (operation.kind === "replace") {
    return {
      kind: "replace",
      file: operation.file,
      match: operation.replacement,
      replacement: operation.match
    };
  }
  return {
    kind: "append",
    file: operation.file,
    content: operation.match
  };
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
