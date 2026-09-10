import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileHandoffStore } from "./handoff-store.js";
import { FileSurfacePointerStore } from "./surface-pointer-store.js";
import { PersistentChannelSessionStore } from "./channel-session-store.js";
import { CronStore } from "../cron/cron-store.js";

it("observes new handoffs and surface pointers across existing instances and consumes a code once", async () => {
  const root = await mkdtemp(join(tmpdir(), "channel-recovery-"));
  try {
    const path = join(root, "handoffs.json");
    const cli = new FileHandoffStore({ path }), gateway = new FileHandoffStore({ path });
    expect(await gateway.list()).toEqual([]);
    const code = await cli.create({ sessionId: "shared", surfaceType: "telegram", ttlMinutes: 5 });
    expect(await gateway.get(code.code)).toEqual(code);
    const resolutions = await Promise.all([gateway.redeem({ code: code.code, surfaceType: "telegram", surfaceId: "one" }),
      cli.redeem({ code: code.code, surfaceType: "telegram", surfaceId: "two" })]);
    expect(resolutions.filter((r) => r.ok)).toHaveLength(1);
    const first = new FileSurfacePointerStore({ path: join(root, "pointers.json") });
    const second = new FileSurfacePointerStore({ path: join(root, "pointers.json") });
    await first.listPointers(); await second.listPointers();
    await Promise.all([first.setPointer("telegram", "one", { sessionId: "a", attachedAt: new Date().toISOString() }),
      second.setPointer("telegram", "two", { sessionId: "b", attachedAt: new Date().toISOString() })]);
    expect(await first.listPointers()).toHaveLength(2);
    await second.removePointer("telegram", "one");
    expect(await first.getPointer("telegram", "one")).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not erase corrupt or unknown state and refuses cross-profile session pointers repeatedly", async () => {
  const root = await mkdtemp(join(tmpdir(), "channel-corruption-"));
  try {
    const path = join(root, "sessions.json");
    await writeFile(path, JSON.stringify({ version: 2, profileId: "other", entries: [] }));
    const sessions = new PersistentChannelSessionStore({ path, profileId: "work" });
    for (let i = 0; i < 2; i++) await expect(sessions.getOrCreateSessionId({ platform: "telegram", chatId: "one" })).rejects.toThrow("profile mismatch");
    const jobs = join(root, "jobs.json"), raw = '{"jobs":[{"id":"legacy","executionOrigin":{"schemaVersion":99}}]}';
    await writeFile(jobs, raw);
    const cron = new CronStore({ path: jobs });
    await expect(cron.list()).rejects.toThrow("Invalid recurring execution origin");
    await expect(cron.create({ prompt: "new", schedule: "every 1h" })).rejects.toThrow();
    expect(await readFile(jobs, "utf8")).toBe(raw);
  } finally { await rm(root, { recursive: true, force: true }); }
});
