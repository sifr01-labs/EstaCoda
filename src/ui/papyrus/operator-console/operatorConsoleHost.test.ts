import { describe, expect, it } from "vitest";
import { createLineEditorState } from "../../input/lineEditor.js";
import { stringWidth } from "../screen/stringWidth.js";
import {
  buildOperatorConsoleRawPromptFrame,
  buildOperatorConsoleStateFromRawPrompt,
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

    expect(frame.rows[0]).toContain("Prompt");
    expect(frame.rows).toContainEqual(expect.stringContaining("› review the Papyrus rollout plan"));
    expect(frame.rows.at(-1)).toBe("kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k 7% │ session 01:12");
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

    expect(frame.rows[0]).toContain("Prompt · multiline");
    expect(frame.rows).toContainEqual(expect.stringContaining("› write a migration plan for:"));
    expect(frame.rows).toContainEqual(expect.stringContaining("  - approval cards"));
    expect(frame.rows.at(-1)).toContain("session 01:12");
  });

  it("keeps slash overlay rows above the status rail", () => {
    const frame = buildOperatorConsoleRawPromptFrame({
      prompt: "> ",
      state: createLineEditorState("/h"),
      terminal: { width: 72, height: 12, isTty: true },
      overlayRows: [{ text: "> /help - Show help" }],
    });
    const promptIndex = frame.rows.findIndex((line) => line.includes("Prompt"));
    const overlayIndex = frame.rows.findIndex((line) => line.includes("/help"));
    const statusIndex = frame.rows.findIndex((line) => line.includes("session 00:00"));

    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(overlayIndex).toBeGreaterThan(promptIndex);
    expect(statusIndex).toBeGreaterThan(overlayIndex);
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
    const promptIndex = frame.rows.findIndex((line) => line.includes("Prompt"));
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
});
