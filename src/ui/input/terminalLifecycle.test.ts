import { describe, expect, it, vi } from "vitest";
import {
  DBP,
  DISABLE_MOUSE_TRACKING,
  EBP,
  ENABLE_MOUSE_TRACKING,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from "../papyrus/termio/dec.js";
import { createTerminalLifecycle, TerminalLifecycleError, type TerminalLifecycleStdin, type TerminalLifecycleStdout } from "./terminalLifecycle.js";

function fakeStdin(overrides: Partial<TerminalLifecycleStdin> = {}) {
  const calls: boolean[] = [];
  const stream: TerminalLifecycleStdin = {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn((mode: boolean) => {
      calls.push(mode);
      stream.isRaw = mode;
    }),
    ...overrides,
  };
  return { stream, calls };
}

function fakeStdout(overrides: Partial<TerminalLifecycleStdout> = {}) {
  const writes: string[] = [];
  const stream: TerminalLifecycleStdout = {
    isTTY: true,
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
    }),
    ...overrides,
  };
  return { stream, writes };
}

describe("terminal lifecycle", () => {
  it("start enables raw mode and writes cursor/bracketed-paste setup", () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const lifecycle = createTerminalLifecycle({ stdin: stdin.stream, stdout: stdout.stream });

    lifecycle.start();

    expect(stdin.calls).toEqual([true]);
    expect(stdout.writes).toEqual([HIDE_CURSOR, EBP]);
    expect(lifecycle.isStarted()).toBe(true);
  });

  it("stop restores raw mode and writes bracketed-paste/cursor cleanup in reverse order", () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const lifecycle = createTerminalLifecycle({ stdin: stdin.stream, stdout: stdout.stream });

    lifecycle.start();
    const result = lifecycle.stop();

    expect(result.errors).toEqual([]);
    expect(stdin.calls).toEqual([true, false]);
    expect(stdout.writes).toEqual([HIDE_CURSOR, EBP, DBP, SHOW_CURSOR]);
    expect(lifecycle.isStarted()).toBe(false);
  });

  it("start and stop are idempotent", () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const lifecycle = createTerminalLifecycle({ stdin: stdin.stream, stdout: stdout.stream });

    lifecycle.start();
    lifecycle.start();
    lifecycle.stop();
    lifecycle.stop();

    expect(stdin.calls).toEqual([true, false]);
    expect(stdout.writes).toEqual([HIDE_CURSOR, EBP, DBP, SHOW_CURSOR]);
  });

  it("respects disabled cursor and bracketed-paste options", () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const lifecycle = createTerminalLifecycle({
      stdin: stdin.stream,
      stdout: stdout.stream,
      hideCursor: false,
      enableBracketedPaste: false,
    });

    lifecycle.start();
    lifecycle.stop();

    expect(stdin.calls).toEqual([true, false]);
    expect(stdout.writes).toEqual([]);
  });

  it("enables click/wheel SGR tracking and always disables every mouse mode on cleanup", () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const lifecycle = createTerminalLifecycle({
      stdin: stdin.stream,
      stdout: stdout.stream,
      hideCursor: false,
      enableBracketedPaste: false,
      enableMouseTracking: true,
    });

    lifecycle.start();
    lifecycle.stop();

    expect(ENABLE_MOUSE_TRACKING).toBe("\x1b[?1000h\x1b[?1006h");
    expect(ENABLE_MOUSE_TRACKING).not.toContain("?1002h");
    expect(ENABLE_MOUSE_TRACKING).not.toContain("?1003h");
    expect(stdout.writes).toEqual([ENABLE_MOUSE_TRACKING, DISABLE_MOUSE_TRACKING]);
  });

  it("disables mouse tracking when a later lifecycle setup step fails", () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout({
      write: vi.fn((chunk: string) => {
        stdout.writes.push(chunk);
        if (chunk === ENABLE_MOUSE_TRACKING) throw new Error("mouse enable failed");
      }),
    });
    const lifecycle = createTerminalLifecycle({
      stdin: stdin.stream,
      stdout: stdout.stream,
      enableMouseTracking: true,
    });

    expect(() => lifecycle.start()).toThrow(TerminalLifecycleError);
    expect(stdout.writes).toEqual([
      HIDE_CURSOR,
      EBP,
      ENABLE_MOUSE_TRACKING,
      DISABLE_MOUSE_TRACKING,
      DBP,
      SHOW_CURSOR,
    ]);
    expect(lifecycle.isStarted()).toBe(false);
  });

  it("failed start cleans up partially applied terminal state", () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout({
      write: vi.fn((chunk: string) => {
        stdout.writes.push(chunk);
        if (chunk === EBP) throw new Error("paste enable failed");
      }),
    });
    const lifecycle = createTerminalLifecycle({ stdin: stdin.stream, stdout: stdout.stream });

    expect(() => lifecycle.start()).toThrow(TerminalLifecycleError);
    expect(stdin.calls).toEqual([true, false]);
    expect(stdout.writes).toEqual([HIDE_CURSOR, EBP, DBP, SHOW_CURSOR]);
    expect(lifecycle.isStarted()).toBe(false);
  });

  it("cleanup continues after one cleanup operation fails", () => {
    const stdin = fakeStdin({
      setRawMode: vi.fn((mode: boolean) => {
        stdin.calls.push(mode);
        if (mode === false) throw new Error("raw restore failed");
      }),
    });
    const stdout = fakeStdout();
    const lifecycle = createTerminalLifecycle({ stdin: stdin.stream, stdout: stdout.stream });

    lifecycle.start();
    const result = lifecycle.stop();

    expect(result.errors).toHaveLength(1);
    expect(stdin.calls).toEqual([true, false]);
    expect(stdout.writes).toEqual([HIDE_CURSOR, EBP, DBP, SHOW_CURSOR]);
    expect(lifecycle.isStarted()).toBe(false);
  });

  it("is safe for non-TTY stdin and stdout", () => {
    const stdin = fakeStdin({ isTTY: false });
    const stdout = fakeStdout({ isTTY: false });
    const lifecycle = createTerminalLifecycle({ stdin: stdin.stream, stdout: stdout.stream });

    expect(() => lifecycle.start()).not.toThrow();
    expect(lifecycle.stop()).toEqual({ errors: [] });
    expect(stdin.calls).toEqual([]);
    expect(stdout.writes).toEqual([]);
  });

  it("does not require global process streams", () => {
    const lifecycle = createTerminalLifecycle();

    expect(() => lifecycle.start()).not.toThrow();
    expect(lifecycle.stop()).toEqual({ errors: [] });
  });
});
