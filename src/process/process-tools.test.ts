import { describe, expect, it, vi } from "vitest";
import { createProcessTools } from "./process-tools.js";
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
    stop: vi.fn()
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
