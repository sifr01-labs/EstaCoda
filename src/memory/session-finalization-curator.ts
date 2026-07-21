import { isAbsolute } from "node:path";
import { resolveProfileStateHome } from "../config/profile-home.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { resolveAuxiliaryModelRoute } from "../providers/auxiliary-model-resolver.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { createProviderUsageRecorder } from "../providers/provider-usage-ledger.js";
import { SQLiteProviderSpendController } from "../workflow/sqlite-provider-spend.js";
import type { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import type { SessionFinalizationJob } from "../session/session-finalization-queue.js";
import { MemoryCurationStore, memoryCurationStorePath } from "./memory-curation-store.js";
import {
  MemoryCurationService,
  type MemoryCurationCheckpointResult,
} from "./memory-curation-service.js";
import { SQLiteMemoryCurationCoordinator } from "./memory-curation-coordinator.js";
import { createExternalMemoryProvidersFromConfig } from "./external-memory-provider.js";
import { createMemoryIndexSync } from "./memory-index-sync.js";
import { MemoryMutationService } from "./memory-mutation-service.js";
import { MemoryPersistenceService } from "./memory-persistence-service.js";
import { MemoryStore } from "./memory-store.js";
import { listSharedMemory, renderSharedMemory } from "./shared-memory.js";

export async function curateSessionFinalizationJob(input: {
  job: SessionFinalizationJob;
  config: LoadedRuntimeConfig;
  sessionDb: SQLiteSessionDB;
  homeDir: string;
  workspaceRoot: string;
  profileId: string;
  signal?: AbortSignal;
}): Promise<MemoryCurationCheckpointResult> {
  if (input.job.profileId !== input.profileId) {
    throw new Error("Session finalization job does not belong to the active profile.");
  }
  const session = await input.sessionDb.getSessionForProfile(input.job.sessionId, input.profileId);
  if (session === undefined) {
    throw new Error("Session finalization job is outside the active profile scope.");
  }
  const workspaceRoot = resolveSessionFinalizationWorkspaceRoot(session.metadata, input.workspaceRoot);
  if (
    input.config.memory.curation.auditOnRuntimeDispose !== true
    || input.config.memory.curation.mode === "manual"
  ) {
    return skippedFinalization(input.job);
  }

  const profilePaths = resolveProfileStateHome({ homeDir: input.homeDir, profileId: input.profileId });
  const persistence = new MemoryPersistenceService();
  const memoryStore = new MemoryStore();
  const [userMemory, soulMemory, profileMemory, sharedEntries] = await Promise.all([
    persistence.readFile({ path: profilePaths.userMdPath, kind: "USER.md" }),
    persistence.readFile({ path: profilePaths.soulMdPath, kind: "SOUL.md" }),
    persistence.readFile({ path: profilePaths.memoryMdPath, kind: "MEMORY.md" }),
    listSharedMemory({ homeDir: input.homeDir }),
  ]);
  hydrateMemory(memoryStore, "USER.md", userMemory);
  hydrateMemory(memoryStore, "SOUL.md", soulMemory);
  hydrateMemory(memoryStore, "MEMORY.md", profileMemory);
  hydrateMemory(memoryStore, "SHARED.md", renderSharedMemory(sharedEntries));

  const memoryIndexSync = input.config.memory.index.enabled === true
    ? createMemoryIndexSync({
        profileId: input.profileId,
        homeDir: input.homeDir,
        config: input.config.memory,
      })
    : undefined;

  try {
    const mainRoute = input.config.primaryModelRoute ?? {
      provider: input.config.model.provider,
      id: input.config.model.id,
      profile: input.config.model,
    };
    const providerModels = input.config.model.provider === "unconfigured"
      ? []
      : await input.config.providerRegistry.listModels();
    const compressionRoute = input.config.model.provider === "unconfigured"
      ? undefined
      : resolveAuxiliaryModelRoute("compression", input.config.auxiliaryModels, {
          mainRoute,
          providerRegistry: input.config.providerRegistry,
          providerModels,
        });
    const providerExecutor = new ProviderExecutor({
      registry: input.config.providerRegistry,
      homeDir: input.homeDir,
      profileId: input.profileId,
      spendController: new SQLiteProviderSpendController({ db: input.sessionDb.db, profileId: input.profileId }),
      usageRecorder: createProviderUsageRecorder({
        profileId: input.profileId,
        record: (entries) => input.sessionDb.recordProviderUsageEntries(entries),
        resolveSessionBudgetScopeId: async (sessionId) =>
          (await input.sessionDb.getSessionForProfile(sessionId, input.profileId))?.spendingScopeSessionId
      })
    });
    const externalMemory = input.config.externalMemory;
    const externalMemoryProviders = createExternalMemoryProvidersFromConfig(externalMemory, {
      profileRoot: profilePaths.profileRoot,
    });
    const persistencePaths = {
      "USER.md": profilePaths.userMdPath,
      "MEMORY.md": profilePaths.memoryMdPath,
      "SOUL.md": profilePaths.soulMdPath,
    };
    const curationService = new MemoryCurationService({
      config: input.config.memory.curation,
      profileId: input.profileId,
      sessionId: input.job.sessionId,
      sessionDb: input.sessionDb,
      memoryStore,
      curationStore: new MemoryCurationStore({
        path: memoryCurationStorePath(profilePaths.profileRoot),
      }),
      extractorOptions: {
        route: compressionRoute,
        mainRoute,
        providerExecutor,
      },
      persistence,
      persistencePaths,
      memoryIndexSync,
      checkpointCoordinator: new SQLiteMemoryCurationCoordinator({
        db: input.sessionDb.db,
        profileId: input.profileId,
      }),
      memoryMutationService: new MemoryMutationService({
        memoryStore,
        profileId: input.profileId,
        sessionId: input.job.sessionId,
        workspaceRoot,
        sessionDb: input.sessionDb,
        persistence,
        persistencePaths,
        memoryIndexSync,
        externalMemory,
        externalMemoryProviders,
      }),
    });

    return await curationService.checkpoint({
      trigger: "runtime-dispose",
      minNewMessages: input.config.memory.curation.runtimeDisposeMinNewMessages,
      cutoffMessageId: input.job.cutoffMessageId,
      sourceMessageCount: input.job.sourceMessageCount,
      signal: input.signal,
    });
  } finally {
    memoryIndexSync?.dispose();
  }
}

export function resolveSessionFinalizationWorkspaceRoot(
  metadata: Record<string, unknown> | undefined,
  fallbackWorkspaceRoot: string
): string {
  const candidate = metadata?.workspaceRoot;
  return typeof candidate === "string" && candidate.trim() === candidate && isAbsolute(candidate)
    ? candidate
    : fallbackWorkspaceRoot;
}

function skippedFinalization(job: SessionFinalizationJob): MemoryCurationCheckpointResult {
  return {
    status: "skipped",
    trigger: "runtime-dispose",
    sessionId: job.sessionId,
    sourceMessageCount: job.sourceMessageCount,
    reviewedMessageCount: 0,
    extractedFactCount: 0,
    candidateCount: 0,
    autoAppliedCount: 0,
    pendingReviewCount: 0,
    ignoredCount: 0,
    failedCount: 0,
    warnings: [],
  };
}

function hydrateMemory(
  store: MemoryStore,
  kind: "USER.md" | "SOUL.md" | "MEMORY.md" | "SHARED.md",
  content: string | undefined
): void {
  if (content !== undefined) {
    store.hydrate(kind, content);
  }
}
