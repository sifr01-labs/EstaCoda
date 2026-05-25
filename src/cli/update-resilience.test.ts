import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import {
  redactUpdateLogText,
  runManagedSourceUpdateWithResilience,
  updateLogPath
} from "./update-resilience.js";
import type { InstallMethodInfo } from "../lifecycle/install-method.js";

describe("runManagedSourceUpdateWithResilience", () => {
  it("writes successful managed-source updates to update.log", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "estacoda-update-log-"));
    try {
      const result = await runManagedSourceUpdateWithResilience({
        homeDir,
        installMethod: managedSourceInfo(),
        run: async () => ({ kind: "success", message: "Update applied." })
      });

      expect(result.result.kind).toBe("success");
      expect(result.logPath).toBe(updateLogPath(homeDir));
      const log = readFileSync(updateLogPath(homeDir), "utf8");
      expect(log).toContain("=== update start: managed-source ===");
      expect(log).toContain("update result: success");
      expect(log).toContain("Update applied.");
      expect(log).toContain("=== update end: managed-source ===");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("writes failed managed-source updates to update.log", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "estacoda-update-log-"));
    try {
      const result = await runManagedSourceUpdateWithResilience({
        homeDir,
        installMethod: managedSourceInfo(),
        run: async () => ({ kind: "error", message: "Update failed during build." })
      });

      expect(result.result.kind).toBe("error");
      const log = readFileSync(updateLogPath(homeDir), "utf8");
      expect(log).toContain("update result: error");
      expect(log).toContain("Update failed during build.");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("treats logging failure as non-fatal", async () => {
    const result = await runManagedSourceUpdateWithResilience({
      homeDir: "/tmp/estacoda-home",
      installMethod: managedSourceInfo(),
      appendLog: async () => {
        throw new Error("disk full");
      },
      run: async () => ({ kind: "success", message: "Update applied." })
    });

    expect(result.result.kind).toBe("success");
    expect(result.logAvailable).toBe(false);
    expect(result.logFailure).toBe("disk full");
    expect(result.logPath).toBeUndefined();
  });

  it("does not crash on broken or closed stdout and stderr writes and restores handlers", async () => {
    const writes: string[] = [];
    const stdout: { write: (...args: unknown[]) => boolean } = {
      write: (chunk: unknown) => {
        writes.push(String(chunk));
        throw Object.assign(new Error("pipe closed"), { code: "EPIPE" });
      }
    };
    const stderr: { write: (...args: unknown[]) => boolean } = {
      write: () => {
        throw Object.assign(new Error("bad fd"), { code: "EBADF" });
      }
    };
    const originalStdoutWrite = stdout.write;
    const originalStderrWrite = stderr.write;

    const result = await runManagedSourceUpdateWithResilience({
      homeDir: "/tmp/estacoda-home",
      installMethod: managedSourceInfo(),
      stdout,
      stderr,
      appendLog: async () => {},
      run: async () => {
        expect(stdout.write("progress")).toBe(false);
        expect(stderr.write("warning")).toBe(false);
        return { kind: "success", message: "Update applied." };
      }
    });

    expect(result.result.kind).toBe("success");
    expect(writes).toEqual(["progress"]);
    expect(stdout.write).toBe(originalStdoutWrite);
    expect(stderr.write).toBe(originalStderrWrite);
  });

  it("restores stdout and stderr after failed updates", async () => {
    const stdout: { write: (...args: unknown[]) => boolean } = {
      write: () => true
    };
    const stderr: { write: (...args: unknown[]) => boolean } = {
      write: () => true
    };
    const originalStdoutWrite = stdout.write;
    const originalStderrWrite = stderr.write;

    const result = await runManagedSourceUpdateWithResilience({
      homeDir: "/tmp/estacoda-home",
      installMethod: managedSourceInfo(),
      stdout,
      stderr,
      appendLog: async () => {},
      run: async () => ({ kind: "error", message: "Update failed during rollback." })
    });

    expect(result.result.kind).toBe("error");
    expect(stdout.write).toBe(originalStdoutWrite);
    expect(stderr.write).toBe(originalStderrWrite);
  });

  it("does not hide non-terminal write errors and still restores streams", async () => {
    const stdout: { write: (...args: unknown[]) => boolean } = {
      write: () => {
        throw Object.assign(new Error("unexpected stream failure"), { code: "EIO" });
      }
    };
    const originalStdoutWrite = stdout.write;

    const result = await runManagedSourceUpdateWithResilience({
      homeDir: "/tmp/estacoda-home",
      installMethod: managedSourceInfo(),
      stdout,
      appendLog: async () => {},
      run: async () => {
        stdout.write("progress");
        return { kind: "success", message: "should not succeed" };
      }
    });

    expect(result.result.kind).toBe("error");
    expect(result.result.message).toContain("unexpected stream failure");
    expect(stdout.write).toBe(originalStdoutWrite);
  });

  it("installs and restores a SIGHUP handler during the update", async () => {
    const processLike = new EventEmitter() as EventEmitter & {
      on(signal: "SIGHUP", listener: () => void): EventEmitter;
      off(signal: "SIGHUP", listener: () => void): EventEmitter;
    };
    const logLines: string[] = [];

    const result = await runManagedSourceUpdateWithResilience({
      homeDir: "/tmp/estacoda-home",
      installMethod: managedSourceInfo(),
      processLike,
      appendLog: async (_path, text) => {
        logLines.push(text);
      },
      run: async () => {
        expect(processLike.listenerCount("SIGHUP")).toBe(1);
        processLike.emit("SIGHUP");
        return { kind: "success", message: "Update applied." };
      }
    });

    expect(result.sighupReceived).toBe(true);
    expect(processLike.listenerCount("SIGHUP")).toBe(0);
    expect(logLines.join("")).toContain("SIGHUP received during managed-source update");
  });

  it("preserves existing SIGHUP listeners and does not accumulate update handlers", async () => {
    const processLike = new EventEmitter() as EventEmitter & {
      on(signal: "SIGHUP", listener: () => void): EventEmitter;
      off(signal: "SIGHUP", listener: () => void): EventEmitter;
    };
    const existing = () => {};
    processLike.on("SIGHUP", existing);

    for (const _ of [0, 1]) {
      await runManagedSourceUpdateWithResilience({
        homeDir: "/tmp/estacoda-home",
        installMethod: managedSourceInfo(),
        processLike,
        appendLog: async () => {},
        run: async () => {
          expect(processLike.listenerCount("SIGHUP")).toBe(2);
          return { kind: "success", message: "Update applied." };
        }
      });
      expect(processLike.listeners("SIGHUP")).toEqual([existing]);
    }
  });

  it("redacts obvious secret-like output before writing logs", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "estacoda-update-log-"));
    try {
      await runManagedSourceUpdateWithResilience({
        homeDir,
        installMethod: managedSourceInfo(),
        run: async () => ({
          kind: "error",
          message: "OPENAI_API_KEY=sk-test Authorization: Bearer abc123 token=plain api_key=raw apikey=raw2 https://user:pass@example.com"
        })
      });

      const log = readFileSync(updateLogPath(homeDir), "utf8");
      expect(log).not.toContain("sk-test");
      expect(log).not.toContain("Bearer abc123");
      expect(log).not.toContain("token=plain");
      expect(log).not.toContain("api_key=raw");
      expect(log).not.toContain("apikey=raw2");
      expect(log).not.toContain("user:pass");
      expect(log).toContain("OPENAI_API_KEY=[redacted]");
      expect(log).toContain("Authorization: Bearer [redacted]");
      expect(log).toContain("token=[redacted]");
      expect(log).toContain("api_key=[redacted]");
      expect(log).toContain("apikey=[redacted]");
      expect(log).toContain("https://[redacted]@example.com");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("redactUpdateLogText", () => {
  it("redacts secret-like values without removing surrounding context", () => {
    expect(redactUpdateLogText("prefix PASSWORD=hunter2 suffix")).toBe("prefix PASSWORD=[redacted] suffix");
  });

  it("leaves normal command output readable", () => {
    expect(redactUpdateLogText("git pull --ff-only origin main\nFast-forward")).toBe("git pull --ff-only origin main\nFast-forward");
  });
});

function managedSourceInfo(): InstallMethodInfo {
  return {
    method: "managed-source",
    source: "stamp",
    installDir: "/repo",
    sourceUrl: "https://github.com/KemetResearch/EstaCoda.git",
    branch: "main",
    expectedBranch: "main",
    recommendedUpdateCommand: "estacoda update",
    canSelfUpdate: true,
    reason: "Install method stamp declares managed-source."
  };
}
