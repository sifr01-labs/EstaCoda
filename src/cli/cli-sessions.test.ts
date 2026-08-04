import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCliCommand } from "./cli.js";
import { FileSurfacePointerStore } from "../channels/surface-pointer-store.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { SESSION_RECALL_UNTRUSTED_NOTICE } from "../session/session-recall-service.js";
import type { Prompt } from "./prompt-contract.js";
import type { SelectPromptInput } from "./interactive-select.js";
import { InteractiveSelectCancelledError } from "./interactive-select.js";

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
        ended_at text,
        end_reason text,
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

  describe("sessions picker", () => {
    it("returns a workspace-scoped resume handoff for the selected session", async () => {
      const db = openDefaultSQLiteDatabase({ path: dbPath });
      seedPickerSession(db, {
        id: "sess-selected",
        profileId: "default",
        title: "Review Telegram deployment",
        workspaceRoot: tmpDir,
        originSurface: "telegram",
        updatedAt: "2026-08-04T10:00:00.000Z",
      });
      seedPickerSession(db, {
        id: "sess-other-workspace",
        profileId: "default",
        title: "Other workspace",
        workspaceRoot: "/other/workspace",
        updatedAt: "2026-08-04T11:00:00.000Z",
      });
      seedPickerSession(db, {
        id: "sess-internal",
        profileId: "default",
        title: "Internal task worker",
        workspaceRoot: tmpDir,
        kind: "task-step-worker",
        updatedAt: "2026-08-04T12:00:00.000Z",
      });
      db.close();

      let selection: SelectPromptInput<string> | undefined;
      const prompt = pickerPrompt(async (input) => {
        selection = input;
        return input.options[0]!.value;
      });
      const result = await runCliCommand({
        argv: ["sessions"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        interactive: true,
        prompt,
      });

      expect(result).toEqual(expect.objectContaining({
        handled: true,
        exitCode: 0,
        output: "",
        sessionHandoff: { sessionId: "sess-selected", workspaceRoot: tmpDir },
      }));
      expect(selection?.columns).toEqual([
        { key: "number", header: "#", align: "right" },
        { key: "session", header: "Session" },
        { key: "started", header: "Started" },
        { key: "active", header: "Last active" },
        { key: "origin", header: "Via" },
      ]);
      expect(selection?.options.map((option) => option.value)).toEqual(["sess-selected"]);
      expect(selection?.options[0]?.description).toContain("Via Telegram");
    });

    it("honors a command-local profile override", async () => {
      const db = openDefaultSQLiteDatabase({ path: dbPath });
      seedPickerSession(db, {
        id: "default-session",
        profileId: "default",
        title: "Default profile",
        workspaceRoot: tmpDir,
      });
      seedPickerSession(db, {
        id: "work-session",
        profileId: "work",
        title: "Work profile",
        workspaceRoot: tmpDir,
      });
      db.close();

      let optionValues: string[] = [];
      const result = await runCliCommand({
        argv: ["sessions"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        profileId: "work",
        interactive: true,
        prompt: pickerPrompt(async (input) => {
          optionValues = input.options.map((option) => option.value);
          return input.options[0]!.value;
        }),
      });

      expect(optionValues).toEqual(["work-session"]);
      expect(result.sessionHandoff?.sessionId).toBe("work-session");
    });

    it("returns a non-error empty state without prompting", async () => {
      let prompted = false;
      const result = await runCliCommand({
        argv: ["sessions"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        interactive: true,
        prompt: pickerPrompt(async () => {
          prompted = true;
          return "unexpected";
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("No resumable sessions");
      expect(result.sessionHandoff).toBeUndefined();
      expect(prompted).toBe(false);
    });

    it("keeps explicit sessions list non-interactive", async () => {
      const db = openDefaultSQLiteDatabase({ path: dbPath });
      seedPickerSession(db, {
        id: "sess-list",
        profileId: "default",
        title: "List only",
        workspaceRoot: tmpDir,
      });
      db.close();
      let prompted = false;

      const result = await runCliCommand({
        argv: ["sessions", "list"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        interactive: true,
        prompt: pickerPrompt(async () => {
          prompted = true;
          return "unexpected";
        }),
      });

      expect(result.output).toContain("sess-list");
      expect(result.sessionHandoff).toBeUndefined();
      expect(prompted).toBe(false);
    });

    it("treats Escape cancellation as a successful no-op", async () => {
      const db = openDefaultSQLiteDatabase({ path: dbPath });
      seedPickerSession(db, {
        id: "sess-cancel",
        profileId: "default",
        title: "Leave this session untouched",
        workspaceRoot: tmpDir,
      });
      db.close();

      const result = await runCliCommand({
        argv: ["sessions"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        interactive: true,
        prompt: pickerPrompt(async () => { throw new InteractiveSelectCancelledError(); }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Session selection cancelled");
      expect(result.sessionHandoff).toBeUndefined();
    });

    it("revalidates the selected session before returning a handoff", async () => {
      const db = openDefaultSQLiteDatabase({ path: dbPath });
      seedPickerSession(db, {
        id: "sess-stale",
        profileId: "default",
        title: "Session ending while the picker is open",
        workspaceRoot: tmpDir,
      });
      db.close();

      const result = await runCliCommand({
        argv: ["sessions"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
        interactive: true,
        prompt: pickerPrompt(async () => {
          const updateDb = openDefaultSQLiteDatabase({ path: dbPath });
          updateDb.query("update sessions set ended_at = ?, end_reason = ? where id = ?")
            .run("2026-08-04T12:00:00.000Z", "done", "sess-stale");
          updateDb.close();
          return "sess-stale";
        }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("no longer resumable");
      expect(result.sessionHandoff).toBeUndefined();
    });
  });

  describe("sessions open", () => {
    it("returns a handoff for an active session in the selected profile and workspace", async () => {
      const db = openDefaultSQLiteDatabase({ path: dbPath });
      seedPickerSession(db, {
        id: "sess-open",
        profileId: "default",
        title: "Continue deployment review",
        workspaceRoot: tmpDir,
        originSurface: "telegram",
      });
      db.close();
      const pointers = new FileSurfacePointerStore({ path: surfacePointerPath });
      await pointers.setPointer("telegram", "chat-1", {
        sessionId: "sess-open",
        attachedAt: "2026-08-01T08:00:00.000Z",
      });

      const result = await runCliCommand({
        argv: ["sessions", "open", "sess-open"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
      });

      expect(result).toEqual(expect.objectContaining({
        exitCode: 0,
        sessionHandoff: { sessionId: "sess-open", workspaceRoot: tmpDir },
      }));
      const verifyDb = openDefaultSQLiteDatabase({ path: dbPath });
      const row = verifyDb.query<{ metadata_json: string }>("select metadata_json from sessions where id = ?").get("sess-open");
      verifyDb.close();
      expect(JSON.parse(row!.metadata_json).originSurface).toBe("telegram");
      await expect(pointers.getPointer("telegram", "chat-1")).resolves.toMatchObject({ sessionId: "sess-open" });
    });

    it("rejects empty sessions", async () => {
      const db = openDefaultSQLiteDatabase({ path: dbPath });
      db.query("insert into sessions (id, profile_id, title, created_at, updated_at, metadata_json) values (?, ?, ?, ?, ?, ?)")
        .run("sess-empty", "default", "EstaCoda session", "2026-08-01T08:00:00.000Z", "2026-08-01T08:00:00.000Z", JSON.stringify({ workspaceRoot: tmpDir, originSurface: "cli" }));
      db.close();

      const result = await runCliCommand({
        argv: ["sessions", "open", "sess-empty"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
      });

      expect(result.exitCode).toBe(1);
      expect(result.sessionHandoff).toBeUndefined();
    });

    it.each([
      { name: "another profile", profileId: "work", workspaceRoot: undefined, kind: undefined },
      { name: "another workspace", profileId: "default", workspaceRoot: "/other", kind: undefined },
      { name: "an internal session", profileId: "default", workspaceRoot: undefined, kind: "task-step-worker" },
    ])("rejects $name without exposing a handoff", async ({ profileId, workspaceRoot, kind }) => {
      const db = openDefaultSQLiteDatabase({ path: dbPath });
      seedPickerSession(db, {
        id: `blocked-${profileId}-${kind ?? "session"}`,
        profileId,
        title: "Blocked",
        workspaceRoot: workspaceRoot ?? tmpDir,
        kind,
      });
      db.close();

      const result = await runCliCommand({
        argv: ["sessions", "open", `blocked-${profileId}-${kind ?? "session"}`],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("not available in the selected profile and current workspace");
      expect(result.sessionHandoff).toBeUndefined();
    });

    it("rejects ended sessions", async () => {
      const db = openDefaultSQLiteDatabase({ path: dbPath });
      seedPickerSession(db, {
        id: "sess-ended",
        profileId: "default",
        title: "Ended",
        workspaceRoot: tmpDir,
      });
      db.query("update sessions set ended_at = ?, end_reason = ? where id = ?")
        .run("2026-08-04T12:00:00.000Z", "done", "sess-ended");
      db.close();

      const result = await runCliCommand({
        argv: ["sessions", "open", "sess-ended"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
      });
      expect(result.exitCode).toBe(1);
      expect(result.sessionHandoff).toBeUndefined();
    });
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
      db.query("insert into sessions (id, profile_id, title, created_at, updated_at, metadata_json) values (?, ?, ?, ?, ?, ?)")
        .run("sess-1", "default", "Test Session", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z", JSON.stringify({ workspaceRoot: tmpDir, originSurface: "cli" }));
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
      expect(result.output).toContain(`Workspace: ${tmpDir}`);
      expect(result.output).toContain("Origin: cli");
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

function pickerPrompt(select: (input: SelectPromptInput<string>) => Promise<string>): Prompt {
  return Object.assign(async () => "", { select }) as Prompt;
}

function seedPickerSession(
  db: ReturnType<typeof openDefaultSQLiteDatabase>,
  input: {
    id: string;
    profileId: string;
    title: string;
    workspaceRoot: string;
    originSurface?: string;
    kind?: string;
    updatedAt?: string;
  }
): void {
  const createdAt = "2026-08-01T08:00:00.000Z";
  const updatedAt = input.updatedAt ?? "2026-08-02T09:00:00.000Z";
  db.query("insert into sessions (id, profile_id, title, created_at, updated_at, metadata_json) values (?, ?, ?, ?, ?, ?)")
    .run(input.id, input.profileId, input.title, createdAt, updatedAt, JSON.stringify({
      workspaceRoot: input.workspaceRoot,
      ...(input.originSurface === undefined ? {} : { originSurface: input.originSurface }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
    }));
  db.query("insert into messages (id, session_id, role, content, created_at, channel) values (?, ?, ?, ?, ?, ?)")
    .run(`message-${input.id}`, input.id, "user", input.title, updatedAt, input.originSurface ?? "cli");
}

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
