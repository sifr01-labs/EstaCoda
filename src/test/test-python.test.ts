import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  spawn: vi.fn(),
  userInfo: vi.fn()
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: mocks.existsSync
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: mocks.spawn
  };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    userInfo: mocks.userInfo
  };
});

const PROBE_MARKER = "ESTACODA_TEST_PYTHON_OK";

type CandidateBehavior = "usable" | "hang" | "fail" | "bad-marker" | "spawn-error";

const candidateBehaviors = new Map<string, CandidateBehavior>();
const missingCandidates = new Set<string>();

class FakeChildProcess extends EventEmitter {
  readonly stdout = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn()
  });

  readonly stderr = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn()
  });

  readonly kill = vi.fn();
}

beforeEach(() => {
  candidateBehaviors.clear();
  missingCandidates.clear();
  delete process.env.ESTACODA_TEST_PYTHON_BINARY;
  delete process.env.ESTACODA_TEST_ORIGINAL_HOME;
  delete process.env.CODEX_SQLITE_HOME;
  process.env.HOME = "/isolated-home";
  mocks.existsSync.mockReset();
  mocks.existsSync.mockImplementation((candidate: string) => !missingCandidates.has(candidate));
  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation((candidate: string) => createFakeChildProcess(candidate));
  mocks.userInfo.mockReset();
  mocks.userInfo.mockReturnValue({ homedir: "/user-info-home" });
  resetTestPythonBinaryCache();
});

describe("resolveUsableTestPythonBinary", () => {
  it("returns a usable candidate", async () => {
    setCandidateBehavior("usable-python", "usable");

    await expect(resolveUsableTestPythonBinary(["usable-python"], 1_000)).resolves.toBe("usable-python");
  });

  it("rejects hanging and failing candidates before returning a later usable candidate", async () => {
    setCandidateBehavior("hanging-python", "hang");
    setCandidateBehavior("failing-python", "fail");
    setCandidateBehavior("usable-python", "usable");

    await expect(
      resolveUsableTestPythonBinary(["hanging-python", "failing-python", "usable-python"], 500)
    ).resolves.toBe("usable-python");
  });

  it("rejects exit-zero candidates that do not print the Python probe marker", async () => {
    setCandidateBehavior("not-python", "bad-marker");
    setCandidateBehavior("usable-python", "usable");

    await expect(resolveUsableTestPythonBinary(["not-python", "usable-python"], 1_000)).resolves.toBe(
      "usable-python"
    );
  });

  it("rejects spawn error candidates before returning a later usable candidate", async () => {
    setCandidateBehavior("blocked-python", "spawn-error");
    setCandidateBehavior("usable-python", "usable");

    await expect(resolveUsableTestPythonBinary(["blocked-python", "usable-python"], 1_000)).resolves.toBe(
      "usable-python"
    );
  });

  it("throws a clear error when no candidate passes the probe", async () => {
    setCandidateBehavior("failing-python", "fail");

    await expect(resolveUsableTestPythonBinary(["failing-python"], 1_000)).rejects.toThrow(
      /No usable Python interpreter found for tests/
    );
  });

  it("includes candidate failure reasons in diagnostics", async () => {
    missingCandidates.add("missing-python");
    setCandidateBehavior("hanging-python", "hang");
    setCandidateBehavior("failing-python", "fail");
    setCandidateBehavior("not-python", "bad-marker");
    setCandidateBehavior("blocked-python", "spawn-error");

    await expect(
      resolveUsableTestPythonBinary([
        "missing-python",
        "hanging-python",
        "failing-python",
        "not-python",
        "blocked-python",
      ], 10)
    ).rejects.toThrow(
      /missing-python: missing path[\s\S]*hanging-python: timeout[\s\S]*failing-python: non-zero exit; exit=2[\s\S]*not-python: probe output invalid[\s\S]*blocked-python: spawn error; error=spawn failed/u
    );
  });
});

describe("resolveTestPythonBinary", () => {
  it("uses ESTACODA_TEST_PYTHON_BINARY as the highest-priority override", async () => {
    process.env.ESTACODA_TEST_PYTHON_BINARY = "/explicit/python";
    setCandidateBehavior("/explicit/python", "usable");

    await expect(resolveTestPythonBinary()).resolves.toBe("/explicit/python");
    expect(mocks.spawn.mock.calls[0]?.[0]).toBe("/explicit/python");
  });

  it("uses ESTACODA_TEST_ORIGINAL_HOME even when HOME is isolated", async () => {
    process.env.ESTACODA_TEST_ORIGINAL_HOME = "/original-home";
    process.env.HOME = "/isolated-home";
    const originalHomePython = codexRuntimePython("/original-home");
    setCandidateBehavior(originalHomePython, "usable");

    await expect(resolveTestPythonBinary()).resolves.toBe(originalHomePython);
  });

  it("uses userInfo().homedir when original HOME is absent", async () => {
    delete process.env.ESTACODA_TEST_ORIGINAL_HOME;
    process.env.HOME = "/isolated-home";
    mocks.userInfo.mockReturnValue({ homedir: "/real-user-home" });
    const realUserPython = codexRuntimePython("/real-user-home");
    setCandidateBehavior(realUserPython, "usable");

    await expect(resolveTestPythonBinary()).resolves.toBe(realUserPython);
  });

  it("keeps python3 as the final fallback after bundled runtime candidates", async () => {
    process.env.ESTACODA_TEST_ORIGINAL_HOME = "/original-home";
    process.env.CODEX_SQLITE_HOME = "/codex-runtime/sqlite/state.sqlite";
    process.env.HOME = "/isolated-home";
    mocks.userInfo.mockReturnValue({ homedir: "/real-user-home" });
    for (const candidate of [
      codexRuntimePython("/original-home"),
      codexRuntimePython("/real-user-home"),
      codexRuntimePython("/codex-runtime"),
      codexRuntimePython("/isolated-home"),
    ]) {
      setCandidateBehavior(candidate, "fail");
    }
    setCandidateBehavior("python3", "usable");

    await expect(resolveTestPythonBinary()).resolves.toBe("python3");
    expect(mocks.spawn.mock.calls.map((call) => call[0])).toEqual([
      codexRuntimePython("/original-home"),
      codexRuntimePython("/real-user-home"),
      codexRuntimePython("/codex-runtime"),
      codexRuntimePython("/isolated-home"),
      "python3",
    ]);
  });
});

function setCandidateBehavior(candidate: string, behavior: CandidateBehavior): void {
  candidateBehaviors.set(candidate, behavior);
}

function codexRuntimePython(home: string): string {
  return `${home}/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3`;
}

function createFakeChildProcess(candidate: string): FakeChildProcess {
  const child = new FakeChildProcess();
  const behavior = candidateBehaviors.get(candidate) ?? "spawn-error";

  queueMicrotask(() => {
    if (behavior === "usable") {
      child.stdout.emit("data", `${PROBE_MARKER}\n${candidate}\n`);
      child.emit("close", 0);
      return;
    }
    if (behavior === "fail") {
      child.stderr.emit("data", "candidate failed\n");
      child.emit("close", 2);
      return;
    }
    if (behavior === "bad-marker") {
      child.stdout.emit("data", `NOT_${PROBE_MARKER}\n${candidate}\n`);
      child.emit("close", 0);
      return;
    }
    if (behavior === "spawn-error") {
      child.emit("error", new Error("spawn failed"));
    }
  });

  return child;
}

const { resolveUsableTestPythonBinary } = await import("./test-python.js");
const { resolveTestPythonBinary, resetTestPythonBinaryCache } = await import("./test-python.js");
