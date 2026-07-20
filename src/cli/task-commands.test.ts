import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readActiveProfile, resolveGlobalStateHome, writeActiveProfile } from "../config/profile-home.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { SQLiteTaskStore } from "../workflow/sqlite-task-store.js";
import { TaskOperatorService } from "../workflow/task-operator-service.js";
import { executeTaskCommand, taskCommand } from "./task-commands.js";

describe("Task commands", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "estacoda-task-command-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("renders deterministic non-interactive list and show output", async () => {
    const db = await createSQLiteSessionDB({ path: join(root, "sessions.sqlite") });
    await db.createSession({ id: "owner", profileId: "alpha" });
    const service = new TaskOperatorService({
      store: new SQLiteTaskStore({ db: db.db, profileId: "alpha" }),
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const created = service.begin({
      objective: "Inspect deterministic output",
      workspace: { canonicalPath: root, identityHash: "workspace-hash" },
      creatorSessionId: "owner"
    });

    await expect(executeTaskCommand({ args: ["list"], service, authorizedSessionId: "owner" })).resolves.toEqual({
      ok: true,
      output: `${created.taskId}\tqueued\t0/1\tInspect deterministic output`
    });
    const shown = await executeTaskCommand({
      args: ["show", created.taskId],
      service,
      authorizedSessionId: "owner",
      workspaceTrusted: async () => true,
      backgroundHost: async () => "inactive"
    });
    expect(shown.ok).toBe(true);
    expect(shown.output).toContain(`Task ${created.taskId} · Inspect deterministic output`);
    expect(shown.output).toContain("Estimated cost: $0.0000 (incomplete)");
    expect(shown.output).toContain("Workspace: trusted");
    expect(shown.output).toContain("Background host: inactive");
    expect(shown.output).not.toContain(root);
    db.close();
  });

  it("keeps --profile command-local while creating a durable system-owned Task", async () => {
    writeActiveProfile("alpha", { homeDir: root });
    await new WorkspaceTrustStore({ homeDir: root }).grant(root);
    const result = await taskCommand({
      argv: [],
      workspaceRoot: root,
      homeDir: root,
      profileId: "beta"
    }, ["begin", "Inspect", "the", "selected", "profile"]);

    expect(result).toMatchObject({ handled: true, exitCode: 0 });
    expect(result.output).toContain("Created Task:");
    expect(readActiveProfile({ homeDir: root }).profileId).toBe("alpha");
    const db = await createSQLiteSessionDB({ path: resolveGlobalStateHome({ homeDir: root }).sessionsSqlitePath });
    expect(new SQLiteTaskStore({ db: db.db, profileId: "beta" }).listTasks()).toHaveLength(1);
    expect(new SQLiteTaskStore({ db: db.db, profileId: "alpha" }).listTasks()).toHaveLength(0);
    db.close();
  });

  it("fails closed when Task creation workspace trust is absent", async () => {
    const result = await taskCommand({ argv: [], workspaceRoot: root, homeDir: root }, ["begin", "Inspect"]);
    expect(result).toMatchObject({ handled: true, exitCode: 1 });
    expect(result.output).toContain("Task creation requires a trusted workspace");
  });

  it("renders Arabic Task command copy without translating technical identifiers", async () => {
    const db = await createSQLiteSessionDB({ path: join(root, "sessions.sqlite") });
    const service = new TaskOperatorService({
      store: new SQLiteTaskStore({ db: db.db, profileId: "alpha" })
    });

    const help = await executeTaskCommand({ args: ["help"], service, locale: "ar" });
    expect(help.output).toContain("أوامر المهام الدائمة");
    expect(help.output).toContain("task show <task-id>");

    const empty = await executeTaskCommand({ args: ["list"], service, locale: "ar" });
    expect(empty.output).toBe("لم يتم العثور على مهام.");
    db.close();
  });

  it("does not let an in-session command select a different creator session", async () => {
    const db = await createSQLiteSessionDB({ path: join(root, "sessions.sqlite") });
    const service = new TaskOperatorService({
      store: new SQLiteTaskStore({ db: db.db, profileId: "alpha" })
    });
    const begin = vi.fn();

    const result = await executeTaskCommand({
      args: ["begin", "--session", "other", "Inspect"],
      service,
      authorizedSessionId: "owner",
      begin
    });

    expect(result).toEqual({
      ok: false,
      output: "--session is available only from the top-level task command."
    });
    expect(begin).not.toHaveBeenCalled();
    db.close();
  });
});
