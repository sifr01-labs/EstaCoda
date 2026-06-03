import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SpawnCall = {
  command: string;
  args: string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean };
};

type LockOptions = {
  lockDir: string;
  staleTimeoutMs?: number;
};

type SpawnBehavior = (call: SpawnCall, child: MockChildProcess) => void;

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter & { setEncoding: (encoding: string) => void };
  stderr: EventEmitter & { setEncoding: (encoding: string) => void };
  kill: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => {
  const state = {
    spawnCalls: [] as SpawnCall[],
    lockOptions: [] as LockOptions[],
    acquired: true,
    acquireResults: [] as Array<{ acquired: boolean; stale?: boolean }>,
    spawnBehavior: undefined as SpawnBehavior | undefined
  };

  function createChild(): MockChildProcess {
    const child = new EventEmitter() as MockChildProcess;
    child.stdout = new EventEmitter() as MockChildProcess["stdout"];
    child.stderr = new EventEmitter() as MockChildProcess["stderr"];
    child.stdout.setEncoding = vi.fn();
    child.stderr.setEncoding = vi.fn();
    child.kill = vi.fn();
    return child;
  }

  return {
    state,
    spawn: vi.fn((command: string, args: string[] = [], options: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean } = {}) => {
      const child = createChild();
      const call = { command, args, options };
      state.spawnCalls.push(call);
      state.spawnBehavior?.(call, child);
      return child;
    }),
    createFileCronJobLock: vi.fn((options: LockOptions) => {
      state.lockOptions.push(options);
      return {
        acquire: vi.fn(async () => state.acquireResults.shift() ?? { acquired: state.acquired, stale: false }),
        release: vi.fn(async () => undefined),
        isLocked: vi.fn(async () => false),
        staleSince: vi.fn(async () => undefined)
      };
    })
  };
});

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn
}));

vi.mock("../cron/cron-lock.js", () => ({
  createFileCronJobLock: mocks.createFileCronJobLock
}));

import {
  checkManagedEnvironment,
  createManagedEnvironment,
  findSystemPython,
  resolveManagedVenvPath,
  resolvePythonBinary
} from "./manager.js";

