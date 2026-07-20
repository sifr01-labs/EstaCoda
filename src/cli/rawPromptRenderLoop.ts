import { stringWidth } from "../ui/papyrus/screen/stringWidth.js";
import type { LineEditorState } from "../ui/input/lineEditor.js";
import {
  buildOperatorConsoleRawPromptFrameWithRuntimeHost,
  type OperatorConsoleRawPromptFrame,
  type OperatorConsoleRawPromptSnapshot,
} from "../ui/papyrus/operator-console/operatorConsoleHost.js";
import {
  createOperatorConsoleRuntimeHost,
  type OperatorConsoleRuntimeHost,
} from "../ui/papyrus/operator-console/operatorConsoleRuntimeHost.js";
import type {
  OperatorConsoleRegion,
  OperatorConsoleRegionKind,
} from "../ui/papyrus/operator-console/operatorConsoleLayout.js";
import type {
  AttachmentCardState,
  PromptSurfaceState,
  SlashMenuState,
  SteerState,
  StreamingState,
  ToolActivityState,
  TaskCardState,
  TaskSurfaceState,
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

export type RawPromptRenderOptions = {
  readonly dirtyRegions?: readonly OperatorConsoleRegionKind[];
};

export type RawPromptOperatorConsoleOptions = Omit<OperatorConsoleRawPromptSnapshot, "prompt" | "state"> & {
  readonly enabled: boolean;
  readonly onAttachmentsChange?: (attachments: readonly AttachmentCardState[]) => void;
  readonly onAttachmentPreview?: (attachment: AttachmentCardState) => void;
  readonly getStatus?: () => OperatorConsoleRawPromptSnapshot["status"];
  readonly getTasks?: () => readonly TaskCardState[];
  readonly tasks?: TaskSurfaceState;
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
  #lastOperatorConsoleRegions: readonly OperatorConsoleRegion[] | undefined;
  #renderedRows = 0;
  #cursorRow = 0;

  constructor(
    output: RawPromptRenderOutput,
    options: { readonly operatorConsoleHostFactory?: () => OperatorConsoleRuntimeHost } = {}
  ) {
    this.#output = output;
    this.#operatorConsoleHostFactory = options.operatorConsoleHostFactory ?? createOperatorConsoleRuntimeHost;
  }

  render(snapshot: RawPromptRenderSnapshot, options: RawPromptRenderOptions = {}): number {
    return this.#withHiddenCursorDuringManagedRedraw(() => this.#renderVisibleFrame(snapshot, options));
  }

  clear(): void {
    if (this.#renderedRows === 0) return;
    this.#withHiddenCursorDuringManagedRedraw(() => {
      const chunks = [this.#moveToFirstRenderedRowSequence()];
      for (let row = 0; row < this.#renderedRows; row += 1) {
        chunks.push("\x1b[0K");
        if (row < this.#renderedRows - 1) chunks.push("\n");
      }
      chunks.push(this.#moveToFrameCursorSequence(this.#renderedRows, 0, 0));
      this.#writeRedraw(chunks);
      this.#renderedRows = 0;
      this.#cursorRow = 0;
      this.#lastOperatorConsoleRegions = undefined;
    });
  }

  #renderVisibleFrame(snapshot: RawPromptRenderSnapshot, options: RawPromptRenderOptions): number {
    const frame = snapshot.operatorConsole?.enabled === true
      ? buildOperatorConsoleRawPromptFrameWithRuntimeHost(this.#getOperatorConsoleHost(), {
        mode: snapshot.operatorConsole.mode,
        locale: snapshot.operatorConsole.locale,
        prompt: snapshot.prompt,
        state: snapshot.state,
        status: snapshot.operatorConsole.getStatus?.() ?? snapshot.operatorConsole.status,
        setupPanel: snapshot.operatorConsole.setupPanel,
        transcript: snapshot.operatorConsole.transcript,
        turnActivity: snapshot.operatorConsole.turnActivity,
        terminal: snapshot.operatorConsole.terminal,
        attachments: snapshot.operatorConsole.attachments,
        tasks: snapshot.operatorConsole.tasks,
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

    if (this.#canRedrawDirtyOperatorConsoleRegions(frame, options.dirtyRegions)) {
      this.#redrawDirtyOperatorConsoleRegions(frame, options.dirtyRegions!);
      this.#rememberRenderedFrame(frame);
      return frame.rows.length;
    }

    const chunks = [this.#moveToFirstRenderedRowSequence()];

    const physicalRows = Math.max(this.#renderedRows, frame.rows.length);
    for (let row = 0; row < physicalRows; row += 1) {
      chunks.push("\x1b[0K");
      if (row < frame.rows.length) chunks.push(frame.rows[row]!);
      if (row < physicalRows - 1) chunks.push("\n");
    }

    chunks.push(this.#moveToFrameCursorSequence(physicalRows, frame.cursorRow, frame.cursorColumn));
    this.#writeRedraw(chunks);
    this.#rememberRenderedFrame(frame);
    return frame.rows.length;
  }

  #canRedrawDirtyOperatorConsoleRegions(
    frame: RawPromptFrame,
    dirtyRegions: readonly OperatorConsoleRegionKind[] | undefined
  ): frame is OperatorConsoleRawPromptFrame {
    if (dirtyRegions === undefined || dirtyRegions.length === 0) return false;
    if (!isOperatorConsoleFrame(frame)) return false;
    if (this.#lastOperatorConsoleRegions === undefined) return false;
    if (this.#renderedRows !== frame.rows.length) return false;
    if (!operatorConsoleRegionsMatch(this.#lastOperatorConsoleRegions, frame.layout.regions)) return false;
    return frame.layout.regions.some((region) => {
      return dirtyRegions.includes(region.kind) && region.visible && region.height > 0;
    });
  }

  #redrawDirtyOperatorConsoleRegions(
    frame: OperatorConsoleRawPromptFrame,
    dirtyRegions: readonly OperatorConsoleRegionKind[]
  ): void {
    const dirty = new Set(dirtyRegions);
    const regions = frame.layout.regions
      .filter((region) => dirty.has(region.kind) && region.visible && region.height > 0)
      .sort((a, b) => a.y - b.y);
    let currentRow = this.#cursorRow;
    const chunks: string[] = [];

    for (const region of regions) {
      chunks.push(this.#moveFromFrameRowToFrameRowSequence(currentRow, region.y));
      currentRow = region.y;
      for (let offset = 0; offset < region.height; offset += 1) {
        const row = region.y + offset;
        chunks.push("\x1b[0K");
        if (row < frame.rows.length) chunks.push(frame.rows[row]!);
        if (offset < region.height - 1) {
          chunks.push("\n");
          currentRow += 1;
        }
      }
    }

    chunks.push(this.#moveFromFrameRowToFrameRowSequence(currentRow, frame.cursorRow));
    if (frame.cursorColumn > 0) chunks.push(`\x1b[${frame.cursorColumn}C`);
    this.#writeRedraw(chunks);
    this.#cursorRow = frame.cursorRow;
  }

  #rememberRenderedFrame(frame: RawPromptFrame): void {
    this.#renderedRows = frame.rows.length;
    this.#cursorRow = frame.cursorRow;
    this.#lastOperatorConsoleRegions = isOperatorConsoleFrame(frame)
      ? cloneOperatorConsoleRegions(frame.layout.regions)
      : undefined;
  }

  #getOperatorConsoleHost(): OperatorConsoleRuntimeHost {
    if (this.#operatorConsoleHost === undefined) {
      this.#operatorConsoleHost = this.#operatorConsoleHostFactory();
    }
    return this.#operatorConsoleHost;
  }

  #moveToFirstRenderedRowSequence(): string {
    const chunks: string[] = [];
    if (this.#cursorRow > 0) chunks.push(`\x1b[${this.#cursorRow}A`);
    if (this.#renderedRows > 0) chunks.push("\r");
    return chunks.join("");
  }

  #moveToFrameCursorSequence(physicalRows: number, cursorRow: number, cursorColumn: number): string {
    const chunks: string[] = [];
    const rowsBelowCursor = Math.max(0, physicalRows - 1 - cursorRow);
    if (rowsBelowCursor > 0) chunks.push(`\x1b[${rowsBelowCursor}A`);
    chunks.push("\r");
    if (cursorColumn > 0) chunks.push(`\x1b[${cursorColumn}C`);
    return chunks.join("");
  }

  #moveFromFrameRowToFrameRowSequence(currentRow: number, targetRow: number): string {
    const chunks: string[] = [];
    if (currentRow > targetRow) chunks.push(`\x1b[${currentRow - targetRow}A`);
    if (currentRow < targetRow) chunks.push(`\x1b[${targetRow - currentRow}B`);
    chunks.push("\r");
    return chunks.join("");
  }

  #writeRedraw(chunks: readonly string[]): void {
    const text = chunks.join("");
    if (text.length > 0) this.#output.write(text);
  }

  #withHiddenCursorDuringManagedRedraw<T>(redraw: () => T): T {
    if (this.#output.isTTY !== true) return redraw();
    this.#output.write(HIDE_CURSOR);
    try {
      return redraw();
    } finally {
      this.#output.write(SHOW_CURSOR);
    }
  }
}

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

type RawPromptFrame = OperatorConsoleRawPromptFrame | {
  readonly rows: readonly string[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
};

function buildFallbackRawPromptFrame(snapshot: RawPromptRenderSnapshot): RawPromptFrame {
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

function isOperatorConsoleFrame(frame: RawPromptFrame): frame is OperatorConsoleRawPromptFrame {
  return "layout" in frame;
}

function operatorConsoleRegionsMatch(
  previous: readonly OperatorConsoleRegion[],
  next: readonly OperatorConsoleRegion[]
): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((region, index) => {
    const candidate = next[index];
    return candidate !== undefined &&
      region.kind === candidate.kind &&
      region.x === candidate.x &&
      region.y === candidate.y &&
      region.width === candidate.width &&
      region.height === candidate.height &&
      region.visible === candidate.visible;
  });
}

function cloneOperatorConsoleRegions(regions: readonly OperatorConsoleRegion[]): readonly OperatorConsoleRegion[] {
  return regions.map((region) => ({ ...region }));
}
