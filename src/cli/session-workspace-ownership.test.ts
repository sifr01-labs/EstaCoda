import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { ensureRuntimeSession } from "../session/session-workspace-ownership.js";
import { handleSlashCommand } from "./session-loop.js";
import type { Runtime } from "../runtime/create-runtime.js";

it.each(["/switch target", "/sessions"])("resolves bound Sessions using the configured state home for %s", async (text) => {
  const homeDir = await realpath(await mkdtemp(join(tmpdir(), "cli-bound-session-")));
  const db = new SQLiteSessionDB({ path: join(homeDir, "sessions.sqlite") });
  try {
    for (const sessionId of ["current", "target"]) await ensureRuntimeSession({ sessionDb: db, sessionId, homeDir, profileId: "selected", workspaceRoot: homeDir, durable: true });
    await db.appendMessage({ sessionId: "target", role: "user", channel: "cli", content: "Continue this work" });
    const target = { sessionDb: db, sessionId: "target" } as unknown as Runtime;
    const switchRuntime = vi.fn(async () => target);
    const result = await handleSlashCommand({
      text, homeDir, workspaceRoot: homeDir, runtime: { sessionDb: db, sessionId: "current" } as unknown as Runtime,
      switchRuntime, prompt: Object.assign(async () => "", { select: async <T>() => "target" as T }),
      output: { write: () => true } as unknown as NodeJS.WritableStream,
      renderer: { render: () => "", locale: "en" },
    });
    expect(switchRuntime).toHaveBeenCalledWith("target");
    expect(result).toMatchObject({ runtime: target });
  } finally { db.close(); await rm(homeDir, { recursive: true, force: true }); }
});
