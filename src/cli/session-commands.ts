import { join } from "node:path";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import type { ViewModel } from "../contracts/view-model.js";
import type { SessionRecord } from "../contracts/session.js";
import { defaultProfileId, readActiveProfile, resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
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
  runtime?: { sessionId: string };
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
