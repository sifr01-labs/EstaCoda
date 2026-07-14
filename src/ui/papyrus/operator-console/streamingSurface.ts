import {
  type AssistantMessageFrameBlock,
  getAssistantMessageFrameDesiredHeight,
  renderAssistantMessageFrame,
} from "./assistantMessageFrame.js";
import type { StreamingState } from "./operatorConsoleState.js";
import type { OperatorConsoleStyle } from "./operatorConsoleStyle.js";

export type StreamingSurfaceRenderOptions = {
  readonly width: number;
  readonly height?: number;
  readonly terminalHeight?: number;
  readonly style?: OperatorConsoleStyle;
};

export function hasStreamingSurface(state: StreamingState | undefined): state is StreamingState {
  return state !== undefined && state.isStreaming && (
    state.tail.trim().length > 0 ||
    state.segments.some((segment) => segment.text.trim().length > 0)
  );
}

export function hasLiveStreamingTail(state: StreamingState | undefined): boolean {
  return state !== undefined && state.isStreaming && state.tail.trim().length > 0;
}

export function getStreamingSurfaceDesiredHeight(
  state: StreamingState | undefined,
  width: number,
  _options: { readonly terminalHeight?: number } = {}
): number {
  if (!hasStreamingSurface(state)) return 0;
  return getAssistantMessageFrameDesiredHeight({
    lines: [],
    blocks: streamingContentBlocks(state),
  }, width);
}

export function renderStreamingSurface(
  state: StreamingState | undefined,
  options: StreamingSurfaceRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0 || !hasStreamingSurface(state)) return [];

  const height = normalizeDimension(options.height ?? getStreamingSurfaceDesiredHeight(state, width));
  if (height <= 0) return [];

  return renderAssistantMessageFrame({
    lines: [],
    blocks: streamingContentBlocks(state),
  }, { width, height, style: options.style });
}

function streamingContentBlocks(state: StreamingState): readonly AssistantMessageFrameBlock[] {
  const blocks: AssistantMessageFrameBlock[] = [];
  const toolTrail = state.toolTrail ?? [];
  const emittedToolIds = new Set<string>();

  for (const segment of state.segments) {
    const textLines = normalizeStreamingText(segment.text);
    if (textLines.length > 0) {
      blocks.push({ kind: "text", lines: textLines });
    }
    const entries = toolTrail.filter((entry) => entry.afterSegmentId === segment.id);
    if (entries.length > 0) {
      blocks.push({ kind: "toolTrail", entries });
      for (const entry of entries) emittedToolIds.add(entry.id);
    }
  }

  const unanchoredEntries = toolTrail.filter((entry) => !emittedToolIds.has(entry.id));
  if (unanchoredEntries.length > 0) {
    blocks.push({ kind: "toolTrail", entries: unanchoredEntries });
  }

  const showCursor = state.showCursor ?? true;
  const tailLines = normalizeStreamingText(state.tail);
  if (tailLines.length > 0) {
    blocks.push({ kind: "text", lines: tailLines, cursor: showCursor });
  } else if (showCursor && !hasToolTrailBlocks(blocks)) {
    const lastTextIndex = findLastTextBlockIndex(blocks);
    if (lastTextIndex >= 0) {
      const block = blocks[lastTextIndex] as Extract<AssistantMessageFrameBlock, { readonly kind: "text" }>;
      blocks[lastTextIndex] = { ...block, cursor: true };
    }
  }

  return blocks;
}

function normalizeStreamingText(text: string): readonly string[] {
  if (text.length === 0) return [];
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  return lines.length === 0 ? [] : lines;
}

function hasToolTrailBlocks(blocks: readonly AssistantMessageFrameBlock[]): boolean {
  return blocks.some((block) => block.kind === "toolTrail" && block.entries.length > 0);
}

function findLastTextBlockIndex(blocks: readonly AssistantMessageFrameBlock[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.kind === "text") return index;
  }
  return -1;
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
