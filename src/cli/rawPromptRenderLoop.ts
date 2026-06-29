import { stringWidth } from "../ui/papyrus/screen/stringWidth.js";
import type { LineEditorState } from "../ui/input/lineEditor.js";
import {
  buildOperatorConsoleRawPromptFrameWithRuntimeHost,
  type OperatorConsoleRawPromptSnapshot,
} from "../ui/papyrus/operator-console/operatorConsoleHost.js";
import {
  createOperatorConsoleRuntimeHost,
  type OperatorConsoleRuntimeHost,
} from "../ui/papyrus/operator-console/operatorConsoleRuntimeHost.js";
import type {
  AttachmentCardState,
  PromptSurfaceState,
  SlashMenuState,
  SteerState,
  StreamingState,
  ToolActivityState,
  TranscriptBlock,
  TurnActivityState,
} from "../ui/papyrus/operator-console/operatorConsoleState.js";
import type { FocusState } from "../ui/papyrus/operator-console/focusModel.js";

export type RawPromptRenderOutput = {
  write(chunk: string): unknown;
  readonly columns?: number;
  readonly rows?: number;
  readonly isTTY?: boolean;
};

export type RawPromptOverlayRow = {
  readonly id?: string;
  readonly text: string;
};

export type RawPromptGhostText = {
  readonly text: string;
};

export type RawPromptRenderSnapshot = {
  readonly prompt: string;
  readonly state: LineEditorState;
  readonly ghostText?: RawPromptGhostText;
  readonly fallbackRows?: readonly RawPromptOverlayRow[];
  readonly operatorConsole?: RawPromptOperatorConsoleOptions;
};

export type RawPromptOperatorConsoleOptions = Omit<OperatorConsoleRawPromptSnapshot, "prompt" | "state"> & {
  readonly enabled: boolean;
  readonly onAttachmentsChange?: (attachments: readonly AttachmentCardState[]) => void;
  readonly onAttachmentPreview?: (attachment: AttachmentCardState) => void;
  readonly getStatus?: () => OperatorConsoleRawPromptSnapshot["status"];
  readonly focus?: FocusState;
  readonly slash?: SlashMenuState;
  readonly activeWork?: ToolActivityState;
  readonly streaming?: StreamingState;
  readonly transcript?: readonly TranscriptBlock[];
  readonly turnActivity?: TurnActivityState;
  readonly steer?: SteerState;
  readonly promptMode?: PromptSurfaceState["mode"];
};

export class RawPromptOverlayHost {
  #rows: readonly RawPromptOverlayRow[] = [];

  setRows(rows: readonly RawPromptOverlayRow[]): void {
    this.#rows = [...rows];
  }

  clear(): void {
    this.#rows = [];
  }

  getRows(): readonly RawPromptOverlayRow[] {
    return this.#rows;
  }
}

export class RawPromptRenderLoop {
  readonly #output: RawPromptRenderOutput;
  readonly #operatorConsoleHostFactory: () => OperatorConsoleRuntimeHost;
  #operatorConsoleHost: OperatorConsoleRuntimeHost | undefined;
  #renderedRows = 0;
  #cursorRow = 0;

  constructor(
    output: RawPromptRenderOutput,
    options: { readonly operatorConsoleHostFactory?: () => OperatorConsoleRuntimeHost } = {}
  ) {
    this.#output = output;
    this.#operatorConsoleHostFactory = options.operatorConsoleHostFactory ?? createOperatorConsoleRuntimeHost;
  }

