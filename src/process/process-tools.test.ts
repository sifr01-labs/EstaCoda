import { describe, expect, it, vi } from "vitest";
import { createProcessTools } from "../tools/process-tools.js";
import type { ProcessManager } from "./process-manager.js";

function createFakeProcessManager(): ProcessManager {
  return {
    start: vi.fn(async (command: string) => ({
      id: "proc-1",
      command,
      cwd: "/tmp/workspace",
      status: "running" as const,
      startedAt: "2026-05-18T10:00:00.000Z",
      updatedAt: "2026-05-18T10:00:00.000Z"
    })),
    list: vi.fn(() => []),
    logs: vi.fn(() => []),
    stop: vi.fn(),
    prepareProtectedEnvironment: vi.fn(async (command: string, variableName: string) => ({
      id: "proc-protected",
      command,
      cwd: "/tmp/workspace",
      status: "prepared" as const,
      startedAt: "2026-05-18T10:00:00.000Z",
      updatedAt: "2026-05-18T10:00:00.000Z",
      variableName
    })),
    releasePrepared: vi.fn(),
    get: vi.fn((id: string) => ({
      id,
      command: "service start",
      cwd: "/tmp/workspace",
      status: "running" as const,
      startedAt: "2026-05-18T10:00:00.000Z",
      updatedAt: "2026-05-18T10:00:00.000Z"
    }))
  } as unknown as ProcessManager;
}

describe("process.start hardline floor", () => {
  it("allows approved non-hardline destructive-local commands to reach process start", async () => {
    const processManager = createFakeProcessManager();
    const start = createProcessTools({ processManager }).find((tool) => tool.name === "process.start");

    const result = await start?.run({ command: "rm -rf ./build" });

    expect(result?.ok).toBe(true);
    expect(processManager.start).toHaveBeenCalledWith("rm -rf ./build");
  });

  it("rejects hardBlock commands inside the process handler", async () => {
    const processManager = createFakeProcessManager();
    const start = createProcessTools({ processManager }).find((tool) => tool.name === "process.start");

    const result = await start?.run({ command: "rm -rf /" });

    expect(result?.ok).toBe(false);
    expect(result?.content).toContain("filesystem root");
    expect(processManager.start).not.toHaveBeenCalled();
  });

  it("ignores environmentType supplied through tool input", async () => {
    const processManager = createFakeProcessManager();
    const start = createProcessTools({ processManager }).find((tool) => tool.name === "process.start");

    const result = await start?.run({ command: "sudo apt update", environmentType: "docker" } as never);

    expect(result?.ok).toBe(false);
    expect(result?.content).toContain("privilege escalation");
    expect(processManager.start).not.toHaveBeenCalled();
  });
});

describe("protected process tool requests", () => {
  it("reserves a process and requests one-process environment delivery without putting the value in the command", async () => {
    const processManager = createFakeProcessManager();
    const start = createProcessTools({ processManager }).find((tool) => tool.name === "process.start");
    const onSecureInputRequest = vi.fn(async (request) => {
      expect(request.destination).toEqual({
        type: "process-environment",
        processId: "proc-protected",
        variableName: "SERVICE_TOKEN"
      });
      return { status: "delivered" as const, destinationLabel: "Process environment SERVICE_TOKEN", persisted: false };
    });

    const result = await start?.run({
      command: "service start",
      protectedEnvironment: {
        ref: "SERVICE_TOKEN",
        protectedInput: { kind: "access-token", purpose: "Authenticate service" }
      }
    }, { onSecureInputRequest });

    expect(result?.ok).toBe(true);
    expect(processManager.prepareProtectedEnvironment).toHaveBeenCalledWith("service start", "SERVICE_TOKEN");
    expect(processManager.start).not.toHaveBeenCalled();
  });

  it("requests stdin delivery only for an explicit prompt label", async () => {
    const processManager = createFakeProcessManager();
    const inputTool = createProcessTools({ processManager }).find((tool) => tool.name === "process.input");
    const onSecureInputRequest = vi.fn(async (request) => ({
      status: "delivered" as const,
      destinationLabel: request.destination.type,
      persisted: false
    }));
    const result = await inputTool?.run({
      id: "proc-1",
      promptLabel: "Password:",
      protectedInput: { kind: "password", purpose: "Sign in" }
    }, { onSecureInputRequest });
    expect(result?.ok).toBe(true);
    expect(onSecureInputRequest).toHaveBeenCalledWith(expect.objectContaining({
      destination: { type: "process-stdin", processId: "proc-1", promptLabel: "Password:" }
    }), expect.any(Function));
  });
});
