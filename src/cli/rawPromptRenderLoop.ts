import { stringWidth } from "../ui/papyrus/screen/stringWidth.js";
import type { LineEditorState } from "../ui/input/lineEditor.js";

export type RawPromptRenderOutput = {
  write(chunk: string): unknown;
};

export type RawPromptOverlayRow = {
  readonly id?: string;
  readonly text: string;
};

export type RawPromptRenderSnapshot = {
  readonly prompt: string;
  readonly state: LineEditorState;
  readonly overlayRows?: readonly RawPromptOverlayRow[];
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
  #renderedRows = 0;

  constructor(output: RawPromptRenderOutput) {
    this.#output = output;
  }

  render(snapshot: RawPromptRenderSnapshot): number {
    const frame = buildRawPromptFrame(snapshot);
    this.#moveToFirstRenderedRow();

    const physicalRows = Math.max(this.#renderedRows, frame.rows.length);
    for (let row = 0; row < physicalRows; row += 1) {
      this.#output.write("\x1b[0K");
      if (row < frame.rows.length) this.#output.write(frame.rows[row]!);
      if (row < physicalRows - 1) this.#output.write("\n");
    }

    this.#moveToFrameCursor(physicalRows, frame.cursorRow, frame.cursorColumn);
    this.#renderedRows = frame.rows.length;
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
  }

  #moveToFirstRenderedRow(): void {
    if (this.#renderedRows > 1) this.#output.write(`\x1b[${this.#renderedRows - 1}A`);
    if (this.#renderedRows > 0) this.#output.write("\r");
  }

  #moveToFrameCursor(physicalRows: number, cursorRow: number, cursorColumn: number): void {
    const rowsBelowCursor = Math.max(0, physicalRows - 1 - cursorRow);
    if (rowsBelowCursor > 0) this.#output.write(`\x1b[${rowsBelowCursor}A`);
    this.#output.write("\r");
    if (cursorColumn > 0) this.#output.write(`\x1b[${cursorColumn}C`);
  }
}

export function buildRawPromptFrame(snapshot: RawPromptRenderSnapshot): {
  readonly rows: readonly string[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
} {
  const textBeforeCursor = snapshot.state.text.slice(0, snapshot.state.cursor);
  const beforeCursorLines = textBeforeCursor.split("\n");
  const textLines = snapshot.state.text.split("\n");
  const promptRows = textLines.map((line, index) => index === 0 ? `${snapshot.prompt}${line}` : line);
  const overlayRows = (snapshot.overlayRows ?? []).map((row) => row.text);
  const rows = [...promptRows, ...overlayRows];
  const cursorRow = beforeCursorLines.length - 1;
  const cursorLinePrefix = beforeCursorLines[beforeCursorLines.length - 1] ?? "";
  const cursorColumn = (cursorRow === 0 ? stringWidth(snapshot.prompt) : 0) + stringWidth(cursorLinePrefix);

  return {
    rows: rows.length === 0 ? [""] : rows,
    cursorRow,
    cursorColumn,
  };
}