  render(snapshot: RawPromptRenderSnapshot): number {
    const frame = snapshot.operatorConsole?.enabled === true
      ? buildOperatorConsoleRawPromptFrameWithRuntimeHost(this.#getOperatorConsoleHost(), {
        mode: snapshot.operatorConsole.mode,
        prompt: snapshot.prompt,
        state: snapshot.state,
        status: snapshot.operatorConsole.getStatus?.() ?? snapshot.operatorConsole.status,
        setupPanel: snapshot.operatorConsole.setupPanel,
        transcript: snapshot.operatorConsole.transcript,
        turnActivity: snapshot.operatorConsole.turnActivity,
        terminal: snapshot.operatorConsole.terminal,
        attachments: snapshot.operatorConsole.attachments,
        slash: snapshot.operatorConsole.slash,
        activeWork: snapshot.operatorConsole.activeWork,
        streaming: snapshot.operatorConsole.streaming,
        steer: snapshot.operatorConsole.steer,
        promptMode: snapshot.operatorConsole.promptMode,
        placeholder: snapshot.operatorConsole.placeholder,
        style: snapshot.operatorConsole.style,
        focus: snapshot.operatorConsole.focus,
      })
      : buildFallbackRawPromptFrame(snapshot);
    this.#moveToFirstRenderedRow();

    const physicalRows = Math.max(this.#renderedRows, frame.rows.length);
    for (let row = 0; row < physicalRows; row += 1) {
      this.#output.write("\x1b[0K");
      if (row < frame.rows.length) this.#output.write(frame.rows[row]!);
      if (row < physicalRows - 1) this.#output.write("\n");
    }

    this.#moveToFrameCursor(physicalRows, frame.cursorRow, frame.cursorColumn);
    this.#renderedRows = frame.rows.length;
    this.#cursorRow = frame.cursorRow;
    return frame.rows.length;
  }

  clear(): void {
    if (this.#renderedRows === 0) return;
    this.#moveToFirstRenderedRow();
    for (let row = 0; row < this.#renderedRows; row += 1) {
      this.#output.write("\x1b[0K");
      if (row < this.#renderedRows - 1) this.#output.write("\n");
    }
    this.#moveToFrameCursor(this.#renderedRows, 0, 0);
    this.#renderedRows = 0;
    this.#cursorRow = 0;
  }

  #getOperatorConsoleHost(): OperatorConsoleRuntimeHost {
    if (this.#operatorConsoleHost === undefined) {
      this.#operatorConsoleHost = this.#operatorConsoleHostFactory();
    }
    return this.#operatorConsoleHost;
  }

  #moveToFirstRenderedRow(): void {
    if (this.#cursorRow > 0) this.#output.write(`\x1b[${this.#cursorRow}A`);
    if (this.#renderedRows > 0) this.#output.write("\r");
  }

  #moveToFrameCursor(physicalRows: number, cursorRow: number, cursorColumn: number): void {
    const rowsBelowCursor = Math.max(0, physicalRows - 1 - cursorRow);
    if (rowsBelowCursor > 0) this.#output.write(`\x1b[${rowsBelowCursor}A`);
    this.#output.write("\r");
    if (cursorColumn > 0) this.#output.write(`\x1b[${cursorColumn}C`);
  }
}

function buildFallbackRawPromptFrame(snapshot: RawPromptRenderSnapshot): {
  readonly rows: readonly string[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
} {
  const textBeforeCursor = snapshot.state.text.slice(0, snapshot.state.cursor);
  const beforeCursorLines = textBeforeCursor.split("\n");
  const textLines = snapshot.state.text.split("\n");
  const cursorLineIndex = beforeCursorLines.length - 1;
  const cursorOffsetInLine = beforeCursorLines[beforeCursorLines.length - 1]?.length ?? 0;
  const promptRows = textLines.map((line, index) => {
    const renderedLine = index === cursorLineIndex && snapshot.ghostText?.text
      ? `${line.slice(0, cursorOffsetInLine)}${snapshot.ghostText.text}${line.slice(cursorOffsetInLine)}`
      : line;
    return index === 0 ? `${snapshot.prompt}${renderedLine}` : renderedLine;
  });
  const fallbackRows = (snapshot.fallbackRows ?? []).map((row) => row.text);
  const rows = [...promptRows, ...fallbackRows];
  const cursorRow = cursorLineIndex;
  const cursorLinePrefix = beforeCursorLines[beforeCursorLines.length - 1] ?? "";
  const cursorColumn = (cursorRow === 0 ? stringWidth(snapshot.prompt) : 0) + stringWidth(cursorLinePrefix);

  return {
    rows: rows.length === 0 ? [""] : rows,
    cursorRow,
    cursorColumn,
  };
}
