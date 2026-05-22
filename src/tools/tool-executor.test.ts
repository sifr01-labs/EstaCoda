import { describe, expect, it, vi } from "vitest";
import { capabilityFirstDefaults, type SecurityPolicy, type SecurityRequest } from "../contracts/security.js";
import type { SessionDB } from "../contracts/session.js";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { ToolRegistry } from "./tool-registry.js";
import { ToolExecutor } from "./tool-executor.js";

function createMockPolicy(decision: "allow" | "deny" = "allow"): SecurityPolicy {
  return {
    decide() {
      return decision;
    }
  };
}

function createThrowingTool(name: string, message: string): RegisteredTool {
  return {
    name,
    description: "throws",
    inputSchema: { type: "object", properties: {} },
    riskClass: "read-only-local",
    toolsets: ["core"],
    progressLabel: "throwing",
    maxResultSizeChars: 1000,
    isAvailable: () => true,
    run: async (): Promise<ToolResult> => {
      throw new Error(message);
    }
  };
}

function createEchoTool(name: string): RegisteredTool {
  return {
    name,
    description: "echoes",
    inputSchema: { type: "object", properties: {} },
    riskClass: "read-only-local",
    toolsets: ["core"],
    progressLabel: "echoing",
    maxResultSizeChars: 1000,
    isAvailable: () => true,
    run: async (_input, context): Promise<ToolResult> => {
      if (context?.signal?.aborted === true) {
        throw new Error("Should not reach here when pre-cancelled");
      }
      return { ok: true, content: "echo" };
    }
  };
}

function createSensitiveEchoTool(name: string): RegisteredTool {
  return {
    name,
    description: "echoes input back for redaction testing",
    inputSchema: { type: "object", properties: {} },
    riskClass: "read-only-local",
    toolsets: ["core"],
    progressLabel: "echoing",
    maxResultSizeChars: 1000,
    isAvailable: () => true,
    run: async (input): Promise<ToolResult> => {
      return { ok: true, content: JSON.stringify(input) };
    }
  };
}

function createRequiredUrlTool(name: string): RegisteredTool {
  return {
    name,
    description: "requires url",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" }
      },
      required: ["url"]
    },
    riskClass: "read-only-network",
    toolsets: ["web"],
    progressLabel: "validating",
    maxResultSizeChars: 1000,
    isAvailable: () => true,
    run: async (): Promise<ToolResult> => {
      return { ok: true, content: "validated" };
    }
  };
}

function createTerminalEchoTool(): RegisteredTool {
  return {
    name: "terminal.run",
    description: "runs command",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" }
      },
      required: ["command"]
    },
    riskClass: "workspace-write",
    toolsets: ["shell-write"],
    progressLabel: "running",
    maxResultSizeChars: 1000,
    isAvailable: () => true,
    run: async (_input, context): Promise<ToolResult> => {
      return {
        ok: true,
        content: `environment=${context?.environmentType ?? "missing"}`
      };
    }
  };
}

async function setupExecutor(options: {
  policy?: SecurityPolicy;
  tools?: RegisteredTool[];
}) {
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? []) {
    registry.register(tool);
  }
  const sessionDb: SessionDB = new InMemorySessionDB();
  const trajectoryRecorder = new TrajectoryRecorder({
    profileId: "test",
    sessionId: "test-session",
    modelId: "test-model"
  });
  const executor = new ToolExecutor({
    registry,
    securityPolicy: options.policy ?? createMockPolicy("allow"),
    sessionDb,
    trajectoryRecorder,
    workspaceRoot: process.cwd()
  });
  await sessionDb.createSession({ profileId: "test", id: "test-session" });
  return { executor, sessionDb, trajectoryRecorder };
}

async function persistedExecutionState(
  sessionDb: SessionDB,
  trajectoryRecorder: TrajectoryRecorder
): Promise<string> {
  return JSON.stringify({
    events: await sessionDb.listEvents("test-session"),
    messages: await sessionDb.listMessages("test-session"),
    trajectory: trajectoryRecorder.snapshot().events
  });
}

