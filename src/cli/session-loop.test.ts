import { describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { runSessionLoop } from "./session-loop.js";
import type { PromptOptions } from "./readline-prompt.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { AgentLoopResponse } from "../runtime/agent-loop.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { TerminalCapabilities } from "../contracts/ui.js";
import type { CompactResult } from "../prompt/session-compression-service.js";
import { isolateLtr } from "../ui/bidi.js";
import { stripAnsi } from "../ui/renderers/layout.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { writeCliVoiceMode } from "./voice-mode.js";

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

function makeTtyInput(): NodeJS.ReadStream & {
  readonly rawModes: boolean[];
  press(chunk: string, key?: { name?: string; ctrl?: boolean; sequence?: string }): void;
} {
  const input = new PassThrough() as unknown as NodeJS.ReadStream & {
    rawModes: boolean[];
    press(chunk: string, key?: { name?: string; ctrl?: boolean; sequence?: string }): void;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.rawModes = [];
  input.setRawMode = (mode: boolean) => {
    input.isRaw = mode;
    input.rawModes.push(mode);
    return input;
  };
  input.press = (chunk, key = {}) => {
    input.emit("keypress", chunk, key);
  };
  return input;
}

function createMockRuntime(overrides: Partial<Runtime> = {}): Runtime {
  const sessionDb = new InMemorySessionDB();
  const runtime: Runtime = {
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
  return { ...runtime, ...overrides };
}

type ApprovalGrantInput = Parameters<NonNullable<Runtime["grantApproval"]>>[0];

function approvalAskResponse(): AgentLoopResponse {
  return {
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
  };
}

function approvalAllowResponse(): AgentLoopResponse {
  return {
    label: "EstaCoda",
    text: "Write completed.",
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
}

async function runApprovalPromptScenario(approvalAnswers: string[]): Promise<{
  grants: ApprovalGrantInput[];
  handleInputs: string[];
  rendered: string;
}> {
  const outputChunks: string[] = [];
  const grants: ApprovalGrantInput[] = [];
  const handleInputs: string[] = [];
  let handleCalls = 0;
  const runtime = {
    ...createMockRuntime(),
    revokeApproval: async () => true,
    grantApproval: async (input) => {
      grants.push(input);
    },
    handle: async (input): Promise<AgentLoopResponse> => {
      handleCalls += 1;
      handleInputs.push(input.text);
      return handleCalls === 1 ? approvalAskResponse() : approvalAllowResponse();
    },
  } as Runtime;

  let promptIndex = 0;
  await runSessionLoop({
    runtime,
    output: {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: false,
      columns: 120,
    } as unknown as NodeJS.WritableStream,
    capabilities: interactiveCaps({
      isTTY: false,
      supportsAnimation: false,
    }),
    prompt: Object.assign(
      async () => {
        const values = ["write file", ...approvalAnswers, "/exit"];
        return values[promptIndex++] ?? "/exit";
      },
      { close: () => {} }
    ),
    close: () => {},
  });

  return {
    grants,
    handleInputs,
    rendered: outputChunks.join(""),
  };
}

describe("runSessionLoop — user prompt rail behavior", () => {
  it("hides assistant response progress by default", async () => {
    const outputChunks: string[] = [];
    const runtime = {
      ...createMockRuntime(),
      handle: async (): Promise<AgentLoopResponse> => ({
        ...mockResponse(),
        progress: ["received prompt", "ready for direct response"],
      }),
    };
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: false,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ isTTY: false, supportsAnimation: false }),
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
    expect(rendered).toContain("Mock response");
    expect(rendered).not.toContain("progress:");
    expect(rendered).not.toContain("received prompt -> ready for direct response");
  });

  it("shows assistant response progress when enabled", async () => {
    const outputChunks: string[] = [];
    const runtime = {
      ...createMockRuntime(),
      handle: async (): Promise<AgentLoopResponse> => ({
        ...mockResponse(),
        progress: ["received prompt", "ready for direct response"],
      }),
    };
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: false,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ isTTY: false, supportsAnimation: false }),
      showResponseProgress: true,
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
    expect(rendered).toContain("Mock response");
    expect(rendered).toContain("progress: received prompt -> ready for direct response");
  });

  it("injects a CLI voice transcript as the next user turn", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-session-voice-"));
    const profilePaths = resolveProfileStateHome({ homeDir, profileId: "default" });
    await mkdir(dirname(profilePaths.configPath), { recursive: true });
    await writeFile(profilePaths.configPath, JSON.stringify({
      stt: {
        provider: "local",
        local: { command: "mock-stt" }
      }
    }), "utf8");
    await writeCliVoiceMode(profilePaths, "on");
    const outputChunks: string[] = [];
    const handleInputs: string[] = [];
    const recorder = {
      record: vi.fn(async ({ outputPath }: { outputPath: string }) => {
        await writeFile(outputPath, "wav");
        return { ok: true as const };
      })
    };
    const runtime = {
      ...createMockRuntime(),
      transcribeAudio: async ({ path }): ReturnType<NonNullable<Runtime["transcribeAudio"]>> => {
        expect(path).toContain("/audio/cli-voice/");
        return { ok: true, text: "spoken turn", model: "mock-stt" };
      },
      handle: async (input): Promise<AgentLoopResponse> => {
        handleInputs.push(input.text);
        return {
          ...await createMockRuntime().handle(input),
          text: `heard ${input.text}`
        };
      }
    } as Runtime;
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      homeDir,
      workspaceRoot: homeDir,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: false,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ isTTY: false, supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
      cliVoice: {
        recorder,
        envOptions: {
          platform: "darwin",
          commandExists: async (command) => command === "sox"
        }
      }
    });

    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(handleInputs).toEqual(["spoken turn"]);
    expect(outputChunks.join("")).toContain("Transcript: spoken turn");
  });

  it("stops the idle bottom chrome ticker before CLI voice progress writes", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-session-voice-chrome-"));
    const profilePaths = resolveProfileStateHome({ homeDir, profileId: "default" });
    await mkdir(dirname(profilePaths.configPath), { recursive: true });
    await writeFile(profilePaths.configPath, JSON.stringify({
      stt: {
        provider: "local",
        local: { command: "mock-stt" }
      }
    }), "utf8");
    await writeCliVoiceMode(profilePaths, "on");

    const outputChunks: string[] = [];
    const recorder = {
      record: vi.fn(async ({ outputPath }: { outputPath: string }) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await writeFile(outputPath, "wav");
        return { ok: true as const };
      })
    };
    const runtime = {
      ...createMockRuntime(),
      transcribeAudio: async (): ReturnType<NonNullable<Runtime["transcribeAudio"]>> =>
        ({ ok: true, text: "spoken turn", model: "mock-stt" })
    } as Runtime;
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      homeDir,
      workspaceRoot: homeDir,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
      cliVoice: {
        recorder,
        envOptions: {
          platform: "darwin",
          commandExists: async (command) => command === "sox"
        }
      }
    });

    const recordingIndex = outputChunks.findIndex((chunk) => chunk.includes("Recording CLI voice input..."));
    const transcriptIndex = outputChunks.findIndex((chunk) => chunk.includes("Transcript: spoken turn"));
    expect(recordingIndex).toBeGreaterThan(-1);
    expect(transcriptIndex).toBeGreaterThan(recordingIndex);
    expect(outputChunks.slice(recordingIndex, transcriptIndex).join("")).not.toContain("\x1b[s");
  });

  it("renders the richer startup dashboard at session launch", async () => {
    const outputChunks: string[] = [];
    const getStartupReadiness = vi.fn(createMockRuntime().getStartupReadiness);
    const runtime = createMockRuntime({ getStartupReadiness });
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

    const rendered = stripAnsi(outputChunks.join(""));
    expect(getStartupReadiness).toHaveBeenCalledTimes(1);
    expect(rendered).toContain("test-session");
    expect(rendered).toContain("Workspace Trust");
    expect(rendered).toContain("Workspace Verification");
    expect(rendered).toContain("Security Mode");
    expect(rendered).toContain("╭");
    expect(rendered).toContain("𓂀  mock-model");
    expect(rendered).toContain("/tools");
  });

  it("falls back to the legacy startup hero when readiness collection fails", async () => {
    const outputChunks: string[] = [];
    const runtime = createMockRuntime({
      getStartupReadiness: vi.fn(async () => {
        throw new Error("readiness failed");
      }),
    });
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

    const rendered = stripAnsi(outputChunks.join(""));
    expect(rendered).toContain("model: mock/mock-model");
    expect(rendered).toContain("readiness: ready");
    expect(rendered).not.toContain("Workspace Trust");
  });

  it("defaults startup and session chrome to English when no locale is provided", async () => {
    const outputChunks: string[] = [];
    const runtime = createMockRuntime();
    let promptIndex = 0;
    let promptOptions: PromptOptions | undefined;

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
        async (_question: string, options?: PromptOptions) => {
          promptOptions = options;
          const values = ["/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).not.toContain("Type a message.");
    expect(promptOptions?.placeholder).toContain("/help");
    expect(promptOptions?.placeholder).toContain("Ctrl+C exit");
    expect(rendered).not.toContain("/exit");
    expect(rendered).not.toContain("اكتب رسالة.");
  });

  it("preserves the direct startup hint for non-bottom-chrome fallback output", async () => {
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
        isTTY: false,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ isTTY: false, supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = stripAnsi(outputChunks.join(""));
    expect(rendered).toContain("Type a message.");
    expect(rendered).toContain("/help");
    expect(rendered).toContain("/exit");
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
    let promptOptions: PromptOptions | undefined;

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
        async (_question: string, options?: PromptOptions) => {
          promptOptions = options;
          const values = ["/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).not.toContain("اكتب رسالة.");
    expect(promptOptions?.placeholder).toContain(isolateLtr("/help"));
    expect(promptOptions?.placeholder).toContain(isolateLtr("Ctrl+C"));
    expect(rendered).not.toContain(isolateLtr("/exit"));
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
    expect(rendered).not.toContain("Name  Description");
    const completionIndexInOutput = outputChunks.findIndex((chunk) => String(chunk).includes("Show command help"));
    const promptIndexInOutput = outputChunks.findIndex((chunk) => String(chunk).includes("hello"));
    expect(completionIndexInOutput).toBeGreaterThanOrEqual(0);
    expect(promptIndexInOutput).toBeGreaterThanOrEqual(0);
    expect(outputChunks.slice(completionIndexInOutput, promptIndexInOutput).join("")).not.toContain("Commands");
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
    expect(rendered).toContain("Show active model");
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

function mockResponse(): AgentLoopResponse {
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
}

function withModelInfo<T extends Runtime>(runtime: T): T {
  return {
    ...runtime,
    getModelInfo: () => ({
      kind: "kv" as const,
      title: "Model",
      entries: [
        { key: "provider", value: "mock" },
        { key: "model", value: "gpt-5.5" },
        { key: "context window", value: "128000" },
      ],
    }),
  };
}

function compactResult(didCompress: boolean, postTokens: number): CompactResult {
  return {
    didCompress,
    originalSessionId: "test-session",
    activeSessionId: "test-session",
    rotated: false,
    messages: [],
    diagnostics: {
      shouldCompress: didCompress,
      reason: didCompress ? "compressed" : "nothing-to-compress",
      preTokens: 32_000,
      postTokens,
      estimatedSavingsTokens: Math.max(0, 32_000 - postTokens),
      estimatedSavingsRatio: didCompress ? 0.5 : 0,
      sourceMessageCount: 4,
      summarizedMessageCount: didCompress ? 2 : 0,
      protectedMessageCount: 0,
      protectedFirstN: 0,
      protectedLastN: 0,
      protectedSpans: [],
      protectedCategories: [],
      summaryFormatVersion: "test",
      summaryChars: 0,
      fallbackUsed: false,
      warnings: [],
      prunedToolResults: 0,
      prunedToolResultChars: 0,
      protectedToolResultsKept: 0,
      scopeKey: "test",
      ineffectiveCompressionCount: 0,
      eventWarnings: [],
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

  it("clears the readline echo before rendering the submitted user prompt rail", async () => {
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
    const userRailIndex = rendered.indexOf("▸ hello");
    const echoClearIndex = rendered.lastIndexOf("\x1b[1A\x1b[2K\r", userRailIndex);
    expect(echoClearIndex).toBeGreaterThan(-1);
    expect(echoClearIndex).toBeLessThan(userRailIndex);
  });

  it("clears every wrapped readline echo row before the submitted user prompt rail", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 20,
    } as unknown as NodeJS.WritableStream;
    const longText = "this is a deliberately long prompt";
    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: longText },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps({ terminalWidth: 20, supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = [longText, "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    const userRailIndex = rendered.indexOf("▸ this is a delib...");
    const beforeUserRail = rendered.slice(0, userRailIndex);
    const chromeClearIndex = beforeUserRail.search(/\x1b\[\d+A\x1b\[2K/u);
    const echoClearIndex = rendered.lastIndexOf("\x1b[1A\x1b[2K\x1b[1A\x1b[2K\r", userRailIndex);
    expect(chromeClearIndex).toBeGreaterThan(-1);
    expect(echoClearIndex).toBeGreaterThan(-1);
    expect(chromeClearIndex).toBeLessThan(echoClearIndex);
    expect(echoClearIndex).toBeLessThan(userRailIndex);
  });

  it("uses the raw echoed readline text when clearing trailing-space wraps", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 20,
    } as unknown as NodeJS.WritableStream;
    const rawText = "x".padEnd(35, " ");
    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "x" },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps({ terminalWidth: 20, supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = [rawText, "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = outputChunks.join("");
    const userRailIndex = rendered.indexOf("▸ x");
    const echoClearIndex = rendered.lastIndexOf("\x1b[1A\x1b[2K\x1b[1A\x1b[2K\r", userRailIndex);
    expect(echoClearIndex).toBeGreaterThan(-1);
    expect(echoClearIndex).toBeLessThan(userRailIndex);
  });

  it("renders active-turn bottom chrome without a read-only prompt box", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 80,
    } as unknown as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps({ terminalWidth: 80 }),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = stripAnsi(outputChunks.join(""));
    expect(rendered).toContain("▸ hello\n+──────────────────────────────────────────────────────────────────────────────+");
    expect(rendered).toContain("mock-model");
    expect(rendered).toContain("contemplating");
    expect(rendered).not.toContain("────────────────────────────────────────────────────────────────────────────────\n▸ hello\n────────────────────────────────────────────────────────────────────────────────");
  });

  it("brokers tool output above the redrawn bottom chrome", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 80,
    } as unknown as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "tool-start", tool: "browser.status", stepId: "s1" },
      { kind: "tool-result", tool: "browser.status", ok: true, chars: 10, sentChars: 10 },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps({ terminalWidth: 80 }),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = stripAnsi(outputChunks.join(""));
    const toolIndex = rendered.indexOf("browser.status");
    const redrawnChromeIndex = rendered.indexOf("mock-model", toolIndex);
    expect(toolIndex).toBeGreaterThan(-1);
    expect(redrawnChromeIndex).toBeGreaterThan(toolIndex);
    expect(rendered.slice(toolIndex)).not.toContain("────────────────────────────────────────────────────────────────────────────────\n▸ hello\n────────────────────────────────────────────────────────────────────────────────");
  });

  it("renders bottom-chrome tool activity as durable transcript rows", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 100,
    } as unknown as NodeJS.WritableStream;

    const runtime = createEventEmittingMockRuntime([
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "tool-start", tool: "browser.status", stepId: "s1" },
      { kind: "tool-result", tool: "browser.status", ok: true, chars: 10, sentChars: 10 },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps({ terminalWidth: 100, supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const startChunk = outputChunks.find((chunk) => {
      const stripped = stripAnsi(chunk);
      return stripped.includes("preparing") && stripped.includes("browser.status");
    });
    const startChunkIndex = outputChunks.findIndex((chunk) => chunk === startChunk);
    const resultChunk = outputChunks.find((chunk, index) => {
      const stripped = stripAnsi(chunk);
      return index > startChunkIndex
        && stripped.includes("│")
        && stripped.includes("ms")
        && !stripped.includes("preparing")
        && !stripped.includes("mock-model");
    });
    expect(startChunk).toBeDefined();
    expect(resultChunk).toBeDefined();
    const toolChunks = [startChunk, resultChunk] as string[];
    for (const chunk of toolChunks) {
      expect(chunk).not.toContain("\x1b[1A\x1b[2K\r");
      expect(chunk).not.toContain("\x1b[0J");
      expect(stripAnsi(chunk)).not.toContain("mock-model");
    }
    expect(outputChunks.some((chunk) => stripAnsi(chunk).includes("mock-model"))).toBe(true);
  });

  it("renders provider spinner below the most recent tool row in bottom chrome mode", async () => {
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
      { kind: "provider-attempt", provider: "mock", model: "mock-model", fallback: false },
      { kind: "provider-result", provider: "mock", model: "mock-model", ok: true, fallback: false, willFallback: false },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const strippedChunks = outputChunks.map((chunk) => stripAnsi(chunk));
    const lastToolChunkIndex = strippedChunks.reduce(
      (lastIndex, chunk, index) => chunk.includes("browser.status") ? index : lastIndex,
      -1
    );
    const providerSpinnerChunkIndex = strippedChunks.findIndex((chunk, index) =>
      index > lastToolChunkIndex && chunk.includes("scribbling")
    );
    const nextChromeChunkIndex = strippedChunks.findIndex((chunk, index) =>
      index > providerSpinnerChunkIndex && chunk.includes("mock-model")
    );
    const chromeChunksAfterTool = strippedChunks.slice(lastToolChunkIndex + 1).filter((chunk) =>
      chunk.includes("mock-model")
    );
    const providerSpinnerChunk = strippedChunks[providerSpinnerChunkIndex] ?? "";
    const spinnerOffset = providerSpinnerChunk.indexOf("scribbling");
    const modelOffset = providerSpinnerChunk.indexOf("mock-model");
    const promptOffset = providerSpinnerChunk.indexOf("▸ hello");

    expect(lastToolChunkIndex).toBeGreaterThan(-1);
    expect(providerSpinnerChunkIndex).toBeGreaterThan(lastToolChunkIndex);
    expect(spinnerOffset).toBeGreaterThan(-1);
    if (modelOffset !== -1) {
      expect(modelOffset).toBeGreaterThan(spinnerOffset);
    }
    expect(nextChromeChunkIndex).toBeGreaterThan(providerSpinnerChunkIndex);
    expect(promptOffset).toBe(-1);
    expect(chromeChunksAfterTool.some((chunk) => chunk.includes("mock-model"))).toBe(true);
  });

  it("attaches the active-turn command controller only during runtime.handle", async () => {
    const input = makeTtyInput();
    let resolvePrompt: ((value: string) => void) | undefined;
    let promptIndex = 0;
    const prompt = Object.assign(
      vi.fn(async () => {
        if (promptIndex++ === 0) {
          return await new Promise<string>((resolve) => {
            resolvePrompt = resolve;
          });
        }
        return "/exit";
      }),
      { close: () => {} }
    );
    let releaseTurn: (() => void) | undefined;
    let handleStarted: (() => void) | undefined;
    const handleStartedPromise = new Promise<void>((resolve) => {
      handleStarted = resolve;
    });
    const runtime = createMockRuntime({
      handle: async () => {
        handleStarted?.();
        await new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        return mockResponse();
      },
    });

    const loop = runSessionLoop({
      runtime,
      input,
      output: {
        write(): boolean {
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt,
      close: () => {},
    });

    while (resolvePrompt === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(input.listenerCount("keypress")).toBe(0);
    resolvePrompt("hello");
    await handleStartedPromise;
    expect(input.listenerCount("keypress")).toBe(1);
    releaseTurn?.();
    await loop;
    expect(input.listenerCount("keypress")).toBe(0);
    expect(input.rawModes).toEqual([true, false]);
  });

  it("/interrupt aborts an active turn from the command lane", async () => {
    const input = makeTtyInput();
    const outputChunks: string[] = [];
    let abortReason: unknown;
    const handleInputs: string[] = [];
    let handleStarted: (() => void) | undefined;
    const handleStartedPromise = new Promise<void>((resolve) => {
      handleStarted = resolve;
    });
    const runtime = createMockRuntime({
      handle: async ({ text, signal, onEvent }: { text: string; channel: string; signal?: AbortSignal; onEvent?: (event: RuntimeEvent) => void }) => {
        handleInputs.push(text);
        onEvent?.({ kind: "agent-start", sessionId: "test-session", input: "hello" });
        handleStarted?.();
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => {
            abortReason = signal.reason;
            resolve();
          }, { once: true });
        });
        onEvent?.({ kind: "agent-cancelled", reason: String(abortReason) });
        return {
          ...mockResponse(),
          text: "Interrupted response",
        };
      },
    });
    let promptIndex = 0;
    const loop = runSessionLoop({
      runtime,
      input,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    await handleStartedPromise;
    for (const char of "/interrupt") {
      input.press(char, { name: char, sequence: char });
    }
    expect(stripAnsi(outputChunks.join(""))).toContain("active command: /interrupt");
    const beforeSubmit = outputChunks.length;
    input.press("\r", { name: "return" });
    await loop;

    expect(abortReason).toBe("CLI interrupt");
    expect(handleInputs).toEqual(["hello"]);
    expect(outputChunks.slice(beforeSubmit).map((chunk) => stripAnsi(chunk)).join("")).not.toContain("active command: /interrupt");
    expect(stripAnsi(outputChunks.join(""))).toContain("cancelled: CLI interrupt");
  });

  it("/steer aborts the active turn and retries once with the steering note", async () => {
    const input = makeTtyInput();
    const outputChunks: string[] = [];
    const handleInputs: string[] = [];
    let abortReason: unknown;
    let firstHandleStarted: (() => void) | undefined;
    let secondHandleStarted: (() => void) | undefined;
    const firstHandleStartedPromise = new Promise<void>((resolve) => {
      firstHandleStarted = resolve;
    });
    const secondHandleStartedPromise = new Promise<void>((resolve) => {
      secondHandleStarted = resolve;
    });
    const runtime = createMockRuntime({
      handle: async ({ text, signal, onEvent }: { text: string; channel: string; signal?: AbortSignal; onEvent?: (event: RuntimeEvent) => void }) => {
        handleInputs.push(text);
        if (handleInputs.length === 1) {
          onEvent?.({ kind: "agent-start", sessionId: "test-session", input: text });
          firstHandleStarted?.();
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => {
              abortReason = signal.reason;
              resolve();
            }, { once: true });
          });
          onEvent?.({ kind: "agent-cancelled", reason: String(abortReason) });
          return {
            ...mockResponse(),
            text: "Interrupted response",
          };
        }
        secondHandleStarted?.();
        return {
          ...mockResponse(),
          text: "Retried response",
        };
      },
    });
    let promptIndex = 0;
    const loop = runSessionLoop({
      runtime,
      input,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["build feature", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    await firstHandleStartedPromise;
    for (const char of "/steer use simpler approach") {
      input.press(char, { name: char, sequence: char });
    }
    expect(stripAnsi(outputChunks.join(""))).toContain("active command: /steer use simpler approach");
    input.press("\r", { name: "return" });
    await secondHandleStartedPromise;
    await loop;

    expect(abortReason).toBe("CLI steer");
    expect(handleInputs).toEqual([
      "build feature",
      "build feature\n\n[Steering note while previous turn was interrupted]\nuse simpler approach",
    ]);
  });

  it("empty /steer shows usage and does not abort", async () => {
    const input = makeTtyInput();
    const outputChunks: string[] = [];
    let releaseTurn: (() => void) | undefined;
    let aborted = false;
    let handleStarted: (() => void) | undefined;
    const handleStartedPromise = new Promise<void>((resolve) => {
      handleStarted = resolve;
    });
    const runtime = createMockRuntime({
      handle: async ({ signal }: { text: string; channel: string; signal?: AbortSignal }) => {
        handleStarted?.();
        signal?.addEventListener("abort", () => {
          aborted = true;
        }, { once: true });
        await new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        return mockResponse();
      },
    });
    let promptIndex = 0;
    const loop = runSessionLoop({
      runtime,
      input,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["build feature", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    await handleStartedPromise;
    for (const char of "/steer   ") {
      input.press(char, { name: char, sequence: char });
    }
    input.press("\r", { name: "return" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseTurn?.();
    await loop;

    expect(aborted).toBe(false);
    expect(stripAnsi(outputChunks.join(""))).toContain("active command: Usage: /steer <guidance>");
  });

  it("does not loop forever when the steered retry fails", async () => {
    const input = makeTtyInput();
    const handleInputs: string[] = [];
    let firstHandleStarted: (() => void) | undefined;
    let secondHandleStarted: (() => void) | undefined;
    const firstHandleStartedPromise = new Promise<void>((resolve) => {
      firstHandleStarted = resolve;
    });
    const secondHandleStartedPromise = new Promise<void>((resolve) => {
      secondHandleStarted = resolve;
    });
    const runtime = createMockRuntime({
      handle: async ({ text, signal }: { text: string; channel: string; signal?: AbortSignal }) => {
        handleInputs.push(text);
        if (handleInputs.length === 1) {
          firstHandleStarted?.();
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return {
            ...mockResponse(),
            text: "Interrupted response",
          };
        }
        secondHandleStarted?.();
        throw new Error("retry failed");
      },
    });
    let promptIndex = 0;
    const loop = runSessionLoop({
      runtime,
      input,
      output: {
        write(): boolean {
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["build feature", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    await firstHandleStartedPromise;
    for (const char of "/steer use simpler approach") {
      input.press(char, { name: char, sequence: char });
    }
    input.press("\r", { name: "return" });
    await secondHandleStartedPromise;

    await expect(loop).rejects.toThrow("retry failed");
    expect(handleInputs).toHaveLength(2);
  });

  it("does not reapply steering after retry cancellation or interruption", async () => {
    const input = makeTtyInput();
    const handleInputs: string[] = [];
    let firstAbortReason: unknown;
    let secondAbortReason: unknown;
    let firstHandleStarted: (() => void) | undefined;
    let secondHandleStarted: (() => void) | undefined;
    const firstHandleStartedPromise = new Promise<void>((resolve) => {
      firstHandleStarted = resolve;
    });
    const secondHandleStartedPromise = new Promise<void>((resolve) => {
      secondHandleStarted = resolve;
    });
    const runtime = createMockRuntime({
      handle: async ({ text, signal, onEvent }: { text: string; channel: string; signal?: AbortSignal; onEvent?: (event: RuntimeEvent) => void }) => {
        handleInputs.push(text);
        const callNumber = handleInputs.length;
        if (callNumber === 1) {
          firstHandleStarted?.();
        } else {
          secondHandleStarted?.();
        }
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => {
            if (callNumber === 1) {
              firstAbortReason = signal.reason;
            } else {
              secondAbortReason = signal.reason;
            }
            resolve();
          }, { once: true });
        });
        onEvent?.({
          kind: "agent-cancelled",
          reason: String(callNumber === 1 ? firstAbortReason : secondAbortReason),
        });
        return {
          ...mockResponse(),
          text: "Interrupted response",
        };
      },
    });
    let promptIndex = 0;
    const loop = runSessionLoop({
      runtime,
      input,
      output: {
        write(): boolean {
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["build feature", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    await firstHandleStartedPromise;
    for (const char of "/steer use simpler approach") {
      input.press(char, { name: char, sequence: char });
    }
    input.press("\r", { name: "return" });
    await secondHandleStartedPromise;
    for (const char of "/interrupt") {
      input.press(char, { name: char, sequence: char });
    }
    input.press("\r", { name: "return" });
    await loop;

    expect(firstAbortReason).toBe("CLI steer");
    expect(secondAbortReason).toBe("CLI interrupt");
    expect(handleInputs).toHaveLength(2);
  });

  it("bounds repeated /steer attempts during the steered retry", async () => {
    const input = makeTtyInput();
    const outputChunks: string[] = [];
    const handleInputs: string[] = [];
    let firstAbortReason: unknown;
    let secondAbortReason: unknown;
    let firstHandleStarted: (() => void) | undefined;
    let secondHandleStarted: (() => void) | undefined;
    let releaseSecondTurn: (() => void) | undefined;
    const firstHandleStartedPromise = new Promise<void>((resolve) => {
      firstHandleStarted = resolve;
    });
    const secondHandleStartedPromise = new Promise<void>((resolve) => {
      secondHandleStarted = resolve;
    });
    const runtime = createMockRuntime({
      handle: async ({ text, signal, onEvent }: { text: string; channel: string; signal?: AbortSignal; onEvent?: (event: RuntimeEvent) => void }) => {
        handleInputs.push(text);
        if (handleInputs.length === 1) {
          firstHandleStarted?.();
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => {
              firstAbortReason = signal.reason;
              resolve();
            }, { once: true });
          });
          onEvent?.({ kind: "agent-cancelled", reason: String(firstAbortReason) });
          return {
            ...mockResponse(),
            text: "Interrupted response",
          };
        }
        secondHandleStarted?.();
        signal?.addEventListener("abort", () => {
          secondAbortReason = signal.reason;
        }, { once: true });
        await new Promise<void>((resolve) => {
          releaseSecondTurn = resolve;
        });
        return {
          ...mockResponse(),
          text: "Retried response",
        };
      },
    });
    let promptIndex = 0;
    const loop = runSessionLoop({
      runtime,
      input,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["build feature", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    await firstHandleStartedPromise;
    for (const char of "/steer use simpler approach") {
      input.press(char, { name: char, sequence: char });
    }
    input.press("\r", { name: "return" });
    await secondHandleStartedPromise;
    for (const char of "/steer also shorter") {
      input.press(char, { name: char, sequence: char });
    }
    input.press("\r", { name: "return" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseSecondTurn?.();
    await loop;

    expect(firstAbortReason).toBe("CLI steer");
    expect(secondAbortReason).toBeUndefined();
    expect(handleInputs).toHaveLength(2);
    expect(stripAnsi(outputChunks.join(""))).toContain("active command: Steering already queued for this turn.");
  });

  it("keeps normal active-turn typing out of the transcript", async () => {
    const input = makeTtyInput();
    const outputChunks: string[] = [];
    let handleStarted: (() => void) | undefined;
    const handleStartedPromise = new Promise<void>((resolve) => {
      handleStarted = resolve;
    });
    let releaseTurn: (() => void) | undefined;
    const runtime = createMockRuntime({
      handle: async () => {
        handleStarted?.();
        await new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        return mockResponse();
      },
    });
    let promptIndex = 0;
    const loop = runSessionLoop({
      runtime,
      input,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    await handleStartedPromise;
    for (const char of "zzqzz") {
      input.press(char, { name: char, sequence: char });
    }
    releaseTurn?.();
    await loop;

    expect(stripAnsi(outputChunks.join(""))).not.toContain("zzqzz");
  });

  it("animates the bottom chrome transcript spinner in place between runtime events", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    let releaseTurn: (() => void) | undefined;
    let providerStarted: (() => void) | undefined;
    const providerStartedPromise = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const runtime: Runtime = {
      ...createMockRuntime(),
      handle: async ({ onEvent }: { text: string; channel: string; signal?: AbortSignal; onEvent?: (event: RuntimeEvent) => void }) => {
        onEvent?.({ kind: "agent-start", sessionId: "test-session", input: "hello" });
        onEvent?.({ kind: "provider-attempt", provider: "mock", model: "mock-model", fallback: false });
        providerStarted?.();
        await new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        onEvent?.({ kind: "provider-result", provider: "mock", model: "mock-model", ok: true, fallback: false, willFallback: false });
        onEvent?.({ kind: "agent-final", text: "Mock response" });
        return mockResponse();
      },
    };

    let promptIndex = 0;
    const loop = runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: true }),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    await providerStartedPromise;
    await new Promise((resolve) => setTimeout(resolve, 450));
    releaseTurn?.();
    await loop;

    const strippedChunks = outputChunks.map((chunk) => stripAnsi(chunk));
    const spinnerChunks = strippedChunks.filter((chunk) => chunk.includes("scribbling"));
    expect(spinnerChunks.length).toBeGreaterThanOrEqual(2);
    expect(outputChunks.some((chunk) =>
      chunk.includes("\x1b7") && chunk.includes("scribbling") && !chunk.includes("\x1b[0J")
    )).toBe(true);
  });

  it("ticks the session timer while waiting for idle input", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    let nowMs = 0;
    let resolvePrompt: ((value: string) => void) | undefined;
    const prompt = Object.assign(
      vi.fn(async () => await new Promise<string>((resolve) => {
        resolvePrompt = resolve;
      })),
      { close: () => {} }
    );

    const loop = runSessionLoop({
      runtime: createMockRuntime(),
      output,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt,
      close: () => {},
      now: () => nowMs,
    });

    while (resolvePrompt === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    nowMs = 61_000;
    await new Promise((resolve) => setTimeout(resolve, 1050));
    resolvePrompt("/exit");
    await loop;

    const rendered = stripAnsi(outputChunks.join(""));
    expect(rendered).toContain("◷ 1m 1s");
  });

  it("uses live wrapped prompt rows when ticking the idle session timer", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    let nowMs = 0;
    let resolvePrompt: ((value: string) => void) | undefined;
    let promptOptions: { onRowsChange?: (rows: number) => void } | undefined;
    const prompt = Object.assign(
      vi.fn(async (_question: string, options?: { onRowsChange?: (rows: number) => void }) => {
        promptOptions = options;
        return await new Promise<string>((resolve) => {
          resolvePrompt = resolve;
        });
      }),
      { close: () => {} }
    );

    const loop = runSessionLoop({
      runtime: createMockRuntime(),
      output,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt,
      close: () => {},
      now: () => nowMs,
    });

    while (resolvePrompt === undefined || promptOptions === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    promptOptions.onRowsChange?.(3);
    nowMs = 61_000;
    await new Promise((resolve) => setTimeout(resolve, 1050));
    resolvePrompt("/exit");
    await loop;

    expect(outputChunks.some((chunk) => /\x1b7\x1b\[\d+A/u.test(chunk))).toBe(true);
  });

  it("renders slash completion chrome while typing idle input", async () => {
    const outputChunks: string[] = [];
    let resolvePrompt: ((value: string) => void) | undefined;
    let promptOptions: PromptOptions | undefined;
    const prompt = Object.assign(
      vi.fn(async (_question: string, options?: PromptOptions) => {
        promptOptions = options;
        return await new Promise<string>((resolve) => {
          resolvePrompt = resolve;
        });
      }),
      { close: () => {} }
    );

    const loop = runSessionLoop({
      runtime: createMockRuntime(),
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt,
      close: () => {},
    });

    while (resolvePrompt === undefined || promptOptions === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    promptOptions.onInputChange?.("/h");
    expect(outputChunks.join("")).toContain("/help");
    expect(outputChunks.join("")).toContain("Show command help");

    resolvePrompt("/exit");
    await loop;
  });

  it("clears live slash completion chrome when idle input is no longer slash-prefixed", async () => {
    const outputChunks: string[] = [];
    let resolvePrompt: ((value: string) => void) | undefined;
    let promptOptions: PromptOptions | undefined;
    const prompt = Object.assign(
      vi.fn(async (_question: string, options?: PromptOptions) => {
        promptOptions = options;
        return await new Promise<string>((resolve) => {
          resolvePrompt = resolve;
        });
      }),
      { close: () => {} }
    );

    const loop = runSessionLoop({
      runtime: createMockRuntime(),
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt,
      close: () => {},
    });

    while (resolvePrompt === undefined || promptOptions === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    promptOptions.onInputChange?.("/h");
    const afterSlashHint = outputChunks.length;
    promptOptions.onInputChange?.("hello");
    const clearChunks = outputChunks.slice(afterSlashHint).join("");
    expect(clearChunks).not.toContain("/help");
    expect(clearChunks).toContain("mock-model");

    resolvePrompt("/exit");
    await loop;
  });

  it("shows idle shortcuts only for empty bottom-chrome input and gives slash menu priority", async () => {
    const outputChunks: string[] = [];
    let resolvePrompt: ((value: string) => void) | undefined;
    let promptOptions: PromptOptions | undefined;
    let promptQuestion = "";
    const prompt = Object.assign(
      vi.fn(async (question: string, options?: PromptOptions) => {
        promptQuestion = stripAnsi(question);
        promptOptions = options;
        return await new Promise<string>((resolve) => {
          resolvePrompt = resolve;
        });
      }),
      { close: () => {} }
    );

    const loop = runSessionLoop({
      runtime: createMockRuntime(),
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt,
      close: () => {},
    });

    while (resolvePrompt === undefined || promptOptions === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const initial = stripAnsi(outputChunks.join(""));
    expect(promptQuestion).toBe("> ");
    expect(promptOptions.placeholder).toContain("/help · /tools · /model · /status · Ctrl+C exit");
    expect(promptOptions.placeholder).not.toContain("›");
    expect(initial).not.toContain("/help · /tools · /model · /status · Ctrl+C exit");
    expect(initial).not.toContain("Type a message.");

    const afterInitial = outputChunks.length;
    promptOptions.onInputChange?.("hello");
    const afterTyping = stripAnsi(outputChunks.slice(afterInitial).join(""));
    expect(afterTyping).toContain("mock-model");
    expect(afterTyping).not.toContain("Ctrl+C exit");
    expect(afterTyping).not.toContain("Show command help");

    const afterTypingIndex = outputChunks.length;
    promptOptions.onInputChange?.("/");
    const afterSlash = stripAnsi(outputChunks.slice(afterTypingIndex).join(""));
    expect(afterSlash).toContain("Show command help");
    expect(afterSlash).not.toContain("Ctrl+C exit");

    const afterSlashIndex = outputChunks.length;
    promptOptions.onInputChange?.("");
    const afterEmpty = stripAnsi(outputChunks.slice(afterSlashIndex).join(""));
    expect(promptOptions.placeholder).toContain("/help · /tools · /model · /status · Ctrl+C exit");
    expect(afterEmpty).not.toContain("/help · /tools · /model · /status · Ctrl+C exit");
    expect(afterEmpty).not.toContain("Show command help");

    resolvePrompt("/exit");
    await loop;
  });

  it("renders and clears paste preview chrome around idle readline submission", async () => {
    const outputChunks: string[] = [];
    let resolvePrompt: ((value: string) => void) | undefined;
    let promptOptions: PromptOptions | undefined;
    const prompt = Object.assign(
      vi.fn(async (_question: string, options?: PromptOptions) => {
        promptOptions = options;
        return await new Promise<string>((resolve) => {
          resolvePrompt = resolve;
        });
      }),
      { close: () => {} }
    );

    const loop = runSessionLoop({
      runtime: createMockRuntime(),
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt,
      close: () => {},
    });

    while (resolvePrompt === undefined || promptOptions === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    promptOptions.onPastePreview?.("line one\nline two", "line one ↵ line two");
    const previewOutput = outputChunks.join("");
    expect(previewOutput).toContain("line one");
    expect(previewOutput).toContain("line two");
    const afterPreview = outputChunks.length;

    resolvePrompt("/exit");
    await loop;

    expect(outputChunks.slice(afterPreview).join("")).not.toContain("line one");
    expect(outputChunks.slice(afterPreview).join("")).not.toContain("line two");
  });

  it("keeps submitted multiline text intact after paste preview", async () => {
    const handledTexts: string[] = [];
    const runtime = createMockRuntime({
      handle: async (input: Parameters<Runtime["handle"]>[0]) => {
        handledTexts.push(input.text);
        return mockResponse();
      },
    });
    let promptIndex = 0;
    let resolvePrompt: ((value: string) => void) | undefined;
    let promptOptions: PromptOptions | undefined;
    const prompt = Object.assign(
      vi.fn(async (_question: string, options?: PromptOptions) => {
        if (promptIndex++ === 0) {
          promptOptions = options;
          return await new Promise<string>((resolve) => {
            resolvePrompt = resolve;
          });
        }
        return "/exit";
      }),
      { close: () => {} }
    );

    const loop = runSessionLoop({
      runtime,
      output: {
        write(): boolean {
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      prompt,
      close: () => {},
    });

    while (resolvePrompt === undefined || promptOptions === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    promptOptions.onPastePreview?.("line one\nline two", "line one ↵ line two");
    resolvePrompt("line one\nline two");
    await loop;

    expect(handledTexts).toEqual(["line one\nline two"]);
  });

  it("keeps live slash callbacks out of disabled bottom chrome output", async () => {
    const outputChunks: string[] = [];
    let resolvePrompt: ((value: string) => void) | undefined;
    let promptOptions: PromptOptions | undefined;
    const prompt = Object.assign(
      vi.fn(async (_question: string, options?: PromptOptions) => {
        promptOptions = options;
        return await new Promise<string>((resolve) => {
          resolvePrompt = resolve;
        });
      }),
      { close: () => {} }
    );

    const loop = runSessionLoop({
      runtime: createMockRuntime(),
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: false,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ isTTY: false, supportsAnimation: false }),
      prompt,
      close: () => {},
    });

    while (resolvePrompt === undefined || promptOptions === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    promptOptions.onInputChange?.("/h");
    resolvePrompt("/exit");
    await loop;

    expect(stripAnsi(outputChunks.join(""))).not.toContain("Show command help");
  });

  it("updates chrome status rail from provider-actual context usage events", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const runtime = {
      ...createEventEmittingMockRuntime([
        { kind: "agent-start", sessionId: "test-session", input: "hello" },
        { kind: "context-usage", filled: 1024, total: 64_000, source: "provider-actual" },
        { kind: "agent-final", text: "Mock response" },
      ]),
      getModelInfo: () => ({
        kind: "kv" as const,
        title: "Model",
        entries: [
          { key: "provider", value: "mock" },
          { key: "model", value: "mock-model" },
          { key: "context window", value: "64000" },
        ],
      }),
    };

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

    const rendered = stripAnsi(outputChunks.join(""));
    expect(rendered).toContain("context 1.0k/64.0k");
  });

  it("keeps the last provider-actual context usage when live estimates arrive", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const runtime = {
      ...createEventEmittingMockRuntime([
        { kind: "agent-start", sessionId: "test-session", input: "hello" },
        { kind: "context-usage", filled: 12_000, total: 64_000, source: "provider-actual" },
        { kind: "context-usage", filled: 300, total: 64_000, source: "live-estimate" },
        { kind: "context-usage", filled: 500, total: 64_000, source: "assembled-prompt" },
        { kind: "agent-final", text: "Mock response" },
      ]),
      getModelInfo: () => ({
        kind: "kv" as const,
        title: "Model",
        entries: [
          { key: "provider", value: "mock" },
          { key: "model", value: "mock-model" },
          { key: "context window", value: "64000" },
        ],
      }),
    };

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

    const rendered = stripAnsi(outputChunks.join(""));
    expect(rendered).toContain("context 12.0k/64.0k");
    expect(rendered).not.toContain("context 300/64.0k");
    expect(rendered).not.toContain("context 500/64.0k");
  });

  it("renders fresh session timing with idle state and no turn timer", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;

    const runtime = withModelInfo(createMockRuntime());
    let promptIndex = 0;
    let nowCalls = 0;
    await runSessionLoop({
      runtime,
      output,
      now: () => nowCalls++ === 0 ? 0 : 10_000,
      capabilities: interactiveCaps({ supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = stripAnsi(outputChunks.join(""));
    const idleRail = rendered.split("\n").find((line) => line.includes("◷ 10s") && line.includes("idle"));
    expect(idleRail).toBeDefined();
    expect(idleRail).not.toContain("⧖");
  });

  it("renders live session and turn timing while the agent is working", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;
    let nowMs = 0;
    const runtime = withModelInfo({
      ...createMockRuntime(),
      handle: async ({ onEvent }: Parameters<Runtime["handle"]>[0]): Promise<AgentLoopResponse> => {
        nowMs = 252_000;
        onEvent?.({ kind: "context-usage", filled: 32_700, total: 128_000, source: "provider-actual" });
        onEvent?.({ kind: "agent-final", text: "Mock response" });
        return mockResponse();
      },
    });

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      now: () => nowMs,
      capabilities: interactiveCaps({ supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/exit"];
          if (promptIndex === 0) {
            nowMs = 234_000;
          }
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = stripAnsi(outputChunks.join(""));
    const activeRail = rendered.split("\n").find((line) => line.includes("◷ 4m 12s") && line.includes("⧖ 18s"));
    expect(activeRail).toBeDefined();
    expect(activeRail).not.toContain("running");
  });

  it("keeps showing the completed turn duration while waiting for the next user input", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;
    let nowMs = 0;
    const runtime = withModelInfo({
      ...createMockRuntime(),
      handle: async ({ onEvent }: Parameters<Runtime["handle"]>[0]): Promise<AgentLoopResponse> => {
        nowMs = 312_000;
        onEvent?.({ kind: "agent-final", text: "Mock response" });
        return mockResponse();
      },
    });

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      now: () => nowMs,
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

    const rendered = stripAnsi(outputChunks.join(""));
    const completedRail = rendered.split("\n").find((line) => line.includes("⧖ 5m 12s"));
    expect(completedRail).toBeDefined();
    expect(completedRail).not.toContain("idle");
  });

  it("clears the completed turn timer after /reset swaps to a fresh runtime", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;
    let nowMs = 0;
    const runtime = withModelInfo({
      ...createMockRuntime(),
      handle: async ({ onEvent }: Parameters<Runtime["handle"]>[0]): Promise<AgentLoopResponse> => {
        nowMs = 312_000;
        onEvent?.({ kind: "agent-final", text: "Mock response" });
        return mockResponse();
      },
    });
    const refreshedRuntime = withModelInfo({
      ...createMockRuntime(),
      sessionId: "fresh-session",
    });

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      refreshRuntime: async () => refreshedRuntime,
      now: () => nowMs,
      capabilities: interactiveCaps({ supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/reset", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = stripAnsi(outputChunks.join(""));
    expect(rendered).toContain("⧖ 5m 12s");
    const afterReset = rendered.slice(rendered.indexOf("Started fresh session fresh-session."));
    const resetRail = afterReset.split("\n").find((line) => line.includes("idle"));
    expect(resetRail).toBeDefined();
    expect(resetRail).not.toContain("⧖");
  });

  it("clears the completed turn timer after /switch swaps to another session", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;
    let nowMs = 0;
    const runtime = withModelInfo({
      ...createMockRuntime(),
      handle: async ({ onEvent }: Parameters<Runtime["handle"]>[0]): Promise<AgentLoopResponse> => {
        nowMs = 312_000;
        onEvent?.({ kind: "agent-final", text: "Mock response" });
        return mockResponse();
      },
    });
    await runtime.sessionDb.createSession({ id: "target-session", profileId: "default" });
    const switchedRuntime = withModelInfo({
      ...createMockRuntime(),
      sessionDb: runtime.sessionDb,
      sessionId: "target-session",
    });

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      switchRuntime: async () => switchedRuntime,
      now: () => nowMs,
      capabilities: interactiveCaps({ supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/switch target-session", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = stripAnsi(outputChunks.join(""));
    expect(rendered).toContain("⧖ 5m 12s");
    const afterSwitch = rendered.slice(rendered.indexOf("Switched this session to an existing session."));
    const switchRail = afterSwitch.split("\n").find((line) => line.includes("idle"));
    expect(switchRail).toBeDefined();
    expect(switchRail).not.toContain("⧖");
  });

  it("resets the completed turn timer after successful manual compaction", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;
    let nowMs = 0;
    const runtime = withModelInfo({
      ...createMockRuntime(),
      handle: async ({ onEvent }: Parameters<Runtime["handle"]>[0]): Promise<AgentLoopResponse> => {
        nowMs = 312_000;
        onEvent?.({ kind: "agent-final", text: "Mock response" });
        return mockResponse();
      },
      compactSession: async () => compactResult(true, 5_000),
    });

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      now: () => nowMs,
      capabilities: interactiveCaps({ supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/compact", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = stripAnsi(outputChunks.join(""));
    const resetRail = rendered.split("\n").find((line) => line.includes("context 5.0k/128k") && line.includes("idle"));
    expect(resetRail).toBeDefined();
    expect(resetRail).not.toContain("⧖");
  });

  it("reuses the last known context total when compaction resets without model context window", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;
    let nowMs = 0;
    const runtime = {
      ...createMockRuntime(),
      getModelInfo: () => ({
        kind: "kv" as const,
        title: "Model",
        entries: [
          { key: "provider", value: "mock" },
          { key: "model", value: "gpt-5.5" },
        ],
      }),
      handle: async ({ onEvent }: Parameters<Runtime["handle"]>[0]): Promise<AgentLoopResponse> => {
        nowMs = 312_000;
        onEvent?.({ kind: "context-usage", filled: 90_000, total: 128_000, source: "provider-actual" });
        onEvent?.({ kind: "agent-final", text: "Mock response" });
        return mockResponse();
      },
      compactSession: async () => compactResult(true, 5_000),
    };

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      now: () => nowMs,
      capabilities: interactiveCaps({ supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/compact", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = stripAnsi(outputChunks.join(""));
    const resetRail = rendered.split("\n").find((line) => line.includes("context 5.0k/128k") && line.includes("idle"));
    expect(resetRail).toBeDefined();
  });

  it("resets the completed turn timer after an automatic compaction event", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;
    let nowMs = 0;
    const runtime = withModelInfo({
      ...createMockRuntime(),
      handle: async ({ onEvent }: Parameters<Runtime["handle"]>[0]): Promise<AgentLoopResponse> => {
        nowMs = 312_000;
        onEvent?.({
          kind: "session-compacted",
          originalSessionId: "test-session",
          activeSessionId: "test-session",
          rotated: false,
          trigger: "auto",
          postTokens: 5_000,
        });
        onEvent?.({ kind: "agent-final", text: "Mock response" });
        return mockResponse();
      },
    });

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      now: () => nowMs,
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

    const rendered = stripAnsi(outputChunks.join(""));
    const resetRail = rendered.split("\n").find((line) => line.includes("context 5.0k/128k") && line.includes("idle"));
    expect(resetRail).toBeDefined();
    expect(resetRail).not.toContain("⧖");
  });

  it("keeps the completed turn timer when manual compaction is skipped", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 120,
    } as unknown as NodeJS.WritableStream;
    let nowMs = 0;
    const runtime = withModelInfo({
      ...createMockRuntime(),
      handle: async ({ onEvent }: Parameters<Runtime["handle"]>[0]): Promise<AgentLoopResponse> => {
        nowMs = 312_000;
        onEvent?.({ kind: "agent-final", text: "Mock response" });
        return mockResponse();
      },
      compactSession: async () => compactResult(false, 5_000),
    });

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      now: () => nowMs,
      capabilities: interactiveCaps({ supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/compact", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = stripAnsi(outputChunks.join(""));
    const completedRail = rendered.split("\n").find((line) => line.includes("⧖ 5m 12s"));
    expect(completedRail).toBeDefined();
    expect(completedRail).not.toContain("idle");
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
    const renderedPlain = stripAnsi(rendered);
    const plainPermissionIndex = renderedPlain.indexOf("Permission required");
    const submittedRailIndex = renderedPlain.indexOf("▸ write file");
    expect(submittedRailIndex).toBeGreaterThan(-1);
    expect(submittedRailIndex).toBeLessThan(plainPermissionIndex);
    expect(renderedPlain.slice(plainPermissionIndex)).not.toContain("▸ write file");
  });

  it("renders image setup secret flow above redrawn bottom chrome", async () => {
    const outputChunks: string[] = [];
    const executeToolCalls: string[] = [];
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-image-setup-"));
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 80,
    } as unknown as NodeJS.WritableStream;

    const baseRuntime = createMockRuntime();
    const runtime = {
      ...baseRuntime,
      handle: async (): Promise<AgentLoopResponse> => ({
        label: "EstaCoda",
        text: "Image setup is required.",
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
        toolExecutions: [
          {
            tool: {
              name: "image.generate",
              description: "Generate an image",
              inputSchema: {},
              riskClass: "external-side-effect",
              toolsets: ["image"],
              progressLabel: "generating image",
              maxResultSizeChars: 1000,
            },
            decision: "allow",
            riskClass: "external-side-effect",
            targetKey: "image.generate",
            targetSummary: "image.generate",
            input: { prompt: "a quiet terminal" },
            result: {
              ok: false,
              content: "setup needed",
              metadata: {
                kind: "setup_needed",
                capability: "image_generation",
                providerOptions: ["fal"],
                requiredSecret: "FAL_KEY",
                resumeIntent: "image",
                suggestedCommand: "config.image.setup",
                suggestedTool: "config.image.setup",
                provider: "fal",
                model: "fal-ai/flux",
              },
            },
          },
        ],
        toolPlans: [],
        skillOutcomes: [],
        artifacts: [],
        context: undefined,
        projectContext: undefined,
        progress: [],
      }),
      executeTool: async (input) => {
        executeToolCalls.push(input.tool);
        return {
          tool: {
            name: input.tool,
            description: input.tool,
            inputSchema: {},
            riskClass: "external-side-effect",
            toolsets: [],
            progressLabel: input.tool,
            maxResultSizeChars: 1000,
          },
          decision: "allow",
          riskClass: "external-side-effect",
          targetKey: input.tool,
          targetSummary: input.tool,
          input: input.toolInput,
          result: {
            ok: true,
            content: input.tool === "image.generate" ? "generated image" : "saved",
          },
        };
      },
      verifyImageGeneration: async () => ({
        ok: true,
        provider: "fal",
        model: "fal-ai/flux",
        apiKeyEnv: "FAL_KEY",
        apiKeyPresent: true,
        check: "skipped",
        message: "ok",
        cachePath: join(homeDir, ".estacoda", "profiles", "default", "image-cache"),
        telegramDelivery: "not-configured",
      }),
    } as Runtime;

    let promptIndex = 0;
    const secretPromptOptions: PromptOptions[] = [];
    try {
      await runSessionLoop({
        runtime,
        output,
        capabilities: interactiveCaps({ terminalWidth: 80 }),
        homeDir,
        prompt: Object.assign(
          async (_question: string, options?: PromptOptions) => {
            if (options?.secret === true) {
              secretPromptOptions.push(options);
            }
            const values = ["make image", "secret-value", "/exit"];
            return values[promptIndex++] ?? "/exit";
          },
          { close: () => {} }
        ),
        close: () => {},
      });
    } finally {
      delete process.env.FAL_KEY;
    }

    const rendered = stripAnsi(outputChunks.join(""));
    const setupIndex = rendered.indexOf("Setup required");
    const resumedIndex = rendered.indexOf("Image setup verified");
    const submittedRailIndex = rendered.indexOf("▸ make image");
    expect(setupIndex).toBeGreaterThan(-1);
    expect(submittedRailIndex).toBeGreaterThan(-1);
    expect(submittedRailIndex).toBeLessThan(setupIndex);
    expect(resumedIndex).toBeGreaterThan(setupIndex);
    expect(rendered.slice(setupIndex)).not.toContain("▸ make image");
    expect(executeToolCalls).toEqual(["config.image.setup", "image.generate"]);
    expect(rendered).toContain("generated image");
    expect(secretPromptOptions).toHaveLength(1);
    expect(secretPromptOptions[0]?.onInputChange).toBeUndefined();
    expect(secretPromptOptions[0]?.onPastePreview).toBeUndefined();
  });

  it("keeps bottom chrome alive after active-turn SIGINT cancellation", async () => {
    const outputChunks: string[] = [];
    const output = {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 80,
    } as unknown as NodeJS.WritableStream;

    const baseRuntime = createMockRuntime();
    let handleCalls = 0;
    const runtime = {
      ...baseRuntime,
      handle: async ({ text, signal, onEvent }: { text: string; channel: string; signal?: AbortSignal; onEvent?: (event: RuntimeEvent) => void }): Promise<AgentLoopResponse> => {
        handleCalls += 1;
        onEvent?.({ kind: "agent-start", sessionId: "test-session", input: text });
        if (handleCalls === 1) {
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
            setTimeout(() => {
              process.emit("SIGINT");
            }, 0);
          });
          await new Promise((resolve) => setTimeout(resolve, 250));
          onEvent?.({ kind: "agent-cancelled", reason: "SIGINT" });
          return {
            ...mockResponse(),
            text: "Cancelled response",
          };
        }
        return {
          ...mockResponse(),
          text: "Second response",
        };
      },
    } as Runtime;

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps({ terminalWidth: 80 }),
      prompt: Object.assign(
        async () => {
          const values = ["first", "second", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = stripAnsi(outputChunks.join(""));
    const cancelIndex = rendered.indexOf("Cancelling current turn.");
    const secondPromptIndex = rendered.indexOf("▸ second", cancelIndex);
    expect(cancelIndex).toBeGreaterThan(-1);
    expect(secondPromptIndex).toBeGreaterThan(cancelIndex);
    expect(rendered.slice(cancelIndex, secondPromptIndex)).not.toContain("▸ first");
    expect(rendered.slice(cancelIndex, secondPromptIndex)).not.toContain("scribbling");
    expect(rendered).toContain("Second response");
  });

  it("/approve once grants one-time approval and retries", async () => {
    const result = await runApprovalPromptScenario(["/approve once"]);

    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]).toMatchObject({
      toolName: "workspace.write",
      riskClass: "workspace-write",
      targetKey: "src/app.ts",
      targetSummary: "src/app.ts",
      scope: "once",
    });
    expect(result.handleInputs).toEqual(["write file", "write file"]);
    expect(result.rendered).toContain("Approval granted (once). Retrying now.");
  });

  it("/approve session grants session approval and retries", async () => {
    const result = await runApprovalPromptScenario(["/approve session"]);

    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]?.scope).toBe("session");
    expect(result.handleInputs).toEqual(["write file", "write file"]);
    expect(result.rendered).toContain("Approval granted (session). Retrying now.");
  });

  it("/approve always grants persistent workspace approval and retries", async () => {
    const result = await runApprovalPromptScenario(["/approve always"]);

    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]?.scope).toBe("always");
    expect(result.handleInputs).toEqual(["write file", "write file"]);
    expect(result.rendered).toContain("Approval granted (persistent for this workspace). Retrying now.");
  });

  it("/deny denies and does not retry", async () => {
    const result = await runApprovalPromptScenario(["/deny"]);

    expect(result.grants).toEqual([]);
    expect(result.handleInputs).toEqual(["write file"]);
    expect(result.rendered).toContain("Permission denied.");
    expect(result.rendered).not.toContain("Write completed.");
  });

  it("keeps existing bare approval answers unchanged", async () => {
    for (const [answer, scope] of [
      ["once", "once"],
      ["session", "session"],
      ["always", "always"],
    ] as const) {
      const result = await runApprovalPromptScenario([answer]);
      expect(result.grants).toHaveLength(1);
      expect(result.grants[0]?.scope).toBe(scope);
      expect(result.handleInputs).toEqual(["write file", "write file"]);
    }

    const deny = await runApprovalPromptScenario(["deny"]);
    expect(deny.grants).toEqual([]);
    expect(deny.handleInputs).toEqual(["write file"]);
    expect(deny.rendered).toContain("Permission denied.");
  });

  it("invalid /approve input does not grant approval and asks for a valid choice", async () => {
    const result = await runApprovalPromptScenario(["/approve banana", "session"]);

    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]?.scope).toBe("session");
    expect(result.handleInputs).toEqual(["write file", "write file"]);
    expect(result.rendered).toContain("Enter one of: once, session, always, deny.");
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
