import { describe, expect, it } from "vitest";
import { resolveTokens } from "../../../theme/token-resolver.js";
import { stringWidth } from "../screen/stringWidth.js";
import {
  createOperatorConsoleStyle,
  createInitialOperatorConsoleState,
  createOperatorConsoleLayout,
  renderOperatorConsoleLines,
  renderOperatorConsoleTextLines,
  type OperatorConsoleState,
} from "./index.js";

describe("Papyrus operator console renderer", () => {
  it("returns deterministic output for the same state and layout", () => {
    const state = createState();
    const layout = createOperatorConsoleLayout(state, { width: 60, height: 8, isTty: true });

    expect(renderOperatorConsoleTextLines(state, layout)).toEqual(renderOperatorConsoleTextLines(state, layout));
  });

  it("returns deterministic output for attachment renders", () => {
    const state = createFullState();
    const layout = createOperatorConsoleLayout(state, { width: 120, height: 20, isTty: true });

    expect(renderOperatorConsoleTextLines(state, layout)).toEqual(renderOperatorConsoleTextLines(state, layout));
  });

  it("emits no ANSI escape sequences", () => {
    const output = renderOperatorConsoleTextLines(
      createFullState(),
      createOperatorConsoleLayout(createFullState(), { width: 80, height: 20, isTty: true })
    ).join("\n");

    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\\x1b");
    expect(output).not.toContain("\\u001b");
    expect(output).not.toContain("\\033");
  });

  it("emits no terminal cursor control sequences", () => {
    const output = renderOperatorConsoleTextLines(
      createFullState(),
      createOperatorConsoleLayout(createFullState(), { width: 80, height: 20, isTty: true })
    ).join("\n");

    expect(output).not.toMatch(/\b(moveCursor|clearLine|clearScreenDown|cursorTo|setRawMode)\b/);
    expect(output).not.toMatch(/\[[0-9;?]*[A-Za-z]/);
  });

  it("renders prompt before status rail", () => {
    const state = createState();
    const layout = createOperatorConsoleLayout(state, { width: 80, height: 8, isTty: true });
    const output = renderOperatorConsoleTextLines(state, layout);

    expect(output[0]?.trim()).toBe("");
    expect(output.at(-1)).toContain("◷ 00:00");
  });

  it("renders minimal prompt frame and status rail for minimal state", () => {
    const state = createState();
    const layout = createOperatorConsoleLayout(state, { width: 80, height: 8, isTty: true });

    const output = renderOperatorConsoleTextLines(state, layout);
    expect(output[0]?.trim()).toBe("");
    expect(output[1]).toContain("›");
    expect(output[2]?.trim()).toBe("");
    expect(output[3]).toContain("model pending ● · ctx [··········] --");
    expect(output[3]?.endsWith("· ◷ 00:00")).toBe(true);
  });

  it("renders multiline prompt expansion with status rail below", () => {
    const state = createState({
      prompt: {
        value: [
          "write a migration plan for:",
          "- approval cards",
          "- pasted attachments",
          "- tool activity",
        ].join("\n"),
        cursorOffset: "write a migration plan for:\n- approval cards\n- pasted attachments\n- tool activity".length,
        multiline: true,
        scrollOffset: 0,
        mode: "prompt",
      },
      status: {
        model: { label: "kimi-k2.7-code", state: "working" },
        context: { usedTokens: 18400, totalTokens: 262000, percent: 7 },
        sessionTimer: { elapsedMs: 72_000 },
      },
    });
    const layout = createOperatorConsoleLayout(state, { width: 72, height: 20, isTty: true });

    const output = renderOperatorConsoleTextLines(state, layout);
    expect(output[0]?.trim()).toBe("");
    expect(output).toContainEqual(expect.stringContaining("› write a migration plan for:"));
    expect(output).toContainEqual(expect.stringContaining("  - approval cards"));
    expect(output.at(-1)).toContain("kimi-k2.7-code ● · ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k");
    expect(output.at(-1)?.endsWith("· ◷ 01:12")).toBe(true);
    expect(output.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("renders startup dashboard above the prompt and status rail when present", () => {
    const state = createState({
      startup: startupDashboard(),
      status: {
        model: { label: "kimi-k2.7-code", state: "working" },
        context: { usedTokens: 18400, totalTokens: 262000, percent: 7 },
        sessionTimer: { elapsedMs: 72_000 },
      },
    });
    const output = renderOperatorConsoleTextLines(
      state,
      createOperatorConsoleLayout(state, { width: 80, height: 24, isTty: true })
    );
    const startupIndex = output.findIndex((line) => line.includes("EstaCoda"));
    const promptIndex = output.findIndex((line) => line.includes("›"));
    const statusIndex = output.findIndex((line) => line.includes("◷ 01:12"));

    expect(startupIndex).toBeGreaterThanOrEqual(0);
    expect(output).toContainEqual(expect.stringContaining("⟡ SIFR01 ⟡"));
    expect(output).toContainEqual(expect.stringContaining("Session"));
    expect(output).toContainEqual(expect.stringContaining("Commands"));
    expect(output).toContainEqual(expect.stringContaining("/setup"));
    expect(promptIndex).toBeGreaterThan(startupIndex);
    expect(statusIndex).toBeGreaterThan(promptIndex);
    expect(output.every((line) => stringWidth(line) <= 80)).toBe(true);
  });

  it("renders setup panel shell above the prompt deterministically", () => {
    const state = createState({
      setupPanel: setupPanel(),
    });
    const layout = createOperatorConsoleLayout(state, { width: 72, height: 26, isTty: true });
    const first = renderOperatorConsoleTextLines(state, layout);
    const second = renderOperatorConsoleTextLines(state, layout);
    const setupIndex = first.findIndex((line) => line.includes("Provider"));
    const promptIndex = first.findIndex((line) => line.includes("›"));

    expect(first).toEqual(second);
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(first).toContainEqual(expect.stringContaining("gpt-5.5"));
    expect(first).toContainEqual(expect.stringContaining("↑↓ navigate"));
    expect(promptIndex).toBeGreaterThan(setupIndex);
    expect(first.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("renders only setup-owned surfaces in setup mode", () => {
    const state = createFullState({
      mode: "setup",
      setupPanel: setupPanel(),
    });
    const layout = createOperatorConsoleLayout(state, { width: 72, height: 26, isTty: true });
    const output = renderOperatorConsoleTextLines(state, layout);
    const text = output.join("\n");

    expect(text).toContain("Model Route");
    expect(text).toContain("gpt-5.5");
    expect(text).toContain("↑↓ navigate");
    expect(text).not.toContain("›");
    expect(text).not.toContain("ctx");
    expect(text).not.toContain("◷");
    expect(text).not.toContain("Ready.");
    expect(text).not.toContain("Running tools");
    expect(text).not.toContain("Attachments");
    expect(output.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("renders Arabic setup mode without session prompt or status rail", () => {
    const state = createState({
      mode: "setup",
      setupPanel: arabicSetupPanel(),
    });
    const layout = createOperatorConsoleLayout(state, { width: 80, height: 18, isTty: true });
    const output = renderOperatorConsoleTextLines(state, layout);
    const text = output.join("\n");

    expect(text).toContain("إعداد النموذج");
    expect(text).toContain("OpenAI");
    expect(text).toContain("gpt-5.5");
    expect(text).toContain("◂");
    expect(text).not.toContain("›");
    expect(text).not.toContain("ctx");
    expect(text).not.toContain("◷");
    expect(output.every((line) => stringWidth(line) <= 80)).toBe(true);
  });

  it("renders attachments above steer input and status rail", () => {
    const state = createFullState();
    const layout = createOperatorConsoleLayout(state, { width: 120, height: 20, isTty: true });
    const output = renderOperatorConsoleTextLines(state, layout);

    expect(output[0]).toContain("EstaCoda");
    expect(output).toContainEqual(expect.stringContaining("Ready."));
    expect(output).not.toContainEqual(expect.stringContaining("Running tools"));
    expect(output).toContain("Attachments");
    expect(output.findIndex((line) => line === "Attachments")).toBeLessThan(
      output.findIndex((line) => line.includes("Steer current turn"))
    );
    expect(output.at(-1)).toContain("◷ 01:12");
    expect(output.every((line) => stringWidth(line) <= 120)).toBe(true);
  });

  it("renders streaming segments and live tail between transcript and turn activity", () => {
    const state = createState({
      transcript: [{ id: "t1", role: "assistant", text: "Ready." }],
      streaming: {
        segments: [{
          id: "segment-1",
          role: "assistant",
          text: "I am reading the operator console path.",
        }],
        tail: "Now checking the layout",
        isStreaming: true,
        toolTrail: [{
          id: "read-1",
          sequence: 1,
          toolName: "read_file",
          status: "running",
          summary: "src/ui/papyrus/operator-console",
          target: "src/ui/papyrus/operator-console",
          durationMs: 3_000,
          afterSegmentId: "segment-1",
        }],
      },
      activeWork: {
        startedAtMs: 0,
        updatedAtMs: 33_000,
        scrollOffset: 0,
        expanded: false,
        items: [
          {
            id: "read-1",
            toolName: "read_file",
            status: "running",
            summary: "src/ui/papyrus/operator-console",
            target: "src/ui/papyrus/operator-console",
          },
          {
            id: "glob-1",
            toolName: "glob",
            status: "succeeded",
            summary: "**/*.ts",
            target: "**/*.ts",
          },
        ],
      },
      turnActivity: { phase: "provider" },
    });
    const rendered = renderOperatorConsoleLines(
      state,
      createOperatorConsoleLayout(state, { width: 80, height: 18, isTty: true })
    );
    const output = rendered.map((line) => line.text);
    const transcriptIndex = rendered.findIndex((line) => line.region === "transcript");
    const streamingIndex = rendered.findIndex((line) => line.region === "streaming");
    const tailIndex = output.findIndex((line) => line.includes("Now checking the layout"));
    const turnActivityIndex = rendered.findIndex((line) => line.region === "turnActivity");

    expect(streamingIndex).toBeGreaterThan(transcriptIndex);
    expect(tailIndex).toBeGreaterThan(streamingIndex);
    expect(turnActivityIndex).toBeGreaterThan(streamingIndex);
    expect(output).toContainEqual(expect.stringContaining("I am reading the operator console path."));
    expect(output).toContainEqual(expect.stringContaining("◷ read_file"));
    expect(output).toContainEqual(expect.stringContaining("Now checking the layout"));
    expect(output).toContainEqual(expect.stringContaining("Now checking the layout▍"));
    expect(output).toContainEqual(expect.stringContaining("scribbling · 1 active · 1 done · 00:33"));
    expect(output.join("\n")).not.toContain("Running tools");
    expect(output.join("\n")).not.toContain("Assistant stream");
    expect(output.join("\n")).not.toContain("assistant:");
    expect(output.every((line) => stringWidth(line) <= 80)).toBe(true);
  });

  it("threads style to assistant transcript and streaming frame titles", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const state = createState({
      style,
      transcript: [{ id: "t1", role: "assistant", text: "Ready." }],
      streaming: {
        segments: [{
          id: "segment-1",
          role: "assistant",
          text: "Reading the stream path.",
        }],
        tail: "Checking frame style",
        isStreaming: true,
      },
    });
    const rendered = renderOperatorConsoleLines(
      state,
      createOperatorConsoleLayout(state, { width: 80, height: 18, isTty: true })
    );
    const transcriptTitle = rendered.find((line) => line.region === "transcript" && line.text.includes("EstaCoda"))?.text ?? "";
    const streamingTitle = rendered.find((line) => line.region === "streaming" && line.text.includes("EstaCoda"))?.text ?? "";

    expect(transcriptTitle).toContain(ansiFg(tokens.contract.palette.brand));
    expect(streamingTitle).toContain(ansiFg(tokens.contract.palette.brand));
    expect(transcriptTitle).toContain("𓂀  EstaCoda");
    expect(streamingTitle).toContain("𓂀  EstaCoda");
  });

  it("does not render inactive streaming state", () => {
    const state = createState({
      streaming: {
        segments: [{
          id: "segment-1",
          role: "assistant",
          text: "hidden inactive segment",
        }],
        tail: "hidden inactive tail",
        isStreaming: false,
      },
    });
    const output = renderOperatorConsoleTextLines(
      state,
      createOperatorConsoleLayout(state, { width: 80, height: 12, isTty: true })
    ).join("\n");

    expect(output).not.toContain("Assistant stream");
    expect(output).not.toContain("hidden inactive");
  });

  it("renders approval cards above attachments, prompt, and status rail", () => {
    const state = createState({
      approvals: [{
        id: "approval-1",
        status: "pending",
        action: "write file",
        target: "src/runtime/provider-turn-loop.ts",
        risk: "runtime behavior change",
      }],
      activeWork: {
        items: [{
          id: "tool-1",
          toolName: "read_file",
          status: "running",
          summary: "src/cli/session-loop.ts",
          target: "src/cli/session-loop.ts",
          durationMs: 1_000,
        }],
        scrollOffset: 0,
        expanded: false,
      },
      attachments: [{
        id: "paste-1",
        kind: "pastedText",
        title: "pasted text",
        preview: "MVP known issue",
        content: "MVP known issue details",
        metadata: { chars: 2_481 },
      }],
      status: {
        model: { label: "kimi-k2.7-code", state: "working" },
        context: { usedTokens: 18400, totalTokens: 262000, percent: 7 },
        sessionTimer: { elapsedMs: 72_000 },
      },
    });
    const output = renderOperatorConsoleTextLines(
      state,
      createOperatorConsoleLayout(state, { width: 120, height: 24, isTty: true })
    );
    const approvalIndex = output.findIndex((line) => line.includes("Approval required"));
    const attachmentsIndex = output.findIndex((line) => line === "Attachments");
    const promptIndex = output.findIndex((line) => line.includes("›"));
    const statusIndex = output.findIndex((line) => line.includes("◷ 01:12"));

    expect(approvalIndex).toBeGreaterThanOrEqual(0);
    expect(output).not.toContainEqual(expect.stringContaining("Running tools"));
    expect(approvalIndex).toBeLessThan(attachmentsIndex);
    expect(approvalIndex).toBeLessThan(promptIndex);
    expect(approvalIndex).toBeLessThan(statusIndex);
    expect(output).toContainEqual(expect.stringContaining("[Approve once]"));
    expect(output.every((line) => stringWidth(line) <= 120)).toBe(true);
  });

  it("includes approval card output deterministically without mutating state", () => {
    const state = createState({
      approvals: [{
        id: "approval-1",
        status: "pending",
        action: "write file",
        target: "src/runtime/provider-turn-loop.ts",
        risk: "runtime behavior change",
        focusedControl: "reject",
      }],
    });
    const before = JSON.stringify(state);
    const layout = createOperatorConsoleLayout(state, { width: 72, height: 12, isTty: true });
    const first = renderOperatorConsoleTextLines(state, layout);
    const second = renderOperatorConsoleTextLines(state, layout);

    expect(first).toEqual(second);
    expect(first).toContainEqual(expect.stringContaining("Approval required"));
    expect(first).toContainEqual(expect.stringContaining("Approve once        ❯ Reject        Inspect"));
    expect(first.every((line) => stringWidth(line) <= 72)).toBe(true);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("places queued steer above attachments, steer input, and status rail when present", () => {
    const state = createFullState();
    const layout = createOperatorConsoleLayout(state, { width: 120, height: 20, isTty: true });
    const output = renderOperatorConsoleTextLines(state, layout);
    const queuedSteerIndex = output.findIndex((line) => line.includes("Queued steer"));
    const attachmentsIndex = output.findIndex((line) => line === "Attachments");
    const steerInputIndex = output.findIndex((line) => line.includes("Steer current turn"));
    const statusIndex = output.findIndex((line) => line.includes("◷ 01:12"));

    expect(output).not.toContainEqual(expect.stringContaining("Running tools"));
    expect(queuedSteerIndex).toBeGreaterThanOrEqual(0);
    expect(queuedSteerIndex).toBeLessThan(attachmentsIndex);
    expect(queuedSteerIndex).toBeLessThan(steerInputIndex);
    expect(queuedSteerIndex).toBeLessThan(statusIndex);
  });

  it("renders queued steer above steer input and keeps status rail below it", () => {
    const state = createState({
      steer: {
        draft: "",
        cursorOffset: 0,
        mode: "queued",
        queued: {
          id: "steer-1",
          text: "focus only on approval cards and pasted attachments",
          status: "queued",
        },
      },
      status: {
        model: { label: "kimi-k2.7-code", state: "working" },
        context: { usedTokens: 18400, totalTokens: 262000, percent: 7 },
        sessionTimer: { elapsedMs: 31_000 },
      },
    });
    const output = renderOperatorConsoleTextLines(
      state,
      createOperatorConsoleLayout(state, { width: 72, height: 12, isTty: true })
    );
    const queuedSteerIndex = output.findIndex((line) => line.includes("Queued steer"));
    const steerInputIndex = output.findIndex((line) => line.includes("Steer current turn"));
    const statusIndex = output.findIndex((line) => line.includes("◷ 00:31"));

    expect(queuedSteerIndex).toBeGreaterThanOrEqual(0);
    expect(queuedSteerIndex).toBeLessThan(steerInputIndex);
    expect(steerInputIndex).toBeLessThan(statusIndex);
    expect(output).toContainEqual(expect.stringContaining("Will apply at next safe boundary · Esc cancel"));
    expect(output).not.toContainEqual(expect.stringContaining("Prompt"));
    expect(output.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("does not render applied or cancelled queued steer cards", () => {
    for (const statusValue of ["applied", "cancelled"] as const) {
      const state = createState({
        steer: {
          draft: "",
          cursorOffset: 0,
          mode: "queued",
          queued: {
            id: `steer-${statusValue}`,
            text: "focus only on approvals",
            status: statusValue,
          },
        },
        status: {
          model: { label: "kimi-k2.7-code", state: "working" },
          context: { usedTokens: 18400, totalTokens: 262000, percent: 7 },
          sessionTimer: { elapsedMs: 31_000 },
        },
      });
      const output = renderOperatorConsoleTextLines(
        state,
        createOperatorConsoleLayout(state, { width: 72, height: 10, isTty: true })
      );

      expect(output).not.toContainEqual(expect.stringContaining("Queued steer"));
      expect(output.at(-1)).toContain("kimi-k2.7-code ● · ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k");
      expect(output.at(-1)?.endsWith("· ◷ 00:31")).toBe(true);
      expect(output.every((line) => stringWidth(line) <= 72)).toBe(true);
    }
  });

  it("keeps status rail limited to model, context, and timer while steer is active", () => {
    const state = createState({
      steer: {
        draft: "focus only on approvals",
        cursorOffset: 23,
        mode: "drafting",
      },
      status: {
        model: { label: "kimi-k2.7-code", state: "working" },
        context: { usedTokens: 18400, totalTokens: 262000, percent: 7 },
        sessionTimer: { elapsedMs: 31_000 },
      },
    });
    const output = renderOperatorConsoleTextLines(
      state,
      createOperatorConsoleLayout(state, { width: 72, height: 8, isTty: true })
    );
    const status = output.at(-1) ?? "";

    expect(status).toContain("kimi-k2.7-code ● · ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k");
    expect(status.endsWith("· ◷ 00:31")).toBe(true);
    expect(status).not.toMatch(/\b(steer|approval|attachment|tool|workspace|trust|setup|channel)\b/iu);
  });

  it("renders steer draft instead of prompt when steering is active", () => {
    const state = createState({
      steer: {
        draft: "focus only on approval cards and pasted attachments",
        cursorOffset: 51,
        mode: "drafting",
      },
      status: {
        model: { label: "kimi-k2.7-code", state: "working" },
        context: { usedTokens: 18400, totalTokens: 262000, percent: 7 },
        sessionTimer: { elapsedMs: 31_000 },
      },
    });
    const output = renderOperatorConsoleTextLines(
      state,
      createOperatorConsoleLayout(state, { width: 72, height: 8, isTty: true })
    );
    const steerInputIndex = output.findIndex((line) => line.includes("Steer current turn"));
    const statusIndex = output.findIndex((line) => line.includes("◷ 00:31"));

    expect(steerInputIndex).toBeGreaterThanOrEqual(0);
    expect(output).not.toContainEqual(expect.stringContaining("Prompt"));
    expect(output).toContainEqual(expect.stringContaining("› focus only on approval cards"));
    expect(statusIndex).toBeGreaterThan(steerInputIndex);
    expect(output.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("does not reserve active work rows when active work is empty", () => {
    const state = createState();
    const layout = createOperatorConsoleLayout(state, { width: 80, height: 8, isTty: true });
    const output = renderOperatorConsoleTextLines(state, layout);

    expect(output).not.toContainEqual(expect.stringContaining("Running tools"));
    expect(output[0]?.trim()).toBe("");
  });

  it("does not reserve attachment rows when attachments are absent", () => {
    const state = createState();
    const layout = createOperatorConsoleLayout(state, { width: 80, height: 8, isTty: true });
    const output = renderOperatorConsoleTextLines(state, layout);

    expect(output).not.toContain("Attachments");
    expect(output[0]?.trim()).toBe("");
  });

  it("renders slash menu between prompt and status rail", () => {
    const state = createState({
      prompt: {
        value: "/mo",
        cursorOffset: 3,
        multiline: false,
        scrollOffset: 0,
        mode: "prompt",
      },
      slash: {
        query: "/mo",
        activeItemId: "slash.model",
        items: [
          { id: "slash.model", label: "/model", detail: "show or change active model route" },
          { id: "slash.model.setup", label: "/model setup", detail: "configure provider/model credentials" },
        ],
      },
    });
    const output = renderOperatorConsoleTextLines(
      state,
      createOperatorConsoleLayout(state, { width: 72, height: 10, isTty: true })
    );
    const promptIndex = output.findIndex((line) => line.includes("› /mo"));
    const slashIndex = output.findIndex((line) => line.includes("Commands"));
    const statusIndex = output.findIndex((line) => line.includes("◷ 00:00"));

    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(slashIndex).toBeGreaterThan(promptIndex);
    expect(statusIndex).toBeGreaterThan(slashIndex);
    expect(output).toContainEqual(expect.stringContaining("❯ /model        show or change active model route"));
    expect(output.every((line) => stringWidth(line) <= 72)).toBe(true);
    expect(output.at(-1)).not.toMatch(/\b(slash|Commands|model setup)\b/iu);
  });

  it("keeps rendered line widths within the terminal width", () => {
    const state = createFullState();
    const layout = createOperatorConsoleLayout(state, { width: 20, height: 20, isTty: true });
    const output = renderOperatorConsoleTextLines(state, layout);

    expect(output.length).toBeGreaterThan(0);
    expect(output.every((line) => stringWidth(line) <= 20)).toBe(true);
  });

  it("does not render hidden regions", () => {
    const state = createFullState();
    const layout = createOperatorConsoleLayout(state, { width: 80, height: 2, isTty: true });

    const output = renderOperatorConsoleTextLines(state, layout);
    expect(output[0]).toBe("Steer: >");
    expect(output[1]).toContain("kimi-k2.7-code ● · ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k");
    expect(output[1]?.endsWith("· ◷ 01:12")).toBe(true);
  });

  it("keeps prompt and status visible under constrained layout", () => {
    const state = createFullState();
    const layout = createOperatorConsoleLayout(state, { width: 80, height: 2, isTty: true });
    const output = renderOperatorConsoleTextLines(state, layout);

    expect(output).toHaveLength(2);
    expect(output[0]).toContain("Steer:");
    expect(output[1]).toContain("◷ 01:12");
  });

  it("hidden optional regions do not affect prompt and status render", () => {
    const state = createFullState();
    const constrained = createOperatorConsoleLayout(state, { width: 80, height: 2, isTty: true });
    const withoutOptional = createOperatorConsoleLayout(createState({
      prompt: state.prompt,
      status: state.status,
      steer: state.steer,
    }), { width: 80, height: 2, isTty: true });

    expect(renderOperatorConsoleTextLines(state, constrained)).toEqual(
      renderOperatorConsoleTextLines(createState({
        prompt: state.prompt,
        status: state.status,
        steer: state.steer,
      }), withoutOptional)
    );
  });

  it("does not mutate state", () => {
    const state = createFullState();
    const snapshot = JSON.stringify(state);
    const layout = createOperatorConsoleLayout(state, { width: 80, height: 20, isTty: true });

    renderOperatorConsoleTextLines(state, layout);

    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

function createState(input: Partial<OperatorConsoleState> = {}): OperatorConsoleState {
  return createInitialOperatorConsoleState({
    terminal: { width: 80, height: 24, isTty: true },
    ...input,
  });
}

function createFullState(input: Partial<OperatorConsoleState> = {}): OperatorConsoleState {
  return createState({
    transcript: [{ id: "t1", role: "assistant", text: "Ready." }],
    prompt: {
      value: "tell EstaCoda what to do",
      cursorOffset: 26,
      multiline: false,
      scrollOffset: 0,
      mode: "prompt",
    },
    status: {
      model: { label: "kimi-k2.7-code", state: "working" },
      context: { usedTokens: 18400, totalTokens: 262000, percent: 7 },
      sessionTimer: { elapsedMs: 72_000 },
    },
    activeWork: {
      items: [{
        id: "tool-1",
        toolName: "read_file",
        status: "running",
        summary: "src/cli/session-loop.ts",
        target: "src/cli/session-loop.ts",
        durationMs: 1_000,
      }],
      scrollOffset: 0,
      expanded: true,
    },
    steer: {
      draft: "",
      cursorOffset: 0,
      mode: "queued",
      queued: {
        id: "steer-1",
        text: "focus on approvals",
        status: "queued",
      },
    },
    attachments: [{
      id: "paste-1",
      kind: "pastedText",
      title: "pasted text",
      preview: "MVP known issue",
      content: "MVP known issue details",
      metadata: { chars: 2_481 },
    }],
    slash: {
      query: "/mo",
      items: [{ id: "model", label: "/model" }],
    },
    ...input,
  });
}

function ansiFg(hex: string): string {
  const clean = hex.replace("#", "");
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function startupDashboard() {
  return {
    productName: "EstaCoda",
    orgName: "⟡ SIFR01 ⟡",
    tagline: "sovereign agentic infrastructure",
    version: "v0.1.0",
    sessionId: "20ea8195",
    session: {
      model: "kimi-k2.6 ◐",
      context: "0 / 262k",
      workspace: "verified",
      security: "open",
      autonomy: "autonomous",
    },
    commands: [
      { command: "/tools", description: "inspect tools" },
      { command: "/skills", description: "loaded skills" },
      { command: "/model", description: "active model route" },
      { command: "/status", description: "runtime state" },
      { command: "/setup", description: "setup editor" },
    ],
    tips: [
      "Paste large context as attachments.",
      "Approvals appear inline when an action needs permission.",
    ],
  };
}

function setupPanel() {
  return {
    kind: "table" as const,
    title: "Model route",
    description: "Choose the active provider and model route.",
    rows: [
      { id: "openai", provider: "OpenAI", model: "gpt-5.5", status: "ready", notes: "API key set" },
      { id: "anthropic", provider: "Anthropic", model: "claude-sonnet-4.5", status: "ready", notes: "API key set" },
      { id: "local", provider: "Local", model: "qwen3-coder", status: "offline", notes: "endpoint unset" },
    ],
    selectedRowId: "openai",
  };
}

function arabicSetupPanel() {
  return {
    kind: "table" as const,
    layout: "choiceMenu" as const,
    title: "إعداد النموذج",
    description: "اختار المزوّد الأساسي.",
    locale: "ar" as const,
    rows: [
      {
        id: "openai",
        provider: "OpenAI",
        model: "",
        status: "نماذج GPT مع مفتاح API.",
        notes: "gpt-5.5",
      },
      {
        id: "local",
        provider: "Local",
        model: "",
        status: "نقطة نهاية خاصة.",
        notes: "qwen3-coder",
      },
    ],
    selectedRowId: "openai",
  };
}
