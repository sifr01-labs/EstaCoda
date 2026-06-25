export type PapyrusVimMode = "insert" | "normal";

export type PapyrusVimOperator = "delete" | "change" | "yank";

export type PapyrusVimCommandState =
  | { readonly type: "idle" }
  | { readonly type: "count"; readonly digits: string }
  | {
      readonly type: "operator";
      readonly operator: PapyrusVimOperator;
      readonly count: number;
    };

export type PapyrusVimRegisterState = {
  readonly unnamed: string;
  readonly linewise: boolean;
};

export type PapyrusVimDotRepeatState =
  | { readonly type: "none" }
  | { readonly type: "insert"; readonly text: string }
  | {
      readonly type: "operator";
      readonly operator: PapyrusVimOperator;
      readonly motion: string;
      readonly count: number;
    };

export type PapyrusVimState = {
  readonly mode: PapyrusVimMode;
  readonly command: PapyrusVimCommandState;
  readonly countBuffer: string;
  readonly register: PapyrusVimRegisterState;
  readonly dotRepeat: PapyrusVimDotRepeatState;
};

export function createInitialPapyrusVimState(
  mode: PapyrusVimMode = "insert"
): PapyrusVimState {
  return {
    mode,
    command: { type: "idle" },
    countBuffer: "",
    register: {
      unnamed: "",
      linewise: false,
    },
    dotRepeat: { type: "none" },
  };
}

export function resetPapyrusVimCommandState(state: PapyrusVimState): PapyrusVimState {
  return {
    ...state,
    command: { type: "idle" },
    countBuffer: "",
  };
}

export function setPapyrusVimMode(
  state: PapyrusVimState,
  mode: PapyrusVimMode
): PapyrusVimState {
  return resetPapyrusVimCommandState({
    ...state,
    mode,
  });
}
