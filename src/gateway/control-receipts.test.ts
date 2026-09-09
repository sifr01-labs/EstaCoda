import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { ensureRuntimeSession } from "../session/session-workspace-ownership.js";
import { ControlReceipts, createControlOperationId } from "./control-receipts.js";

it("deduplicates exact inputs, rejects conflicting retries and preserves uncertainty across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "control-receipts-"));
  const db = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
  try {
    await ensureRuntimeSession({ sessionDb: db, sessionId: "session", profileId: "default", workspaceRoot: root, homeDir: root, durable: true });
    const request = { method: "send" as const, sessionId: "session", targetId: (await db.getSession("session"))!.executionTarget!.targetId, operationId: createControlOperationId(), text: "hello" };
    const receipts = new ControlReceipts(db.db, "default", "first");
    expect(receipts.accept(request).inserted).toBe(true);
    expect(receipts.accept(request).inserted).toBe(false);
    expect(() => receipts.accept({ ...request, text: "different" })).toThrow("different input");
    receipts.transition(request, "dispatched");
    const restarted = new ControlReceipts(db.db, "default", "second");
    restarted.recover();
    expect(restarted.accept(request)).toMatchObject({ inserted: false, receipt: { status: "uncertain" } });
    expect(() => receipts.transition(request, "completed")).toThrow("fenced");
    expect(new ControlReceipts(db.db, "other", "second").inspect(request)).toEqual([]);
    expect(() => restarted.accept({ ...request, operationId: "1:expired" })).toThrow("expired");
    expect(db.db.query<{ event_json: string }>("select event_json from session_events where event_json like '%private-control-input%'").all()).toHaveLength(1);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
