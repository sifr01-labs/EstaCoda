import {
  truncateVisible,
  wrapText,
} from "../../renderers/layout.js";
import { stringWidth } from "../screen/stringWidth.js";
import { renderAssistantMessageFrame } from "./assistantMessageFrame.js";
import type { TranscriptBlock } from "./operatorConsoleState.js";
import {
  styleBold,
  styleColor,
  type OperatorConsoleStyle,
} from "./operatorConsoleStyle.js";
import type { OperatorConsoleLocale } from "./activeWorkCopy.js";
import type {
  TaskCompletionTraceCategory,
  TaskCompletionTraceOutcome,
} from "../../../contracts/task-completion-trace.js";
import { renderTaskCompletionTrace } from "../../task-completion-trace.js";

export type TranscriptSurfaceRenderOptions = {
  readonly width: number;
  readonly height?: number;
  readonly locale?: OperatorConsoleLocale;
  readonly style?: OperatorConsoleStyle;
};

const ROLE_LABELS: Record<TranscriptBlock["role"], string> = {
  startup: "Startup",
  user: "User",
  assistant: "Assistant",
  system: "System",
  tool: "Tool",
  approval: "Approval",
  summary: "Summary",
};

export function getTranscriptSurfaceDesiredHeight(
  transcript: readonly TranscriptBlock[],
  width: number,
  locale: OperatorConsoleLocale = "en"
): number {
  if (transcript.length === 0) return 0;
  return renderTranscriptRows(transcript, normalizeDimension(width), undefined, locale).length;
}

export function renderTranscriptSurface(
  transcript: readonly TranscriptBlock[],
  options: TranscriptSurfaceRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0 || transcript.length === 0) return [];

  const rows = renderTranscriptRows(transcript, width, options.style, options.locale ?? "en");
  const height = normalizeDimension(options.height ?? rows.length);
  if (height <= 0) return [];
  return renderLatestTranscriptRows(transcript, width, height, options.style, options.locale ?? "en");
}

function renderTranscriptRows(
  transcript: readonly TranscriptBlock[],
  width: number,
  style: OperatorConsoleStyle | undefined,
  locale: OperatorConsoleLocale
): readonly string[] {
  if (width <= 0) return [];
  return transcript.flatMap((block) => renderTranscriptBlockRows(block, width, undefined, style, locale));
}

function renderTranscriptBlockRows(
  block: TranscriptBlock,
  width: number,
  height?: number,
  style?: OperatorConsoleStyle,
  locale: OperatorConsoleLocale = "en"
): readonly string[] {
  if (block.role === "assistant") {
    const renderAnswer = (answerHeight?: number) => renderAssistantMessageFrame({
      lines: normalizeTranscriptText(block.text),
      toolTrail: block.toolTrail,
    }, {
      width,
      height: answerHeight,
      style,
    });
    if (block.taskTrace === undefined) return renderAnswer(height);
    const trace = renderTaskCompletionTrace(block.taskTrace, {
      width,
      locale,
      useUnicode: style?.tokens.mode !== "plain",
      style: completionTraceStyle(style),
    });
    if (height === undefined) return [...trace, "".padEnd(width), ...renderAnswer()];
    if (height <= trace.length) return trace.slice(0, height);
    const answerHeight = Math.max(0, height - trace.length - 1);
    return [
      ...trace,
      ...Array.from({ length: height > trace.length ? 1 : 0 }, () => "".padEnd(width)),
      ...(answerHeight === 0 ? [] : renderAnswer(answerHeight)),
    ].slice(0, height);
  }

  const label = `${ROLE_LABELS[block.role] ?? block.role}`;
  const prefix = `${label} │ `;
  const continuationPrefix = `${" ".repeat(stringWidth(label))} │ `;
  const contentWidth = Math.max(1, width - stringWidth(prefix));
  const lines = normalizeTranscriptText(block.text).flatMap((line) => wrapText(line, contentWidth));
  if (lines.length === 0) return [truncateVisible(prefix.trimEnd(), width)];
  return lines.map((line, index) => truncateVisible(`${index === 0 ? prefix : continuationPrefix}${line}`, width));
}

function renderLatestTranscriptRows(
  transcript: readonly TranscriptBlock[],
  width: number,
  height: number,
  style: OperatorConsoleStyle | undefined,
  locale: OperatorConsoleLocale
): readonly string[] {
  const selected: string[][] = [];
  let remaining = height;

  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const fullRows = renderTranscriptBlockRows(transcript[index]!, width, undefined, style, locale);
    const rows = selected.length === 0 && fullRows.length > remaining
      ? renderTranscriptBlockRows(transcript[index]!, width, remaining, style, locale)
      : fullRows;
    if (rows.length === 0) continue;
    if (rows.length > remaining) {
      if (selected.length === 0) {
        return rows.slice(Math.max(0, rows.length - height));
      }
      break;
    }
    selected.unshift([...rows]);
    remaining -= rows.length;
    if (remaining <= 0) break;
  }

  return selected.flat();
}

function completionTraceStyle(style: OperatorConsoleStyle | undefined) {
  const tokens = style?.tokens.contract;
  if (tokens === undefined) return undefined;
  return {
    accent: (text: string) => styleColor(style, styleBold(style, text), tokens.palette.accent),
    muted: (text: string) => styleColor(style, text, tokens.text.muted),
    outcome: (text: string, outcome: TaskCompletionTraceOutcome) => styleColor(
      style,
      styleBold(style, text),
      outcome === "complete"
        ? tokens.severity.ok
        : outcome === "failed"
          ? tokens.severity.error
          : tokens.severity.warn
    ),
    span: (text: string, category: TaskCompletionTraceCategory) => styleColor(
      style,
      text,
      completionTraceColor(category, tokens)
    ),
  };
}

function completionTraceColor(
  category: TaskCompletionTraceCategory,
  tokens: NonNullable<OperatorConsoleStyle["tokens"]>["contract"]
): string {
  if (category === "plan") return tokens.trace.plan;
  if (category === "search") return tokens.trace.search;
  if (category === "read") return tokens.trace.read;
  if (category === "execute") return tokens.palette.caution;
  if (category === "write") return tokens.trace.answer;
  if (category === "validate" || category === "deliver") return tokens.trace.finish;
  if (category === "wait") return tokens.text.muted;
  if (category === "retry") return tokens.severity.warn;
  return tokens.trace.failed;
}

function normalizeTranscriptText(text: string): readonly string[] {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  return lines.length === 0 ? [""] : lines;
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
