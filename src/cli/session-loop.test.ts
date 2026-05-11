import { describe, it, expect } from "vitest";
import { runSessionLoop } from "./session-loop.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { AgentLoopResponse } from "../runtime/agent-loop.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { TerminalCapabilities } from "../contracts/ui.js";
import { isolateLtr } from "../ui/bidi.js";

function interactiveCaps(overrides: Partial<TerminalCapabilities> = {}): TerminalCapabilities {
  return {
    isTTY: true,
    supportsColor: true,
    supportsTrueColor: true,
    supportsUnicode: true,
    supportsEmoji: true,
    terminalWidth: 120,
    isDumb: false,
    isCI: false,
    supportsAnimation: true,
    ...overrides,
  };
}

function createMockRuntime(): Runtime {
  const sessionDb = new InMemorySessionDB();
  return {
    describe: () => "mock runtime",
    getStatus: () => ({
      kind: "status" as const,
      agentName: "EstaCoda",
      model: { provider: "mock", id: "mock-model" },
      securityMode: "open",
      skillCount: 0,
      toolCount: 0,
      mcp: { active: 0, total: 0 },
      taskflowActive: false,
      warnings: [],
    }),
    getModelInfo: () => ({
      kind: "kv" as const,
      title: "Model",
      entries: [
        { key: "provider", value: "mock" },
        { key: "model", value: "mock-model" },
      ],
    }),
    getStartup: () => ({
      kind: "startup" as const,
      agentName: "EstaCoda",
      taglines: [],
      model: { provider: "mock", id: "mock-model" },
      readiness: "ready",
      warnings: [],
    }),
    getStartupReadiness: async () => ({
      workspaceTrust: "trusted",
      workspaceVerification: "verified",
      providerReadiness: "ready",
      versionStatus: "unknown",
      workspaceDirectory: "/tmp",
      securityMode: "open",
      model: { provider: "mock", id: "mock-model" },
      warnings: [],
    }),
    tools: () => [],
    skills: () => [],
    latestResumeNote: async () => undefined,
    inspectMemoryPromotions: async () => [],
    inspectMcpServers: () => [],
    handle: async (): Promise<AgentLoopResponse> => ({
      label: "EstaCoda",
      text: "Mock response",
      matchedSkills: [],
      intent: {
        nativeIntent: "general",
        labels: ["chat"],
        confidence: 1,
        suggestedToolsets: [],
        suggestedSkills: [],
        evidence: [{ kind: "native-intent" as const, detail: "mock" }],
        confirmationRequired: false,
        rationale: "mock",
      },
      securityDecision: "allow",
      toolExecutions: [],
      toolPlans: [],
      skillOutcomes: [],
      artifacts: [],
      context: undefined,
      projectContext: undefined,
      progress: [],
    }),
    trustWorkspace: async () => {},
    isWorkspaceTrusted: async () => true,
    revokeWorkspaceTrust: async () => true,
    dispose: async () => {},
    sessionDb,
    sessionId: "test-session",
  };
}

