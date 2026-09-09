import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { AcpServer } from "./server.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import type { Runtime } from "../runtime/create-runtime.js";
import { exactActionKey } from "../security/pending-action-approval.js";

it.each(["same action", "changed arguments", "unoffered option"])("binds ACP permission to its issued request: %s", async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), "acp-approval-"));
  const input = new PassThrough(); const output = new PassThrough();
  const db = new InMemorySessionDB();
  const rows: Array<{ id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown }> = [];
  let calls = 0; let executed = 0; let permissionCount = 0;
  const server = new AcpServer({ homeDir: root, workspaceRoot: root, profileId: "test", sessionDb: db, input, output,
    runtimeFactory: async ({ sessionId, securityPolicy }) => {
      await db.createSession({ id: sessionId, profileId: "test", metadata: { workspaceRoot: root } });
      return { sessionId, dispose: async () => undefined, handle: async () => {
        calls++;
        const actionKey = exactActionKey(["terminal.run", scenario === "changed arguments" && calls > 1 ? "changed" : "reviewed"]);
        const assessment = await securityPolicy.assess!({
          toolName: "terminal.run", riskClass: "destructive-local", command: "rm -rf ./build", targetKey: "fixture-target",
          actionKey, description: "fixture command", context: { trustedWorkspace: true }
        });
        if (assessment.decision === "allow") executed++;
        return { text: "fixture", toolExecutions: [{ tool: { name: "terminal.run" }, riskClass: "destructive-local",
          targetKey: "fixture-target", decision: assessment.decision, pendingApproval: assessment.pendingApproval }] };
      } } as unknown as Runtime;
    } });
  output.on("data", (chunk) => {
    for (const line of String(chunk).trim().split("\n")) {
      const row = JSON.parse(line); rows.push(row);
      if (row.method === "session/request_permission") {
        permissionCount++;
        const optionId = scenario === "unoffered option" ? "allow-always" : permissionCount === 1 ? "allow-once" : "reject-once";
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id: row.id, result: { outcome: "selected", optionId } })}\n`);
      }
    }
  });
  const running = server.run();
  try {
    await vi.waitFor(() => expect(input.listenerCount("data")).toBeGreaterThan(0));
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: root } }) + "\n");
    await vi.waitFor(() => expect(rows.find((row) => row.id === 1)).toBeDefined());
    const sessionId = (rows.find((row) => row.id === 1)!.result as { sessionId: string }).sessionId;
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "Perform the fixture action." }] } }) + "\n");
    await vi.waitFor(() => expect(rows.find((row) => row.id === 2)).toBeDefined());
    expect(executed).toBe(scenario === "same action" ? 1 : 0);
    expect(permissionCount).toBe(scenario === "changed arguments" ? 2 : 1);
    if (scenario === "unoffered option") expect(rows.find((row) => row.id === 2)?.error).toBeDefined();
  } finally { input.end(); await running; await rm(root, { recursive: true, force: true }); }
});
