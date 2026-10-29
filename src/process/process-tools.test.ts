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
    fileObservation: vi.fn(async () => undefined),
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
    expect(processManager.start).toHaveBeenCalledWith("rm -rf ./build", undefined, { purpose: undefined, continuationSignal: undefined, requirements: undefined, visibleTurnId: undefined });
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
  it.each([undefined, null, {}, { ref: "", protectedInput: { kind: "", purpose: "", retention: "" } }])(
    "starts ordinary commands with an absent credential envelope: %j", async (protectedEnvironment) => {
      const processManager = createFakeProcessManager();
      const start = createProcessTools({ processManager }).find(tool => tool.name === "process.start")!;
      const onSecureInputRequest = vi.fn();
      const result = await start.run({ command: "sleep 1", protectedEnvironment }, { onSecureInputRequest });
      expect(result.ok).toBe(true);
      expect(processManager.start).toHaveBeenCalledExactlyOnceWith("sleep 1", undefined, { purpose: undefined, continuationSignal: undefined, requirements: undefined, visibleTurnId: undefined });
      expect(processManager.prepareProtectedEnvironment).not.toHaveBeenCalled();
      expect(onSecureInputRequest).not.toHaveBeenCalled();
    }
  );

  it.each([
    { ref: "SERVICE_TOKEN", protectedInput: { kind: "", purpose: "", retention: "" } },
    { ref: "", protectedInput: { kind: "access-token", purpose: "Authenticate" } },
    { ref: "", protectedInput: { kind: "", purpose: "", value: "must-not-be-ignored" } },
    { protectedInput: null }, { value: "must-not-be-ignored" }, "", []
  ])("rejects partial or malformed credential requests without dispatch: %j", async (protectedEnvironment) => {
    const processManager = createFakeProcessManager();
    const start = createProcessTools({ processManager }).find(tool => tool.name === "process.start")!;
    expect((await start.run({ command: "sleep 1", protectedEnvironment })).ok).toBe(false);
    expect(processManager.start).not.toHaveBeenCalled();
    expect(processManager.prepareProtectedEnvironment).not.toHaveBeenCalled();
  });

  it("does not start a cancelled ordinary command", async () => {
    const processManager = createFakeProcessManager();
    const start = createProcessTools({ processManager }).find(tool => tool.name === "process.start")!;
    expect((await start.run({ command: "sleep 1", protectedEnvironment: null }, { signal: AbortSignal.abort() })).ok).toBe(false);
    expect(processManager.start).not.toHaveBeenCalled();
  });

  it("releases a denied protected request without falling back to ordinary execution", async () => {
    const processManager = createFakeProcessManager();
    const start = createProcessTools({ processManager }).find(tool => tool.name === "process.start")!;
    const result = await start.run({ command: "service start", protectedEnvironment: {
      ref: "SERVICE_TOKEN", protectedInput: { kind: "access-token", purpose: "Authenticate" }
    } }, { onSecureInputRequest: async () => ({ status: "denied", reason: "Denied", persisted: false }) } as never);
    expect(result.ok).toBe(false);
    expect(processManager.releasePrepared).toHaveBeenCalledWith("proc-protected");
    expect(processManager.start).not.toHaveBeenCalled();
  });

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


it("validates service intent without relaxing command safety", async () => {
  const manager = createFakeProcessManager();
  const start = createProcessTools({processManager: manager}).find(t => t.name === "process.start")!;
  expect((await start.run({command: "sleep 30", purpose: "forever"})).ok).toBe(false);
  expect((await start.run({command: "rm -rf /", purpose: "service"})).ok).toBe(false);
  expect(manager.start).not.toHaveBeenCalled();
  expect((await start.run({command: "sleep 30", purpose: "service"})).ok).toBe(true);
  expect(manager.start).toHaveBeenCalledWith("sleep 30", undefined, expect.objectContaining({purpose: "service"}));
});
