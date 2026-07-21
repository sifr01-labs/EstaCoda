import { join } from "node:path";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import type { ViewModel } from "../contracts/view-model.js";
import type { SessionRecord } from "../contracts/session.js";
import { loadRuntimeConfig, type LoadRuntimeConfigOptions } from "../config/runtime-config.js";
import { defaultProfileId, readActiveProfile, resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { renderSessionRecallResult, SessionRecallService } from "../session/session-recall-service.js";
import { renderSessionCompactionResult, type CompactResult } from "../prompt/session-compression-service.js";
import { resolveAuxiliaryModelRoute } from "../providers/auxiliary-model-resolver.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { createProviderUsageRecorder } from "../providers/provider-usage-ledger.js";
import {
  buildSessionsHelpViewModel,
  buildSessionsListViewModel,
  buildSessionShowViewModel,
  buildSessionCurrentViewModel,
  buildSessionAttachViewModel,
  buildSessionDetachViewModel,
  buildSessionNotFoundViewModel,
  buildNoActiveSessionViewModel,
  buildInvalidSurfaceViewModel,
  buildSessionUsageErrorViewModel,
} from "./session-view-models.js";

export type SessionRenderer = (viewModel: ViewModel) => string;

export type SessionCommandInput = {
  args: string[];
  homeDir: string;
  workspaceRoot?: string;
  providerFetch?: LoadRuntimeConfigOptions["providerFetch"];
  modelsDevOptions?: LoadRuntimeConfigOptions["modelsDevOptions"];
  runtime?: {
    sessionId: string;
    compactSession?: (input?: {
      sessionId?: string;
      focusTopic?: string;
      preserveTranscript?: boolean;
      signal?: AbortSignal;
    }) => Promise<CompactResult>;
  };
};

const VALID_SURFACES = ["cli", "telegram", "discord", "whatsapp", "email"] as const;

export async function runSessionsCommand(
  input: SessionCommandInput,
  renderer: SessionRenderer = renderPlain
): Promise<{ ok: boolean; output: string }> {
  const [subcommand, ...rest] = input.args;
  const homeDir = input.homeDir;
  const profileId = readActiveProfile({ homeDir }).profileId ?? defaultProfileId();
  const globalPaths = resolveGlobalStateHome({ homeDir });
  const profilePaths = resolveProfileStateHome({ homeDir, profileId });
  const surfacePointerPath = join(profilePaths.gatewayStatePath, "surface-pointers.json");

  if (subcommand === "list" || subcommand === undefined) {
    const db = await createSQLiteSessionDB({ path: globalPaths.sessionsSqlitePath });
    const { FileSurfacePointerStore } = await import("../channels/surface-pointer-store.js");
    const pointerStore = new FileSurfacePointerStore({ path: surfacePointerPath });
    try {
      const sessions = await db.listSessions(profileId);
      const pointers = await pointerStore.listPointers();
      const entries = sessions.slice(0, 20).map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        attachments: pointers
          .filter((p) => p.record.sessionId === s.id)
          .map((p) => `${p.surfaceType}:${p.surfaceId}`),
      }));
      const viewModel = buildSessionsListViewModel({ sessions: entries });
      return { ok: true, output: renderer(viewModel) };
    } finally {
      await db.close();
    }
  }

  if (subcommand === "recall") {
    const query = rest.join(" ").trim();
    if (query.length === 0) {
      const viewModel = buildSessionUsageErrorViewModel({
        message: "Usage: estacoda sessions recall <query>",
      });
      return { ok: false, output: renderer(viewModel) };
    }
    const db = await createSQLiteSessionDB({ path: globalPaths.sessionsSqlitePath });
    try {
      const runtimeConfig = await loadRuntimeConfig({
        workspaceRoot: input.workspaceRoot ?? process.cwd(),
        homeDir,
        profileId,
        providerFetch: input.providerFetch,
        modelsDevOptions: input.modelsDevOptions
      });
      const providerModels = await runtimeConfig.providerRegistry.listModels();
      const sessionSearchRoute = runtimeConfig.model.provider === "unconfigured"
        ? undefined
        : resolveAuxiliaryModelRoute("session_search", runtimeConfig.auxiliaryModels, {
            mainRoute: runtimeConfig.primaryModelRoute,
            providerRegistry: runtimeConfig.providerRegistry,
            providerModels
          });
      const result = await new SessionRecallService({
        sessionDb: db,
        profileId,
        workspaceRoot: input.workspaceRoot,
        route: sessionSearchRoute,
        mainRoute: runtimeConfig.primaryModelRoute,
        providerExecutor: new ProviderExecutor({
          registry: runtimeConfig.providerRegistry,
          homeDir: runtimeConfig.homeDir,
          profileId: runtimeConfig.profileId,
          usageRecorder: createProviderUsageRecorder({
            profileId,
            record: (entries) => db.recordProviderUsageEntries(entries)
          })
        })
      }).recall(query);
      return { ok: true, output: renderSessionRecallResult(result) };
    } finally {
      await db.close();
    }
  }

  if (subcommand === "compact") {
    const parsed = parseCompactArgs(rest);
    if (!parsed.ok) {
      const viewModel = buildSessionUsageErrorViewModel({
        message: parsed.message,
      });
      return { ok: false, output: renderer(viewModel) };
    }
    if (input.runtime?.compactSession === undefined) {
      const viewModel = buildSessionUsageErrorViewModel({
        message: "Session compaction is not available in this runtime.",
      });
      return { ok: false, output: renderer(viewModel) };
    }
    try {
      const result = await input.runtime.compactSession({
        sessionId: parsed.sessionId,
        focusTopic: parsed.topic,
        preserveTranscript: false
      });
      return {
        ok: true,
        output: renderSessionCompactionResult(result, { focusTopic: parsed.topic })
      };
    } catch (error) {
      const viewModel = buildSessionUsageErrorViewModel({
        message: `Session compaction failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return { ok: false, output: renderer(viewModel) };
    }
  }

  if (subcommand === "show") {
    const sessionId = rest[0];
    if (sessionId === undefined) {
      const viewModel = buildSessionUsageErrorViewModel({
        message: "Usage: estacoda sessions show <session-id>",
      });
      return { ok: false, output: renderer(viewModel) };
    }
    const db = await createSQLiteSessionDB({ path: globalPaths.sessionsSqlitePath });
    const { FileSurfacePointerStore } = await import("../channels/surface-pointer-store.js");
    const pointerStore = new FileSurfacePointerStore({ path: surfacePointerPath });
    try {
      const session = await db.getSessionForProfile(sessionId, profileId);
      if (session === undefined) {
        const viewModel = buildSessionNotFoundViewModel({ sessionId });
        return { ok: false, output: renderer(viewModel) };
      }
      const messages = await db.listMessagesForProfile(sessionId, profileId);
      const sessionPointers = (await pointerStore.listPointers()).filter((p) => p.record.sessionId === sessionId);
      const viewModel = buildSessionShowViewModel({
        session,
        messageCount: messages.length,
        pointers: sessionPointers.map((p) => ({
          surfaceType: p.surfaceType,
          surfaceId: p.surfaceId,
          attachedAt: p.record.attachedAt,
          homeDelivery: p.record.homeDelivery,
        })),
      });
      return { ok: true, output: renderer(viewModel) };
    } finally {
      await db.close();
    }
  }

  if (subcommand === "current") {
    const runtime = input.runtime;
    if (runtime === undefined) {
      const viewModel = buildNoActiveSessionViewModel({
        message: "No active session in this shell.",
      });
      return { ok: false, output: renderer(viewModel) };
    }
    const { FileSurfacePointerStore } = await import("../channels/surface-pointer-store.js");
    const pointerStore = new FileSurfacePointerStore({ path: surfacePointerPath });
    const pointers = (await pointerStore.listPointers()).filter((p) => p.record.sessionId === runtime.sessionId);
    const viewModel = buildSessionCurrentViewModel({
      sessionId: runtime.sessionId,
      pointers: pointers.map((p) => ({
        surfaceType: p.surfaceType,
        surfaceId: p.surfaceId,
        attachedAt: p.record.attachedAt,
      })),
    });
    return { ok: true, output: renderer(viewModel) };
  }

  if (subcommand === "attach") {
    const [surface, surfaceId, sessionId] = rest;
    if (surface === undefined || surfaceId === undefined || sessionId === undefined) {
      const viewModel = buildSessionUsageErrorViewModel({
        message: "Usage: estacoda sessions attach <surface> <surface-id> <session-id>",
      });
      return { ok: false, output: renderer(viewModel) };
    }
    if (!VALID_SURFACES.includes(surface as typeof VALID_SURFACES[number])) {
      const viewModel = buildInvalidSurfaceViewModel({
        surface,
        validSurfaces: [...VALID_SURFACES],
      });
      return { ok: false, output: renderer(viewModel) };
    }
    const { FileSurfacePointerStore } = await import("../channels/surface-pointer-store.js");
    const pointerStore = new FileSurfacePointerStore({ path: surfacePointerPath });
    const db = await createSQLiteSessionDB({ path: globalPaths.sessionsSqlitePath });
    try {
      const session = await db.getSessionForProfile(sessionId, profileId);
      if (session === undefined) {
        const viewModel = buildSessionNotFoundViewModel({ sessionId });
        return { ok: false, output: renderer(viewModel) };
      }
    } finally {
      await db.close();
    }
    await pointerStore.setPointer(surface as typeof VALID_SURFACES[number], surfaceId, {
      sessionId,
      attachedAt: new Date().toISOString(),
    });
    const viewModel = buildSessionAttachViewModel({ surface, surfaceId, sessionId });
    return { ok: true, output: renderer(viewModel) };
  }

  if (subcommand === "detach") {
    const [surface, surfaceId] = rest;
    if (surface === undefined || surfaceId === undefined) {
      const viewModel = buildSessionUsageErrorViewModel({
        message: "Usage: estacoda sessions detach <surface> <surface-id>",
      });
      return { ok: false, output: renderer(viewModel) };
    }
    if (!VALID_SURFACES.includes(surface as typeof VALID_SURFACES[number])) {
      const viewModel = buildInvalidSurfaceViewModel({
        surface,
        validSurfaces: [...VALID_SURFACES],
      });
      return { ok: false, output: renderer(viewModel) };
    }
    const { FileSurfacePointerStore } = await import("../channels/surface-pointer-store.js");
    const pointerStore = new FileSurfacePointerStore({ path: surfacePointerPath });
    await pointerStore.removePointer(surface as typeof VALID_SURFACES[number], surfaceId);
    const viewModel = buildSessionDetachViewModel({ surface, surfaceId });
    return { ok: true, output: renderer(viewModel) };
  }

  return { ok: true, output: renderer(buildSessionsHelpViewModel()) };
}

function parseCompactArgs(args: readonly string[]): { ok: true; sessionId: string; topic?: string } | { ok: false; message: string } {
  const sessionId = args[0];
  if (sessionId === undefined || sessionId.startsWith("-")) {
    return { ok: false, message: "Usage: estacoda sessions compact <session-id> [--topic <topic>]" };
  }

  let topic: string | undefined;
  const rest = args.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--topic") {
      const value = rest.slice(index + 1).join(" ").trim();
      if (value.length === 0) {
        return { ok: false, message: "--topic requires a value." };
      }
      topic = value;
      break;
    }
    if (arg.startsWith("--topic=")) {
      const value = arg.slice("--topic=".length).trim();
      if (value.length === 0) {
        return { ok: false, message: "--topic requires a value." };
      }
      topic = value;
      continue;
    }
    return { ok: false, message: `Unknown option for sessions compact: ${arg}` };
  }

  return topic === undefined ? { ok: true, sessionId } : { ok: true, sessionId, topic };
}
