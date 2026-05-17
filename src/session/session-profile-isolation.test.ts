import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSQLiteSessionDB } from "./session-setup.js";
import type { SQLiteSessionDB } from "./sqlite-session-db.js";

describe("SQLite session profile isolation", () => {
  let tempDir: string;
  let dbPath: string;
  let db: SQLiteSessionDB;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-session-profile-"));
    dbPath = join(tempDir, ".estacoda", "sessions.sqlite");
    db = await createSQLiteSessionDB({ path: dbPath });
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("does not expose one profile's sessions through another profile's scoped reads", async () => {
    const profileA = await db.createSession({ id: "session-a", profileId: "profile-a", title: "A" });
    const profileB = await db.createSession({ id: "session-b", profileId: "profile-b", title: "B" });
    await db.appendMessage({ sessionId: profileA.id, role: "user", content: "needle alpha" });
    await db.appendMessage({ sessionId: profileB.id, role: "user", content: "needle beta" });

    expect(await db.listSessions("profile-a")).toEqual([expect.objectContaining({ id: "session-a" })]);
    await expect(db.getSessionForProfile("session-b", "profile-a")).resolves.toBeUndefined();
    await expect(db.listMessagesForProfile("session-b", "profile-a")).resolves.toEqual([]);

    const searchResults = await db.search("needle", { profileId: "profile-a" });
    expect(searchResults.map((result) => result.session.id)).toEqual(["session-a"]);
  });

  it("uses a profile index for scoped session list lookups where practical", async () => {
    await db.createSession({ id: "indexed-session", profileId: "profile-a" });

    const plan = db.db
      .query<{ detail: string }>(
        "explain query plan select * from sessions where profile_id = ? order by updated_at desc"
      )
      .all("profile-a");

    expect(plan.map((row) => row.detail).join("\n")).toContain("idx_sessions_profile_updated");
  });

  it("keeps simultaneous writes for different profiles isolated", async () => {
    const writerA = await createSQLiteSessionDB({ path: dbPath });
    const writerB = await createSQLiteSessionDB({ path: dbPath });

    try {
      await Promise.all([
        ...Array.from({ length: 10 }, async (_, index) =>
          writerA.createSession({ id: `a-${index}`, profileId: "profile-a" })
        ),
        ...Array.from({ length: 10 }, async (_, index) =>
          writerB.createSession({ id: `b-${index}`, profileId: "profile-b" })
        )
      ]);
    } finally {
      writerA.close();
      writerB.close();
    }

    expect(await db.listSessions("profile-a")).toHaveLength(10);
    expect(await db.listSessions("profile-b")).toHaveLength(10);
  });

  it("assigns the default profile id when SQLite inserts omit profile_id", async () => {
    const now = "2026-05-17T00:00:00.000Z";
    db.db
      .query(
        `insert into sessions (
          id,
          title,
          created_at,
          updated_at,
          parent_session_id,
          metadata_json
        ) values (?, ?, ?, ?, ?, ?)`
      )
      .run("raw-default", "Raw default", now, now, null, null);

    await expect(db.getSessionForProfile("raw-default", "default")).resolves.toEqual(
      expect.objectContaining({
        id: "raw-default",
        profileId: "default"
      })
    );
  });
});
