import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLineEditorState } from "../../../input/lineEditor.js";
import { createInitialPapyrusVimState, type PapyrusVimState } from "./vimTypes.js";
import { transitionPapyrusVimState } from "./vimStateMachine.js";

describe("Papyrus Vim state machine", () => {
  it("enters normal mode from insert on escape", () => {
    const result = transitionPapyrusVimState(createInitialPapyrusVimState("insert"), {
      type: "escape",
    });

    expect(result.state).toMatchObject({
      mode: "normal",
      command: { type: "idle" },
      countBuffer: "",
    });
    expect(result.actions).toEqual([{ type: "set-mode", mode: "normal" }]);
  });

  it("enters insert mode from normal with i at the current cursor", () => {
    const result = transitionPapyrusVimState(createInitialPapyrusVimState("normal"), {
      type: "key",
      key: "i",
    });

    expect(result.state.mode).toBe("insert");
    expect(result.actions).toEqual([{ type: "set-mode", mode: "insert" }]);
  });

  it("returns cursor intents for append and line insert transitions", () => {
    const normal = createInitialPapyrusVimState("normal");

    expect(transitionPapyrusVimState(normal, { type: "key", key: "a" }).actions).toEqual([
      { type: "move-cursor", target: "right" },
      { type: "set-mode", mode: "insert" },
    ]);
    expect(transitionPapyrusVimState(normal, { type: "key", key: "I" }).actions).toEqual([
      { type: "move-cursor", target: "start" },
      { type: "set-mode", mode: "insert" },
    ]);
    expect(transitionPapyrusVimState(normal, { type: "key", key: "A" }).actions).toEqual([
      { type: "move-cursor", target: "end" },
      { type: "set-mode", mode: "insert" },
    ]);
  });

  it("resets pending normal-mode state for unknown keys", () => {
    const state: PapyrusVimState = {
      ...createInitialPapyrusVimState("normal"),
      command: { type: "count", digits: "2" },
      countBuffer: "2",
    };

    const result = transitionPapyrusVimState(state, { type: "key", key: "z" });

    expect(result.state).toMatchObject({
      mode: "normal",
      command: { type: "idle" },
      countBuffer: "",
    });
    expect(result.actions).toEqual([{ type: "reset-pending-command" }]);
  });

  it("passes insert-mode printable keys through without consuming typing", () => {
    const state = createInitialPapyrusVimState("insert");
    const result = transitionPapyrusVimState(state, { type: "key", key: "x" });

    expect(result.state).toBe(state);
    expect(result.actions).toEqual([{ type: "passthrough-key", key: "x" }]);
  });

  it("accumulates normal-mode counts without executing motions", () => {
    const first = transitionPapyrusVimState(createInitialPapyrusVimState("normal"), {
      type: "key",
      key: "2",
    });
    const second = transitionPapyrusVimState(first.state, { type: "key", key: "0" });

    expect(second.state).toMatchObject({
      mode: "normal",
      command: { type: "count", digits: "20" },
      countBuffer: "20",
    });
    expect(second.actions).toEqual([{ type: "noop" }]);
  });

  it("keeps operator state as inert pending data only", () => {
    const count = transitionPapyrusVimState(createInitialPapyrusVimState("normal"), {
      type: "key",
      key: "3",
    });
    const result = transitionPapyrusVimState(count.state, { type: "key", key: "d" });

    expect(result.state).toMatchObject({
      mode: "normal",
      command: {
        type: "operator",
        operator: "delete",
        count: 3,
      },
      countBuffer: "",
    });
    expect(result.actions).toEqual([{ type: "noop" }]);
  });

  it("emits cursor offset intent for normal-mode motions", () => {
    const result = transitionPapyrusVimState(
      createInitialPapyrusVimState("normal"),
      { type: "key", key: "w" },
      { line: createLineEditorState("one two", 0) }
    );

    expect(result.state).toMatchObject({
      mode: "normal",
      command: { type: "idle" },
      countBuffer: "",
    });
    expect(result.actions).toEqual([
      { type: "move-cursor-to", motion: "w", count: 1, cursor: "one ".length },
    ]);
  });

  it("applies counts to motions and resets count state afterward", () => {
    const count = transitionPapyrusVimState(createInitialPapyrusVimState("normal"), {
      type: "key",
      key: "3",
    });
    const result = transitionPapyrusVimState(
      count.state,
      { type: "key", key: "l" },
      { line: createLineEditorState("abcdef", 0) }
    );

    expect(result.state).toMatchObject({
      mode: "normal",
      command: { type: "idle" },
      countBuffer: "",
    });
    expect(result.actions).toEqual([{ type: "move-cursor-to", motion: "l", count: 3, cursor: 3 }]);
  });

  it("treats 0 as a start motion, not a leading count", () => {
    const result = transitionPapyrusVimState(
      createInitialPapyrusVimState("normal"),
      { type: "key", key: "0" },
      { line: createLineEditorState("abc", 2) }
    );

    expect(result.state).toMatchObject({
      command: { type: "idle" },
      countBuffer: "",
    });
    expect(result.actions).toEqual([{ type: "move-cursor-to", motion: "0", count: 1, cursor: 0 }]);
  });

  it("does not execute motions without line state", () => {
    const result = transitionPapyrusVimState(createInitialPapyrusVimState("normal"), {
      type: "key",
      key: "$",
    });

    expect(result.state).toMatchObject({
      command: { type: "idle" },
      countBuffer: "",
    });
    expect(result.actions).toEqual([{ type: "noop" }]);
  });

  it("emits delete intent for x and resets count state", () => {
    const count = transitionPapyrusVimState(createInitialPapyrusVimState("normal"), {
      type: "key",
      key: "2",
    });
    const result = transitionPapyrusVimState(
      count.state,
      { type: "key", key: "x" },
      { line: createLineEditorState("abcd", 1) }
    );

    expect(result.state).toMatchObject({
      mode: "normal",
      command: { type: "idle" },
      countBuffer: "",
    });
    expect(result.actions).toEqual([
      { type: "delete-range", operator: "x", count: 2, range: { start: 1, end: 3 } },
    ]);
  });

  it("emits delete intent for dw and remains normal mode", () => {
    const operator = transitionPapyrusVimState(createInitialPapyrusVimState("normal"), {
      type: "key",
      key: "d",
    });
    const result = transitionPapyrusVimState(
      operator.state,
      { type: "key", key: "w" },
      { line: createLineEditorState("one two", 0) }
    );

    expect(result.state).toMatchObject({
      mode: "normal",
      command: { type: "idle" },
      countBuffer: "",
    });
    expect(result.actions).toEqual([
      {
        type: "delete-range",
        operator: "delete",
        count: 1,
        motion: "w",
        range: { start: 0, end: "one ".length },
      },
    ]);
  });

  it("applies counts to operator motions", () => {
    const count = transitionPapyrusVimState(createInitialPapyrusVimState("normal"), {
      type: "key",
      key: "3",
    });
    const operator = transitionPapyrusVimState(count.state, { type: "key", key: "d" });
    const result = transitionPapyrusVimState(
      operator.state,
      { type: "key", key: "w" },
      { line: createLineEditorState("one two three four", 0) }
    );

    expect(result.state).toMatchObject({
      mode: "normal",
      command: { type: "idle" },
      countBuffer: "",
    });
    expect(result.actions).toEqual([
      {
        type: "delete-range",
        operator: "delete",
        count: 3,
        motion: "w",
        range: { start: 0, end: "one two three ".length },
      },
    ]);
  });

  it("emits change intent for cw and enters insert mode", () => {
    const operator = transitionPapyrusVimState(createInitialPapyrusVimState("normal"), {
      type: "key",
      key: "c",
    });
    const result = transitionPapyrusVimState(
      operator.state,
      { type: "key", key: "w" },
      { line: createLineEditorState("one two", 0) }
    );

    expect(result.state).toMatchObject({
      mode: "insert",
      command: { type: "idle" },
      countBuffer: "",
    });
    expect(result.actions).toEqual([
      {
        type: "change-range",
        operator: "change",
        count: 1,
        motion: "w",
        range: { start: 0, end: "one".length },
        enterInsert: true,
      },
      { type: "set-mode", mode: "insert" },
    ]);
  });

  it("applies counts to change motions", () => {
    const count = transitionPapyrusVimState(createInitialPapyrusVimState("normal"), {
      type: "key",
      key: "2",
    });
    const operator = transitionPapyrusVimState(count.state, { type: "key", key: "c" });
    const result = transitionPapyrusVimState(
      operator.state,
      { type: "key", key: "w" },
      { line: createLineEditorState("one two three", 0) }
    );

    expect(result.state).toMatchObject({
      mode: "insert",
      command: { type: "idle" },
      countBuffer: "",
    });
    expect(result.actions).toEqual([
      {
        type: "change-range",
        operator: "change",
        count: 2,
        motion: "w",
        range: { start: 0, end: "one two".length },
        enterInsert: true,
      },
      { type: "set-mode", mode: "insert" },
    ]);
  });

  it("resets pending operators safely for invalid operator motions", () => {
    const operator = transitionPapyrusVimState(createInitialPapyrusVimState("normal"), {
      type: "key",
      key: "d",
    });
    const result = transitionPapyrusVimState(operator.state, { type: "key", key: "z" });

    expect(result.state).toMatchObject({
      mode: "normal",
      command: { type: "idle" },
      countBuffer: "",
    });
    expect(result.actions).toEqual([{ type: "reset-pending-command" }]);
  });

  it("does not produce delete ranges for unsupported delete motions", () => {
    for (const key of ["h", "$", "0", "b", "e"]) {
      const operator = transitionPapyrusVimState(createInitialPapyrusVimState("normal"), {
        type: "key",
        key: "d",
      });
      const result = transitionPapyrusVimState(
        operator.state,
        { type: "key", key },
        { line: createLineEditorState("one two", 0) }
      );

      expect(result.state).toMatchObject({
        mode: "normal",
        command: { type: "idle" },
        countBuffer: "",
      });
      expect(result.actions).toEqual([{ type: "reset-pending-command" }]);
    }
  });

  it("does not produce change ranges for unsupported change motions", () => {
    for (const key of ["h", "$", "0", "b", "e"]) {
      const operator = transitionPapyrusVimState(createInitialPapyrusVimState("normal"), {
        type: "key",
        key: "c",
      });
      const result = transitionPapyrusVimState(
        operator.state,
        { type: "key", key },
        { line: createLineEditorState("one two", 0) }
      );

      expect(result.state).toMatchObject({
        mode: "normal",
        command: { type: "idle" },
        countBuffer: "",
      });
      expect(result.actions).toEqual([{ type: "reset-pending-command" }]);
    }
  });

  it("resets pending state on normal-mode escape without altering submit/cancel semantics", () => {
    const state: PapyrusVimState = {
      ...createInitialPapyrusVimState("normal"),
      command: { type: "operator", operator: "change", count: 4 },
      countBuffer: "",
    };

    const result = transitionPapyrusVimState(state, { type: "escape" });

    expect(result.state).toMatchObject({
      mode: "normal",
      command: { type: "idle" },
      countBuffer: "",
    });
    expect(result.actions).toEqual([{ type: "reset-pending-command" }]);
  });

  it("is pure and does not mutate external state", () => {
    const state: PapyrusVimState = {
      ...createInitialPapyrusVimState("normal"),
      command: { type: "count", digits: "9" },
      countBuffer: "9",
    };
    const before = structuredClone(state);

    const result = transitionPapyrusVimState(state, { type: "key", key: "a" });

    expect(state).toEqual(before);
    expect(result.state).not.toBe(state);
  });

  it("keeps implementation free of upstream and live app coupling", () => {
    const source = readFileSync(fileURLToPath(new URL("./vimStateMachine.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/\.\.\/ink|wrapAnsi|stringWidth|killRing|Image #|source-app|analytics/u);
    expect(source).not.toMatch(/\bsrc\/(cli|security|runtime|providers|session)\//u);
    expect(source).not.toMatch(/\bprocess\b|\bchild_process\b|\bsetRawMode\b|\bstdout\b|\bstderr\b/u);
  });
});
