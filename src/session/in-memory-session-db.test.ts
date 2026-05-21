import { describe, expect, it } from "vitest";
import { InMemorySessionDB } from "./in-memory-session-db.js";

describe("InMemorySessionDB", () => {
  it("round-trips session lineage and ended fields", async () => {
    const db = new InMemorySessionDB({
      now: () => new Date("2030-01-01T00:00:00.000Z")
    });

    await db.createSession({
      id: "parent-session",
      profileId: "profile",
      endedAt: "2030-01-01T00:00:10.000Z",
      endReason: "compression"
    });
    await db.createSession({
      id: "child-session",
      profileId: "profile",
      parentSessionId: "parent-session",
      endedAt: "2030-01-01T00:00:20.000Z",
      endReason: "manual-test"
    });

    await expect(db.getSession("child-session")).resolves.toMatchObject({
      id: "child-session",
      parentSessionId: "parent-session",
      endedAt: "2030-01-01T00:00:20.000Z",
      endReason: "manual-test"
    });
    await expect(db.listSessions("profile")).resolves.toContainEqual(expect.objectContaining({
      id: "child-session",
      parentSessionId: "parent-session",
      endedAt: "2030-01-01T00:00:20.000Z",
      endReason: "manual-test"
    }));
  });

  it("marks sessions ended without deleting messages and keeps the first end reason", async () => {
    const times = [
      "2030-01-01T00:00:00.000Z",
      "2030-01-01T00:00:01.000Z",
      "2030-01-01T00:00:02.000Z",
      "2030-01-01T00:00:03.000Z",
      "2030-01-01T00:00:04.000Z"
    ];
    const db = new InMemorySessionDB({
      now: () => new Date(times.shift() ?? "2030-01-01T00:00:09.000Z")
    });

    await db.createSession({ id: "session-1", profileId: "profile" });
    await db.appendMessage({
      id: "message-1",
      sessionId: "session-1",
      role: "user",
      content: "ended in-memory sessions stay searchable"
    });

    await db.endSession("session-1", "compression");
    await db.endSession("session-1", "second-call");

    await expect(db.getSession("session-1")).resolves.toMatchObject({
      endedAt: "2030-01-01T00:00:03.000Z",
      endReason: "compression"
    });
    await expect(db.listMessages("session-1")).resolves.toHaveLength(1);
    const results = await db.search("searchable", { profileId: "profile" });
    expect(results).toHaveLength(1);
    expect(results[0].session).toMatchObject({
      id: "session-1",
      endedAt: "2030-01-01T00:00:03.000Z",
      endReason: "compression"
    });
  });

  it("rewrites transcripts with generated timestamps and preserves supplied timestamps", async () => {
    const db = new InMemorySessionDB({
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      id: (() => {
        let next = 0;
        return () => `generated-${++next}`;
      })()
    });

    await db.createSession({ id: "session-1", profileId: "profile" });
    await db.appendMessage({
      id: "old-1",
      sessionId: "session-1",
      role: "user",
      content: "old content"
    });

    const rewritten = await db.rewriteTranscript({
      sessionId: "session-1",
      messages: [
        { role: "user", content: "new alpha" },
        { id: "supplied", role: "agent", content: "new beta", createdAt: "2030-01-01T00:00:10.000Z" }
      ]
    });

    expect(rewritten.map((message) => message.id)).toEqual(["generated-1", "supplied"]);
    expect(rewritten.map((message) => message.createdAt)).toEqual([
      "2030-01-01T00:00:00.000Z",
      "2030-01-01T00:00:10.000Z"
    ]);
    await expect(db.listMessages("session-1")).resolves.toEqual(rewritten);
  });

  it("requires an existing session before ending or rewriting", async () => {
    const db = new InMemorySessionDB();

    await expect(db.endSession("missing", "compression")).rejects.toThrow("Session not found: missing");
    await expect(db.rewriteTranscript({
      sessionId: "missing",
      messages: [{ role: "user", content: "replacement" }]
    })).rejects.toThrow("Session not found: missing");
  });
});
