import { it, expect } from "vitest";
import { mkdtemp, rm, writeFile, readFile, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostEnvironment } from "./host-environment.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { ensureRuntimeSession } from "../session/session-workspace-ownership.js";
import { SessionExecutionOwnership } from "../session/execution-ownership.js";
import { copyFixture } from "../test/copy-fixture.js";
import { prepareTemporaryCopy } from "../workspaces/temporary-copy.js";
import { ChangeApplicationStore } from "../workspaces/change-application.js";

it("repeated owner succession rejects every stale result while preserving the next owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-fences-"));
  const db = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
  try {
    await ensureRuntimeSession({ sessionDb: db, sessionId: "s", profileId: "default", workspaceRoot: root, homeDir: root, durable: true });
    const owners = new SessionExecutionOwnership(db.db);
    const input = { sessionId: "s", profileId: "default", targetId: (await db.getSession("s"))!.executionTarget!.targetId };
    let claim = owners.claim(input);
    for (let i = 0; i < 32; i++) {
      const stale = claim; owners.release(claim); claim = owners.claim(input);
      await Promise.all(Array.from({ length: 8 }, async () => {
        await Promise.resolve(); expect(() => owners.advance(stale, "turn")).toThrow();
        expect(() => owners.release(stale)).toThrow();
      }));
      owners.assert(claim); expect(claim.fence).toBe(stale.fence + 1);
    }
    owners.release(claim);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
it("concurrent scope cancellation retains sibling access and settles owned resources exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-scopes-"));
  const environment = await HostEnvironment.create({ profileId: "default", workspaceRoot: root });
  const parent = environment.acquire({ profileId: "default", sessionId: "parent", surface: "cli" });
  const children = Array.from({ length: 24 }, (_, i) => parent.child({ profileId: "default", sessionId: `child-${i}`, surface: "task" }));
  const released = children.map(() => 0);
  try {
    children.forEach((child, i) => child.own({ release: async () => { await Promise.resolve(); released[i]++; } }));
    await parent.release();
    await Promise.all(children.slice(0, 12).flatMap((child) => [child.release(), child.release()]));
    children.slice(12).forEach((child) => child.assertActive());
    await children[12]!.files.writeFile("survivor.txt", "still owned");
    expect(await readFile(join(root, "survivor.txt"), "utf8")).toBe("still owned");
    await Promise.all(children.flatMap((child) => [child.release(), child.release()]));
    expect(released).toEqual(children.map(() => 1));
  } finally { await Promise.all(children.map((child) => child.release())); await parent.release(); await environment.destroy(); await rm(root, { recursive: true, force: true }); }
});
it.each(["regrant", "source-symlink"])("rejects changed %s authority after export without modifying the source", async (change) => {
  const f = await copyFixture(), store = new ChangeApplicationStore(f);
  try {
    const target = await prepareTemporaryCopy({ ...f, source: "source", manifest: f.input });
    const auth = await store.authorize(target.id, { version: 1, outcome: "apply", paths: [{ path: "hello.bin", operations: ["update"] }] });
    await writeFile(join(f.destination, "hello.bin"), "agent change");
    const artifact = await store.export(target.id, "s");
    if (change === "regrant") {
      await store.approvals.revoke(auth.grant!.id, auth.grant!.workspaceRoot);
      await store.approvals.grant(auth.grant!);
    } else {
      await rename(join(f.source, "hello.bin"), join(f.source, "original.bin"));
      await symlink("original.bin", join(f.source, "hello.bin"));
    }
    expect((await store.apply(artifact.id)).status).toBe("attention");
    expect(await readFile(join(f.source, "hello.bin"))).toEqual(Buffer.from([0, 255, 1]));
  } finally { store.close(); await f.cleanup(); }
});
