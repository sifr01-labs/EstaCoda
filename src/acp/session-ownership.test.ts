import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AcpServer } from "./server.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import type { Runtime } from "../runtime/create-runtime.js";

let homeDir: string;
let workspaceRoot: string;
beforeEach(async () => { homeDir = await mkdtemp(join(tmpdir(), "acp-ownership-")); workspaceRoot = join(homeDir, "workspace"); await mkdir(workspaceRoot); });
afterEach(async () => { await rm(homeDir, { recursive: true, force: true }); });

type Response = { id?: number; error?: { message: string }; result?: unknown };
async function withServer(db: InMemorySessionDB, test: (request: (method: string, params?: unknown) => Promise<Response>, output: () => string, built: () => number) => Promise<void>) {
  const input = new PassThrough(); const output = new PassThrough();
  let wire = ""; let sequence = 0; let builds = 0;
  output.on("data", (chunk) => { wire += String(chunk); });
  const server = new AcpServer({ homeDir, workspaceRoot, profileId: "selected", sessionDb: db, input, output,
    runtimeFactory: async ({ sessionId }) => { builds++; return { sessionId, dispose: async () => undefined } as unknown as Runtime; } });
  const running = server.run();
  try {
    await vi.waitFor(() => expect(input.listenerCount("data")).toBeGreaterThan(0));
    await test(async (method, params) => {
      const id = ++sequence;
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      let response: Response | undefined;
      await vi.waitFor(() => { response = wire.trim().split("\n").map((line) => JSON.parse(line) as Response).find((row) => row.id === id); expect(response).toBeDefined(); });
      return response!;
    }, () => wire, () => builds);
  } finally { input.end(); await running; }
}

it.each(["profile", "workspace", "ambiguous"])("rejects %s mismatch before runtime construction or transcript replay", async (kind) => {
  const db = new InMemorySessionDB();
  const otherRoot = join(homeDir, "other"); await mkdir(otherRoot);
  await db.createSession({ id: "private", profileId: kind === "profile" ? "other" : "selected",
    metadata: kind === "ambiguous" ? { originSurface: "telegram" } : { workspaceRoot: kind === "workspace" ? otherRoot : workspaceRoot } });
  await db.appendMessage({ sessionId: "private", role: "user", channel: "cli", content: "PRIVATE_TRANSCRIPT_MARKER" });
  await withServer(db, async (request, output, built) => {
    expect((await request("session/load", { sessionId: "private", cwd: workspaceRoot })).error).toBeDefined();
    expect(built()).toBe(0);
    expect(output()).not.toContain("PRIVATE_TRANSCRIPT_MARKER");
    expect(output()).not.toContain('"session/update"');
  });
});

it("lists only the selected profile and revalidates cached session loads", async () => {
  const db = new InMemorySessionDB();
  await db.createSession({ id: "allowed", profileId: "selected", metadata: { workspaceRoot } });
  await db.createSession({ id: "other-profile", profileId: "other", title: "PRIVATE_TITLE", metadata: { workspaceRoot } });
  await db.appendMessage({ sessionId: "allowed", role: "user", channel: "cli", content: "ALLOWED_TRANSCRIPT" });
  const otherRoot = join(homeDir, "other"); await mkdir(otherRoot);
  await withServer(db, async (request, output, built) => {
    expect((await request("session/list")).result).toMatchObject({ sessions: [{ sessionId: "allowed" }] });
    expect(output()).not.toContain("PRIVATE_TITLE");
    expect((await request("session/load", { sessionId: "allowed", cwd: workspaceRoot })).error).toBeUndefined();
    expect(built()).toBe(1);
    const count = output().split("ALLOWED_TRANSCRIPT").length;
    expect((await request("session/load", { sessionId: "allowed", cwd: otherRoot })).error).toBeDefined();
    expect(output().split("ALLOWED_TRANSCRIPT").length).toBe(count);
    expect(built()).toBe(1);
  });
});