function expectNoRawSecrets(serialized: string, secrets: string[]): void {
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
  }
}

describe("ToolExecutor exception containment", () => {
  it("returns structured error when tool throws an uncaught exception", async () => {
    const { executor } = await setupExecutor({
      tools: [createThrowingTool("thrower", "boom")]
    });

    const record = await executor.executeTool({
      tool: "thrower",
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    expect(record).toBeDefined();
    expect(record?.result?.ok).toBe(false);
    expect(record?.result?.content).toBe("Tool execution failed: boom");
    expect(record?.result?.metadata).toMatchObject({ reason: "error" });
  });

  it("returns structured cancellation result when signal is pre-aborted", async () => {
    const { executor } = await setupExecutor({
      tools: [createEchoTool("echo")]
    });

    const controller = new AbortController();
    controller.abort();

    const record = await executor.executeTool({
      tool: "echo",
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session",
      signal: controller.signal
    });

    expect(record).toBeDefined();
    expect(record?.result?.ok).toBe(false);
    expect(record?.result?.content).toBe("Tool execution cancelled.");
    expect(record?.result?.metadata).toMatchObject({ reason: "cancelled" });
  });

  it("returns structured cancellation result when signal aborts during execution", async () => {
    const { executor } = await setupExecutor({
      tools: [
        {
          name: "sleeper",
          description: "sleeps",
          inputSchema: { type: "object", properties: {} },
          riskClass: "read-only-local",
          toolsets: ["core"],
          progressLabel: "sleeping",
          maxResultSizeChars: 1000,
          isAvailable: () => true,
          run: async (_input, context): Promise<ToolResult> => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (context?.signal?.aborted === true) {
              throw new Error("AbortError");
            }
            return { ok: true, content: "done" };
          }
        }
      ]
    });

    const controller = new AbortController();
    const promise = executor.executeTool({
      tool: "sleeper",
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session",
      signal: controller.signal
    });

    controller.abort();
    const record = await promise;

    expect(record).toBeDefined();
    expect(record?.result?.ok).toBe(false);
    expect(record?.result?.content).toBe("Tool execution cancelled.");
    expect(record?.result?.metadata).toMatchObject({ reason: "cancelled" });
  });
});

describe("ToolExecutor input redaction", () => {
  it("redacts sensitive keys in session events", async () => {
    const { executor, sessionDb } = await setupExecutor({
      tools: [createSensitiveEchoTool("setup")]
    });

    const input = {
      provider: "openai",
      apiKey: "sk-secret123",
      api_key: "sk-secret456",
      password: "hunter2",
      token: "tok-abc",
      secret: "shh",
      credential: "creds",
      nested: {
        apiKey: "nested-secret"
      }
    };

    await executor.executeTool({
      tool: "setup",
      input,
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const events = await sessionDb.listEvents("test-session");
    const toolCalled = events.find((e) => e.kind === "tool-called");
    expect(toolCalled).toBeDefined();
    expect(toolCalled?.kind === "tool-called" ? toolCalled.input : undefined).toMatchObject({
      provider: "openai",
      apiKey: "[REDACTED]",
      api_key: "[REDACTED]",
      password: "[REDACTED]",
      token: "[REDACTED]",
      secret: "[REDACTED]",
      credential: "[REDACTED]",
      nested: {
        apiKey: "[REDACTED]"
      }
    });
    expectNoRawSecrets(JSON.stringify(events), [
      "sk-secret123",
      "sk-secret456",
      "hunter2",
      "tok-abc",
      "nested-secret"
    ]);
  });

  it("does not mutate the original input passed to tool.run", async () => {
    const { executor } = await setupExecutor({
      tools: [createSensitiveEchoTool("setup")]
    });

    const input = {
      provider: "openai",
      apiKey: "sk-secret123"
    };

    const record = await executor.executeTool({
      tool: "setup",
      input,
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    expect(record?.result?.ok).toBe(true);
    expect(record?.result?.content).toContain("sk-secret123");
    expect(input.apiKey).toBe("sk-secret123");
  });

  it("redacts sensitive keys in trajectory records", async () => {
    const { executor, trajectoryRecorder } = await setupExecutor({
      tools: [createSensitiveEchoTool("setup")]
    });

    const input = {
      apiKey: "sk-secret123"
    };

    await executor.executeTool({
      tool: "setup",
      input,
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const trajectory = trajectoryRecorder.snapshot();
    const toolCallEvent = trajectory.events.find((e) => e.kind === "tool-call");
    expect(toolCallEvent).toBeDefined();
    expect(toolCallEvent?.data).toMatchObject({
      tool: "setup",
      input: {
        apiKey: "[REDACTED]"
      }
    });
  });

  it("redacts secret-bearing web.extract URLs before persistence", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("web.extract")]
    });

    await executor.executeTool({
      tool: "web.extract",
      input: { url: "https://x.test/?token=secret" },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = JSON.stringify(await sessionDb.listEvents("test-session"));
    const trajectory = JSON.stringify(trajectoryRecorder.snapshot().events);
    expect(persisted).not.toContain("token=secret");
    expect(trajectory).not.toContain("token=secret");
    expect(persisted).toContain("[REDACTED_URL_WITH_SECRET]");
    expect(trajectory).toContain("[REDACTED_URL_WITH_SECRET]");
  });

  it("redacts secret-bearing browser.navigate URLs before persistence", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("browser.navigate")]
    });

    await executor.executeTool({
      tool: "browser.navigate",
      input: { url: "https://x.test/?api_key=secret" },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = JSON.stringify(await sessionDb.listEvents("test-session"));
    const trajectory = JSON.stringify(trajectoryRecorder.snapshot().events);
    expect(persisted).not.toContain("api_key=secret");
    expect(trajectory).not.toContain("api_key=secret");
    expect(persisted).toContain("[REDACTED_URL_WITH_SECRET]");
    expect(trajectory).toContain("[REDACTED_URL_WITH_SECRET]");
  });

  it("redacts secret-bearing web.crawl URLs before persistence", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("web.crawl")]
    });

    await executor.executeTool({
      tool: "web.crawl",
      input: { url: "https://x.test/?key=secret" },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = JSON.stringify(await sessionDb.listEvents("test-session"));
    const trajectory = JSON.stringify(trajectoryRecorder.snapshot().events);
    expect(persisted).not.toContain("key=secret");
    expect(trajectory).not.toContain("key=secret");
    expect(persisted).toContain("[REDACTED_URL_WITH_SECRET]");
    expect(trajectory).toContain("[REDACTED_URL_WITH_SECRET]");
  });

  it.each([
    ["token URL", { url: "https://x.test/?token=secret" }, ["token=secret"]],
    ["password URL", { url: "https://x.test/?password=secret" }, ["password=secret"]],
    ["client secret URL", { url: "https://x.test/?client_secret=secret" }, ["client_secret=secret"]],
    ["access token URL", { url: "https://x.test/?access_token=secret" }, ["access_token=secret"]],
    ["userinfo URL", { url: "https://user:pass@x.test/path" }, ["user:pass"]],
    ["authorization bearer text", { note: "Authorization: Bearer secret" }, ["Bearer secret"]],
    ["nested params URL", { params: { url: "https://x.test/?password=secret" } }, ["password=secret"]]
  ])("redacts %s before any execution persistence", async (_label, input, secrets) => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("web.extract")]
    });

    await executor.executeTool({
      tool: "web.extract",
      input,
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = await persistedExecutionState(sessionDb, trajectoryRecorder);
    expectNoRawSecrets(persisted, secrets);
    expect(persisted).toMatch(/\[REDACTED(?:_URL_WITH_SECRET)?\]/u);
  });

  it("redacts provider-native JSON argument strings across persisted events and messages", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("web.extract")]
    });
    const providerNativeToolCall = {
      id: "call-provider-secret",
      type: "function",
      function: {
        name: "web.extract",
        arguments: JSON.stringify({
          url: "https://x.test/?token=secret",
          params: {
            url: "https://x.test/?password=secret"
          },
          note: "Authorization: Bearer secret"
        })
      }
    };

    await executor.executeTool({
      tool: "web.extract",
      input: { url: "https://example.test/page" },
      trustedWorkspace: true,
      sessionId: "test-session",
      toolCallId: "call-stable-secret",
      toolCallName: "web.extract",
      providerNativeToolCall
    });

    const persisted = await persistedExecutionState(sessionDb, trajectoryRecorder);
    expectNoRawSecrets(persisted, ["token=secret", "password=secret", "Bearer secret"]);
    expect(persisted).toContain("call-provider-secret");
    expect(persisted).toContain("web.extract");
    expect(persisted).toContain("[REDACTED_URL_WITH_SECRET]");
  });

  it("strips ambiguous provider-native argument strings before persistence", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("web.extract")]
    });

    await executor.executeTool({
      tool: "web.extract",
      input: { url: "https://example.test/page" },
      trustedWorkspace: true,
      sessionId: "test-session",
      providerNativeToolCall: {
        id: "call-provider-ambiguous",
        type: "function",
        function: {
          name: "web.extract",
          arguments: "url=https://x.test/?token=secret"
        }
      }
    });

    const persisted = await persistedExecutionState(sessionDb, trajectoryRecorder);
    expectNoRawSecrets(persisted, ["token=secret", "url=https://x.test"]);
    expect(persisted).toContain("[REDACTED_PROVIDER_ARGUMENTS]");
  });

  it("redacts provider-native payloads on validation-error persistence", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createRequiredUrlTool("web.extract")]
    });

    await executor.executeTool({
      tool: "web.extract",
      input: { url: 42 },
      trustedWorkspace: true,
      sessionId: "test-session",
      providerNativeToolCall: {
        id: "call-provider-validation",
        type: "function",
        function: {
          name: "web.extract",
          arguments: JSON.stringify({
            url: "https://x.test/?access_token=secret"
          })
        }
      }
    });

    const persisted = await persistedExecutionState(sessionDb, trajectoryRecorder);
    expectNoRawSecrets(persisted, ["access_token=secret"]);
    expect(persisted).toContain("call-provider-validation");
    expect(persisted).toContain("[REDACTED_URL_WITH_SECRET]");
  });

  it("redacts Runtime.evaluate expressions before persistence", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("browser.cdp")]
    });

    await executor.executeTool({
      tool: "browser.cdp",
      input: {
        method: "Runtime.evaluate",
        params: {
          expression: "fetch('https://x.test/?token=secret')"
        }
      },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = JSON.stringify(await sessionDb.listEvents("test-session"));
    const trajectory = JSON.stringify(trajectoryRecorder.snapshot().events);
    expect(persisted).not.toContain("fetch");
    expect(trajectory).not.toContain("fetch");
    expect(persisted).toContain("[REDACTED_CDP_EXPRESSION]");
    expect(trajectory).toContain("[REDACTED_CDP_EXPRESSION]");
  });

  it("redacts Runtime.callFunctionOn function declarations before persistence", async () => {
    const { executor, sessionDb } = await setupExecutor({
      tools: [createEchoTool("browser.cdp")]
    });

    await executor.executeTool({
      tool: "browser.cdp",
      input: {
        method: "Runtime.callFunctionOn",
        params: {
          functionDeclaration: "function () { return 'https://x.test/?token=secret'; }"
        }
      },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = JSON.stringify(await sessionDb.listEvents("test-session"));
    expect(persisted).not.toContain("function ()");
    expect(persisted).not.toContain("token=secret");
    expect(persisted).toContain("[REDACTED_CDP_EXPRESSION]");
  });

  it("keeps safe inputs readable in persisted records", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("web.extract")]
    });

    await executor.executeTool({
      tool: "web.extract",
      input: { url: "https://example.test/page", maxContentChars: 1000 },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = JSON.stringify(await sessionDb.listEvents("test-session"));
    const trajectory = JSON.stringify(trajectoryRecorder.snapshot().events);
    expect(persisted).toContain("https://example.test/page");
    expect(trajectory).toContain("https://example.test/page");
  });
});

