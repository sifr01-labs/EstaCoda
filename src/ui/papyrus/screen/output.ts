import type { Rectangle } from "../layout/geometry.js";
import { Parser } from "../termio/parser.js";
import type { Action, TextStyle } from "../termio/types.js";
import { defaultStyle } from "../termio/types.js";
import { reorderBidi, type ClusteredChar } from "./bidi.js";
import { CellWidth, type Screen } from "./screen.js";
import { stringWidth } from "./stringWidth.js";

export type WriteOptions = {
  bidi?: "auto" | "software" | "native" | "off";
};

export class Output {
  readonly screen: Screen;

  constructor(screen: Screen) {
    this.screen = screen;
  }

  write(x: number, y: number, text: string, options?: WriteOptions): { x: number; y: number } {
    const parser = new Parser();
    const actions = [...parser.feed(text), ...parser.flush()];
    let cursorX = x;
    let cursorY = y;
    let activeHyperlink: string | undefined;

    for (const action of actions) {
      if (action.type === "link") {
        activeHyperlink = action.action.type === "start" ? action.action.url : undefined;
        continue;
      }
      if (action.type !== "text") continue;
      const clusters = this.actionToClusters(action, activeHyperlink, options);
      for (const cluster of clusters) {
        if (cluster.value === "\n") {
          cursorX = x;
          cursorY += 1;
          continue;
        }

        if (cursorY >= this.screen.height) break;
        if (cursorX >= this.screen.width) continue;

        const width = cluster.width === 2 ? CellWidth.Wide : CellWidth.Narrow;
        if (this.screen.setCell(cursorX, cursorY, cluster.value, width, cluster.styleId, this.screen.internHyperlink(cluster.hyperlink))) {
          cursorX += cluster.width;
        } else {
          cursorX += 1;
        }
      }
    }

    return { x: cursorX, y: cursorY };
  }

  clearRegion(region: Rectangle): void {
    this.screen.clearRegion(region);
  }

  private actionToClusters(action: Extract<Action, { type: "text" }>, hyperlink: string | undefined, options?: WriteOptions): ClusteredChar[] {
    const styleId = this.screen.internStyle(action.style);
    const clusters: ClusteredChar[] = [];

    for (const grapheme of action.graphemes) {
      const value = grapheme.value;
      if (value.includes("\n")) {
        for (const part of value.split(/(\n)/u)) {
          if (part === "") continue;
          clusters.push({ value: part, width: part === "\n" ? 1 : Math.max(1, Math.min(2, stringWidth(part))), styleId, hyperlink });
        }
      } else {
        clusters.push({ value, width: Math.max(1, Math.min(2, stringWidth(value))), styleId, hyperlink });
      }
    }

    return [...reorderBidi(clusters, { mode: options?.bidi })];
  }
}

export function writeToScreen(screen: Screen, x: number, y: number, text: string, options?: WriteOptions): { x: number; y: number } {
  return new Output(screen).write(x, y, text, options);
}

export function styleIdFor(screen: Screen, style: TextStyle = defaultStyle()): number {
  return screen.internStyle(style);
}
