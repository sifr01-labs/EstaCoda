import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
