import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCliCommand } from "./cli.js";
import { FileSurfacePointerStore } from "../channels/surface-pointer-store.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { SESSION_RECALL_UNTRUSTED_NOTICE } from "../session/session-recall-service.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-cli-sess-test-"));
}

describe("CLI session commands", () => {
  let tmpDir: string;
  let stateRoot: string;
  let dbPath: string;
  let surfacePointerPath: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    stateRoot = join(tmpDir, ".estacoda");
    await mkdir(stateRoot, { recursive: true });
    surfacePointerPath = join(resolveProfileStateHome({ homeDir: tmpDir, profileId: "default" }).gatewayStatePath, "surface-pointers.json");
    dbPath = join(stateRoot, "sessions.sqlite");
    const db = openDefaultSQLiteDatabase({ path: dbPath });
    db.exec(`
      create table if not exists sessions (
        id text primary key,
        profile_id text not null,
        title text,
        created_at text not null,
        updated_at text,
        parent_session_id text,
        metadata_json text
      )
    `);
    db.exec(`
      create table if not exists messages (
        id text primary key,
        session_id text not null,
        role text not null,
        content text not null,
        created_at text not null,
        channel text,
        metadata_json text
      )
    `);
    db.exec(`
      create virtual table if not exists messages_fts using fts5(
        message_id unindexed,
        content,
        tokenize = 'unicode61'
      )
    `);
    db.exec(`
      create table if not exists session_events (
        id text primary key,
        session_id text not null,
        created_at text not null,
        event_json text not null
      )
    `);
    db.close();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("sessions list", () => {
    it("lists sessions", async () => {
      const db = openDefaultSQLiteDatabase({ path: dbPath });
      db.query("insert into sessions (id, profile_id, title, created_at, updated_at) values (?, ?, ?, ?, ?)")
        .run("sess-1", "default", "Test Session", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z");
      db.close();

      const result = await runCliCommand({
        argv: ["sessions", "list"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });
      expect(result.handled).toBe(true);
      expect(result.output).toContain("sess-1");
      expect(result.output).toContain("Test Session");
    });

    it("prepares the session DB file permissions before listing sessions", async () => {
      await chmod(dbPath, 0o644);

      const result = await runCliCommand({
        argv: ["sessions", "list"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.exitCode).toBe(0);
      if (process.platform !== "win32") {
        const stats = await stat(dbPath);
        expect(stats.mode & 0o777).toBe(0o600);
      }
    });

    it("shows surface pointers attached to sessions", async () => {
      const db = openDefaultSQLiteDatabase({ path: dbPath });
      db.query("insert into sessions (id, profile_id, title, created_at, updated_at) values (?, ?, ?, ?, ?)")
        .run("sess-1", "default", "Test Session", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z");
      db.close();

      const pointerStore = new FileSurfacePointerStore({ path: surfacePointerPath });
      await pointerStore.setPointer("telegram", "chat-1", { sessionId: "sess-1", attachedAt: "2024-01-01T00:00:00Z" });

      const result = await runCliCommand({
        argv: ["sessions", "list"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });
      expect(result.handled).toBe(true);
      expect(result.output).toContain("telegram:chat-1");
    });
  });

  describe("sessions show", () => {
    it("shows session details", async () => {
      const db = openDefaultSQLiteDatabase({ path: dbPath });
      db.query("insert into sessions (id, profile_id, title, created_at, updated_at) values (?, ?, ?, ?, ?)")
        .run("sess-1", "default", "Test Session", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z");
      db.query("insert into messages (id, session_id, role, content, created_at) values (?, ?, ?, ?, ?)")
        .run("msg-1", "sess-1", "user", "hello", "2024-01-01T00:00:00Z");
      db.close();

      const result = await runCliCommand({
        argv: ["sessions", "show", "sess-1"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });
      expect(result.handled).toBe(true);
      expect(result.output).toContain("sess-1");
      expect(result.output).toContain("Test Session");
      expect(result.output).toContain("Messages: 1");
    });

    it("returns error for missing session", async () => {
      const result = await runCliCommand({
        argv: ["sessions", "show", "missing"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("not found");
    });

    it("shows surface pointers for session", async () => {
      const db = openDefaultSQLiteDatabase({ path: dbPath });
      db.query("insert into sessions (id, profile_id, title, created_at, updated_at) values (?, ?, ?, ?, ?)")
        .run("sess-1", "default", "Test Session", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z");
      db.close();

      const pointerStore = new FileSurfacePointerStore({ path: surfacePointerPath });
      await pointerStore.setPointer("telegram", "chat-1", { sessionId: "sess-1", attachedAt: "2024-01-01T00:00:00Z" });

      const result = await runCliCommand({
        argv: ["sessions", "show", "sess-1"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });
      expect(result.handled).toBe(true);
      expect(result.output).toContain("Surface pointers");
      expect(result.output).toContain("telegram:chat-1");
    });
  });

  describe("sessions current", () => {
    it("shows current runtime session", async () => {
      const result = await runCliCommand({
        argv: ["sessions", "current"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        runtime: { sessionId: "runtime-sess-1" } as any
      });
      expect(result.handled).toBe(true);
      expect(result.output).toContain("runtime-sess-1");
    });

    it("returns error when no runtime", async () => {
      const result = await runCliCommand({
        argv: ["sessions", "current"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("No active session");
    });
  });

  describe("sessions recall", () => {
    it("returns bounded historical recall through the manual CLI surface", async () => {
      const db = openDefaultSQLiteDatabase({ path: dbPath });
      db.query("insert into sessions (id, profile_id, title, created_at, updated_at, metadata_json) values (?, ?, ?, ?, ?, ?)")
        .run(
          "sess-recall",
          "default",
          "Recall Session",
          "2024-01-01T00:00:00Z",
          "2024-01-02T00:00:00Z",
          JSON.stringify({ workspaceRoot: tmpDir })
        );
      db.query("insert into messages (id, session_id, role, content, created_at) values (?, ?, ?, ?, ?)")
        .run("msg-recall", "sess-recall", "user", "alpha durable recall detail", "2024-01-01T00:00:00Z");
      db.query("insert into messages_fts(rowid, message_id, content) values ((select rowid from messages where id = ?), ?, ?)")
        .run("msg-recall", "msg-recall", "alpha durable recall detail");
      db.close();

      const result = await runCliCommand({
        argv: ["session", "recall", "alpha"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Session recall for \"alpha\"");
      expect(result.output).toContain(SESSION_RECALL_UNTRUSTED_NOTICE);
      expect(result.output).toContain("Source session sess-recall");
      expect(result.output).toContain("alpha durable recall detail");
      expect(result.output).toContain("Summary mode: deterministic snippets");
    });

    it("uses auxiliary session_search summarization when configured", async () => {
      const profilePaths = resolveProfileStateHome({ homeDir: tmpDir, profileId: "default" });
      await mkdir(profilePaths.profileRoot, { recursive: true });
      await writeFile(profilePaths.configPath, JSON.stringify({
        model: {
          provider: "recalltest",
          id: "recall-model"
        },
        providers: {
          recalltest: {
            baseUrl: "https://recall.test/v1",
            enableNetwork: true,
            models: ["recall-model"]
          }
        },
        auxiliaryModels: {
          session_search: {
            provider: "recalltest",
            id: "recall-model",
            enabled: true
          }
        }
      }), "utf8");

      const db = openDefaultSQLiteDatabase({ path: dbPath });
      db.query("insert into sessions (id, profile_id, title, created_at, updated_at, metadata_json) values (?, ?, ?, ?, ?, ?)")
        .run(
          "sess-recall-aux",
          "default",
          "Aux Recall Session",
          "2024-01-01T00:00:00Z",
          "2024-01-02T00:00:00Z",
          JSON.stringify({ workspaceRoot: tmpDir })
        );
      db.query("insert into messages (id, session_id, role, content, created_at) values (?, ?, ?, ?, ?)")
        .run("msg-recall-aux", "sess-recall-aux", "user", "alpha auxiliary recall detail", "2024-01-01T00:00:00Z");
      db.query("insert into messages_fts(rowid, message_id, content) values ((select rowid from messages where id = ?), ?, ?)")
        .run("msg-recall-aux", "msg-recall-aux", "alpha auxiliary recall detail");
      db.close();

      const result = await runCliCommand({
        argv: ["sessions", "recall", "alpha"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        providerFetch: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({ summary: "auxiliary summary from top-level recall" })
                }
              }
            ]
          }),
          text: async () => "",
          body: null
        })
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("auxiliary summary from top-level recall");
      expect(result.output).not.toContain("Summary mode: deterministic snippets");
    });
  });

  describe("sessions compact", () => {
    it("compacts a session through the shared runtime service path", async () => {
      const calls: Array<{ sessionId?: string; focusTopic?: string; preserveTranscript?: boolean }> = [];
      const result = await runCliCommand({
        argv: ["sessions", "compact", "sess-compact", "--topic", "handoff notes"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        runtime: {
          sessionId: "active-session",
          compactSession: async (input?: { sessionId?: string; focusTopic?: string; preserveTranscript?: boolean }) => {
            calls.push(input ?? {});
            return compactResult();
          }
        } as any
      });

      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(calls).toEqual([{ sessionId: "sess-compact", focusTopic: "handoff notes", preserveTranscript: false }]);
      expect(result.output).toContain("Compacted 8 messages -> 4 messages");
      expect(result.output).toContain("Token estimate: 2000 -> 900");
      expect(result.output).toContain("Focus topic: handoff notes");
    });

    it("fails clearly for missing or invalid session ids", async () => {
      const missing = await runCliCommand({
        argv: ["sessions", "compact"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        runtime: { sessionId: "active-session", compactSession: async () => compactResult() } as any
      });
      expect(missing.exitCode).toBe(1);
      expect(missing.output).toContain("Usage: estacoda sessions compact <session-id>");

      const invalid = await runCliCommand({
        argv: ["sessions", "compact", "missing-session"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        runtime: {
          sessionId: "active-session",
          compactSession: async () => {
            throw new Error("Session not found: missing-session");
          }
        } as any
      });
      expect(invalid.exitCode).toBe(1);
      expect(invalid.output).toContain("Session compaction failed: Session not found: missing-session");
    });

    it("surfaces deterministic fallback warnings", async () => {
      const result = await runCliCommand({
        argv: ["sessions", "compact", "sess-fallback"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        runtime: {
          sessionId: "active-session",
          compactSession: async () => compactResult({
            fallbackUsed: true,
            fallbackReason: "failed",
            warnings: ["auxiliary compression failed; used deterministic fallback"]
          })
        } as any
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Warning: fallback summary used (failed)");
      expect(result.output).toContain("Warning: auxiliary compression failed; used deterministic fallback");
    });
  });

  describe("sessions attach", () => {
    it("attaches surface to session", async () => {
      const db = openDefaultSQLiteDatabase({ path: dbPath });
      db.query("insert into sessions (id, profile_id, title, created_at, updated_at) values (?, ?, ?, ?, ?)")
        .run("sess-1", "default", "Test Session", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z");
      db.close();

      const result = await runCliCommand({
        argv: ["sessions", "attach", "telegram", "chat-1", "sess-1"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });
      expect(result.handled).toBe(true);
      expect(result.output).toContain("Attached telegram:chat-1 to session sess-1");

      const pointerStore = new FileSurfacePointerStore({ path: surfacePointerPath });
      const pointer = await pointerStore.getPointer("telegram", "chat-1");
      expect(pointer?.sessionId).toBe("sess-1");
    });

    it("returns error for invalid surface", async () => {
      const result = await runCliCommand({
        argv: ["sessions", "attach", "invalid", "chat-1", "sess-1"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Invalid surface");
    });

    it("returns error for missing args", async () => {
      const result = await runCliCommand({
        argv: ["sessions", "attach", "telegram"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Usage:");
    });
  });

  describe("sessions detach", () => {
    it("detaches surface from session", async () => {
      const pointerStore = new FileSurfacePointerStore({ path: surfacePointerPath });
      await pointerStore.setPointer("telegram", "chat-1", { sessionId: "sess-1", attachedAt: "2024-01-01T00:00:00Z" });

      const result = await runCliCommand({
        argv: ["sessions", "detach", "telegram", "chat-1"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });
      expect(result.handled).toBe(true);
      expect(result.output).toContain("Detached telegram:chat-1");

      const pointerStore2 = new FileSurfacePointerStore({ path: surfacePointerPath });
      const pointer = await pointerStore2.getPointer("telegram", "chat-1");
      expect(pointer).toBeUndefined();
    });

    it("returns error for invalid surface", async () => {
      const result = await runCliCommand({
        argv: ["sessions", "detach", "invalid", "chat-1"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Invalid surface");
    });
  });

  describe("read-only status commands do not mutate sessions", () => {
    it("sessions list does not create or modify sessions", async () => {
      const db = openDefaultSQLiteDatabase({ path: dbPath });
      db.query("insert into sessions (id, profile_id, title, created_at, updated_at) values (?, ?, ?, ?, ?)")
        .run("sess-1", "default", "Test", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z");
      db.close();

      await runCliCommand({
        argv: ["sessions", "list"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      const db2 = openDefaultSQLiteDatabase({ path: dbPath });
      const rows = db2.query("select * from sessions where id = ?").all("sess-1") as any[];
      db2.close();
      expect(rows.length).toBe(1);
      expect(rows[0].title).toBe("Test");
      expect(rows[0].updated_at).toBe("2024-01-02T00:00:00Z");
    });
  });
});

function compactResult(overrides: {
  fallbackUsed?: boolean;
  fallbackReason?: string;
  warnings?: string[];
} = {}) {
  return {
    didCompress: true,
    messages: [
      { id: "m1", role: "user", content: "head" },
      { id: "summary", role: "system", content: "summary", metadata: { semanticCompression: true } },
      { id: "m7", role: "agent", content: "tail" },
      { id: "m8", role: "user", content: "latest" }
    ],
    diagnostics: {
      shouldCompress: true,
      reason: "forced",
      preTokens: 2000,
      postTokens: 900,
      estimatedSavingsTokens: 1100,
      estimatedSavingsRatio: 0.55,
      sourceMessageCount: 8,
      summarizedMessageCount: 4,
      protectedMessageCount: 4,
      protectedFirstN: 1,
      protectedLastN: 1,
      protectedSpans: [],
      protectedCategories: [],
      summaryFormatVersion: "v1",
      summaryChars: 100,
      fallbackUsed: overrides.fallbackUsed ?? false,
      fallbackReason: overrides.fallbackReason,
      warnings: overrides.warnings ?? [],
      eventWarnings: [],
      prunedToolResults: 0,
      scopeKey: "profile:session",
      ineffectiveCompressionCount: 0
    },
    userFacingMessage: "Session history compacted"
  };
}
