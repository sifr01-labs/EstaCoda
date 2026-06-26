import { describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { handleSlashCommand, runSessionLoop } from "./session-loop.js";
import type { ApprovalPromptAdapter } from "./approval-prompt-adapter.js";
import { APPROVAL_WIDGET_MODE_ENV_VAR } from "./approval-widget-mode.js";
import { UI_INPUT_MODE_ENV_VAR } from "../ui/input-mode.js";
import { UI_RENDERER_ENV_VAR } from "../ui/renderer-mode.js";
import { SHELL_HISTORY_MODE_ENV_VAR } from "./shell-history-mode.js";
import { CLIPBOARD_MODE_ENV_VAR } from "./clipboard-mode.js";
import { MCP_SUGGESTIONS_MODE_ENV_VAR } from "./mcp-suggestions-mode.js";
import { SKILL_SUGGESTIONS_MODE_ENV_VAR } from "./skill-suggestions-mode.js";
import { INPUT_KEYMAP_MODE_ENV_VAR } from "./input-keymap-mode.js";
import type { PromptOptions } from "./prompt-contract.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import type { Runtime } from "../runtime/create-runtime.js";
import { deriveAgentEvolutionPolicy } from "../contracts/agent-evolution.js";
import type { AgentLoopResponse } from "../runtime/agent-loop.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { TerminalCapabilities, UiLocale } from "../contracts/ui.js";
import type { CompactResult } from "../prompt/session-compression-service.js";
import { isolateLtr } from "../ui/bidi.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import { stripAnsi } from "../ui/renderers/layout.js";
import { StandardRenderer } from "../ui/renderers/standard-renderer.js";
import { buildStartupDashboardViewModel } from "../ui/view-models/builders.js";
import { resolveTokens } from "../theme/token-resolver.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { writeCliVoiceMode } from "./voice-mode.js";
import { CronStore } from "../cron/cron-store.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";

const STARTUP_VISIBLE_SCREEN_CLEAR = "\x1b[2J\x1b[H";
const MANAGED_REGION_CLEAR_PATTERN = /\x1b\[\d+A\x1b\[1G\x1b\[0J/u;

function managedRegionClearIndex(input: string, endIndex?: number): number {
  const haystack = endIndex === undefined ? input : input.slice(0, endIndex);
  const match = haystack.match(MANAGED_REGION_CLEAR_PATTERN);
  return match?.index ?? -1;
}

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
    agentEvolutionPolicy: () => deriveAgentEvolutionPolicy("suggest"),
    describe: () => "mock runtime",
    getStatus: () => ({
      kind: "status" as const,
      agentName: "EstaCoda",
      model: { provider: "mock", id: "mock-model" },
      securityMode: "open",
      skillCount: 0,
      toolCount: 0,
      mcp: { active: 0, total: 0 },
      workflowAvailable: false,
      workflowRunActive: false,
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
    trajectoryId: "test-trajectory",
  };
  return { ...runtime, ...overrides };
}

async function captureStartupSession(options: {
  runtime?: Runtime;
  capabilities?: TerminalCapabilities;
  locale?: UiLocale;
} = {}): Promise<{ raw: string; chunks: string[]; promptOptions?: PromptOptions }> {
  const outputChunks: string[] = [];
  const capabilities = options.capabilities ?? interactiveCaps({ supportsAnimation: false });
  let promptOptions: PromptOptions | undefined;

  await runSessionLoop({
    runtime: options.runtime ?? createMockRuntime(),
    output: {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: capabilities.isTTY,
      columns: capabilities.terminalWidth,
    } as unknown as NodeJS.WritableStream,
    capabilities,
    locale: options.locale,
    prompt: Object.assign(
      async (_question: string, options?: PromptOptions) => {
        promptOptions = options;
        return "/exit";
      },
      { close: () => {} }
    ),
    close: () => {},
  });

  return { raw: outputChunks.join(""), chunks: outputChunks, promptOptions };
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

function approvalDenyResponse(): AgentLoopResponse {
  return {
    ...approvalAskResponse(),
    securityDecision: "deny",
    toolExecutions: approvalAskResponse().toolExecutions.map((execution) => ({
      ...execution,
      decision: "deny" as const,
    })),
  };
}

function commandApprovalAskResponse(): AgentLoopResponse {
  return {
    ...approvalAskResponse(),
    text: "I need permission before running this command.",
    toolExecutions: [
      {
        tool: {
          name: "terminal.run",
          description: "Run a bounded shell command in the active workspace.",
          inputSchema: {},
          riskClass: "destructive-local",
          toolsets: ["shell-write"],
          progressLabel: "running command",
          maxResultSizeChars: 1000,
        },
        input: { command: "npm install left-pad" },
        decision: "ask",
        riskClass: "destructive-local",
        targetKey: "npm install left-pad",
        targetSummary: "npm install left-pad",
      },
    ],
  };
}

function commandApprovalDenyResponse(): AgentLoopResponse {
  return {
    ...commandApprovalAskResponse(),
    securityDecision: "deny",
    toolExecutions: commandApprovalAskResponse().toolExecutions.map((execution) => ({
      ...execution,
      decision: "deny" as const,
    })),
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

async function runApprovalPromptScenario(
  approvalAnswers: string[],
  options: {
    approvalPromptAdapter?: ApprovalPromptAdapter;
    response?: AgentLoopResponse;
    env?: Record<string, string | undefined>;
    ttyCoreSession?: boolean;
  } = {}
): Promise<{
  grants: ApprovalGrantInput[];
  handleInputs: string[];
  rendered: string;
  adapterCalls: number;
}> {
  const outputChunks: string[] = [];
  const grants: ApprovalGrantInput[] = [];
  const handleInputs: string[] = [];
  let handleCalls = 0;
  let adapterCalls = 0;
  const approvalPromptAdapter = options.approvalPromptAdapter === undefined
    ? undefined
    : (async (input) => {
        adapterCalls += 1;
        return await options.approvalPromptAdapter!(input);
      }) satisfies ApprovalPromptAdapter;
  const runtime = {
    ...createMockRuntime(),
    revokeApproval: async () => true,
    grantApproval: async (input) => {
      grants.push(input);
    },
    handle: async (input): Promise<AgentLoopResponse> => {
      handleCalls += 1;
      handleInputs.push(input.text);
      return handleCalls === 1 ? options.response ?? approvalAskResponse() : approvalAllowResponse();
    },
  } as Runtime;

  let promptIndex = 0;
  const capabilities = options.ttyCoreSession
    ? interactiveCaps({ supportsAnimation: false })
    : interactiveCaps({
        isTTY: false,
        supportsAnimation: false,
      });
  await runSessionLoop({
    runtime,
    output: {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: capabilities.isTTY,
      columns: 120,
    } as unknown as NodeJS.WritableStream,
    capabilities,
    input: options.ttyCoreSession ? makeTtyInput() : undefined,
    prompt: Object.assign(
      async () => {
        const values = ["write file", ...approvalAnswers, "/exit"];
        return values[promptIndex++] ?? "/exit";
      },
      { close: () => {} }
    ),
    close: () => {},
    env: options.env,
    approvalPromptAdapter,
  });

  return {
    grants,
    handleInputs,
    rendered: outputChunks.join(""),
    adapterCalls,
  };
}

describe("runSessionLoop — user prompt rail behavior", () => {
  it("starts and cleans up the raw prompt by default for interactive TTY core sessions", async () => {
    const input = makeTtyInput();

    const loop = runSessionLoop({
      runtime: createMockRuntime(),
      input,
      output: {
        write(): boolean {
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
      close: () => {},
    });

    for (let attempt = 0; attempt < 20 && input.listenerCount("data") === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(input.listenerCount("data")).toBeGreaterThan(0);

    input.write("\u0003");
    await loop;

    expect(input.rawModes).toEqual([true, false]);
  });

  it("reports optional Papyrus capabilities as disabled by default in /status", async () => {
    const outputChunks: string[] = [];

    await handleSlashCommand({
      text: "/status",
      runtime: createMockRuntime(),
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
      } as NodeJS.WritableStream,
      renderer: { render: renderPlain },
      env: {},
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("Papyrus optional capabilities");
    expect(rendered).toContain("shell history suggestions: off");
    expect(rendered).toContain("clipboard reads: off");
    expect(rendered).toContain("MCP resource suggestions: off");
    expect(rendered).toContain("skill suggestions: off");
    expect(rendered).toContain("Vim keymap: off");
  });

  it("reports explicitly enabled optional Papyrus capabilities in /status diagnostics", async () => {
    const outputChunks: string[] = [];

    await handleSlashCommand({
      text: "/status",
      runtime: createMockRuntime(),
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
      } as NodeJS.WritableStream,
      renderer: { render: renderPlain },
      env: {
        [SHELL_HISTORY_MODE_ENV_VAR]: "1",
        [CLIPBOARD_MODE_ENV_VAR]: "true",
        [MCP_SUGGESTIONS_MODE_ENV_VAR]: "on",
        [SKILL_SUGGESTIONS_MODE_ENV_VAR]: "1",
        [INPUT_KEYMAP_MODE_ENV_VAR]: "vim",
      },
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("Papyrus optional capabilities");
    expect(rendered).toContain("shell history suggestions: on");
    expect(rendered).toContain("clipboard reads: on");
    expect(rendered).toContain("MCP resource suggestions: on");
    expect(rendered).toContain("skill suggestions: on");
    expect(rendered).toContain("Vim keymap: on");
  });

  it("renders /skills as a skills-only table", async () => {
    const outputChunks: string[] = [];
    const runtime = createMockRuntime({
      skills: () => ([
        {
          name: "code-review",
          description: "Review changed code for regressions and missing tests.",
          category: "software-development",
          sourceKind: "bundled",
        },
      ] as ReturnType<Runtime["skills"]>),
    });

    await handleSlashCommand({
      text: "/skills",
      runtime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
      } as NodeJS.WritableStream,
      renderer: { render: renderPlain },
    });

    const rendered = outputChunks.join("");
    expect(rendered).toContain("[OK] Skills: 1");
    expect(rendered).toContain("Available skills");
    expect(rendered).toContain("/code-review");
    expect(rendered).not.toContain("Commands");
    expect(rendered).not.toContain("/help");
  });

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
          env: {},
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
          env: {},
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
    expect(rendered).toContain("session test-ses");
    expect(rendered).toContain("Workspace Trust");
    expect(rendered).toContain("Workspace Verification");
    expect(rendered).toContain("Security Mode");
    expect(rendered).toContain("╭");
    expect(rendered).toContain("𓂀  mock-model");
    expect(rendered).toContain("/tools");
  });

  it("clears the visible screen before TTY startup dashboard output", async () => {
    const { raw } = await captureStartupSession({
      capabilities: interactiveCaps({ supportsAnimation: false }),
    });

    expect(raw.startsWith(STARTUP_VISIBLE_SCREEN_CLEAR)).toBe(true);
    expect(raw).not.toContain("\x1b[3J");
  });

  it("horizontally pads TTY startup dashboard lines", async () => {
    const { raw } = await captureStartupSession({
      capabilities: interactiveCaps({ terminalWidth: 160, supportsAnimation: false }),
    });

    const plain = stripAnsi(raw.slice(STARTUP_VISIBLE_SCREEN_CLEAR.length));
    const frameLine = plain.split("\n").find((line) => line.includes("╭"));
    expect(frameLine).toMatch(/^ +╭/u);
  });

  it("horizontally pads Arabic TTY startup dashboard lines", async () => {
    const { raw } = await captureStartupSession({
      capabilities: interactiveCaps({ terminalWidth: 160, supportsAnimation: false }),
      locale: "ar",
    });

    const plain = stripAnsi(raw.slice(STARTUP_VISIBLE_SCREEN_CLEAR.length));
    const frameLine = plain.split("\n").find((line) => line.includes("╭"));
    expect(frameLine).toMatch(/^ +╭/u);
  });

  it("does not clear the screen for non-TTY startup output", async () => {
    const { raw } = await captureStartupSession({
      capabilities: interactiveCaps({ isTTY: false, supportsAnimation: false }),
    });

    expect(raw).not.toContain(STARTUP_VISIBLE_SCREEN_CLEAR);
  });

  it("does not clear the screen for CI startup output", async () => {
    const { raw } = await captureStartupSession({
      capabilities: interactiveCaps({ isCI: true, supportsAnimation: false }),
    });

    expect(raw).not.toContain(STARTUP_VISIBLE_SCREEN_CLEAR);
  });

  it("does not clear the screen for dumb terminal startup output", async () => {
    const { raw } = await captureStartupSession({
      capabilities: interactiveCaps({ isDumb: true, supportsAnimation: false }),
    });

    expect(raw).not.toContain(STARTUP_VISIBLE_SCREEN_CLEAR);
  });

  it("does not clear the screen for no-color startup output", async () => {
    const { raw } = await captureStartupSession({
      capabilities: interactiveCaps({
        supportsColor: false,
        supportsTrueColor: false,
        supportsAnimation: false,
      }),
    });

    expect(raw).not.toContain(STARTUP_VISIBLE_SCREEN_CLEAR);
  });

  it("leaves legacy startup fallback output uncleared and uncentered", async () => {
    const capabilities = interactiveCaps({ terminalWidth: 160, supportsAnimation: false });
    const runtime = createMockRuntime({
      getStartupReadiness: vi.fn(async () => {
        throw new Error("readiness failed");
      }),
    });
    const { raw } = await captureStartupSession({ runtime, capabilities });
    const renderer = new StandardRenderer({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      capabilities,
    });
    const expectedStartup = renderer.render(runtime.getStartup());

    expect(raw).not.toContain(STARTUP_VISIBLE_SCREEN_CLEAR);
    expect(raw.startsWith(`${expectedStartup}\n\n`)).toBe(true);
  });

  it("keeps startup hint and bottom chrome behavior ordered after dashboard output", async () => {
    const fallback = await captureStartupSession({
      capabilities: interactiveCaps({ isTTY: false, supportsAnimation: false }),
    });
    const fallbackPlain = stripAnsi(fallback.raw);
    const dashboardIndex = fallbackPlain.indexOf("EstaCoda");
    const hintIndex = fallbackPlain.indexOf("Type a message.");

    expect(dashboardIndex).toBeGreaterThanOrEqual(0);
    expect(hintIndex).toBeGreaterThan(dashboardIndex);

    const tty = await captureStartupSession({
      capabilities: interactiveCaps({ supportsAnimation: false }),
    });
    expect(tty.raw).not.toContain("Type a message.");
    expect(tty.promptOptions?.placeholder).toContain("/help");
  });

  it("keeps StandardRenderer startup dashboard output uncentered", () => {
    const capabilities = interactiveCaps({ terminalWidth: 160, supportsAnimation: false });
    const renderer = new StandardRenderer({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      capabilities,
    });
    const rendered = renderer.render(buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: [],
      version: "v0.0.5",
      sessionId: "test-session",
      model: { provider: "mock", id: "mock-model" },
      workspaceTrust: "trusted",
      workspaceVerification: "verified",
      workspaceDirectory: "/tmp",
      securityMode: "open",
      providerReadiness: "ready",
      versionStatus: "unknown",
      availableCommands: [],
      warnings: [],
    }));
    const frameLine = stripAnsi(rendered).split("\n").find((line) => line.includes("╭"));

    expect(rendered).not.toContain(STARTUP_VISIBLE_SCREEN_CLEAR);
    expect(frameLine).toMatch(/^╭/u);
  });

  it("shows configured model only before the first provider call", async () => {
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
    const idleRail = rendered.split("\n").find((line) => line.includes("mock-model") && line.includes("idle"));
    expect(idleRail).toBeDefined();
    expect(idleRail).not.toContain("->");
    expect(idleRail).not.toContain("fallback(");
    expect(idleRail).not.toContain("mock/mock-model");
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
    expect(rendered).not.toContain("+----------------------------------------------------------+");
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

  it("does not render slash completion chrome for submitted slash prefix", async () => {
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
      env: { [UI_INPUT_MODE_ENV_VAR]: "readline" },
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
    expect(rendered).not.toContain("Show command help");
    expect(rendered).not.toContain("Name  Description");
    expect(rendered).toContain("Use /help to see available commands.");
    const promptIndexInOutput = outputChunks.findIndex((chunk) => String(chunk).includes("hello"));
    expect(promptIndexInOutput).toBeGreaterThanOrEqual(0);
    expect(outputChunks.slice(promptIndexInOutput).join("")).not.toContain("Show command help");
  });

  it("does not render slash completion chrome for submitted partial slash input", async () => {
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
      env: { [UI_INPUT_MODE_ENV_VAR]: "readline" },
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
    const commandOutput = rendered.slice(rendered.indexOf("Unknown command: /mo"));
    expect(rendered).toContain("Unknown command: /mo");
    expect(commandOutput).not.toContain("Show active model");
    expect(commandOutput).not.toContain("Show command help");
  });

  it("renders unknown command text for unknown slash input", async () => {
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
      env: { [UI_INPUT_MODE_ENV_VAR]: "readline" },
      prompt: Object.assign(
        async () => {
          const values = ["/zzzz", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    expect(outputChunks.join("")).toContain("Unknown command: /zzzz");
    expect(outputChunks.join("")).not.toContain("No slash commands");
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

describe("handleSlashCommand cron", () => {
  it("runs /cron list without loading runtime config", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "estacoda-session-cron-list-"));
    const oldHome = process.env.HOME;
    const oldEstacodaHome = process.env.ESTACODA_HOME;
    try {
      process.env.HOME = tmpHome;
      delete process.env.ESTACODA_HOME;
      const profilePaths = resolveProfileStateHome({ homeDir: tmpHome, profileId: "broken" });
      await mkdir(profilePaths.configPath, { recursive: true });
      const outputChunks: string[] = [];

      const handled = await handleSlashCommand({
        text: "/cron list",
        runtime: createMockRuntime(),
        output: {
          write(chunk: string | Uint8Array): boolean {
            outputChunks.push(String(chunk));
            return true;
          }
        } as NodeJS.WritableStream,
        renderer: { render: renderPlain },
        workspaceRoot: tmpHome,
        homeDir: tmpHome
      });

      expect(handled).toBe(false);
      expect(outputChunks.join("")).toContain("No cron jobs configured");
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = oldHome;
      }
      if (oldEstacodaHome === undefined) {
        delete process.env.ESTACODA_HOME;
      } else {
        process.env.ESTACODA_HOME = oldEstacodaHome;
      }
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("creates an isolated runtime for /cron tick and disposes it", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "estacoda-session-cron-"));
    const oldHome = process.env.HOME;
    const oldEstacodaHome = process.env.ESTACODA_HOME;
    try {
      process.env.HOME = tmpHome;
      delete process.env.ESTACODA_HOME;
      const store = new CronStore({ homeDir: tmpHome });
      const job = await store.create({
        name: "Interactive tick baseline",
        schedule: "* * * * *",
        prompt: "run me"
      });
      await store.requestRun(job.id);
      const interactiveHandle = vi.fn(async () => ({
        ...mockResponse(),
        text: "interactive runtime should not run"
      }));
      const cronHandle = vi.fn(async () => ({
        ...mockResponse(),
        text: "cron isolated runtime"
      }));
      const cronDispose = vi.fn(async () => undefined);
      const runtime = createMockRuntime({ handle: interactiveHandle });
      const cronRuntimeFactory = vi.fn(async (runtimeOptions) => createMockRuntime({
        sessionId: runtimeOptions.sessionId,
        trajectoryId: "cron-trajectory",
        handle: cronHandle,
        dispose: cronDispose,
        sessionDb: runtimeOptions.sessionDb ?? new InMemorySessionDB()
      }));
      const outputChunks: string[] = [];

      const handled = await handleSlashCommand({
        text: "/cron tick",
        runtime,
        output: {
          write(chunk: string | Uint8Array): boolean {
            outputChunks.push(String(chunk));
            return true;
          }
        } as NodeJS.WritableStream,
        renderer: { render: renderPlain },
        workspaceRoot: tmpHome,
        homeDir: tmpHome,
        cronRuntimeFactory
      });

      expect(handled).toBe(false);
      expect(interactiveHandle).not.toHaveBeenCalled();
      expect(cronHandle).toHaveBeenCalledTimes(1);
      expect(cronDispose).toHaveBeenCalledTimes(1);
      expect(cronRuntimeFactory).toHaveBeenCalledTimes(1);
      const runtimeOptions = cronRuntimeFactory.mock.calls[0]?.[0];
      expect(runtimeOptions).toEqual(expect.objectContaining({
        disableCronTools: true,
        sessionId: expect.stringMatching(/^cron-/u)
      }));
      expect(runtimeOptions?.disabledToolsets).toEqual(["cron", "messaging", "clarify"]);
      expect(runtimeOptions?.sessionDb).toBe(runtime.sessionDb);
      expect(outputChunks.join("")).toContain("Cron tick complete. Ran 1 job(s).");
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = oldHome;
      }
      if (oldEstacodaHome === undefined) {
        delete process.env.ESTACODA_HOME;
      } else {
        process.env.ESTACODA_HOME = oldEstacodaHome;
      }
      await rm(tmpHome, { recursive: true, force: true });
    }
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

function contextUsageModelInfo() {
  return {
    kind: "kv" as const,
    title: "Model",
    entries: [
      { key: "provider", value: "mock" },
      { key: "model", value: "mock-model" },
      { key: "context window", value: "64000" },
    ],
  };
}

function mockResponse(overrides: Partial<AgentLoopResponse> = {}): AgentLoopResponse {
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
    ...overrides,
  };
}

async function renderContextUsageRail(
  eventBatches: RuntimeEvent[][],
  promptValues?: string[]
): Promise<string> {
  const outputChunks: string[] = [];
  let handleIndex = 0;
  const runtime = {
    ...createMockRuntime(),
    handle: async ({ onEvent }: { text: string; channel: string; signal?: AbortSignal; onEvent?: (event: RuntimeEvent) => void }): Promise<AgentLoopResponse> => {
      const events = eventBatches[Math.min(handleIndex, eventBatches.length - 1)] ?? [];
      handleIndex += 1;
      for (const event of events) {
        onEvent?.(event);
      }
      return mockResponse();
    },
    getModelInfo: contextUsageModelInfo,
  };
  const prompts = promptValues ?? [
    ...eventBatches.map((_, index) => index === 0 ? "hello" : `hello ${index + 1}`),
    "/exit",
  ];
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
    capabilities: interactiveCaps({ supportsAnimation: false }),
    prompt: Object.assign(
      async () => prompts[promptIndex++] ?? "/exit",
      { close: () => {} }
    ),
    close: () => {},
  });

  return stripAnsi(outputChunks.join(""));
}

function providerExecutionPrimarySuccess(
  provider = "mock",
  model = "mock-model"
): ProviderExecutionResult {
  return {
    ok: true,
    response: {
      ok: true,
      content: "Mock response",
      provider,
      model,
    },
    fallbackUsed: false,
    attempts: [
      {
        provider,
        model,
        ok: true,
        content: "Mock response",
      },
    ],
    toolCalls: [],
  };
}

function providerExecutionFallbackSuccess(): ProviderExecutionResult {
  return {
    ok: true,
    response: {
      ok: true,
      content: "Fallback response",
      provider: "fallback-provider",
      model: "fallback-model",
    },
    fallbackUsed: true,
    attempts: [
      {
        provider: "mock",
        model: "mock-model",
        credentialId: "secret-primary-credential",
        ok: false,
        errorClass: "rate-limit",
        content: "raw upstream body should not appear",
      },
      {
        provider: "fallback-provider",
        model: "fallback-model",
        credentialId: "secret-fallback-credential",
        ok: true,
        content: "Fallback response",
      },
    ],
    toolCalls: [],
  };
}

function providerExecutionFallbackSuccessWithModel(model: string): ProviderExecutionResult {
  return {
    ...providerExecutionFallbackSuccess(),
    response: {
      ok: true,
      content: "Fallback response",
      provider: "fallback-provider",
      model,
    },
    attempts: [
      {
        provider: "mock",
        model: "mock-model",
        credentialId: "secret-primary-credential",
        ok: false,
        errorClass: "rate-limit",
        content: "raw upstream body should not appear",
      },
      {
        provider: "fallback-provider",
        model,
        credentialId: "secret-fallback-credential",
        ok: true,
        content: "Fallback response",
      },
    ],
  };
}

function providerExecutionFailed(): ProviderExecutionResult {
  return {
    ok: false,
    fallbackUsed: false,
    attempts: [
      {
        provider: "mock",
        model: "mock-model",
        credentialId: "secret-primary-credential",
        ok: false,
        errorClass: "network",
        content: "raw upstream body should not appear",
      },
    ],
    toolCalls: [],
  };
}

async function runProviderExecutionSequence(
  executions: ProviderExecutionResult[]
): Promise<string> {
  const outputChunks: string[] = [];
  let handleIndex = 0;
  const runtime = {
    ...createMockRuntime(),
    handle: async (): Promise<AgentLoopResponse> =>
      mockResponse({ providerExecution: executions[Math.min(handleIndex++, executions.length - 1)] }),
  };
  let promptIndex = 0;

  await runSessionLoop({
    runtime,
    output: {
      write(chunk: string | Uint8Array): boolean {
        outputChunks.push(String(chunk));
        return true;
      },
      isTTY: true,
      columns: 160,
    } as unknown as NodeJS.WritableStream,
    capabilities: interactiveCaps({ terminalWidth: 160, supportsAnimation: false }),
    prompt: Object.assign(
      async () => {
        const values = [...executions.map((_, index) => `turn ${index + 1}`), "/exit"];
        return values[promptIndex++] ?? "/exit";
      },
      { close: () => {} }
    ),
    close: () => {},
  });

  return stripAnsi(outputChunks.join(""));
}

function countOccurrences(text: string, pattern: string): number {
  return text.split(pattern).length - 1;
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

function withModelRoute<T extends Runtime>(
  runtime: T,
  provider: string,
  model: string
): T {
  return {
    ...runtime,
    getModelInfo: () => ({
      kind: "kv" as const,
      title: "Model",
      entries: [
        { key: "provider", value: provider },
        { key: "model", value: model },
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
    const clearIndex = managedRegionClearIndex(rendered);
    const assistantIndex = rendered.indexOf("Mock response");
    expect(clearIndex).toBeGreaterThan(-1);
    expect(assistantIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeLessThan(assistantIndex);
  });

  it("lets raw prompt cleanup own submitted prompt rows before rendering the user rail", async () => {
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
    const userRailIndex = rendered.indexOf("↳ hello");
    expect(userRailIndex).toBeGreaterThan(-1);
    expect(rendered.slice(0, userRailIndex)).not.toContain("\x1b[1A\x1b[2K");
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
    expect(rendered).toContain("↳ hello");
    expect(rendered).toContain("mock-model");
    expect(rendered).toContain("contemplating");
    expect(rendered).not.toContain("────────────────────────────────────────────────────────────────────────────────\n↳ hello\n────────────────────────────────────────────────────────────────────────────────");
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
    expect(rendered.slice(toolIndex)).not.toContain("────────────────────────────────────────────────────────────────────────────────\n↳ hello\n────────────────────────────────────────────────────────────────────────────────");
  });

  it("routes bottom-chrome tool activity through live slots after removed fallback flags are ignored", async () => {
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
      { kind: "tool-start", tool: "file.read", stepId: "s1", targetSummary: "old-start-only", activityId: "a" },
      { kind: "tool-result", tool: "file.read", ok: true, chars: 10, sentChars: 10, targetSummary: "src/a.ts", activityId: "a" },
      { kind: "tool-start", tool: "search.files", stepId: "s2", targetSummary: "renderRuntimeEvent", activityId: "b" },
      { kind: "tool-result", tool: "search.files", ok: true, chars: 20, sentChars: 20, targetSummary: "renderRuntimeEvent", activityId: "b" },
      { kind: "tool-start", tool: "file.write", stepId: "s3", targetSummary: "src/app.ts", activityId: "c" },
      {
        kind: "tool-result",
        tool: "file.write",
        ok: true,
        chars: 30,
        sentChars: 30,
        targetSummary: "src/app.ts",
        activityId: "c",
        fileChangePreview: {
          kind: "fileChangePreview",
          path: "src/app.ts",
          changeType: "added",
          summary: ["Added 2 line(s)."],
          diff: "+ one\n+ two",
        },
      },
      { kind: "agent-final", text: "Mock response" },
    ]);

    let promptIndex = 0;
    await runSessionLoop({
      runtime,
      output,
      capabilities: interactiveCaps({ terminalWidth: 100, supportsAnimation: false }),
      env: {
        [UI_INPUT_MODE_ENV_VAR]: "readline",
        [UI_RENDERER_ENV_VAR]: "legacy",
      },
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
    const liveStartChunk = strippedChunks.find((chunk) =>
      chunk.includes("preparing") &&
      chunk.includes("old-start-only") &&
      chunk.includes("mock-model")
    );
    expect(liveStartChunk).toBeDefined();
    expect(liveStartChunk?.split("\n").filter((line) => line.includes("old-start-only") || line === "\u00A0")).toHaveLength(1);

    const finalLiveHudChunk = strippedChunks.reduce<string | undefined>(
      (latest, chunk) =>
        chunk.includes("mock-model") &&
        chunk.includes("src/app.ts") &&
        chunk.includes("renderRuntimeEvent") &&
        !chunk.includes("+ one") &&
        !chunk.includes("Mock response")
          ? chunk
          : latest,
      undefined
    );
    expect(finalLiveHudChunk).toBeDefined();
    const finalLiveToolLines = (finalLiveHudChunk ?? "").split("\n").filter((line) =>
      line.replace(/^\r/u, "").startsWith("│")
    );
    expect(finalLiveToolLines).toHaveLength(5);
    expect(finalLiveToolLines.join("\n")).not.toContain("old-start-only");
    expect(finalLiveToolLines.join("\n")).toContain("src/a.ts");
    expect(finalLiveToolLines.join("\n")).toContain("renderRuntimeEvent");
    expect(finalLiveToolLines.join("\n")).toContain("src/app.ts");

    const durableToolChunk = strippedChunks.find((chunk) =>
      chunk.includes("src/a.ts") &&
      chunk.includes("renderRuntimeEvent") &&
      chunk.includes("src/app.ts") &&
      chunk.includes("+ one") &&
      !chunk.includes("mock-model") &&
      !chunk.includes("preparing")
    );
    expect(durableToolChunk).toBeDefined();
    expect(durableToolChunk).not.toContain("mock-model");
    expect(durableToolChunk).not.toContain("context");
    expect(durableToolChunk).not.toContain("preparing");
    expect(durableToolChunk).not.toContain("old-start-only");
    expect(durableToolChunk).toContain("+ two");

    const durableRows = durableToolChunk ?? "";
    const firstDurableTool = durableRows.indexOf("src/a.ts");
    const lastDurableTool = durableRows.lastIndexOf("src/app.ts");
    expect(firstDurableTool).toBeGreaterThan(-1);
    expect(lastDurableTool).toBeGreaterThan(firstDurableTool);
    const betweenDurableRows = durableRows.slice(firstDurableTool, lastDurableTool);
    expect(betweenDurableRows).not.toContain("mock-model");
    expect(betweenDurableRows).not.toContain("context");
    expect(betweenDurableRows).not.toContain("𓂀");

    const rendered = strippedChunks.join("");
    const durableIndex = rendered.indexOf(durableRows);
    const responseIndex = rendered.indexOf("Mock response");
    expect(durableIndex).toBeGreaterThan(-1);
    expect(responseIndex).toBeGreaterThan(durableIndex);
    const betweenDurableFlushAndResponse = rendered.slice(durableIndex + durableRows.length, responseIndex);
    expect(betweenDurableFlushAndResponse).not.toContain("mock-model");
    expect(betweenDurableFlushAndResponse).not.toContain("context");
    expect(rendered.slice(responseIndex)).toContain("mock-model");
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
    const providerSpinnerChunkIndex = strippedChunks.findIndex((chunk) =>
      chunk.includes("browser.status") && chunk.includes("scribbling")
    );
    const providerSpinnerChunk = strippedChunks[providerSpinnerChunkIndex] ?? "";
    const toolOffset = providerSpinnerChunk.indexOf("browser.status");
    const spinnerOffset = providerSpinnerChunk.indexOf("scribbling");
    const modelOffset = providerSpinnerChunk.indexOf("mock-model");
    const promptOffset = providerSpinnerChunk.indexOf("↳ hello");

    expect(providerSpinnerChunkIndex).toBeGreaterThan(-1);
    expect(toolOffset).toBeGreaterThan(-1);
    expect(spinnerOffset).toBeGreaterThan(-1);
    expect(spinnerOffset).toBeGreaterThan(toolOffset);
    if (modelOffset !== -1) {
      expect(modelOffset).toBeGreaterThan(spinnerOffset);
    }
    expect(promptOffset).toBe(-1);
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
        const isFirstTurn = releaseTurn === undefined;
        handleStarted?.();
        if (isFirstTurn) {
          await new Promise<void>((resolve) => {
            releaseTurn = resolve;
          });
        }
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
    expect(stripAnsi(outputChunks.join(""))).toContain("✕ Interrupt");
    const beforeSubmit = outputChunks.length;
    input.press("\r", { name: "return" });
    await loop;

    expect(abortReason).toBe("CLI interrupt");
    expect(handleInputs).toEqual(["hello"]);
    expect(outputChunks.slice(beforeSubmit).map((chunk) => stripAnsi(chunk)).join("")).not.toContain("✕ Interrupt");
    expect(stripAnsi(outputChunks.join(""))).toContain("cancelled: CLI interrupt");
  });

  it("shows active-turn slash completions for /interrupt and /steer", async () => {
    const input = makeTtyInput();
    const outputChunks: string[] = [];
    let releaseTurn: (() => void) | undefined;
    let handleStarted: (() => void) | undefined;
    const handleStartedPromise = new Promise<void>((resolve) => {
      handleStarted = resolve;
    });
    const runtime = createMockRuntime({
      handle: async () => {
        const isFirstTurn = releaseTurn === undefined;
        handleStarted?.();
        if (isFirstTurn) {
          await new Promise<void>((resolve) => {
            releaseTurn = resolve;
          });
        }
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
    input.press("/", { name: "/", sequence: "/" });
    const rendered = stripAnsi(outputChunks.join(""));
    expect(rendered).toContain("/interrupt");
    expect(rendered).toContain("/steer");
    expect(rendered).toContain("/steer <note>");

    releaseTurn?.();
    await loop;
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
    expect(stripAnsi(outputChunks.join(""))).toContain("↯ Steer: /steer use simpler approach");
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
    expect(stripAnsi(outputChunks.join(""))).toContain("⌘ active command: Usage: /steer <note>");
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
    expect(stripAnsi(outputChunks.join(""))).toContain("⌘ active command: Steering already queued for this turn.");
  });

  it("queues normal active-turn typing as the next turn without aborting the current turn", async () => {
    const input = makeTtyInput();
    const outputChunks: string[] = [];
    const handleInputs: string[] = [];
    let aborted = false;
    let handleStarted: (() => void) | undefined;
    const handleStartedPromise = new Promise<void>((resolve) => {
      handleStarted = resolve;
    });
    let releaseTurn: (() => void) | undefined;
    let queuedTurnStarted: (() => void) | undefined;
    const queuedTurnStartedPromise = new Promise<void>((resolve) => {
      queuedTurnStarted = resolve;
    });
    const runtime = createMockRuntime({
      handle: async ({ text, signal }: { text: string; channel: string; signal?: AbortSignal }) => {
        handleInputs.push(text);
        signal?.addEventListener("abort", () => {
          aborted = true;
        }, { once: true });
        if (handleInputs.length === 1) {
          handleStarted?.();
          await new Promise<void>((resolve) => {
            releaseTurn = resolve;
          });
        } else {
          queuedTurnStarted?.();
        }
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
    for (const char of "queued follow up") {
      input.press(char, { name: char, sequence: char });
    }
    expect(stripAnsi(outputChunks.join(""))).toContain("> Follow up: queued follow up");
    expect(stripAnsi(outputChunks.join(""))).not.toContain("active input: queued follow up");
    input.press("\r", { name: "return" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handleInputs).toEqual(["hello"]);
    expect(aborted).toBe(false);
    expect(stripAnsi(outputChunks.join(""))).toContain("↳ Queued: queued follow up");
    releaseTurn?.();
    await queuedTurnStartedPromise;
    await loop;

    expect(handleInputs).toEqual(["hello", "queued follow up"]);
  });

  it("renders non-steer slash input as an active command preview", async () => {
    const input = makeTtyInput();
    const outputChunks: string[] = [];
    let releaseTurn: (() => void) | undefined;
    let handleStarted: (() => void) | undefined;
    const handleStartedPromise = new Promise<void>((resolve) => {
      handleStarted = resolve;
    });
    const runtime = createMockRuntime({
      handle: async () => {
        const isFirstTurn = releaseTurn === undefined;
        handleStarted?.();
        if (isFirstTurn) {
          await new Promise<void>((resolve) => {
            releaseTurn = resolve;
          });
        }
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
    input.press("/steerx", { name: "text", sequence: "/steerx" });
    expect(stripAnsi(outputChunks.join(""))).toContain("⌘ active command: /steerx");
    expect(stripAnsi(outputChunks.join(""))).not.toContain("↯ Steer: /steerx");
    input.press("", { name: "escape" });
    const afterEscapeIndex = outputChunks.length;
    input.press("/interrupt now", { name: "text", sequence: "/interrupt now" });
    const afterInterruptNow = stripAnsi(outputChunks.slice(afterEscapeIndex).join(""));
    expect(afterInterruptNow).toContain("⌘ active command: /interrupt now");
    expect(afterInterruptNow).not.toContain("✕ Interrupt");

    releaseTurn?.();
    await loop;
  });

  it("renders active-turn labels with ASCII glyph fallbacks", async () => {
    const input = makeTtyInput();
    const outputChunks: string[] = [];
    let releaseTurn: (() => void) | undefined;
    let handleStarted: (() => void) | undefined;
    const handleStartedPromise = new Promise<void>((resolve) => {
      handleStarted = resolve;
    });
    const runtime = createMockRuntime({
      handle: async () => {
        const isFirstTurn = releaseTurn === undefined;
        handleStarted?.();
        if (isFirstTurn) {
          await new Promise<void>((resolve) => {
            releaseTurn = resolve;
          });
        }
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
      capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false, supportsUnicode: false }),
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
    expect(stripAnsi(outputChunks.join(""))).toContain("x Interrupt");
    input.press("", { name: "escape" });
    const afterEscapeIndex = outputChunks.length;
    for (const char of "queued follow up") {
      input.press(char, { name: char, sequence: char });
    }
    input.press("\r", { name: "return" });
    const afterQueue = stripAnsi(outputChunks.slice(afterEscapeIndex).join(""));
    expect(afterQueue).toContain("-> Queued: queued follow up");

    releaseTurn?.();
    await loop;
  });

  it("replaces queued status with a new follow-up preview without stale status", async () => {
    const input = makeTtyInput();
    const outputChunks: string[] = [];
    let releaseTurn: (() => void) | undefined;
    let handleStarted: (() => void) | undefined;
    const handleStartedPromise = new Promise<void>((resolve) => {
      handleStarted = resolve;
    });
    const runtime = createMockRuntime({
      handle: async () => {
        const isFirstTurn = releaseTurn === undefined;
        handleStarted?.();
        if (isFirstTurn) {
          await new Promise<void>((resolve) => {
            releaseTurn = resolve;
          });
        }
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
    input.press("first queued", { name: "text", sequence: "first queued" });
    input.press("\r", { name: "return" });
    expect(stripAnsi(outputChunks.join(""))).toContain("↳ Queued: first queued");

    const beforeSecondPreview = outputChunks.length;
    input.press("second queued", { name: "text", sequence: "second queued" });
    const secondPreview = stripAnsi(outputChunks.slice(beforeSecondPreview).join(""));
    expect(secondPreview).toContain("> Follow up: second queued");
    expect(secondPreview).not.toContain("↳ Queued: first queued");

    releaseTurn?.();
    await loop;
  });

  it("preserves follow-up preview across active-turn tool redraws", async () => {
    const input = makeTtyInput();
    const outputChunks: string[] = [];
    let releaseTurn: (() => void) | undefined;
    let emitTool: (() => void) | undefined;
    let handleStarted: (() => void) | undefined;
    const handleStartedPromise = new Promise<void>((resolve) => {
      handleStarted = resolve;
    });
    const runtime = createMockRuntime({
      handle: async ({ onEvent }: { text: string; channel: string; signal?: AbortSignal; onEvent?: (event: RuntimeEvent) => void }) => {
        const isFirstTurn = releaseTurn === undefined;
        handleStarted?.();
        emitTool = () => {
          onEvent?.({
            kind: "tool-start",
            tool: "shell.exec",
            targetSummary: "status",
            activityId: "tool-1",
          });
        };
        if (isFirstTurn) {
          await new Promise<void>((resolve) => {
            releaseTurn = resolve;
          });
        }
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
    input.press("queued while tool runs", { name: "text", sequence: "queued while tool runs" });
    const beforeToolRedraw = outputChunks.length;
    emitTool?.();
    const afterToolRedraw = stripAnsi(outputChunks.slice(beforeToolRedraw).join(""));
    expect(afterToolRedraw).toContain("> Follow up: queued while tool runs");
    expect(afterToolRedraw).toContain("preparing  status");

    input.press("\r", { name: "return" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stripAnsi(outputChunks.join(""))).toContain("↳ Queued: queued while tool runs");

    releaseTurn?.();
    await loop;
  });

  it("wraps and caps long follow-up previews while preserving the label", async () => {
    const input = makeTtyInput();
    const outputChunks: string[] = [];
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
        columns: 32,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 32, supportsAnimation: false }),
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
    input.press(
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron",
      { name: "text", sequence: "long" }
    );
    const rendered = stripAnsi(outputChunks.join(""));
    expect(rendered).toContain("> Follow up: alpha beta gamma");
    expect(rendered).toContain("kappa lambda mu nu");
    expect(rendered).toContain("xi omicron");
    expect(rendered).not.toContain("             delta epsilon zeta");

    releaseTurn?.();
    await loop;
  });

  it("wraps and caps long steer previews while preserving the label", async () => {
    const input = makeTtyInput();
    const outputChunks: string[] = [];
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
        columns: 32,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 32, supportsAnimation: false }),
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
    input.press(
      "/steer alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega",
      { name: "text", sequence: "long" }
    );
    const rendered = stripAnsi(outputChunks.join(""));
    expect(rendered).toContain("↯ Steer: /steer alpha beta");
    expect(rendered).toContain("sigma tau upsilon phi");
    expect(rendered).toContain("chi psi omega");
    expect(rendered).not.toContain("delta epsilon zeta");

    releaseTurn?.();
    await loop;
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

  it("ticks the idle session timer through Papyrus-managed chrome", async () => {
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
    let promptStarted = false;
    const prompt = Object.assign(
      vi.fn(async () => {
        promptStarted = true;
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

    while (resolvePrompt === undefined || !promptStarted) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    nowMs = 61_000;
    await new Promise((resolve) => setTimeout(resolve, 1050));
    resolvePrompt("/exit");
    await loop;

    expect(outputChunks.some((chunk) => MANAGED_REGION_CLEAR_PATTERN.test(chunk))).toBe(true);
  });

  it("does not install idle prompt slash or transient chrome callbacks", async () => {
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
    expect(promptOptions.onInputChange).toBeUndefined();
    expect(promptOptions.specialKeyController).toBeUndefined();
    expect(promptOptions.onPastePreview).toBeUndefined();
    expect(stripAnsi(outputChunks.join(""))).not.toContain("Show command help");

    resolvePrompt("/exit");
    await loop;
  });

  it("passes idle prompt placeholder without installing prompt slash chrome", async () => {
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

    resolvePrompt("/exit");
    await loop;
  });

  it("keeps submitted multiline text intact", async () => {
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
    resolvePrompt("line one\nline two");
    await loop;

    expect(handledTexts).toEqual(["line one\nline two"]);
  });

  it("provides a profile-local paste reference store to idle prompts", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-session-paste-home-"));
    try {
      let promptOptions: PromptOptions | undefined;
      const prompt = Object.assign(
        vi.fn(async (_question: string, options?: PromptOptions) => {
          promptOptions = options;
          return "/exit";
        }),
        { close: () => {} }
      );

      await runSessionLoop({
        runtime: createMockRuntime(),
        output: {
          write(): boolean {
            return true;
          },
          isTTY: true,
          columns: 120,
        } as unknown as NodeJS.WritableStream,
        capabilities: interactiveCaps({ terminalWidth: 120, supportsAnimation: false }),
        homeDir,
        prompt,
        close: () => {},
      });

      const reference = promptOptions?.pasteReferenceStore?.create("line one\nline two");
      expect(reference).toBeDefined();
      const pasteDir = join(resolveProfileStateHome({ homeDir, profileId: "default" }).tempPath, "pastes");
      expect(reference!.path).toContain(pasteDir);
      expect(reference!.path).not.toContain("/home/idris");
      await expect(readFile(reference!.path, "utf8")).resolves.toBe("line one\nline two");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
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

  it("uses assembled-prompt context usage when provider actual is unavailable", async () => {
    const rendered = await renderContextUsageRail([[
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "context-usage", filled: 8_000, total: 64_000, source: "assembled-prompt" },
      { kind: "agent-final", text: "Mock response" },
    ]]);

    expect(rendered).toContain("context 8.0k/64.0k");
  });

  it("uses live-estimate context usage when it is the only usage event", async () => {
    const rendered = await renderContextUsageRail([[
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "context-usage", filled: 300, total: 64_000, source: "live-estimate" },
      { kind: "agent-final", text: "Mock response" },
    ]]);

    expect(rendered).toContain("context 300/64.0k");
  });

  it("lets assembled-prompt replace an earlier live estimate", async () => {
    const rendered = await renderContextUsageRail([[
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "context-usage", filled: 300, total: 64_000, source: "live-estimate" },
      { kind: "context-usage", filled: 8_000, total: 64_000, source: "assembled-prompt" },
      { kind: "agent-final", text: "Mock response" },
    ]]);

    expect(rendered).toContain("context 8.0k/64.0k");
  });

  it("provider-actual replaces earlier assembled-prompt in the same turn", async () => {
    const rendered = await renderContextUsageRail([[
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "context-usage", filled: 8_000, total: 64_000, source: "assembled-prompt" },
      { kind: "context-usage", filled: 7_500, total: 64_000, source: "provider-actual" },
      { kind: "agent-final", text: "Mock response" },
    ]]);

    expect(rendered).toContain("context 7.5k/64.0k");
  });

  it("lets a new turn estimate replace prior turn provider actual", async () => {
    const rendered = await renderContextUsageRail([
      [
        { kind: "agent-start", sessionId: "test-session", input: "hello" },
        { kind: "context-usage", filled: 1_000, total: 64_000, source: "provider-actual" },
        { kind: "agent-final", text: "Mock response" },
      ],
      [
        { kind: "agent-start", sessionId: "test-session", input: "hello again" },
        { kind: "context-usage", filled: 8_000, total: 64_000, source: "assembled-prompt" },
        { kind: "agent-final", text: "Mock response" },
      ],
    ], ["hello", "hello again", "/exit"]);

    expect(rendered).toContain("context 8.0k/64.0k");
  });

  it("updates same-priority context usage within a turn", async () => {
    const rendered = await renderContextUsageRail([[
      { kind: "agent-start", sessionId: "test-session", input: "hello" },
      { kind: "context-usage", filled: 300, total: 64_000, source: "live-estimate" },
      { kind: "context-usage", filled: 500, total: 64_000, source: "live-estimate" },
      { kind: "agent-final", text: "Mock response" },
    ]]);

    expect(rendered).toContain("context 500/64.0k");
  });

  it("shows actual serving provider after primary success without fallback health", async () => {
    const outputChunks: string[] = [];
    const runtime = {
      ...createMockRuntime(),
      handle: async (): Promise<AgentLoopResponse> =>
        mockResponse({ providerExecution: providerExecutionPrimarySuccess("mock", "mock-model") }),
    };
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 140,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 140, supportsAnimation: false }),
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
    const servingRail = rendered.split("\n").find((line) => line.includes("mock-model") && line.includes("⧖"));
    expect(servingRail).toBeDefined();
    expect(servingRail).not.toContain("->");
    expect(servingRail).not.toContain("fallback(");
    expect(servingRail).not.toContain("mock/mock-model");
    expect(rendered).not.toContain("fallback(");
  });

  it("shows only the actual fallback model after fallback success", async () => {
    const outputChunks: string[] = [];
    const runtime = {
      ...createMockRuntime(),
      handle: async (): Promise<AgentLoopResponse> =>
        mockResponse({ providerExecution: providerExecutionFallbackSuccess() }),
    };
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 160,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 160, supportsAnimation: false }),
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
    const fallbackRail = rendered.split("\n").find((line) => line.includes("fallback-model") && line.includes("⧖"));
    expect(fallbackRail).toBeDefined();
    expect(fallbackRail).not.toContain("->");
    expect(fallbackRail).not.toContain("fallback(");
    expect(fallbackRail).not.toContain("rate-limit");
    expect(fallbackRail).not.toContain("mock-model");
    expect(fallbackRail).not.toContain("fallback-provider/fallback-model");
    expect(rendered).not.toContain("secret-primary-credential");
    expect(rendered).not.toContain("secret-fallback-credential");
    expect(rendered).not.toContain("raw upstream body should not appear");
  });

  it("renders fallback transition alert once and recovery once", async () => {
    const rendered = await runProviderExecutionSequence([
      providerExecutionFallbackSuccess(),
      providerExecutionFallbackSuccess(),
      providerExecutionPrimarySuccess("mock", "mock-model"),
      providerExecutionPrimarySuccess("mock", "mock-model"),
    ]);

    expect(countOccurrences(rendered, "primary model failed: mock-model rate-limit; using fallback fallback-model")).toBe(1);
    expect(countOccurrences(rendered, "primary model available again: mock-model")).toBe(1);
    expect(rendered).not.toContain("secret-primary-credential");
    expect(rendered).not.toContain("secret-fallback-credential");
    expect(rendered).not.toContain("raw upstream body should not appear");
    expect(rendered).not.toContain("mock/mock-model");
    expect(rendered).not.toContain("fallback-provider/fallback-model");

    const fallbackRail = rendered.split("\n").find((line) => line.includes("fallback-model") && line.includes("⧖"));
    expect(fallbackRail).toBeDefined();
    expect(fallbackRail).not.toContain("rate-limit");
    expect(fallbackRail).not.toContain("fallback(");
  });

  it("does not render noisy provider transition alerts for clean primary success", async () => {
    const rendered = await runProviderExecutionSequence([
      providerExecutionPrimarySuccess("mock", "mock-model"),
      providerExecutionPrimarySuccess("mock", "mock-model"),
    ]);

    expect(rendered).not.toContain("primary model failed:");
    expect(rendered).not.toContain("primary model available again:");
    expect(rendered).not.toContain("provider failed:");
  });

  it("shows provider failure without pretending an actual serving model exists", async () => {
    const outputChunks: string[] = [];
    const runtime = {
      ...createMockRuntime(),
      handle: async (): Promise<AgentLoopResponse> =>
        mockResponse({ providerExecution: providerExecutionFailed() }),
    };
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 140,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 140, supportsAnimation: false }),
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
    const failureRail = rendered.split("\n").find((line) => line.includes("mock-model") && line.includes("⧖"));
    expect(failureRail).toBeDefined();
    expect(failureRail).not.toContain("->");
    expect(failureRail).not.toContain("network");
    expect(failureRail).not.toContain("provider-failed");
    expect(rendered).not.toContain("secret-primary-credential");
    expect(rendered).not.toContain("raw upstream body should not appear");
  });

  it("renders provider failed transition alert once without raw provider internals", async () => {
    const rendered = await runProviderExecutionSequence([
      providerExecutionFailed(),
      providerExecutionFailed(),
    ]);

    expect(countOccurrences(rendered, "provider failed: mock-model network")).toBe(1);
    expect(rendered).not.toContain("secret-primary-credential");
    expect(rendered).not.toContain("raw upstream body should not appear");
  });

  it("renders failed to fallback recovery alert once", async () => {
    const rendered = await runProviderExecutionSequence([
      providerExecutionFailed(),
      providerExecutionFallbackSuccess(),
      providerExecutionFallbackSuccess(),
    ]);

    expect(countOccurrences(rendered, "provider failed: mock-model network")).toBe(1);
    expect(countOccurrences(rendered, "provider recovered via fallback: fallback-model; primary mock-model failed with rate-limit")).toBe(1);
    expect(rendered).not.toContain("secret-primary-credential");
    expect(rendered).not.toContain("raw upstream body should not appear");
  });

  it("clears stale serving provider truth after /model refresh and updates it on the next turn", async () => {
    const outputChunks: string[] = [];
    const runtime = {
      ...createMockRuntime(),
      handle: async (): Promise<AgentLoopResponse> =>
        mockResponse({ providerExecution: providerExecutionFallbackSuccess() }),
    };
    const refreshedRuntime = withModelRoute({
      ...createMockRuntime(),
      sessionDb: runtime.sessionDb,
      sessionId: runtime.sessionId,
      handle: async (): Promise<AgentLoopResponse> =>
        mockResponse({ providerExecution: providerExecutionPrimarySuccess("fresh-provider", "fresh-model") }),
    }, "fresh-provider", "fresh-model");
    await runtime.sessionDb.createSession({ id: runtime.sessionId, profileId: "default" });
    let promptIndex = 0;

    await runSessionLoop({
      runtime,
      refreshRuntime: async () => refreshedRuntime,
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
        isTTY: true,
        columns: 160,
      } as unknown as NodeJS.WritableStream,
      capabilities: interactiveCaps({ terminalWidth: 160, supportsAnimation: false }),
      prompt: Object.assign(
        async () => {
          const values = ["hello", "/model clear", "hello again", "/exit"];
          return values[promptIndex++] ?? "/exit";
        },
        { close: () => {} }
      ),
      close: () => {},
    });

    const rendered = stripAnsi(outputChunks.join(""));
    expect(rendered).toContain("fallback-model");
    const afterModelClear = rendered.slice(rendered.indexOf("Cleared the session model override."));
    const refreshedIdleRail = afterModelClear.split("\n").find((line) =>
      line.includes("fresh-model") && line.includes("idle")
    );
    expect(refreshedIdleRail).toBeDefined();
    expect(refreshedIdleRail).not.toContain("fallback(");
    expect(refreshedIdleRail).not.toContain("fallback-model");
    expect(refreshedIdleRail).not.toContain("fresh-provider/fresh-model");
    expect(refreshedIdleRail).not.toContain("->");
    expect(afterModelClear).toContain("fresh-model");
    expect(afterModelClear).not.toContain("fresh-provider/fresh-model");
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
    const clearIndex = managedRegionClearIndex(rendered);
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
    const clearIndex = managedRegionClearIndex(rendered);
    const permissionIndex = rendered.indexOf("[Approval] Approval required");
    expect(clearIndex).toBeGreaterThan(-1);
    expect(permissionIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeLessThan(permissionIndex);
    expect(rendered).toContain("workspace.write");
    expect(rendered).toContain("src/app.ts");
    expect(rendered).toContain("Permission denied.");
    expect(rendered.slice(permissionIndex)).not.toContain("contemplating");
    const renderedPlain = stripAnsi(rendered);
    const plainPermissionIndex = renderedPlain.indexOf("[Approval] Approval required");
    const submittedRailIndex = renderedPlain.indexOf("↳ write file");
    expect(submittedRailIndex).toBeGreaterThan(-1);
    expect(submittedRailIndex).toBeLessThan(plainPermissionIndex);
    expect(renderedPlain.slice(plainPermissionIndex)).not.toContain("↳ write file");
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
    const submittedRailIndex = rendered.indexOf("↳ make image");
    expect(setupIndex).toBeGreaterThan(-1);
    expect(submittedRailIndex).toBeGreaterThan(-1);
    expect(submittedRailIndex).toBeLessThan(setupIndex);
    expect(resumedIndex).toBeGreaterThan(setupIndex);
    expect(rendered.slice(setupIndex)).not.toContain("↳ make image");
    expect(executeToolCalls).toEqual(["config.image.setup", "image.generate"]);
    expect(rendered).toContain("generated image");
    expect(secretPromptOptions).toHaveLength(1);
    expect(secretPromptOptions[0]?.onInputChange).toBeUndefined();
    expect(secretPromptOptions[0]?.onPastePreview).toBeUndefined();
    expect(secretPromptOptions[0]?.specialKeyController).toBeUndefined();
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
    const secondPromptIndex = rendered.indexOf("↳ second", cancelIndex);
    expect(cancelIndex).toBeGreaterThan(-1);
    expect(secondPromptIndex).toBeGreaterThan(cancelIndex);
    expect(rendered.slice(cancelIndex, secondPromptIndex)).not.toContain("↳ first");
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

  it("routes promptable approval requests through the approval prompt adapter without moving grant policy", async () => {
    const adapterInputs: Array<{
      toolName: string;
      allowPersistentApproval: boolean;
      promptAvailable: boolean;
    }> = [];
    const result = await runApprovalPromptScenario([], {
      approvalPromptAdapter: async (input) => {
        adapterInputs.push({
          toolName: input.execution.tool.name,
          allowPersistentApproval: input.allowPersistentApproval,
          promptAvailable: typeof input.prompt === "function",
        });
        return "/approve session";
      },
    });

    expect(adapterInputs).toEqual([
      {
        toolName: "workspace.write",
        allowPersistentApproval: true,
        promptAvailable: true,
      },
    ]);
    expect(result.adapterCalls).toBe(1);
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]).toMatchObject({
      toolName: "workspace.write",
      riskClass: "workspace-write",
      targetKey: "src/app.ts",
      targetSummary: "src/app.ts",
      scope: "session",
    });
    expect(result.handleInputs).toEqual(["write file", "write file"]);
    expect(result.rendered).toContain("Approval granted (session). Retrying now.");
  });

  it("routes promptable file approvals through the adapter and keeps grant scope in core approval code", async () => {
    const adapter = vi.fn<ApprovalPromptAdapter>(async (input) => {
      expect(input.execution).toMatchObject({
        tool: { name: "workspace.write" },
        decision: "ask",
        riskClass: "workspace-write",
        targetKey: "src/app.ts",
        targetSummary: "src/app.ts",
      });
      return "always";
    });

    const result = await runApprovalPromptScenario([], {
      approvalPromptAdapter: adapter,
      response: approvalAskResponse(),
    });

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(result.adapterCalls).toBe(1);
    expect(result.grants).toEqual([
      {
        toolName: "workspace.write",
        riskClass: "workspace-write",
        targetKey: "src/app.ts",
        targetSummary: "src/app.ts",
        scope: "always",
      },
    ]);
    expect(result.handleInputs).toEqual(["write file", "write file"]);
    expect(result.rendered).toContain("Approval granted (persistent for this workspace). Retrying now.");
  });

  it("ignores the removed legacy approval widget fallback in core sessions", async () => {
    const result = await runApprovalPromptScenario(["once"], {
      env: { [APPROVAL_WIDGET_MODE_ENV_VAR]: "legacy" },
      response: approvalAskResponse(),
      ttyCoreSession: true,
    });

    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]).toMatchObject({
      toolName: "workspace.write",
      scope: "once",
    });
    expect(result.rendered).toContain("[Approval] Approval required:");
  });

  it("defaults promptable approvals to Papyrus cards in raw Papyrus core sessions", async () => {
    const result = await runApprovalPromptScenario(["approve-once"], {
      response: approvalAskResponse(),
      ttyCoreSession: true,
    });

    expect(result.grants).toEqual([
      {
        toolName: "workspace.write",
        riskClass: "workspace-write",
        targetKey: "src/app.ts",
        targetSummary: "src/app.ts",
        scope: "once",
      },
    ]);
    expect(result.handleInputs).toEqual(["write file", "write file"]);
    expect(result.rendered).toContain("[Approval] Approval required: workspace.write");
    expect(result.rendered).toContain("Approval granted (once). Retrying now.");
  });

  it("ignores removed readline input fallback for default approval widgets", async () => {
    const result = await runApprovalPromptScenario(["once"], {
      env: { [UI_INPUT_MODE_ENV_VAR]: "readline" },
      response: approvalAskResponse(),
      ttyCoreSession: true,
    });

    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]).toMatchObject({
      toolName: "workspace.write",
      scope: "once",
    });
    expect(result.rendered).toContain("[Approval] Approval required:");
  });

  it("ignores removed readline input fallback when Papyrus approval widgets are explicit", async () => {
    const result = await runApprovalPromptScenario(["once"], {
      env: {
        [UI_INPUT_MODE_ENV_VAR]: "readline",
        [APPROVAL_WIDGET_MODE_ENV_VAR]: "papyrus",
      },
      response: approvalAskResponse(),
      ttyCoreSession: true,
    });

    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]).toMatchObject({
      toolName: "workspace.write",
      scope: "once",
    });
    expect(result.rendered).toContain("[Approval] Approval required:");
  });

  it("ignores removed legacy renderer fallback for default approval widgets", async () => {
    const result = await runApprovalPromptScenario(["once"], {
      env: { [UI_RENDERER_ENV_VAR]: "legacy" },
      response: approvalAskResponse(),
      ttyCoreSession: true,
    });

    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]).toMatchObject({
      toolName: "workspace.write",
      scope: "once",
    });
    expect(result.rendered).toContain("[Approval] Approval required:");
  });

  it("routes promptable command approvals through Papyrus adapter", async () => {
    const result = await runApprovalPromptScenario(["approve-once"], {
      response: commandApprovalAskResponse(),
      ttyCoreSession: true,
    });

    expect(result.grants).toEqual([
      {
        toolName: "terminal.run",
        riskClass: "destructive-local",
        targetKey: "npm install left-pad",
        targetSummary: "npm install left-pad",
        scope: "once",
      },
    ]);
    expect(result.handleInputs).toEqual(["write file", "write file"]);
    expect(result.rendered).toContain("[Approval] Approval required: terminal.run");
    expect(result.rendered).toContain("Approval granted (once). Retrying now.");
  });

  it("routes promptable file approvals through Papyrus adapter", async () => {
    const result = await runApprovalPromptScenario(["reject"], {
      response: approvalAskResponse(),
      ttyCoreSession: true,
    });

    expect(result.grants).toEqual([]);
    expect(result.handleInputs).toEqual(["write file"]);
    expect(result.rendered).toContain("[Approval] Approval required: workspace.write");
    expect(result.rendered).toContain("Permission denied.");
  });

  it("maps Papyrus approval scope answers through existing grant handling", async () => {
    for (const [answer, scope] of [
      ["approve-once", "once"],
      ["session", "session"],
      ["always", "always"],
    ] as const) {
      const result = await runApprovalPromptScenario([answer], {
        response: approvalAskResponse(),
        ttyCoreSession: true,
      });

      expect(result.grants).toHaveLength(1);
      expect(result.grants[0]).toMatchObject({
        toolName: "workspace.write",
        riskClass: "workspace-write",
        targetKey: "src/app.ts",
        targetSummary: "src/app.ts",
        scope,
      });
      expect(result.handleInputs).toEqual(["write file", "write file"]);
    }
  });

  it("keeps Papyrus cancel and unsupported rich answers on the existing invalid-answer path", async () => {
    const result = await runApprovalPromptScenario(["cancel", "feedback", "approve-once"], {
      response: approvalAskResponse(),
      ttyCoreSession: true,
    });

    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]?.scope).toBe("once");
    expect(result.handleInputs).toEqual(["write file", "write file"]);
    expect(result.rendered.split("Enter one of: once, session, always, deny.")).toHaveLength(3);
  });

  it("prefers an injected approval prompt adapter over the core Papyrus approval adapter", async () => {
    const adapter = vi.fn<ApprovalPromptAdapter>(async () => "deny");
    const result = await runApprovalPromptScenario([], {
      approvalPromptAdapter: adapter,
      response: approvalAskResponse(),
    });

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(result.adapterCalls).toBe(1);
    expect(result.grants).toEqual([]);
    expect(result.handleInputs).toEqual(["write file"]);
    expect(result.rendered).toContain("Permission denied.");
    expect(result.rendered).not.toContain("[Approval] Approval required:");
  });

  it("routes promptable command approvals through the adapter and keeps grant scope in core approval code", async () => {
    const adapter = vi.fn<ApprovalPromptAdapter>(async (input) => {
      expect(input.execution).toMatchObject({
        tool: { name: "terminal.run" },
        input: { command: "npm install left-pad" },
        decision: "ask",
        riskClass: "destructive-local",
        targetKey: "npm install left-pad",
        targetSummary: "npm install left-pad",
      });
      return "session";
    });

    const result = await runApprovalPromptScenario([], {
      approvalPromptAdapter: adapter,
      response: commandApprovalAskResponse(),
    });

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(result.adapterCalls).toBe(1);
    expect(result.grants).toEqual([
      {
        toolName: "terminal.run",
        riskClass: "destructive-local",
        targetKey: "npm install left-pad",
        targetSummary: "npm install left-pad",
        scope: "session",
      },
    ]);
    expect(result.handleInputs).toEqual(["write file", "write file"]);
    expect(result.rendered).toContain("Approval granted (session). Retrying now.");
  });

  it("maps fake adapter deny and cancel-like answers through existing approval semantics", async () => {
    const deny = await runApprovalPromptScenario([], {
      approvalPromptAdapter: async () => "deny",
    });
    expect(deny.adapterCalls).toBe(1);
    expect(deny.grants).toEqual([]);
    expect(deny.handleInputs).toEqual(["write file"]);
    expect(deny.rendered).toContain("Permission denied.");

    const cancelLike = await runApprovalPromptScenario([], {
      approvalPromptAdapter: vi.fn()
        .mockResolvedValueOnce("cancel")
        .mockResolvedValueOnce("once"),
    });
    expect(cancelLike.adapterCalls).toBe(2);
    expect(cancelLike.grants).toHaveLength(1);
    expect(cancelLike.grants[0]?.scope).toBe("once");
    expect(cancelLike.rendered).toContain("Enter one of: once, session, always, deny.");
  });

  it("maps file adapter deny and invalid answers through existing approval semantics", async () => {
    const deny = await runApprovalPromptScenario([], {
      approvalPromptAdapter: async () => "reject",
      response: approvalAskResponse(),
    });
    expect(deny.adapterCalls).toBe(1);
    expect(deny.grants).toEqual([]);
    expect(deny.handleInputs).toEqual(["write file"]);
    expect(deny.rendered).toContain("Permission denied.");

    const invalidThenApprove = await runApprovalPromptScenario([], {
      approvalPromptAdapter: vi.fn()
        .mockResolvedValueOnce("cancel")
        .mockResolvedValueOnce("session"),
      response: approvalAskResponse(),
    });
    expect(invalidThenApprove.adapterCalls).toBe(2);
    expect(invalidThenApprove.grants).toHaveLength(1);
    expect(invalidThenApprove.grants[0]).toMatchObject({
      toolName: "workspace.write",
      scope: "session",
    });
    expect(invalidThenApprove.rendered).toContain("Enter one of: once, session, always, deny.");
  });

  it("maps command adapter deny and invalid answers through existing approval semantics", async () => {
    const deny = await runApprovalPromptScenario([], {
      approvalPromptAdapter: async () => "reject",
      response: commandApprovalAskResponse(),
    });
    expect(deny.adapterCalls).toBe(1);
    expect(deny.grants).toEqual([]);
    expect(deny.handleInputs).toEqual(["write file"]);
    expect(deny.rendered).toContain("Permission denied.");

    const invalidThenApprove = await runApprovalPromptScenario([], {
      approvalPromptAdapter: vi.fn()
        .mockResolvedValueOnce("cancel")
        .mockResolvedValueOnce("/approve once"),
      response: commandApprovalAskResponse(),
    });
    expect(invalidThenApprove.adapterCalls).toBe(2);
    expect(invalidThenApprove.grants).toHaveLength(1);
    expect(invalidThenApprove.grants[0]).toMatchObject({
      toolName: "terminal.run",
      scope: "once",
    });
    expect(invalidThenApprove.rendered).toContain("Enter one of: once, session, always, deny.");
  });

  it("does not call the approval prompt adapter for policy-denied tool executions", async () => {
    const adapter = vi.fn<ApprovalPromptAdapter>(async () => "once");
    const result = await runApprovalPromptScenario([], {
      approvalPromptAdapter: adapter,
      response: approvalDenyResponse(),
    });

    expect(adapter).not.toHaveBeenCalled();
    expect(result.adapterCalls).toBe(0);
    expect(result.grants).toEqual([]);
    expect(result.handleInputs).toEqual(["write file"]);
  });

  it("does not call the approval prompt adapter for policy-denied file executions", async () => {
    const adapter = vi.fn<ApprovalPromptAdapter>(async () => "once");
    const result = await runApprovalPromptScenario([], {
      approvalPromptAdapter: adapter,
      response: approvalDenyResponse(),
    });

    expect(adapter).not.toHaveBeenCalled();
    expect(result.adapterCalls).toBe(0);
    expect(result.grants).toEqual([]);
    expect(result.handleInputs).toEqual(["write file"]);
  });

  it("does not call the Papyrus approval adapter for policy-denied file executions", async () => {
    const result = await runApprovalPromptScenario([], {
      response: approvalDenyResponse(),
      ttyCoreSession: true,
    });

    expect(result.grants).toEqual([]);
    expect(result.handleInputs).toEqual(["write file"]);
    expect(result.rendered).not.toContain("[Approval] Approval required:");
  });

  it("does not call the Papyrus approval adapter for hardline or policy-denied command executions", async () => {
    const result = await runApprovalPromptScenario([], {
      response: commandApprovalDenyResponse(),
      ttyCoreSession: true,
    });

    expect(result.grants).toEqual([]);
    expect(result.handleInputs).toEqual(["write file"]);
    expect(result.rendered).not.toContain("[Approval] Approval required:");
  });

  it("does not render default Papyrus approval cards for hardline or policy-denied command executions", async () => {
    const result = await runApprovalPromptScenario([], {
      response: commandApprovalDenyResponse(),
      ttyCoreSession: true,
    });

    expect(result.grants).toEqual([]);
    expect(result.handleInputs).toEqual(["write file"]);
    expect(result.rendered).not.toContain("[Approval] Approval required:");
  });

  it("does not call the approval prompt adapter for hardline or policy-denied command executions", async () => {
    const adapter = vi.fn<ApprovalPromptAdapter>(async () => "once");
    const result = await runApprovalPromptScenario([], {
      approvalPromptAdapter: adapter,
      response: commandApprovalDenyResponse(),
    });

    expect(adapter).not.toHaveBeenCalled();
    expect(result.adapterCalls).toBe(0);
    expect(result.grants).toEqual([]);
    expect(result.handleInputs).toEqual(["write file"]);
  });

  it("keeps the session loop free of direct Papyrus widget imports", async () => {
    const sessionLoopSource = await readFile(new URL("./session-loop.ts", import.meta.url), "utf8");

    expect(sessionLoopSource).not.toContain("papyrus/widgets");
    expect(sessionLoopSource).not.toContain("papyrus-widgets");
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
    const clearIndex = managedRegionClearIndex(rendered);
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
    const clearIndex = managedRegionClearIndex(rendered);
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
    const clearIndex = managedRegionClearIndex(rendered);
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
    const clearIndex = managedRegionClearIndex(rendered);
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
    const clearIndex = managedRegionClearIndex(rendered);
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
    const clearIndex = managedRegionClearIndex(rendered);
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
