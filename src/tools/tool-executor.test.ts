import { describe, expect, it } from "vitest";
import type { SecurityPolicy, SecurityRequest } from "../contracts/security.js";
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
