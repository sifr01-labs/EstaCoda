import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { runCliCommand } from "./cli.js";
import { FileSurfacePointerStore } from "../channels/surface-pointer-store.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-cli-sess-test-"));
}

describe("CLI session commands", () => {
  let tmpDir: string;
  let stateRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    stateRoot = join(tmpDir, ".estacoda");
    await mkdir(stateRoot, { recursive: true });
    dbPath = join(stateRoot, "sessions.sqlite");
    const db = new Database(dbPath, { create: true });
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
      create table if not exists messages_fts (
        rowid integer primary key,
        message_id text,
        content text
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
      const db = new Database(dbPath, { create: true });
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

    it("shows surface pointers attached to sessions", async () => {
      const db = new Database(dbPath, { create: true });
      db.query("insert into sessions (id, profile_id, title, created_at, updated_at) values (?, ?, ?, ?, ?)")
        .run("sess-1", "default", "Test Session", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z");
      db.close();

      const pointerStore = new FileSurfacePointerStore({ path: join(stateRoot, "surface-pointers.json") });
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
      const db = new Database(dbPath, { create: true });
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
      const db = new Database(dbPath, { create: true });
      db.query("insert into sessions (id, profile_id, title, created_at, updated_at) values (?, ?, ?, ?, ?)")
        .run("sess-1", "default", "Test Session", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z");
      db.close();

      const pointerStore = new FileSurfacePointerStore({ path: join(stateRoot, "surface-pointers.json") });
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

  describe("sessions attach", () => {
    it("attaches surface to session", async () => {
      const result = await runCliCommand({
        argv: ["sessions", "attach", "telegram", "chat-1", "sess-1"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });
      expect(result.handled).toBe(true);
      expect(result.output).toContain("Attached telegram:chat-1 to session sess-1");

      const pointerStore = new FileSurfacePointerStore({ path: join(stateRoot, "surface-pointers.json") });
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
      const pointerStore = new FileSurfacePointerStore({ path: join(stateRoot, "surface-pointers.json") });
      await pointerStore.setPointer("telegram", "chat-1", { sessionId: "sess-1", attachedAt: "2024-01-01T00:00:00Z" });

      const result = await runCliCommand({
        argv: ["sessions", "detach", "telegram", "chat-1"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });
      expect(result.handled).toBe(true);
      expect(result.output).toContain("Detached telegram:chat-1");

      const pointerStore2 = new FileSurfacePointerStore({ path: join(stateRoot, "surface-pointers.json") });
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
      const db = new Database(dbPath, { create: true });
      db.query("insert into sessions (id, profile_id, title, created_at, updated_at) values (?, ?, ?, ?, ?)")
        .run("sess-1", "default", "Test", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z");
      db.close();

      await runCliCommand({
        argv: ["sessions", "list"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      const db2 = new Database(dbPath, { create: true });
      const rows = db2.query("select * from sessions where id = ?").all("sess-1") as any[];
      db2.close();
      expect(rows.length).toBe(1);
      expect(rows[0].title).toBe("Test");
      expect(rows[0].updated_at).toBe("2024-01-02T00:00:00Z");
    });
  });
});
