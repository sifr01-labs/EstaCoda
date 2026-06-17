import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteSessionDB } from "./sqlite-session-db.js";
import { reconstructSessionCompressionState } from "./session-compression-state.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";

describe("SQLiteSessionDB", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "estacoda-session-db-test-"));
    dbPath = join(tmpDir, "sessions.sqlite");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates sessions and messages through the internal SQLite adapter", async () => {
    const db = new SQLiteSessionDB({
      path: dbPath,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      id: () => "fixed-id"
    });

    try {
      const session = await db.createSession({ id: "session-1", profileId: "default", title: "Adapter session" });
      const message = await db.appendMessage({
        id: "message-1",
        sessionId: session.id,
        role: "user",
        content: "adapter-backed search text"
      });

      expect(session.profileId).toBe("default");
      expect(message.sessionId).toBe("session-1");
      await expect(db.listMessages("session-1")).resolves.toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("round-trips provider execution metadata on messages", async () => {
    const db = new SQLiteSessionDB({ path: dbPath });
    try {
      await db.createSession({ id: "session-1", profileId: "default" });
      await db.appendMessage({
        id: "message-1",
        sessionId: "session-1",
        role: "agent",
        content: "fallback answer",
        metadata: {
          provider: "deepseek/deepseek-v4-pro",
          providerFallbackUsed: true,
          providerPrimaryFailureClass: "rate-limit",
          providerExecution: {
            configuredPrimary: { provider: "kimi", model: "kimi-k2.7-code" },
            actual: { provider: "deepseek", model: "deepseek-v4-pro" },
            fallbackUsed: true,
            primaryFailureClass: "rate-limit",
            status: "fallback-success",
            attempts: [
              {
                provider: "kimi",
                model: "kimi-k2.7-code",
                ok: false,
                errorClass: "rate-limit",
                routeRole: "primary",
                attemptedRouteIndex: 0
              },
              {
                provider: "deepseek",
                model: "deepseek-v4-pro",
                ok: true,
                routeRole: "fallback",
                attemptedRouteIndex: 1
              }
            ]
          }
        }
      });

      const messages = await db.listMessages("session-1");
      expect(messages[0]?.metadata).toMatchObject({
        provider: "deepseek/deepseek-v4-pro",
        providerFallbackUsed: true,
        providerPrimaryFailureClass: "rate-limit",
        providerExecution: {
          configuredPrimary: { provider: "kimi", model: "kimi-k2.7-code" },
          actual: { provider: "deepseek", model: "deepseek-v4-pro" },
          fallbackUsed: true,
          primaryFailureClass: "rate-limit",
          status: "fallback-success",
          attempts: [
            {
              provider: "kimi",
              model: "kimi-k2.7-code",
              ok: false,
              errorClass: "rate-limit",
              routeRole: "primary",
              attemptedRouteIndex: 0
            },
            {
              provider: "deepseek",
              model: "deepseek-v4-pro",
              ok: true,
              routeRole: "fallback",
              attemptedRouteIndex: 1
            }
          ]
        }
      });
    } finally {
      db.close();
    }
  });

  it("persists a typed session model override in session metadata", async () => {
    const db = new SQLiteSessionDB({ path: dbPath });
    try {
      await db.createSession({ id: "session-1", profileId: "default", metadata: { keep: true } });
      await db.setSessionModelOverride("session-1", sampleOverride());

      await expect(db.getSessionModelOverride("session-1")).resolves.toMatchObject({
        route: { provider: "local", id: "phi4:latest", maxTokens: 8192 },
        source: "cli"
      });
    } finally {
      db.close();
    }

    const reopened = new SQLiteSessionDB({ path: dbPath });
    try {
      await expect(reopened.getSessionModelOverride("session-1")).resolves.toMatchObject({
        route: { provider: "local", id: "phi4:latest", maxTokens: 8192 },
        source: "cli"
      });
      await reopened.clearSessionModelOverride("session-1");
      await expect(reopened.getSessionModelOverride("session-1")).resolves.toBeUndefined();
      await expect(reopened.getSession("session-1")).resolves.toMatchObject({
        metadata: { keep: true }
      });
    } finally {
      reopened.close();
    }
  });

  it("round-trips session lineage and ended fields", async () => {
    const db = new SQLiteSessionDB({
      path: dbPath,
      now: () => new Date("2030-01-01T00:00:00.000Z")
    });

    try {
      const parent = await db.createSession({
        id: "parent-session",
        profileId: "default",
        title: "Parent",
        endedAt: "2030-01-01T00:00:10.000Z",
        endReason: "compression"
      });
      const child = await db.createSession({
        id: "child-session",
        profileId: "default",
        parentSessionId: parent.id,
        endedAt: "2030-01-01T00:00:20.000Z",
        endReason: "manual-test"
      });

      await expect(db.getSession("child-session")).resolves.toMatchObject({
        id: "child-session",
        parentSessionId: "parent-session",
        endedAt: "2030-01-01T00:00:20.000Z",
        endReason: "manual-test"
      });
      await expect(db.listSessions("default")).resolves.toContainEqual(expect.objectContaining({
        id: child.id,
        parentSessionId: "parent-session",
        endedAt: "2030-01-01T00:00:20.000Z",
        endReason: "manual-test"
      }));
    } finally {
      db.close();
    }
  });

  it("keeps child sessions searchable by default and filters them when root sessions are requested", async () => {
    const db = new SQLiteSessionDB({ path: dbPath });
    try {
      await db.createSession({ id: "root-session", profileId: "default" });
      await db.createSession({ id: "child-session", profileId: "default", parentSessionId: "root-session" });
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

      const defaultResults = await db.search("rootonly searchable", { profileId: "default", limit: 10 });
      expect(defaultResults.map((result) => result.session.id).sort()).toEqual(["child-session", "root-session"]);

      const rootOnlyResults = await db.search("rootonly searchable", {
        profileId: "default",
        rootSessionsOnly: true,
        limit: 10
      });
      expect(rootOnlyResults.map((result) => result.session.id)).toEqual(["root-session"]);
    } finally {
      db.close();
    }
  });

  it("migrates existing session DBs without ended columns", async () => {
    const legacy = openDefaultSQLiteDatabase({ path: dbPath });
    try {
      legacy.exec(`
        create table sessions (
          id text primary key,
          profile_id text not null default 'default',
          title text,
          created_at text not null,
          updated_at text not null,
          parent_session_id text,
          metadata_json text
        );
        create table schema_version (version integer primary key);
        insert into schema_version (version) values (5);
        insert into sessions (
          id, profile_id, title, created_at, updated_at, parent_session_id, metadata_json
        ) values (
          'legacy-child', 'default', 'Legacy child',
          '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z',
          'legacy-parent', null
        );
      `);
    } finally {
      legacy.close();
    }

    const migrated = new SQLiteSessionDB({ path: dbPath });
    try {
      const session = await migrated.getSession("legacy-child");
      expect(session).toMatchObject({
        id: "legacy-child",
        parentSessionId: "legacy-parent"
      });
      expect(session?.endedAt).toBeUndefined();
      expect(session?.endReason).toBeUndefined();

      await migrated.endSession("legacy-child", "compression");
      await expect(migrated.getSession("legacy-child")).resolves.toMatchObject({
        endedAt: expect.any(String),
        endReason: "compression"
      });
    } finally {
      migrated.close();
    }
  });

  it("opens an existing DB and preserves FTS search behavior", async () => {
    const first = new SQLiteSessionDB({ path: dbPath });
    try {
      const session = await first.createSession({ id: "session-1", profileId: "default" });
      await first.appendMessage({
        id: "message-1",
        sessionId: session.id,
        role: "agent",
        content: "needle phrase for ranked retrieval"
      });
    } finally {
      first.close();
    }

    const reopened = new SQLiteSessionDB({ path: dbPath });
    try {
      const results = await reopened.search("needle", { profileId: "default" });
      expect(results).toHaveLength(1);
      expect(results[0].message.id).toBe("message-1");
      expect(typeof results[0].score).toBe("number");
    } finally {
      reopened.close();
    }
  });

  it("requires an existing session before replacing messages", async () => {
    const db = new SQLiteSessionDB({ path: dbPath });
    try {
      await expect(db.replaceMessages({
        sessionId: "missing-session",
        messages: [{ role: "user", content: "replacement" }]
      })).rejects.toThrow("Session not found: missing-session");
    } finally {
      db.close();
    }
  });

  it("marks sessions ended without deleting messages and keeps the first end reason", async () => {
    const times = [
      "2030-01-01T00:00:00.000Z",
      "2030-01-01T00:00:01.000Z",
      "2030-01-01T00:00:02.000Z",
      "2030-01-01T00:00:03.000Z"
    ];
    const db = new SQLiteSessionDB({
      path: dbPath,
      now: () => new Date(times.shift() ?? "2030-01-01T00:00:09.000Z")
    });

    try {
      await db.createSession({ id: "session-1", profileId: "default" });
      await db.appendMessage({
        id: "message-1",
        sessionId: "session-1",
        role: "user",
        content: "ended sessions stay searchable"
      });

      await db.endSession("session-1", "compression");
      await db.endSession("session-1", "second-call");

      await expect(db.getSession("session-1")).resolves.toMatchObject({
        endedAt: "2030-01-01T00:00:03.000Z",
        endReason: "compression"
      });
      await expect(db.listMessages("session-1")).resolves.toHaveLength(1);
      const results = await db.search("searchable", { profileId: "default" });
      expect(results).toHaveLength(1);
      expect(results[0].session).toMatchObject({
        id: "session-1",
        endedAt: "2030-01-01T00:00:03.000Z",
        endReason: "compression"
      });
    } finally {
      db.close();
    }
  });

  it("requires an existing session before rewriting a transcript", async () => {
    const db = new SQLiteSessionDB({ path: dbPath });
    try {
      await expect(db.rewriteTranscript({
        sessionId: "missing-session",
        messages: [{ role: "user", content: "replacement" }]
      })).rejects.toThrow("Session not found: missing-session");
    } finally {
      db.close();
    }
  });

  it("rewrites transcripts transactionally while preserving timestamps and FTS", async () => {
    const db = new SQLiteSessionDB({
      path: dbPath,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      id: (() => {
        let next = 0;
        return () => `rewrite-${++next}`;
      })()
    });

    try {
      await db.createSession({ id: "session-1", profileId: "default" });
      await db.appendMessage({ id: "old-1", sessionId: "session-1", role: "user", content: "old rewrite searchable" });

      const rewritten = await db.rewriteTranscript({
        sessionId: "session-1",
        messages: [
          { role: "user", content: "new rewrite alpha" },
          { id: "supplied", role: "agent", content: "new rewrite beta", createdAt: "2030-01-01T00:00:10.000Z" }
        ]
      });

      expect(rewritten.map((message) => message.id)).toEqual(["rewrite-1", "supplied"]);
      expect(rewritten.map((message) => message.createdAt)).toEqual([
        "2030-01-01T00:00:00.000Z",
        "2030-01-01T00:00:10.000Z"
      ]);
      await expect(db.search("old", { profileId: "default" })).resolves.toHaveLength(0);
      await expect(db.search("alpha", { profileId: "default" })).resolves.toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("rolls back messages and FTS rows when transcript rewrite fails", async () => {
    const db = new SQLiteSessionDB({ path: dbPath });

    try {
      await db.createSession({ id: "session-1", profileId: "default" });
      await db.appendMessage({
        id: "old-1",
        sessionId: "session-1",
        role: "user",
        content: "old rewrite rollback searchable"
      });

      await expect(db.rewriteTranscript({
        sessionId: "session-1",
        messages: [
          { id: "duplicate", role: "user", content: "new rewrite should rollback" },
          { id: "duplicate", role: "agent", content: "new rewrite should also rollback" }
        ]
      })).rejects.toThrow();

      const messages = await db.listMessages("session-1");
      expect(messages.map((message) => message.id)).toEqual(["old-1"]);
      await expect(db.search("rollback", { profileId: "default" })).resolves.toHaveLength(1);
      await expect(db.search("should", { profileId: "default" })).resolves.toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("transactionally replaces messages and FTS rows in stable order", async () => {
    const db = new SQLiteSessionDB({
      path: dbPath,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      id: (() => {
        let next = 0;
        return () => `generated-${++next}`;
      })()
    });

    try {
      await db.createSession({ id: "session-1", profileId: "default" });
      await db.appendMessage({ id: "old-1", sessionId: "session-1", role: "user", content: "old searchable content" });

      const replacement = await db.replaceMessages({
        sessionId: "session-1",
        messages: [
          {
            role: "tool",
            content: "new beta content",
            channel: "cli",
            metadata: {
              tool_call_id: "call-tool",
              tool_call_name: "memory.lookup",
              provider_native_tool_call: { id: "provider-call", type: "function" }
            }
          },
          {
            role: "agent",
            content: "new gamma content"
          },
          {
            id: "new-1",
            role: "user",
            content: "new alpha content",
            createdAt: "2030-01-01T00:00:10.000Z",
            metadata: {
              tool_call_id: "call-user",
              tool_call_name: "memory.lookup"
            }
          }
        ]
      });

      expect(replacement.map((message) => message.id)).toEqual(["generated-1", "generated-2", "new-1"]);
      expect(replacement.map((message) => message.createdAt)).toEqual([
        "2030-01-01T00:00:00.000Z",
        "2030-01-01T00:00:00.001Z",
        "2030-01-01T00:00:10.000Z"
      ]);

      const messages = await db.listMessages("session-1");
      expect(messages.map((message) => message.content)).toEqual([
        "new beta content",
        "new gamma content",
        "new alpha content"
      ]);
      expect(messages[0]?.metadata).toMatchObject({
        tool_call_id: "call-tool",
        tool_call_name: "memory.lookup",
        provider_native_tool_call: { id: "provider-call", type: "function" }
      });

      await expect(db.search("old", { profileId: "default" })).resolves.toHaveLength(0);
      const newResults = await db.search("beta", { profileId: "default" });
      expect(newResults.map((result) => result.message.id)).toEqual(["generated-1"]);
    } finally {
      db.close();
    }
  });

  it("rolls back messages and FTS rows when replacement insert fails", async () => {
    const db = new SQLiteSessionDB({ path: dbPath });

    try {
      await db.createSession({ id: "session-1", profileId: "default" });
      await db.appendMessage({
        id: "old-1",
        sessionId: "session-1",
        role: "user",
        content: "old rollback searchable"
      });

      await expect(db.replaceMessages({
        sessionId: "session-1",
        messages: [
          { id: "duplicate", role: "user", content: "new should rollback" },
          { id: "duplicate", role: "agent", content: "new should also rollback" }
        ]
      })).rejects.toThrow();

      const messages = await db.listMessages("session-1");
      expect(messages.map((message) => message.id)).toEqual(["old-1"]);
      expect(messages[0]?.content).toBe("old rollback searchable");
      await expect(db.search("rollback", { profileId: "default" })).resolves.toHaveLength(1);
      await expect(db.search("should", { profileId: "default" })).resolves.toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("reconstructs compression state after reopening the session DB", async () => {
    const first = new SQLiteSessionDB({ path: dbPath });
    try {
      await first.createSession({ id: "session-1", profileId: "default" });
      await first.appendEvent("session-1", {
        kind: "session-compression-state",
        state: {
          status: "compressed",
          trigger: "manual",
          protectedFirstN: 3,
          protectedLastN: 20,
          protectedSpans: [],
          summaryFormatVersion: "session-summary.v1",
          summaryChars: 320,
          fallbackUsed: false,
          warnings: []
        }
      });
    } finally {
      first.close();
    }

    const reopened = new SQLiteSessionDB({ path: dbPath });
    try {
      const state = reconstructSessionCompressionState(await reopened.listEvents("session-1"));
      expect(state).toMatchObject({
        status: "compressed",
        trigger: "manual",
        protectedFirstN: 3,
        protectedLastN: 20,
        summaryFormatVersion: "session-summary.v1",
        summaryChars: 320,
        fallbackUsed: false
      });
    } finally {
      reopened.close();
    }
  });

  it("lists same-timestamp session events in insertion order", async () => {
    const db = new SQLiteSessionDB({
      path: dbPath,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      id: (() => {
        let next = 0;
        return () => `event-${++next}`;
      })()
    });

    try {
      await db.createSession({ id: "session-1", profileId: "default" });
      await db.appendEvent("session-1", {
        kind: "session-history-compressed",
        trigger: "auto",
        source: { messageCount: 10 },
        protectedFirstN: 3,
        protectedLastN: 20,
        summaryFormatVersion: "session-summary.v1",
        summaryChars: 128
      });
      await db.appendEvent("session-1", {
        kind: "session-compression-state",
        state: {
          status: "compressed",
          trigger: "auto",
          compressionCount: 1,
          protectedFirstN: 3,
          protectedLastN: 20,
          protectedSpans: [],
          summaryFormatVersion: "session-summary.v1",
          summaryChars: 128,
          fallbackUsed: false,
          warnings: []
        }
      });
      await db.appendEvent("session-1", {
        kind: "external-memory-recall",
        providerIds: ["file"],
        enabled: true,
        attempted: true,
        resultCount: 0,
        totalChars: 0,
        workspaceScoped: false,
        warningCount: 0,
        failureCount: 0
      });

      const events = await db.listEvents("session-1");

      expect(events.map((event) => event.kind)).toEqual([
        "session-history-compressed",
        "session-compression-state",
        "external-memory-recall"
      ]);
    } finally {
      db.close();
    }
  });

  it("hydrates the last inserted same-timestamp session-compression-state event", async () => {
    const db = new SQLiteSessionDB({
      path: dbPath,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      id: (() => {
        let next = 0;
        return () => `event-${++next}`;
      })()
    });

    try {
      await db.createSession({ id: "session-1", profileId: "default" });
      await db.appendEvent("session-1", {
        kind: "session-compression-state",
        state: {
          status: "compressed",
          trigger: "auto",
          compressionCount: 1,
          ineffectiveCompressionCount: 1,
          protectedFirstN: 3,
          protectedLastN: 20,
          protectedSpans: [],
          summaryFormatVersion: "session-summary.v1",
          summaryChars: 128,
          fallbackUsed: false,
          warnings: ["older state"]
        }
      });
      await db.appendEvent("session-1", {
        kind: "session-compression-state",
        state: {
          status: "compressed",
          trigger: "manual",
          compressionCount: 2,
          ineffectiveCompressionCount: 0,
          protectedFirstN: 4,
          protectedLastN: 30,
          protectedSpans: [],
          summaryFormatVersion: "session-summary.v1",
          summaryChars: 256,
          fallbackUsed: true,
          fallbackReason: "deterministic-packing",
          warnings: ["newer state"]
        }
      });

      const state = reconstructSessionCompressionState(await db.listEvents("session-1"));

      expect(state).toMatchObject({
        status: "compressed",
        trigger: "manual",
        compressionCount: 2,
        ineffectiveCompressionCount: 0,
        protectedFirstN: 4,
        protectedLastN: 30,
        summaryChars: 256,
        fallbackUsed: true,
        fallbackReason: "deterministic-packing",
        warnings: ["newer state"]
      });
    } finally {
      db.close();
    }
  });

  it("lists same-timestamp profile-scoped session events in insertion order", async () => {
    const db = new SQLiteSessionDB({
      path: dbPath,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      id: (() => {
        let next = 0;
        return () => `event-${++next}`;
      })()
    });

    try {
      await db.createSession({ id: "session-1", profileId: "default" });
      await db.appendEvent("session-1", {
        kind: "session-history-packed",
        sourceMessageCount: 10,
        summarizedMessageCount: 4,
        protectedMessageCount: 6,
        estimatedTokens: 900
      });
      await db.appendEvent("session-1", {
        kind: "session-history-compressed",
        trigger: "manual",
        source: { messageCount: 10 },
        protectedFirstN: 3,
        protectedLastN: 20,
        summaryFormatVersion: "session-summary.v1",
        summaryChars: 128
      });
      await db.appendEvent("session-1", {
        kind: "session-compression-state",
        state: {
          status: "compressed",
          trigger: "manual",
          compressionCount: 1,
          protectedFirstN: 3,
          protectedLastN: 20,
          protectedSpans: [],
          summaryFormatVersion: "session-summary.v1",
          summaryChars: 128,
          fallbackUsed: false,
          warnings: []
        }
      });

      const events = await db.listEventsForProfile("session-1", "default");

      expect(events.map((event) => event.kind)).toEqual([
        "session-history-packed",
        "session-history-compressed",
        "session-compression-state"
      ]);
    } finally {
      db.close();
    }
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