describe("managed Python environment manager", () => {
  let tempDir: string;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "estacoda-python-env-test-"));
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    mocks.state.spawnCalls = [];
    mocks.state.lockOptions = [];
    mocks.state.acquired = true;
    mocks.state.acquireResults = [];
    mocks.state.spawnBehavior = successBehavior();
    mocks.spawn.mockClear();
    mocks.createFileCronJobLock.mockClear();
  });

  afterEach(() => {
    if (originalPlatform !== undefined) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolveManagedVenvPath returns <stateRoot>/python-env", () => {
    expect(resolveManagedVenvPath(tempDir)).toBe(join(tempDir, "python-env"));
  });

  it("resolves the POSIX managed Python path", () => {
    setPlatform("linux");
    expect(resolvePythonBinary({ stateRoot: tempDir })).toBe(join(tempDir, "python-env", "bin", "python"));
  });

  it("resolves the Windows managed Python path", () => {
    setPlatform("win32");
    expect(resolvePythonBinary({ stateRoot: tempDir })).toBe(join(tempDir, "python-env", "Scripts", "python.exe"));
  });

  it("reports missing when the managed Python does not exist", async () => {
    await expect(checkManagedEnvironment({ stateRoot: tempDir })).resolves.toEqual({ kind: "missing" });
    expect(mocks.state.spawnCalls).toHaveLength(0);
  });

  it("reports ready when the managed Python exists and imports faster_whisper", async () => {
    const python = await writeManagedPython(tempDir);
    mocks.state.spawnBehavior = successBehavior();

    await expect(checkManagedEnvironment({ stateRoot: tempDir })).resolves.toEqual({
      kind: "ready",
      pythonBinary: python
    });
    expect(mocks.state.spawnCalls).toEqual([
      expect.objectContaining({ command: python, args: ["-c", "import faster_whisper"] })
    ]);
  });

  it("reports corrupted when the managed Python import check fails", async () => {
    const python = await writeManagedPython(tempDir);
    mocks.state.spawnBehavior = (_call, child) => {
      queueMicrotask(() => {
        child.stderr.emit("data", "ModuleNotFoundError: No module named 'faster_whisper'");
        child.emit("close", 1);
      });
    };

    const status = await checkManagedEnvironment({ stateRoot: tempDir });
    expect(status.kind).toBe("corrupted");
    expect(status).toMatchObject({
      reason: expect.stringContaining("faster-whisper could not be imported")
    });
    expect(mocks.state.spawnCalls[0]).toMatchObject({ command: python, args: ["-c", "import faster_whisper"] });
  });

  it("findSystemPython prefers python3, then python", async () => {
    mocks.state.spawnBehavior = (call, child) => {
      queueMicrotask(() => {
        child.emit("close", call.command === "python3" ? 1 : 0);
      });
    };

    await expect(findSystemPython()).resolves.toBe("python");
    expect(mocks.state.spawnCalls.map((call) => call.command)).toEqual(["python3", "python"]);
  });

  it("creates the venv with python3 -m venv and installs the pinned faster-whisper package", async () => {
    const progress: string[] = [];
    const result = await createManagedEnvironment({ stateRoot: tempDir }, (message) => progress.push(message));
    const venvPath = resolveManagedVenvPath(tempDir);
    const python = join(venvPath, "bin", "python");

    expect(result).toEqual({ ok: true, pythonBinary: python });
    expect(mocks.state.spawnCalls).toEqual([
      expect.objectContaining({ command: "python3", args: ["-c", "import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)"] }),
      expect.objectContaining({ command: "python3", args: ["-m", "venv", venvPath] }),
      expect.objectContaining({ command: python, args: ["-m", "pip", "install", "faster-whisper==1.2.1"] }),
      expect.objectContaining({ command: python, args: ["-c", "import faster_whisper"] })
    ]);
    expect(mocks.state.spawnCalls.every((call) => call.options.shell === false)).toBe(true);
    const installCall = mocks.state.spawnCalls.find((call) => call.args.join(" ") === "-m pip install faster-whisper==1.2.1");
    expect(installCall?.options.env?.PIP_CACHE_DIR).toBe(join(tempDir, "cache", "pip"));
    expect(progress).toEqual([
      "Creating managed Python environment...",
      "Installing faster-whisper==1.2.1...",
      "Verifying faster-whisper import...",
      "Managed Python environment ready."
    ]);
  });

  it("returns actionable capability-scoped diagnostics when Python venv support is missing", async () => {
    mocks.state.spawnBehavior = (call, child) => {
      queueMicrotask(() => {
        if (call.args.join(" ") === "-m venv " + resolveManagedVenvPath(tempDir)) {
          child.stderr.emit("data", [
            "The virtual environment was not created successfully because ensurepip is not available.",
            "On Debian/Ubuntu systems, install the python3.13-venv package using:",
            "apt install python3.13-venv"
          ].join("\n"));
          child.emit("close", 1);
          return;
        }
        child.emit("close", 0);
      });
    };

    const result = await createManagedEnvironment({ stateRoot: tempDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("ensurepip");
      expect(result.reason).toContain("python3.13-venv");
      expect(result.reason).toContain("EstaCoda can still run");
      expect(result.reason).toContain("--python-binary");
      expect(result.reason).toContain("Diagnostic:");
    }
  });

  it("runs import verification after install", async () => {
    await createManagedEnvironment({ stateRoot: tempDir });
    const installIndex = mocks.state.spawnCalls.findIndex((call) => call.args.join(" ") === "-m pip install faster-whisper==1.2.1");
    const verifyIndex = mocks.state.spawnCalls.findIndex((call) => call.args.join(" ") === "-c import faster_whisper");
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(verifyIndex).toBeGreaterThan(installIndex);
  });

  it("uses a single in-process install promise for concurrent creation calls", async () => {
    const first = createManagedEnvironment({ stateRoot: tempDir });
    const second = createManagedEnvironment({ stateRoot: tempDir });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, pythonBinary: join(tempDir, "python-env", "bin", "python") },
      { ok: true, pythonBinary: join(tempDir, "python-env", "bin", "python") }
    ]);
    const venvCalls = mocks.state.spawnCalls.filter((call) => call.args[0] === "-m" && call.args[1] === "venv");
    const installCalls = mocks.state.spawnCalls.filter((call) => call.args.join(" ") === "-m pip install faster-whisper==1.2.1");
    expect(venvCalls).toHaveLength(1);
    expect(installCalls).toHaveLength(1);
  });

  it("uses the existing file lock pattern with the install lock path and 30-minute stale timeout", async () => {
    await createManagedEnvironment({ stateRoot: tempDir });
    expect(mocks.state.lockOptions).toEqual([
      {
        lockDir: join(tempDir, "locks"),
        staleTimeoutMs: 1_800_000
      }
    ]);
  });

  it("does not expose raw pip chatter as progress", async () => {
    mocks.state.spawnBehavior = (call, child) => {
      queueMicrotask(() => {
        if (call.args.join(" ") === "-m pip install faster-whisper==1.2.1") {
          child.stdout.emit("data", "Collecting faster-whisper\nDownloading noisy-progress-bar\n");
        }
        child.emit("close", 0);
      });
    };
    const progress: string[] = [];

    await createManagedEnvironment({ stateRoot: tempDir }, (message) => progress.push(message));

    expect(progress.join("\n")).not.toContain("Downloading noisy-progress-bar");
    expect(progress).toEqual([
      "Creating managed Python environment...",
      "Installing faster-whisper==1.2.1...",
      "Verifying faster-whisper import...",
      "Managed Python environment ready."
    ]);
  });

  it("truncates subprocess output in diagnostics", async () => {
    const longOutput = `PIP_OUTPUT_${"x".repeat(2_000)}`;
    mocks.state.spawnBehavior = (call, child) => {
      queueMicrotask(() => {
        if (call.args.join(" ") === "-m pip install faster-whisper==1.2.1") {
          child.stderr.emit("data", longOutput);
          child.emit("close", 1);
          return;
        }
        child.emit("close", 0);
      });
    };

    const result = await createManagedEnvironment({ stateRoot: tempDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("[truncated]");
      expect(result.reason.length).toBeLessThan(1_400);
    }
  });

  it("redacts non-env-assignment secrets in subprocess diagnostics", async () => {
    const rawSecretOutput = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
      "bearer zyxwvutsrqponmlkjihgfedcba987654",
      "https://alice:secret-password@example.com/simple?token=query-token&access_token=access-secret&api_key=api-secret&key=plain-key&secret=query-secret&password=query-password",
      "OpenAI key sk-abcdefghijklmnopqrstuvwxyz123456",
      "API_KEY=env-secret-value",
      "PASSWORD=env-password-value"
    ].join("\n");
    mocks.state.spawnBehavior = (call, child) => {
      queueMicrotask(() => {
        if (call.args.join(" ") === "-m pip install faster-whisper==1.2.1") {
          child.stderr.emit("data", rawSecretOutput);
          child.emit("close", 1);
          return;
        }
        child.emit("close", 0);
      });
    };

    const result = await createManagedEnvironment({ stateRoot: tempDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Authorization: [REDACTED]");
      expect(result.reason).toContain("Bearer [REDACTED]");
      expect(result.reason).toContain("https://[REDACTED]:[REDACTED]@example.com/simple");
      expect(result.reason).toContain("token=[REDACTED]");
      expect(result.reason).toContain("[REDACTED]");
      expect(result.reason).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
      expect(result.reason).not.toContain("secret-password");
      expect(result.reason).not.toContain("query-token");
      expect(result.reason).not.toContain("access-secret");
      expect(result.reason).not.toContain("api-secret");
      expect(result.reason).not.toContain("plain-key");
      expect(result.reason).not.toContain("query-secret");
      expect(result.reason).not.toContain("query-password");
      expect(result.reason).not.toContain("sk-");
      expect(result.reason).not.toContain("env-secret-value");
      expect(result.reason).not.toContain("env-password-value");
    }
  });

  it("redacts standalone key query parameters in subprocess diagnostics", async () => {
    mocks.state.spawnBehavior = (call, child) => {
      queueMicrotask(() => {
        if (call.args.join(" ") === "-m pip install faster-whisper==1.2.1") {
          child.stderr.emit("data", "https://example.com/simple?key=plain-key");
          child.emit("close", 1);
          return;
        }
        child.emit("close", 0);
      });
    };

    const result = await createManagedEnvironment({ stateRoot: tempDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("key=[REDACTED]");
      expect(result.reason).not.toContain("plain-key");
    }
  });

  it("returns the config override before the managed path", () => {
    expect(resolvePythonBinary({ stateRoot: tempDir, configOverride: "/custom/python3" })).toBe("/custom/python3");
  });

  it("returns an error when no system Python is usable", async () => {
    mocks.state.spawnBehavior = (_call, child) => {
      queueMicrotask(() => child.emit("close", 1));
    };

    await expect(createManagedEnvironment({ stateRoot: tempDir })).resolves.toEqual({
      ok: false,
      reason: "Python 3 is required for local STT but was not found."
    });
  });

  it("retries lock acquisition after another process releases the install lock without a ready env", async () => {
    mocks.state.acquireResults = [
      { acquired: false, stale: false },
      { acquired: true, stale: false }
    ];

    const result = await createManagedEnvironment({ stateRoot: tempDir });

    expect(result).toEqual({ ok: true, pythonBinary: join(tempDir, "python-env", "bin", "python") });
    const venvCalls = mocks.state.spawnCalls.filter((call) => call.args[0] === "-m" && call.args[1] === "venv");
    expect(venvCalls).toHaveLength(1);
    expect(mocks.state.lockOptions).toHaveLength(1);
  });

  it("does not wait for the stale timeout when the install lock can be reacquired", async () => {
    vi.useFakeTimers();
    try {
      mocks.state.acquireResults = [
        { acquired: false, stale: false },
        { acquired: true, stale: false }
      ];

      const result = await createManagedEnvironment({ stateRoot: tempDir });

      expect(result).toEqual({ ok: true, pythonBinary: join(tempDir, "python-env", "bin", "python") });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns ready when another process finishes the install while this process is waiting", async () => {
    mocks.state.acquired = false;
    const python = await writeManagedPython(tempDir);

    const result = await createManagedEnvironment({ stateRoot: tempDir });

    expect(result).toEqual({ ok: true, pythonBinary: python });
    expect(mocks.state.spawnCalls).toEqual([
      expect.objectContaining({ command: python, args: ["-c", "import faster_whisper"] })
    ]);
  });

  it("recovers a stale install lock following the cron-lock file format", async () => {
    const lockDir = join(tempDir, "locks");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "managed-python-env.lock"),
      JSON.stringify({ pid: 999999, startedAt: "2020-01-01T00:00:00.000Z" }),
      "utf8"
    );
    vi.doUnmock("../cron/cron-lock.js");
    const { createFileCronJobLock } = await import("../cron/cron-lock.js");
    const lock = createFileCronJobLock({ lockDir, staleTimeoutMs: 1_800_000 });

    const result = await lock.acquire("managed-python-env");

    expect(result.acquired).toBe(true);
    expect(result.stale).toBe(true);
    expect(existsSync(join(lockDir, "managed-python-env.lock"))).toBe(true);
    vi.doMock("../cron/cron-lock.js", () => ({
      createFileCronJobLock: mocks.createFileCronJobLock
    }));
  });
});

function successBehavior(): SpawnBehavior {
  return (_call, child) => {
    queueMicrotask(() => child.emit("close", 0));
  };
}

async function writeManagedPython(stateRoot: string): Promise<string> {
  const python = join(
    stateRoot,
    "python-env",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python"
  );
  await mkdir(dirname(python), { recursive: true });
  writeFileSync(python, "", "utf8");
  return python;
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform
  });
}