describe("ToolExecutor tool-call metadata persistence", () => {
  it("persists stable tool-call metadata on tool events and tool result messages", async () => {
    const { executor, sessionDb } = await setupExecutor({
      tools: [createEchoTool("echo")]
    });
    const providerNativeToolCall = {
      id: "call-provider-1",
      type: "function",
      function: {
        name: "echo"
      }
    };

    await executor.executeTool({
      tool: "echo",
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session",
      toolCallId: "call-stable-1",
      toolCallName: "echo",
      providerNativeToolCall
    });

    const events = await sessionDb.listEvents("test-session");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "tool-called",
      tool: "echo",
      toolCallId: "call-stable-1",
      toolCallName: "echo",
      providerNativeToolCall
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "tool-result",
      tool: "echo",
      toolCallId: "call-stable-1",
      toolCallName: "echo",
      providerNativeToolCall
    }));

    const messages = await sessionDb.listMessages("test-session");
    const toolMessage = messages.find((message) => message.role === "tool");
    expect(toolMessage?.metadata).toMatchObject({
      tool: "echo",
      tool_call_id: "call-stable-1",
      tool_call_name: "echo",
      provider_native_tool_call: providerNativeToolCall
    });
  });
});

describe("ToolExecutor command environment", () => {
  it("passes explicit backend environmentType into command safety and tool context", async () => {
    let observedRequest: SecurityRequest | undefined;
    const policy: SecurityPolicy = {
      decide() {
        return "allow";
      },
      assess(request) {
        observedRequest = request;
        return {
          decision: "allow",
          mode: "adaptive",
          reason: "test",
          risk: "medium"
        };
      }
    };
    const { executor } = await setupExecutor({
      policy,
      tools: [createTerminalEchoTool()]
    });

    const record = await executor.executeTool({
      tool: "terminal.run",
      input: { command: "sudo apt update" },
      trustedWorkspace: true,
      sessionId: "test-session",
      environmentType: "docker"
    });

    expect(record?.decision).toBe("allow");
    expect(record?.riskClass).toBe("workspace-write");
    expect(record?.result?.content).toBe("environment=docker");
    expect(observedRequest?.environmentType).toBe("docker");
  });

  it("ignores environmentType supplied inside tool input", async () => {
    let observedRequest: SecurityRequest | undefined;
    const policy: SecurityPolicy = {
      decide() {
        return "allow";
      },
      assess(request) {
        observedRequest = request;
        return {
          decision: "deny",
          mode: "adaptive",
          reason: "test",
          risk: "high"
        };
      }
    };
    const { executor } = await setupExecutor({
      policy,
      tools: [createTerminalEchoTool()]
    });

    const record = await executor.executeTool({
      tool: "terminal.run",
      input: { command: "sudo apt update", environmentType: "docker" },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    expect(record?.decision).toBe("deny");
    expect(record?.result).toBeUndefined();
    expect(observedRequest?.environmentType).toBe("host");
    expect(observedRequest?.riskClass).toBe("destructive-local");
  });
});

describe("ToolExecutor browser CDP gating", () => {
  it("requires approval for raw browser.cdp even when the default policy allows other active external side effects", async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "ran" }));
    const cdpTool: RegisteredTool = {
      name: "browser.cdp",
      description: "raw cdp",
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string" },
          params: { type: "object" }
        },
        required: ["method"]
      },
      riskClass: "external-side-effect",
      toolsets: ["dangerous"],
      progressLabel: "running cdp",
      maxResultSizeChars: 1000,
      isAvailable: () => true,
      run
    };
    const { executor } = await setupExecutor({
      policy: capabilityFirstDefaults,
      tools: [cdpTool]
    });

    const record = await executor.executeTool({
      tool: "browser.cdp",
      input: {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", key: "Enter" }
      },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    expect(record?.decision).toBe("ask");
    expect(run).not.toHaveBeenCalled();
  });
});
