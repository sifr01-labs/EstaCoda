import type { Rectangle } from "../layout/geometry.js";
import type { TextStyle } from "../termio/types.js";
import { defaultStyle } from "../termio/types.js";

export const enum CellWidth {
  Spacer = 0,
  Narrow = 1,
  Wide = 2,
}

export type Cell = {
  char: string;
  width: CellWidth;
  styleId: number;
  hyperlinkId: number;
};

export type CellSnapshot = Readonly<Cell>;

function blankCell(styleId = 0): Cell {
  return { char: " ", width: CellWidth.Narrow, styleId, hyperlinkId: 0 };
}

export class Screen {
  readonly width: number;
  readonly height: number;
  private readonly cells: Cell[];
  private readonly styles: TextStyle[] = [defaultStyle()];
  private readonly styleKeys = new Map<string, number>([[JSON.stringify(defaultStyle()), 0]]);
  private readonly hyperlinks: string[] = [""];
  private readonly hyperlinkIds = new Map<string, number>();

  constructor(width: number, height: number) {
    this.width = Math.max(0, Math.floor(width));
    this.height = Math.max(0, Math.floor(height));
    this.cells = Array.from({ length: this.width * this.height }, () => blankCell());
  }

  clone(): Screen {
    const next = new Screen(this.width, this.height);
    next.cells.splice(0, next.cells.length, ...this.cells.map((cell) => ({ ...cell })));
    next.styles.splice(0, next.styles.length, ...this.styles.map((style) => ({ ...style })));
    next.styleKeys.clear();
    for (let i = 0; i < next.styles.length; i += 1) next.styleKeys.set(JSON.stringify(next.styles[i]), i);
    next.hyperlinks.splice(0, next.hyperlinks.length, ...this.hyperlinks);
    next.hyperlinkIds.clear();
    for (let i = 1; i < next.hyperlinks.length; i += 1) next.hyperlinkIds.set(next.hyperlinks[i]!, i);
    return next;
  }

  internStyle(style: TextStyle): number {
    const key = JSON.stringify(style);
    const existing = this.styleKeys.get(key);
    if (existing !== undefined) return existing;
    const id = this.styles.length;
    this.styles.push({ ...style });
    this.styleKeys.set(key, id);
    return id;
  }

  getStyle(id: number): TextStyle {
    return this.styles[id] ?? this.styles[0]!;
  }

  internHyperlink(hyperlink: string | undefined): number {
    if (!hyperlink) return 0;
    const existing = this.hyperlinkIds.get(hyperlink);
    if (existing !== undefined) return existing;
    const id = this.hyperlinks.length;
    this.hyperlinks.push(hyperlink);
    this.hyperlinkIds.set(hyperlink, id);
    return id;
  }

  getHyperlink(id: number): string | undefined {
    return id === 0 ? undefined : this.hyperlinks[id];
  }

  contains(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  cellAt(x: number, y: number): CellSnapshot | undefined {
    if (!this.contains(x, y)) return undefined;
    return this.cells[this.index(x, y)];
  }

  row(y: number): CellSnapshot[] {
    if (y < 0 || y >= this.height) return [];
    return Array.from({ length: this.width }, (_, x) => this.cellAt(x, y)!);
  }

  rowText(y: number): string {
    return this.row(y).map((cell) => (cell.width === CellWidth.Spacer ? "" : cell.char)).join("");
  }

  clear(styleId = 0): void {
    for (let i = 0; i < this.cells.length; i += 1) this.cells[i] = blankCell(styleId);
  }

  clearRegion(region: Rectangle, styleId = 0): void {
    const left = Math.max(0, Math.floor(region.x));
    const top = Math.max(0, Math.floor(region.y));
    const right = Math.min(this.width, Math.ceil(region.x + region.width));
    const bottom = Math.min(this.height, Math.ceil(region.y + region.height));

    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) this.setCell(x, y, " ", CellWidth.Narrow, styleId);
    }
  }

  setCell(x: number, y: number, char: string, width: CellWidth = CellWidth.Narrow, styleId = 0, hyperlinkId = 0): boolean {
    if (!this.contains(x, y)) return false;
    if (width === CellWidth.Wide && x + 1 >= this.width) return false;

    this.clearOccupiedCell(x, y);
    this.cells[this.index(x, y)] = { char, width, styleId, hyperlinkId };

    if (width === CellWidth.Wide) {
      this.clearOccupiedCell(x + 1, y);
      this.cells[this.index(x + 1, y)] = { char: "", width: CellWidth.Spacer, styleId, hyperlinkId };
    }

    return true;
  }

  equalsCell(other: Screen, x: number, y: number): boolean {
    const a = this.cellAt(x, y);
    const b = other.cellAt(x, y);
    if (!a || !b) return a === b;
    return (
      a.char === b.char &&
      a.width === b.width &&
      JSON.stringify(this.getStyle(a.styleId)) === JSON.stringify(other.getStyle(b.styleId)) &&
      this.getHyperlink(a.hyperlinkId) === other.getHyperlink(b.hyperlinkId)
    );
  }

  private clearOccupiedCell(x: number, y: number): void {
    const current = this.cellAt(x, y);
    if (!current) return;

    if (current.width === CellWidth.Spacer && x > 0) {
      const previous = this.cellAt(x - 1, y);
      if (previous?.width === CellWidth.Wide) this.cells[this.index(x - 1, y)] = blankCell();
    }

    if (current.width === CellWidth.Wide && x + 1 < this.width) this.cells[this.index(x + 1, y)] = blankCell();
    this.cells[this.index(x, y)] = blankCell();
  }

  private index(x: number, y: number): number {
    return y * this.width + x;
  }
}

export function createScreen(width: number, height: number): Screen {
  return new Screen(width, height);
}

export function diffEach(a: Screen, b: Screen, visit: (x: number, y: number, prev: CellSnapshot | undefined, next: CellSnapshot | undefined) => void): void {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!a.equalsCell(b, x, y)) visit(x, y, a.cellAt(x, y), b.cellAt(x, y));
    }
  }
}
