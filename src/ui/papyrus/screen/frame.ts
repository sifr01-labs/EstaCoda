import type { Size } from "../layout/geometry.js";
import { createScreen, type Screen } from "./screen.js";

export type CursorState = {
  x: number;
  y: number;
  visible: boolean;
};

export type Frame = {
  readonly screen: Screen;
  readonly viewport: Size;
  readonly cursor: CursorState;
};

export type FlickerReason = "resize" | "offscreen" | "clear";

export type Patch =
  | { type: "stdout"; content: string }
  | { type: "cellRun"; x: number; y: number; content: string; styleId: number; style: import("../termio/types.js").TextStyle; hyperlink?: string }
  | { type: "clear"; count: number }
  | { type: "clearTerminal"; reason: FlickerReason }
  | { type: "cursorMove"; x: number; y: number }
  | { type: "cursorTo"; x: number; y: number }
  | { type: "noop" };

export type Diff = Patch[];

export function createFrame(screen: Screen, viewport?: Partial<Size>, cursor?: Partial<CursorState>): Frame {
  return {
    screen: screen.clone(),
    viewport: {
      width: viewport?.width ?? screen.width,
      height: viewport?.height ?? screen.height,
    },
    cursor: {
      x: cursor?.x ?? 0,
      y: cursor?.y ?? 0,
      visible: cursor?.visible ?? true,
    },
  };
}

export function emptyFrame(width: number, height: number): Frame {
  return createFrame(createScreen(width, height), { width, height });
}

export function shouldClearScreen(prev: Frame, next: Frame): FlickerReason | undefined {
  return prev.viewport.width !== next.viewport.width || prev.viewport.height !== next.viewport.height ? "resize" : undefined;
}
