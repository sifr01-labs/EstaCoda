import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ChannelWorkspaceStore, channelSurfaceId } from "./channel-workspace-store.js";
import { PersistentChannelSessionStore } from "./channel-session-store.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";

const key = { platform: "telegram", accountId: "bot", chatType: "thread" as const, chatId: "chat", threadId: "one", userId: "user" };
it("persists profile/surface selection and fresh Session identity without transferring trust or following moves", async () => {
  const root = await mkdtemp(join(tmpdir(), "channel-workspaces-"));
  const store = new ChannelWorkspaceStore({ homeDir: root, profileId: "work" });
  const other = new ChannelWorkspaceStore({ homeDir: root, profileId: "other" });
  try {
    const workspace = await store.add("project", root);
    const selected = await store.select(key, "project", 0);
    const sessions = new PersistentChannelSessionStore({ homeDir: root, profileId: "work", workspaceStore: store });
    expect(await sessions.getOrCreateSessionId(key)).toBe(selected.sessionId);
    expect(other.current(key)).toBeUndefined();
    expect(store.current({ ...key, threadId: "two" })).toBeUndefined();
    expect(store.current({ ...key, accountId: "another-bot" })).toBeUndefined();
    expect(await new WorkspaceTrustStore({ homeDir: root }).isTrusted(root)).toBe(false);
    store.rename("project", "renamed");
    await expect(store.validateSelection(selected)).resolves.toBeUndefined();
    const reopened = new ChannelWorkspaceStore({ homeDir: root, profileId: "work" });
    try { expect(reopened.current(key)).toMatchObject(selected); } finally { reopened.close(); }
    const next = await sessions.resetSessionId(key);
    expect(next).not.toBe(selected.sessionId);
    expect(store.current(key)?.target).toEqual(selected.target);
    const destination = join(root, "moved"); await mkdir(destination);
    await store.move(workspace.id, destination, workspace.locationRevision);
    await expect(sessions.getOrCreateSessionId(key)).rejects.toThrow("moved");
    expect(store.current(key)?.target).toEqual(selected.target);
  } finally { store.close(); other.close(); await rm(root, { recursive: true, force: true }); }
});
it("serializes competing selection and accepts aliases only", async () => {
  const root = await mkdtemp(join(tmpdir(), "channel-selection-"));
  const first = new ChannelWorkspaceStore({ homeDir: root, profileId: "work" });
  const second = new ChannelWorkspaceStore({ homeDir: root, profileId: "work" });
  try {
    await first.add("project", root);
    const results = await Promise.allSettled([first.select(key, "project", 0), second.select(key, "project", 0)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(first.select(key, root, 1)).rejects.toThrow("aliases");
    expect(channelSurfaceId({ ...key, chatId: "a:b", threadId: "c" })).not.toBe(channelSurfaceId({ ...key, chatId: "a", threadId: "b:c" }));
  } finally { first.close(); second.close(); await rm(root, { recursive: true, force: true }); }
});

it.each(["idle", "daily", "both"] as const)("persists %s resets atomically while preserving selected targets", async (resetPolicy) => {
  const root = await mkdtemp(join(tmpdir(), "channel-reset-"));
  const store = new ChannelWorkspaceStore({ homeDir: root, profileId: "work" });
  const reopened = new ChannelWorkspaceStore({ homeDir: root, profileId: "work" });
  const policy = { resetPolicy, idleResetMinutes: 1, timeZone: "Asia/Dubai" };
  try {
    await store.add("project", root); const selected = await store.select(key, "project", 0);
    const first = new PersistentChannelSessionStore({ homeDir: root, profileId: "work", workspaceStore: store, policy });
    const second = new PersistentChannelSessionStore({ homeDir: root, profileId: "work", workspaceStore: reopened, policy });
    expect(await first.getOrCreateSessionId(key, { receivedAt: "2026-09-09T19:59:00Z" })).toBe(selected.sessionId);
    const ids = await Promise.all([first, second].map((sessions) => sessions.getOrCreateSessionId(key, { receivedAt: "2026-09-09T20:02:00Z" })));
    expect(ids[0]).not.toBe(selected.sessionId); expect(ids[0]).toBe(ids[1]);
    expect(store.current(key)).toMatchObject({ source: selected.source, target: selected.target, revision: 2 });
    expect(await second.getOrCreateSessionId(key, { receivedAt: "2026-09-08T00:00:00Z" })).toBe(ids[0]);
    expect(store.current(key)?.lastActivityAt).toBe("2026-09-09T20:02:00.000Z");
    await first.resetSessionId(key, { receivedAt: "2026-09-10T20:00:00Z" });
    expect(await second.getOrCreateSessionId(key, { receivedAt: "2026-09-10T20:00:10Z" })).toBe(store.current(key)?.sessionId);
    expect(store.current(key)?.revision).toBe(3);
  } finally { store.close(); reopened.close(); await rm(root, { recursive: true, force: true }); }
});

it("revalidates a concurrent selection instead of touching the stale Session", async () => {
  const { vi } = await import("vitest");
  const root = await mkdtemp(join(tmpdir(), "channel-reset-selection-"));
  const store = new ChannelWorkspaceStore({ homeDir: root, profileId: "work" });
  try {
    await store.add("project", root); const original = await store.select(key, "project", 0);
    const validate = store.validateSelection.bind(store);
    let replacement = original;
    vi.spyOn(store, "validateSelection").mockImplementationOnce(async (binding) => {
      await validate(binding); replacement = await store.select(key, "project", 1);
    });
    const touched = await store.touchSession(key, new Date(), { resetPolicy: "idle" });
    expect(touched?.sessionId).toBe(replacement.sessionId);
    expect(touched?.sessionId).not.toBe(original.sessionId);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
