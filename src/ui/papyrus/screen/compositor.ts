import type { Rectangle, Size } from "../layout/geometry.js";
import { createFrame, type CursorState, type Frame } from "./frame.js";
import { Output, type WriteOptions } from "./output.js";
import { createScreen, type Screen } from "./screen.js";

export type CompositorSize = Size;

export class Compositor {
  private size: CompositorSize;
  private screen: Screen;
  private output: Output;

  constructor(size: Partial<CompositorSize>) {
    this.size = normalizeSize(size);
    this.screen = createScreen(this.size.width, this.size.height);
    this.output = new Output(this.screen);
  }

  getSize(): CompositorSize {
    return { ...this.size };
  }

  getScreen(): Screen {
    return this.screen;
  }

  snapshot(cursor?: Partial<CursorState>): Frame {
    return createFrame(this.screen, this.size, cursor);
  }

  beginFrame(): Frame {
    this.screen.clear();
    return this.snapshot();
  }

  resize(size: Partial<CompositorSize>): Frame {
    this.size = normalizeSize(size);
    this.screen = createScreen(this.size.width, this.size.height);
    this.output = new Output(this.screen);
    return this.snapshot();
  }

  write(x: number, y: number, text: string, options?: WriteOptions): { x: number; y: number } {
    return this.output.write(x, y, text, options);
  }

  clear(x: number, y: number, width: number, height: number): void {
    this.output.clearRegion({ x, y, width, height });
  }

  clearRegion(region: Rectangle): void {
    this.output.clearRegion(region);
  }
}

export function createCompositor(size: Partial<CompositorSize>): Compositor {
  return new Compositor(size);
}

function normalizeSize(size: Partial<CompositorSize>): CompositorSize {
  return {
    width: Math.max(0, Math.floor(size.width ?? 0)),
    height: Math.max(0, Math.floor(size.height ?? 0)),
  };
}