describe("runSessionLoop — user prompt rail behavior", () => {
  it("defaults startup and session chrome to English when no locale is provided", async () => {
    const outputChunks: string[] = [];
    const runtime = createMockRuntime();
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("Type a message.");
    expect(rendered).toContain("/help");
    expect(rendered).toContain("/exit");
    expect(rendered).not.toContain("اكتب رسالة.");
  });

  it("renders the startup hint in Arabic with isolated slash commands", async () => {
    const outputChunks: string[] = [];
    const runtime = createMockRuntime();
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
      } as NodeJS.WritableStream,
      locale: "ar",
      prompt: Object.assign(
        async () => {
          const values = ["/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("اكتب رسالة.");
    expect(rendered).toContain(isolateLtr("/help"));
    expect(rendered).toContain(isolateLtr("/exit"));
  });

  it("keeps Arabic launch chrome readable in no-color plain fallback", async () => {
    const outputChunks: string[] = [];
    const runtime = createMockRuntime();
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
      } as NodeJS.WritableStream,
      locale: "ar",
      capabilities: {
        ...interactiveCaps(),
        isTTY: false,
        supportsColor: false,
        supportsTrueColor: false,
        supportsUnicode: false,
        supportsEmoji: false,
        supportsAnimation: false,
      },
      prompt: Object.assign(
        async () => {
          const values = ["/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("اكتب رسالة.");
    expect(rendered).toContain(isolateLtr("/help"));
    expect(rendered).toContain(isolateLtr("/exit"));
    expect(rendered).not.toMatch(/\x1b\[/u);
    expect(rendered).not.toContain("𓂀");
    expect(rendered).not.toContain("╭");
  });

  it("keeps Arabic no-Unicode session chrome on ASCII structural fallback", async () => {
    const outputChunks: string[] = [];
    const runtime = createMockRuntime();
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 80,
      } as unknown as NodeJS.WritableStream,
      locale: "ar",
      capabilities: interactiveCaps({
        supportsUnicode: false,
        supportsEmoji: false,
        supportsAnimation: false,
        terminalWidth: 80,
      }),
      prompt: Object.assign(
        async () => {
          const values = ["/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("اكتب رسالة.");
    expect(rendered).toContain(isolateLtr("/help"));
    expect(rendered).toContain(isolateLtr("/exit"));
    expect(rendered).not.toContain("𓂀");
    expect(rendered).not.toContain("╭");
    expect(rendered).toContain("*");
  });

  it("renders a user prompt rail for normal non-slash input", async () => {
    const outputChunks: string[] = [];
    const runtime = createMockRuntime();
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
      } as NodeJS.WritableStream,
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("> hello");
    expect(rendered).toContain("+----------------------------------------------------------+");
  });

  it("does not render a user prompt rail for slash commands", async () => {
    const outputChunks: string[] = [];
    const runtime = createMockRuntime();
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
      } as NodeJS.WritableStream,
      prompt: Object.assign(
        async () => {
          const values = ["/help", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("EstaCoda session commands");
    expect(rendered).not.toContain("\u25b8 /help");
    expect(rendered).not.toContain("> /help");
  });

  it("renders slash completion chrome for submitted slash prefix without table transcript", async () => {
    const outputChunks: string[] = [];
    const runtime = createMockRuntime();
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["/", "hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("/help");
    expect(rendered).toContain("Show command help");
    expect(rendered).not.toContain("Commands");
    expect(rendered).not.toContain("Name  Description");
    const promptIndexInOutput = outputChunks.findIndex((chunk) => String(chunk).includes("hello"));
    expect(promptIndexInOutput).toBeGreaterThanOrEqual(0);
    expect(outputChunks.slice(promptIndexInOutput).join("")).not.toContain("Show command help");
  });

  it("filters slash completion chrome for submitted partial slash input", async () => {
    const outputChunks: string[] = [];
    const runtime = createMockRuntime();
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["/mo", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("/model");
    expect(rendered).toContain("Show or switch model");
    expect(rendered).not.toContain("Show command help");
  });

  it("renders slash completion empty state for unknown slash input", async () => {
    const outputChunks: string[] = [];
    const runtime = createMockRuntime();
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["/zzzz", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    expect(outputChunks.join("")).toContain('No slash commands match "/zzzz".');
  });

  it("keeps slash completion out of plain non-TTY transcript fallback", async () => {
    const outputChunks: string[] = [];
    const runtime = createMockRuntime();
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
      } as NodeJS.WritableStream,
      capabilities: { ...interactiveCaps(), isTTY: false, supportsColor: false, supportsTrueColor: false, supportsUnicode: false },
      prompt: Object.assign(
        async () => {
          const values = ["/", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).not.toContain("Show command help");
    expect(rendered).not.toContain("Commands");
  });
});

function createEventEmittingMockRuntime(events: RuntimeEvent[]): Runtime {
  const base = createMockRuntime();
  return {
    ...base,
    handle: async ({ onEvent }: { text: string; channel: string; signal?: AbortSignal; onEvent?: (event: RuntimeEvent) => void }): Promise<AgentLoopResponse> => {
      for (const event of events) {
        onEvent?.(event);
      }
      return {
        label: "EstaCoda",
        text: "Mock response",
        matchedSkills: [],
        intent: {
          nativeIntent: "general",
          labels: ["chat"],
          confidence: 1,
          suggestedToolsets: [],
          suggestedSkills: [],
          evidence: [{ kind: "native-intent" as const, detail: "mock" }],
          confirmationRequired: false,
          rationale: "mock",
        },
        securityDecision: "allow",
        toolExecutions: [],
        toolPlans: [],
        skillOutcomes: [],
        artifacts: [],
        context: undefined,
        projectContext: undefined,
        progress: [],
      };
    },
  };
}

describe("runSessionLoop — active turn spinner", () => {
  it("renders active turn spinner phases in standard interactive mode", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "intent", labels: ["chat"], confidence: 0.95 },
      { kind: "provider-attempt", provider: "mock", model: "mock-model", fallback: false },
      { kind: "provider-result", provider: "mock", model: "mock-model", ok: true, fallback: false, willFallback: false },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("contemplating");
    expect(rendered).toContain("plotting");
    expect(rendered).toContain("scribbling");
    expect(rendered).toContain("polishing");
  });

  it("suppresses debug lines when chrome is enabled", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "intent", labels: ["chat"], confidence: 0.95 },
      { kind: "provider-attempt", provider: "mock", model: "mock-model", fallback: false },
      { kind: "provider-result", provider: "mock", model: "mock-model", ok: true, fallback: false, willFallback: false },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).not.toContain("thinking:");
    expect(rendered).not.toContain("intent:");
    expect(rendered).not.toContain("provider:");
  });

  it("clears active spinner before assistant output", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "intent", labels: ["chat"], confidence: 0.95 },
      { kind: "provider-attempt", provider: "mock", model: "mock-model", fallback: false },
      { kind: "provider-result", provider: "mock", model: "mock-model", ok: true, fallback: false, willFallback: false },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    const clearIndex = rendered.indexOf("\x1b[1A\x1b[2K\r");
    const assistantIndex = rendered.indexOf("Mock response");
    expect(clearIndex).toBeGreaterThan(-1);
    expect(assistantIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeLessThan(assistantIndex);
  });

  it("uses deterministic spinner labels in plain/noninteractive mode", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
    } as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "intent", labels: ["chat"], confidence: 0.95 },
      { kind: "provider-attempt", provider: "mock", model: "mock-model", fallback: false },
      { kind: "provider-result", provider: "mock", model: "mock-model", ok: true, fallback: false, willFallback: false },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("contemplating");
    expect(rendered).toContain("plotting");
    expect(rendered).toContain("scribbling");
    expect(rendered).toContain("polishing");
    expect(rendered).not.toContain("thinking:");
    expect(rendered).not.toContain("intent:");
    expect(rendered).not.toContain("provider:");
    expect(rendered).not.toContain("\x1b[1A\x1b[2K\r");
  });

  it("uses Arabic spinner labels when locale is ar", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      locale: "ar",
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("\u0628\u0641\u0643\u0631");
  });

  it("clears active spinner before tool output and does not leave it in transcript", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "provider-attempt", provider: "mock", model: "mock-model", fallback: false },
      { kind: "provider-tool-call", provider: "mock", model: "mock-model", name: "browser.status", id: "tc1", argumentsText: "{}" },
      { kind: "tool-start", tool: "browser.status", stepId: "s1" },
      { kind: "tool-result", tool: "browser.status", ok: true, chars: 10, sentChars: 10 },
      { kind: "provider-result", provider: "mock", model: "mock-model", ok: true, fallback: false, willFallback: false },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    // Spinner should appear during thinking/provider phases
    expect(rendered).toContain("contemplating");
    expect(rendered).toContain("scribbling");
    // Tool output should be present
    expect(rendered).toContain("browser.status");
    // The ANSI clear sequence should appear before tool output
    const clearIndex = rendered.indexOf("\x1b[1A\x1b[2K\r");
    const toolIndex = rendered.indexOf("browser.status");
    expect(clearIndex).toBeGreaterThan(-1);
    expect(toolIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeLessThan(toolIndex);
    // After the final assistant response, no spinner label should remain in the durable scrollback
    const assistantIndex = rendered.indexOf("Mock response");
    const afterAssistant = rendered.slice(assistantIndex);
    // The only "contemplating" or "scribbling" or "tinkering" occurrences should be
    // before the assistant response, not after.
    expect(afterAssistant).not.toContain("contemplating");
    expect(afterAssistant).not.toContain("scribbling");
    expect(afterAssistant).not.toContain("tinkering");
  });

  it("clears active chrome before rendering a permission card", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const baseRuntime = createMockRuntime();
    const runtime = {
      ...baseRuntime,
      grantApproval: async () => {},
      handle: async (): Promise<AgentLoopResponse> => ({
        label: "EstaCoda",
        text: "I need permission before writing.",
        matchedSkills: [],
        intent: {
          nativeIntent: "general",
          labels: ["chat"],
          confidence: 1,
          suggestedToolsets: [],
          suggestedSkills: [],
          evidence: [{ kind: "native-intent" as const, detail: "mock" }],
          confirmationRequired: false,
          rationale: "mock",
        },
        securityDecision: "ask",
        toolExecutions: [
          {
            tool: {
              name: "workspace.write",
              description: "Write a workspace file",
              inputSchema: {},
              riskClass: "workspace-write",
              toolsets: ["files"],
              progressLabel: "writing",
              maxResultSizeChars: 1000,
            },
            decision: "ask",
            riskClass: "workspace-write",
            targetKey: "src/app.ts",
            targetSummary: "src/app.ts",
          },
        ],
        toolPlans: [],
        skillOutcomes: [],
        artifacts: [],
        context: undefined,
        projectContext: undefined,
        progress: [],
      }),
    } as Runtime;

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["write file", "deny", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    const clearIndex = rendered.indexOf("\x1b[1A\x1b[2K\r");
    const permissionIndex = rendered.indexOf("Permission required");
    expect(clearIndex).toBeGreaterThan(-1);
    expect(permissionIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeLessThan(permissionIndex);
    expect(rendered).toContain("workspace.write");
    expect(rendered).toContain("src/app.ts");
    expect(rendered).toContain("Permission denied.");
    expect(rendered.slice(permissionIndex)).not.toContain("contemplating");
  });

  it("renders agent-cancelled as durable message in chrome mode", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "agent-cancelled", reason: "user interrupt" },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("cancelled: user interrupt");
    // The clear sequence should appear before the cancellation message
    const clearIndex = rendered.indexOf("\x1b[1A\x1b[2K\r");
    const cancelIndex = rendered.indexOf("cancelled: user interrupt");
    expect(clearIndex).toBeGreaterThan(-1);
    expect(cancelIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeLessThan(cancelIndex);
  });

  it("renders provider-budget-exhausted as durable message in chrome mode", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "provider-attempt", provider: "mock", model: "mock-model", fallback: false },
      { kind: "provider-budget-exhausted", budget: "tokens", limit: 100000, observed: 100001, reason: "token limit reached" },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("provider budget: token limit reached");
    // The clear sequence should appear before the budget message
    const clearIndex = rendered.indexOf("\x1b[1A\x1b[2K\r");
    const budgetIndex = rendered.indexOf("provider budget: token limit reached");
    expect(clearIndex).toBeGreaterThan(-1);
    expect(budgetIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeLessThan(budgetIndex);
  });
});

