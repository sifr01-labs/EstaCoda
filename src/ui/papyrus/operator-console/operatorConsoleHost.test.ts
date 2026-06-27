import { describe, expect, it } from "vitest";
import { resolveTokens } from "../../../theme/token-resolver.js";
import { createLineEditorState } from "../../input/lineEditor.js";
import { stringWidth } from "../screen/stringWidth.js";
import {
  buildOperatorConsoleRawPromptFrame,
  buildOperatorConsoleRawPromptFrameWithRuntimeHost,
  buildOperatorConsoleStateFromRawPrompt,
  createOperatorConsoleRuntimeHost,
  createOperatorConsoleStyle,
  createPastedTextAttachment,
} from "./index.js";

describe("Papyrus operator console raw prompt host", () => {
  it("maps raw prompt text into PromptSurfaceState", () => {
    const state = buildOperatorConsoleStateFromRawPrompt({
      prompt: "> ",
      state: createLineEditorState("review the Papyrus rollout plan", 6),
      terminal: { width: 72, height: 24, isTty: true },
    });

    expect(state.prompt).toEqual({
      value: "review the Papyrus rollout plan",
      cursorOffset: 6,
      multiline: false,
      scrollOffset: 0,
      mode: "prompt",
    });
  });

  it("maps multiline prompt text into multiline prompt state", () => {
    const state = buildOperatorConsoleStateFromRawPrompt({
      prompt: "> ",
      state: createLineEditorState("write a migration plan for:\n- approval cards", 44),
    });

    expect(state.prompt.multiline).toBe(true);
    expect(state.prompt.value).toBe("write a migration plan for:\n- approval cards");
  });

  it("maps status into status rail state without adding persistent rail noise", () => {
    const state = buildOperatorConsoleStateFromRawPrompt({
      prompt: "> ",
      state: createLineEditorState("draft"),
      status: {
        model: { label: "kimi-k2.7-code", state: "working" },
        context: { usedTokens: 18400, totalTokens: 262000, percent: 7 },
        sessionTimer: { elapsedMs: 72_000 },
      },
    });

    expect(Object.keys(state.status)).toEqual(["model", "context", "sessionTimer"]);
    expect(state.status).toEqual({
      model: { label: "kimi-k2.7-code", state: "working" },
      context: { usedTokens: 18400, totalTokens: 262000, percent: 7 },
      sessionTimer: { elapsedMs: 72_000 },
    });
    expect(state.status).not.toHaveProperty("tools");
    expect(state.status).not.toHaveProperty("approvals");
    expect(state.status).not.toHaveProperty("workspace");
    expect(state.status).not.toHaveProperty("trust");
    expect(state.status).not.toHaveProperty("steering");
    expect(state.status).not.toHaveProperty("setup");
  });

  it("renders prompt box with status rail below", () => {
    const frame = buildOperatorConsoleRawPromptFrame({
      prompt: "> ",
      state: createLineEditorState("review the Papyrus rollout plan"),
      terminal: { width: 72, height: 12, isTty: true },
      status: {
        model: { label: "kimi-k2.7-code", state: "working" },
        context: { usedTokens: 18400, totalTokens: 262000, percent: 7 },
        sessionTimer: { elapsedMs: 72_000 },
      },
    });

    expect(frame.rows[0]).toMatch(/^─+$/u);
    expect(frame.rows).toContainEqual(expect.stringContaining("› review the Papyrus rollout plan"));
    expect(frame.rows.at(-1)).toBe("kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k 7% │ ◷ 01:12");
    expect(frame.rows.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("renders multiline prompt box with status rail below", () => {
    const frame = buildOperatorConsoleRawPromptFrame({
      prompt: "> ",
      state: createLineEditorState([
        "write a migration plan for:",
        "- approval cards",
        "- pasted attachments",
        "- tool activity",
      ].join("\n")),
      terminal: { width: 72, height: 24, isTty: true },
      status: {
        model: { label: "kimi-k2.7-code", state: "working" },
        context: { usedTokens: 18400, totalTokens: 262000, percent: 7 },
        sessionTimer: { elapsedMs: 72_000 },
      },
    });

    expect(frame.rows[0]).toMatch(/^─+$/u);
    expect(frame.rows).toContainEqual(expect.stringContaining("› write a migration plan for:"));
    expect(frame.rows).toContainEqual(expect.stringContaining("  - approval cards"));
    expect(frame.rows.at(-1)).toContain("◷ 01:12");
  });

  it("maps raw prompt slash state into a boxed slash menu above the status rail", () => {
    const frame = buildOperatorConsoleRawPromptFrame({
      prompt: "> ",
      state: createLineEditorState("/mo"),
      terminal: { width: 72, height: 12, isTty: true },
      slash: {
        query: "/mo",
        activeItemId: "slash.model",
        items: [
          { id: "slash.model", label: "/model", detail: "show or change active model route" },
          { id: "slash.model.setup", label: "/model setup", detail: "configure provider/model credentials" },
        ],
      },
    });
    const promptIndex = frame.rows.findIndex((line) => line.includes("› /mo"));
    const slashIndex = frame.rows.findIndex((line) => line.includes("Commands"));
    const statusIndex = frame.rows.findIndex((line) => line.includes("◷ 00:00"));

    expect(frame.state.slash?.query).toBe("/mo");
    expect(frame.state.slash?.items).toHaveLength(2);
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(slashIndex).toBeGreaterThan(promptIndex);
    expect(statusIndex).toBeGreaterThan(slashIndex);
    expect(frame.rows).toContainEqual(expect.stringContaining("❯ /model  show or change active model route"));
    expect(frame.rows.at(-1)).not.toMatch(/\b(slash|model setup|Commands)\b/iu);
    expect(frame.rows.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("maps raw prompt attachments into state and renders them above the prompt without status pollution", () => {
    const attachment = createPastedTextAttachment({
      id: "paste-1",
      content: "OPENAI_API_KEY=super-secret-value\ncontext after secret",
    });
    const frame = buildOperatorConsoleRawPromptFrame({
      prompt: "> ",
      state: createLineEditorState("summarize this"),
      terminal: { width: 80, height: 16, isTty: true },
      status: {
        model: { label: "kimi-k2.7-code", state: "working" },
        context: { usedTokens: 18400, totalTokens: 262000, percent: 7 },
        sessionTimer: { elapsedMs: 72_000 },
      },
      attachments: [attachment],
    });
    const attachmentIndex = frame.rows.findIndex((line) => line === "Attachments");
    const promptIndex = frame.rows.findIndex((line) => line.includes("› summarize this"));
    const status = frame.rows.at(-1) ?? "";
    const text = frame.rows.join("\n");

    expect(frame.state.attachments).toEqual([attachment]);
    expect(frame.state.attachments[0]?.content).toContain("super-secret-value");
    expect(attachmentIndex).toBeGreaterThanOrEqual(0);
    expect(attachmentIndex).toBeLessThan(promptIndex);
    expect(text).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(text).not.toContain("super-secret-value");
    expect(status).toContain("kimi-k2.7-code");
    expect(status).not.toMatch(/\b(attachment|pasted text|OPENAI_API_KEY|secret)\b/iu);
  });

  it("is deterministic and emits no ANSI or cursor-control sequences", () => {
    const input = {
      prompt: "> ",
      state: createLineEditorState("draft"),
      terminal: { width: 40, height: 8, isTty: true },
    };
    const first = buildOperatorConsoleRawPromptFrame(input);
    const second = buildOperatorConsoleRawPromptFrame(input);
    const output = first.rows.join("\n");

    expect(first).toEqual(second);
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\\x1b");
    expect(output).not.toContain("\\u001b");
    expect(output).not.toContain("\\033");
    expect(output).not.toMatch(/\b(moveCursor|clearLine|clearScreenDown|cursorTo|setRawMode)\b/u);
    expect(first.rows.every((line) => stringWidth(line) <= 40)).toBe(true);
  });

  it("preserves a shared runtime host style when a refresh snapshot omits style", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const host = createOperatorConsoleRuntimeHost({
      style,
      terminal: { width: 72, height: 12, isTty: true },
    });

    const frame = buildOperatorConsoleRawPromptFrameWithRuntimeHost(host, {
      prompt: "> ",
      state: createLineEditorState("draft"),
      terminal: { width: 72, height: 12, isTty: true },
      status: {
        model: { label: "kimi-k2.7-code", state: "idle", route: "fallback" },
        context: { usedTokens: 18400, totalTokens: 262000, percent: 7 },
        sessionTimer: { elapsedMs: 72_000 },
      },
    });

    expect(frame.state.style).toBe(style);
    expect(frame.rows.join("\n")).toContain(`${ansiFg(tokens.contract.palette.caution)}○\x1b[0m`);
  });
});

function ansiFg(hex: string): string {
  const clean = hex.replace("#", "");
  const value = Number.parseInt(clean, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `\x1b[38;2;${r};${g};${b}m`;
}
