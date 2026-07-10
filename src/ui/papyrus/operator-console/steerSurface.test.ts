import { describe, expect, it } from "vitest";
import { stringWidth } from "../screen/stringWidth.js";
import {
  createSubmittedSteerTranscriptBlock,
  getQueuedSteerSurfaceDesiredHeight,
  getSteerInputSurfaceMetrics,
  hasQueuedSteer,
  renderQueuedSteerSurface,
  renderSteerInputSurface,
  routeSteerKey,
  type QueuedSteerState,
  type SteerState,
} from "./index.js";

describe("Papyrus operator console steer surface", () => {
  it("renders steer draft as Steer current turn", () => {
    const output = renderSteerInputSurface(steerDraft("focus only on approval cards"), { width: 72 });

    expect(output[0]).toMatch(/^╭─ Steer current turn ─+╮$/u);
    expect(output).toContainEqual(expect.stringContaining("› focus only on approval cards"));
  });

  it("renders an empty steer draft with the prompt marker", () => {
    const output = renderSteerInputSurface(steerDraft(""), { width: 72 });

    expect(output).toContainEqual(expect.stringContaining("│ ›"));
  });

  it("positions the cursor after the bordered steer prompt prefix and draft text", () => {
    const metrics = getSteerInputSurfaceMetrics(steerDraft("ifsdswewewww"), { width: 120, height: 3 });

    expect(metrics.cursorRow).toBe(0);
    expect(metrics.cursorColumn).toBe(16);
  });

  it("renders queued steer text and safe-boundary cancellation copy", () => {
    const output = renderQueuedSteerSurface(queuedSteer(), { width: 72 });
    const text = output.join("\n");

    expect(output[0]).toMatch(/^╭─ Queued steer ─+╮$/u);
    expect(text).toContain("focus only on approval cards and pasted attachments");
    expect(text).toContain("Will apply at next safe boundary · Esc cancel");
  });

  it("keeps steer draft and queued steer lines within the terminal width", () => {
    for (const width of [1, 2, 3, 12, 32, 72]) {
      const draft = renderSteerInputSurface(steerDraft("focus only on approval cards and pasted attachments"), { width });
      const queued = renderQueuedSteerSurface(queuedSteer(), { width });

      expect(draft.every((line) => stringWidth(line) <= width)).toBe(true);
      expect(queued.every((line) => stringWidth(line) <= width)).toBe(true);
    }
  });

  it("truncates long steer draft and queued steer text safely", () => {
    const longText = "focus only on approval cards and pasted attachments while ignoring unrelated startup panels";
    const draft = renderSteerInputSurface(steerDraft(longText), { width: 36 }).join("\n");
    const queued = renderQueuedSteerSurface(queuedSteer({ text: longText }), { width: 36 }).join("\n");

    expect(draft).toContain("focus only");
    expect(queued).toContain("focus only");
    expect(draft).not.toContain(longText);
    expect(queued).not.toContain(longText);
  });

  it("emits submit intent for non-empty draft and trims surrounding whitespace", () => {
    expect(routeSteerKey(steerDraft(" focus only on approvals "), { type: "key", key: "enter" })).toEqual({
      type: "submit",
      text: "focus only on approvals",
    });
  });

  it("emits none for empty and whitespace-only steer drafts", () => {
    expect(routeSteerKey(steerDraft(""), { type: "key", key: "enter" })).toEqual({ type: "none" });
    expect(routeSteerKey(steerDraft("   "), { type: "key", key: "enter" })).toEqual({ type: "none" });
  });

  it("emits cancelDraft for draft escape and cancelQueued for queued escape", () => {
    expect(routeSteerKey(steerDraft("focus"), { type: "key", key: "escape" })).toEqual({
      type: "cancelDraft",
    });
    expect(routeSteerKey(steerQueued(), { type: "key", key: "escape" })).toEqual({
      type: "cancelQueued",
      queuedSteerId: "steer-1",
    });
  });

  it("does not model Ctrl+C as steer submission or cancellation", () => {
    expect(routeSteerKey(steerDraft("focus"), { type: "key", key: "c", ctrl: true })).toEqual({ type: "none" });
  });

  it("keeps Ctrl+C outside the steer model and separate from interrupt behavior", () => {
    const intent = routeSteerKey(steerQueued(), { type: "key", key: "c", ctrl: true });

    expect(intent).toEqual({ type: "none" });
    expect(intent).not.toHaveProperty("interrupt");
    expect(intent).not.toHaveProperty("abort");
  });

  it("represents queued, applied, and cancelled steer states without mutation", () => {
    const states = [
      steerQueued({ status: "queued" }),
      steerQueued({ status: "applied" }),
      steerQueued({ status: "cancelled" }),
    ];

    for (const state of states) {
      const before = JSON.stringify(state);
      renderSteerInputSurface(state, { width: 72 });
      if (state.queued !== undefined) renderQueuedSteerSurface(state.queued, { width: 72 });
      routeSteerKey(state, { type: "key", key: "escape" });

      expect(state.queued).toHaveProperty("id", "steer-1");
      expect(JSON.stringify(state)).toBe(before);
    }
  });

  it("represents only one queued steer by default", () => {
    const state = steerQueued();

    expect(Array.isArray(state.queued)).toBe(false);
    expect(state.queued?.id).toBe("steer-1");
    expect(hasQueuedSteer(state)).toBe(true);
  });

  it("does not silently model replacement of an existing queued steer", () => {
    const intent = routeSteerKey(steerQueued({ id: "existing-steer" }), { type: "key", key: "enter" });

    expect(intent).toEqual({ type: "none" });
    expect(intent).not.toHaveProperty("previousQueuedSteerId");
    expect(intent).not.toHaveProperty("replaceQueued");
  });

  it("keeps queued steer visible while status is queued", () => {
    const output = renderQueuedSteerSurface(queuedSteer({ status: "queued" }), { width: 72 });

    expect(getQueuedSteerSurfaceDesiredHeight(queuedSteer({ status: "queued" }))).toBe(4);
    expect(output).toHaveLength(4);
    expect(output.join("\n")).toContain("Queued steer");
  });

  it("does not render applied or cancelled queued steer cards", () => {
    expect(getQueuedSteerSurfaceDesiredHeight(queuedSteer({ status: "applied" }))).toBe(0);
    expect(getQueuedSteerSurfaceDesiredHeight(queuedSteer({ status: "cancelled" }))).toBe(0);
    expect(renderQueuedSteerSurface(queuedSteer({ status: "applied" }), { width: 72 })).toEqual([]);
    expect(renderQueuedSteerSurface(queuedSteer({ status: "cancelled" }), { width: 72 })).toEqual([]);
  });

  it("emits no ANSI escape sequences or cursor-control strings", () => {
    const output = [
      ...renderSteerInputSurface(steerDraft("focus"), { width: 72 }),
      ...renderQueuedSteerSurface(queuedSteer(), { width: 72 }),
    ].join("\n");

    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\\x1b");
    expect(output).not.toContain("\\u001b");
    expect(output).not.toContain("\\033");
    expect(output).not.toMatch(/\b(moveCursor|clearLine|clearScreenDown|cursorTo|setRawMode)\b/u);
  });

  it("creates a collapsed User steer transcript block without assistant behavior", () => {
    const block = createSubmittedSteerTranscriptBlock({
      id: "steer-transcript-1",
      text: "focus only on approval cards and pasted attachments",
      createdAtMs: 123,
    });

    expect(block).toEqual({
      id: "steer-transcript-1",
      role: "user",
      text: "User steer:\nfocus only on approval cards and pasted attachments",
      createdAtMs: 123,
    });
    expect(block.text).not.toMatch(/Understood|Assistant:/u);
  });

  it("does not model runtime safe-boundary application in the pure surface", () => {
    const submit = routeSteerKey(steerDraft("focus only on approvals"), { type: "key", key: "enter" });
    const cancelQueued = routeSteerKey(steerQueued(), { type: "key", key: "escape" });

    expect(submit).toEqual({ type: "submit", text: "focus only on approvals" });
    expect(cancelQueued).toEqual({ type: "cancelQueued", queuedSteerId: "steer-1" });
    expect(submit).not.toHaveProperty("applied");
    expect(submit).not.toHaveProperty("safeBoundary");
    expect(cancelQueued).not.toHaveProperty("applied");
    expect(cancelQueued).not.toHaveProperty("safeBoundary");
  });
});

function steerDraft(draft: string): SteerState {
  return {
    draft,
    cursorOffset: draft.length,
    mode: "drafting",
  };
}

function steerQueued(input: Partial<QueuedSteerState> = {}): SteerState {
  return {
    draft: "",
    cursorOffset: 0,
    mode: "queued",
    queued: queuedSteer(input),
  };
}

function queuedSteer(input: Partial<QueuedSteerState> = {}): QueuedSteerState {
  return {
    id: input.id ?? "steer-1",
    text: input.text ?? "focus only on approval cards and pasted attachments",
    status: input.status ?? "queued",
    ...(input.submittedAtMs === undefined ? {} : { submittedAtMs: input.submittedAtMs }),
  };
}
