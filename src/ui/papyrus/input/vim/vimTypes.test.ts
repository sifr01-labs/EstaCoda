import { describe, expect, it } from "vitest";
import {
  createInitialPapyrusVimState,
  resetPapyrusVimCommandState,
  setPapyrusVimMode,
  type PapyrusVimState,
} from "./vimTypes.js";

describe("Papyrus Vim state types", () => {
  it("creates an inert initial insert-mode state", () => {
    expect(createInitialPapyrusVimState()).toEqual({
      mode: "insert",
      command: { type: "idle" },
      countBuffer: "",
      register: {
        unnamed: "",
        linewise: false,
      },
      dotRepeat: { type: "none" },
    });
  });

  it("can create normal-mode state without routing keys", () => {
    expect(createInitialPapyrusVimState("normal")).toMatchObject({
      mode: "normal",
      command: { type: "idle" },
    });
  });

  it("resets pending command and count state while preserving inert register and repeat data", () => {
    const state: PapyrusVimState = {
      mode: "normal",
      command: {
        type: "operator",
        operator: "delete",
        count: 2,
      },
      countBuffer: "2",
      register: {
        unnamed: "text",
        linewise: false,
      },
      dotRepeat: {
        type: "operator",
        operator: "delete",
        motion: "w",
        count: 2,
      },
    };

    expect(resetPapyrusVimCommandState(state)).toEqual({
      ...state,
      command: { type: "idle" },
      countBuffer: "",
    });
  });

  it("sets mode while clearing pending command state", () => {
    const state: PapyrusVimState = {
      ...createInitialPapyrusVimState("normal"),
      command: { type: "count", digits: "12" },
      countBuffer: "12",
    };

    expect(setPapyrusVimMode(state, "insert")).toMatchObject({
      mode: "insert",
      command: { type: "idle" },
      countBuffer: "",
    });
  });
});