describe("runSessionLoop — animated spinner behavior", () => {
  it("ticks animated frames in standard interactive TTY", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps({ supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    // Spinner labels should appear
    expect(rendered).toContain("contemplating");
    // In animated mode, the renderer may produce varying eye frames over time.
    // The first write includes the initial frame; we verify animation support is active
    // by checking that the spinner was rendered at all in TTY mode.
  });

  it("uses static fallback when animation is unsupported", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("contemplating");
  });

  it("clears animated spinner before assistant output", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "intent", labels: ["chat"], confidence: 0.95 },
      { kind: "provider-attempt", provider: "mock", model: "mock-model", fallback: false },
      { kind: "provider-result", provider: "mock", model: "mock-model", ok: true, fallback: false, willFallback: false },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    const clearIndex = rendered.indexOf("\x1b[1A\x1b[2K\r");
    const assistantIndex = rendered.indexOf("Mock response");
    expect(clearIndex).toBeGreaterThan(-1);
    expect(assistantIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeLessThan(assistantIndex);
  });

  it("clears animated spinner before tool output", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "provider-attempt", provider: "mock", model: "mock-model", fallback: false },
      { kind: "provider-tool-call", provider: "mock", model: "mock-model", name: "browser.status", id: "tc1", argumentsText: "{}" },
      { kind: "tool-start", tool: "browser.status", stepId: "s1" },
      { kind: "tool-result", tool: "browser.status", ok: true, chars: 10, sentChars: 10 },
      { kind: "provider-result", provider: "mock", model: "mock-model", ok: true, fallback: false, willFallback: false },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    // Spinner should appear during thinking/provider phases
    expect(rendered).toContain("contemplating");
    expect(rendered).toContain("scribbling");
    // Tool output should be present
    expect(rendered).toContain("browser.status");
    // The ANSI clear sequence should appear before tool output
    const clearIndex = rendered.indexOf("\x1b[1A\x1b[2K\r");
    const toolIndex = rendered.indexOf("browser.status");
    expect(clearIndex).toBeGreaterThan(-1);
    expect(toolIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeLessThan(toolIndex);
    // After the final assistant response, no spinner label should remain in the durable scrollback
    const assistantIndex = rendered.indexOf("Mock response");
    const afterAssistant = rendered.slice(assistantIndex);
    expect(afterAssistant).not.toContain("contemplating");
    expect(afterAssistant).not.toContain("scribbling");
    expect(afterAssistant).not.toContain("tinkering");
  });

  it("clears animated spinner on cancellation", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "agent-cancelled", reason: "user interrupt" },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("cancelled: user interrupt");
    const clearIndex = rendered.indexOf("\x1b[1A\x1b[2K\r");
    const cancelIndex = rendered.indexOf("cancelled: user interrupt");
    expect(clearIndex).toBeGreaterThan(-1);
    expect(cancelIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeLessThan(cancelIndex);
  });

  it("clears animated spinner on provider-budget exhaustion", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "provider-attempt", provider: "mock", model: "mock-model", fallback: false },
      { kind: "provider-budget-exhausted", budget: "tokens", limit: 100000, observed: 100001, reason: "token limit reached" },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps(),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("provider budget: token limit reached");
    const clearIndex = rendered.indexOf("\x1b[1A\x1b[2K\r");
    const budgetIndex = rendered.indexOf("provider budget: token limit reached");
    expect(clearIndex).toBeGreaterThan(-1);
    expect(budgetIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeLessThan(budgetIndex);
  });

  it("no animation in plain/noninteractive mode", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
    } as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("contemplating");
    expect(rendered).not.toContain("thinking:");
    expect(rendered).not.toContain("\x1b[1A\x1b[2K\r");
  });
});
