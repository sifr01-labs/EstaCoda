import { describe, expect, it } from "vitest";
import { InMemorySessionDB } from "./in-memory-session-db.js";

describe("InMemorySessionDB", () => {
  it("sets, reads, and clears a typed session model override", async () => {
    const db = new InMemorySessionDB({
      now: () => new Date("2030-01-01T00:00:00.000Z")
    });
    await db.createSession({ id: "session-1", profileId: "profile", metadata: { keep: true } });

    await db.setSessionModelOverride("session-1", sampleOverride());

    await expect(db.getSessionModelOverride("session-1")).resolves.toMatchObject({
      route: { provider: "local", id: "phi4:latest", maxTokens: 8192 },
      source: "cli"
    });
    await expect(db.getSession("session-1")).resolves.toMatchObject({
      metadata: {
        keep: true,
        sessionModelOverride: expect.objectContaining({
          route: expect.objectContaining({ provider: "local", id: "phi4:latest" })
        })
      }
    });
    await expect(db.listEvents("session-1")).resolves.toEqual([{
      kind: "context-window-usage-invalidated",
      reason: "model-change"
    }]);

    await db.clearSessionModelOverride("session-1");

    await expect(db.getSessionModelOverride("session-1")).resolves.toBeUndefined();
    await expect(db.getSession("session-1")).resolves.toMatchObject({
      metadata: { keep: true }
    });
    await expect(db.listEvents("session-1")).resolves.toEqual([
      { kind: "context-window-usage-invalidated", reason: "model-change" },
      { kind: "context-window-usage-invalidated", reason: "model-change" }
    ]);
  });

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

  it("keeps child sessions searchable by default and filters them when root sessions are requested", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({ id: "root-session", profileId: "profile" });
    await db.createSession({ id: "child-session", profileId: "profile", parentSessionId: "root-session" });
    await db.createSession({ id: "other-profile-root", profileId: "other" });
    await db.appendMessage({
      id: "root-message",
      sessionId: "root-session",
      role: "user",
      content: "rootonly searchable marker"
    });
    await db.appendMessage({
      id: "child-message",
      sessionId: "child-session",
      role: "user",
      content: "rootonly searchable marker"
    });
    await db.appendMessage({
      id: "other-message",
      sessionId: "other-profile-root",
      role: "user",
      content: "rootonly searchable marker"
    });

    const defaultResults = await db.search("rootonly searchable", { profileId: "profile", limit: 10 });
    expect(defaultResults.map((result) => result.session.id).sort()).toEqual(["child-session", "root-session"]);

    const rootOnlyResults = await db.search("rootonly searchable", {
      profileId: "profile",
      rootSessionsOnly: true,
      limit: 10
    });
    expect(rootOnlyResults.map((result) => result.session.id)).toEqual(["root-session"]);
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
      ],
      events: [{ kind: "context-window-usage-invalidated", reason: "compaction" }]
    });

    expect(rewritten.map((message) => message.id)).toEqual(["generated-1", "supplied"]);
    expect(rewritten.map((message) => message.createdAt)).toEqual([
      "2030-01-01T00:00:00.000Z",
      "2030-01-01T00:00:10.000Z"
    ]);
    await expect(db.listMessages("session-1")).resolves.toEqual(rewritten);
    await expect(db.listEvents("session-1")).resolves.toEqual([{
      kind: "context-window-usage-invalidated",
      reason: "compaction"
    }]);
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

function sampleOverride() {
  return {
    route: {
      provider: "local" as const,
      id: "phi4:latest",
      baseUrl: "http://localhost:11434/v1",
      apiMode: "custom_openai_compatible" as const,
      authMethod: "none" as const,
      contextWindowTokens: 128000,
      maxTokens: 8192
    },
    modelProfile: {
      id: "phi4:latest",
      provider: "local" as const,
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    },
    setAt: "2030-01-01T00:00:00.000Z",
    source: "cli" as const
  };
}
