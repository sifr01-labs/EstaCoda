import { PassThrough } from "node:stream";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentLoopResponse } from "./agent-loop.js";
import type { ChannelMessage } from "../contracts/channel.js";
import { runSessionLoop } from "../cli/session-loop.js";
import { ChannelGateway, InMemoryChannelSessionStore } from "../channels/channel-gateway.js";
import { createFakeTelegramAdapter } from "../test/fakes/fake-telegram-adapter.js";
import { createSecurityPolicyForMode } from "../security/security-policy-factory.js";
import { createResearchWorkflowHarness, nativeCall, answer, REPORT } from "../eval/fixtures/research-workflow-harness.js";
import { measureResearchWorkflow } from "../eval/fixtures/research-workflow-release.js";

type Harness = Awaited<ReturnType<typeof createResearchWorkflowHarness>>;
type Surface = "cli" | "telegram";
const sessionKey = { platform: "telegram", chatId: "release-chat", userId: "release-user", chatType: "dm" as const };
function message(text: string, id: string, userId = "release-user"): ChannelMessage {
  return { id, channel: "telegram", sessionKey: { ...sessionKey, userId }, sender: { id: userId }, text, receivedAt: new Date().toISOString() };
}
async function surface(h: Harness, kind: Surface) {
  let last: AgentLoopResponse | undefined;
  let sequence = 0;
  // The fixture owns the runtime across entry-point exits, worker settlement and restart.
  const observedRuntime = () => ({ ...h.runtime, dispose: async () => {}, handle: async (input: Parameters<typeof h.runtime.handle>[0]) => {
    last = await h.runtime.handle(input); return last;
  } });
  const adapter = createFakeTelegramAdapter();
  const sessions = new InMemoryChannelSessionStore();
  await sessions.setSessionId(sessionKey, h.runtime.sessionId);
  const gateway = new ChannelGateway({ adapters: [adapter], sessionStore: sessions,
    runtimeForSession: async (input) => { expect(input.sessionId).toBe(h.runtime.sessionId); return observedRuntime(); },
    homeDir: h.homeDir, profileId: "baseline", securityMode: "open", trustedWorkspace: true,
    authPolicy: { telegram: { allowedUserIds: ["release-user"], allowedChatIds: ["release-chat"] } }
  });
  return {
    gateway, adapter,
    async turn(text: string) {
      last = undefined;
      if (kind === "telegram") await gateway.receive(message(text, `message-${++sequence}`));
      else {
        const inputs = [text, "/exit"];
        await runSessionLoop({ runtime: observedRuntime(), output: new PassThrough(),
          capabilities: { isTTY: false, supportsColor: false, supportsTrueColor: false, supportsUnicode: true, supportsEmoji: false, terminalWidth: 100, isDumb: true, isCI: true, supportsAnimation: false },
          prompt: Object.assign(async () => inputs.shift() ?? "/exit", { close() {} }), close() {} });
      }
      expect(last).toBeDefined(); return last!;
    },
    async close() { await gateway.stop(); }
  };
}

describe.sequential("research through real CLI and Telegram entry points", () => {
  it.each<Surface>(["cli", "telegram"])("%s runs three workers, synthesis and restart save without a second batch", async (kind) => {
    const result = await measureResearchWorkflow({ harnessOptions: { securityPolicy: createSecurityPolicyForMode("open") }, surface: (h) => surface(h, kind) });
    expect(result).toMatchObject({ workers: 3, acceptedResults: 5, tasks: 1, searches: 3, finalOutcome: "completed", restarted: true });
  });
  it.each<Surface>(["cli", "telegram"])("%s recovers a skill with real instruction evidence", async (kind) => {
    const h = await createResearchWorkflowHarness({ securityPolicy: createSecurityPolicyForMode("open") });
    const entry = await surface(h, kind);
    try {
      h.enqueue(nativeCall("capability_discover", { ids: ["skill:researcher"] }), nativeCall("capability_request", { ids: ["skill:researcher"], reason: "Use the research workflow" }),
        nativeCall("skill_read", { name: "researcher" }), nativeCall("web_search", { query: "current recycling" }), answer(REPORT));
      const result = await entry.turn("Find recent battery research.");
      expect(result.toolExecutions.some((call) => call.tool.name === "skill.read" && call.result?.ok)).toBe(true);
      expect(h.scriptErrors).toEqual([]); expect(h.remainingSteps()).toBe(0);
      expect(h.requests.at(-1)?.messages.some((message) => JSON.stringify(message).includes("researcher"))).toBe(true);
    } finally { await entry.close(); await h.dispose(); }
  });
  it.each<Surface>(["cli", "telegram"])("%s rejects missing search and false file completion", async (kind) => {
    const h = await createResearchWorkflowHarness({ searchAvailable: false, securityPolicy: createSecurityPolicyForMode("open") });
    const entry = await surface(h, kind);
    try {
      h.enqueue(nativeCall("delegate_task", { task: "Research battery recycling", allowedTools: ["web.search"], research: { scope: "methods", requireLiveSources: true, requireRepositoryEvidence: false } }), answer("Research is blocked."));
      const research = await entry.turn("Use the researcher skill to research battery recycling.");
      expect(h.store.listTasks()).toHaveLength(0);
      expect(research.toolExecutions.find((call) => call.tool.name === "delegate_task")?.result?.ok).toBe(false);
      h.enqueue(answer(REPORT));
      const saved = await entry.turn("Save this report as report.md");
      expect(saved.finalOutcome?.status).not.toBe("completed");
      await expect(readFile(join(h.workspaceRoot, "report.md"))).rejects.toThrow();
      expect(h.scriptErrors).toEqual([]);
    } finally { await entry.close(); await h.dispose(); }
  });
  it("Telegram denies foreign users before runtime lookup or local-file delivery", async () => {
    const h = await createResearchWorkflowHarness(); const entry = await surface(h, "telegram");
    try {
      const foreign = message("Save a report and send local files", "foreign", "foreign-user");
      foreign.sessionKey.chatId = "foreign-chat"; // Telegram authorizes either an allowed user or an allowed chat.
      const result = await entry.gateway.receive(foreign);
      expect(result.sessionId).toBe(""); expect(h.requests).toHaveLength(0); expect(h.store.listTasks()).toHaveLength(0);
    } finally { await entry.close(); await h.dispose(); }
  });
});
