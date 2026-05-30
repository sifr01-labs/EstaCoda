import { describe, expect, it } from "vitest";
import {
  extractInlineReasoning,
  extractReasoningFromContentList,
  mergeReasoningParts,
  reasoningMetadataFromReasoning,
  StreamingReasoningFilter,
  stripInlineReasoning,
  stripThinkBlocks
} from "./provider-reasoning.js";

describe("provider reasoning helpers", () => {
  it("extracts and strips inline think blocks", () => {
    const result = extractInlineReasoning("Visible <think>hidden chain</think> answer");

    expect(result.visible).toBe("Visible  answer");
    expect(result.reasoning).toBe("hidden chain");
    expect(result.reasoningMetadata).toEqual({
      present: true,
      chars: "hidden chain".length,
      format: "think_block"
    });
  });

  it("extracts and strips inline thinking blocks", () => {
    const result = extractInlineReasoning("<thinking>private</thinking>Visible");

    expect(result.visible).toBe("Visible");
    expect(result.reasoning).toBe("private");
  });

  it("extracts and strips inline reasoning blocks", () => {
    const result = extractInlineReasoning("Visible <reasoning>private</reasoning> done");

    expect(result.visible).toBe("Visible  done");
    expect(result.reasoning).toBe("private");
  });

  it("preserves visible text before, between, and after multiple reasoning blocks", () => {
    const result = extractInlineReasoning("A <think>one</think>B <thinking>two</thinking>C <reasoning>three</reasoning>D");

    expect(result.visible).toBe("A B C D");
    expect(result.reasoning).toBe("one\n\ntwo\n\nthree");
  });

  it("strips unclosed reasoning blocks without leaking hidden content", () => {
    const result = extractInlineReasoning("Visible <think>hidden forever");

    expect(result.visible).toBe("Visible ");
    expect(result.reasoning).toBe("hidden forever");
  });

  it("leaves ordinary visible text unchanged", () => {
    expect(stripInlineReasoning("No hidden reasoning here.")).toBe("No hidden reasoning here.");
  });

  it("does not strip ordinary prose that mentions reasoning tags", () => {
    const text = "Use <think> as the example tag";

    expect(stripInlineReasoning(text)).toBe(text);
    expect(extractInlineReasoning(text).reasoning).toBeUndefined();
  });

  it("preserves existing stripThinkBlocks trimming behavior", () => {
    expect(stripThinkBlocks("  <think>hidden</think> Visible  ")).toBe("Visible");
  });

  it("extracts reasoning and visible text from provider content lists", () => {
    const result = extractReasoningFromContentList([
      { type: "thinking", thinking: "hidden thought" },
      { type: "output", text: "Visible answer" },
      { type: "reasoning", reasoning: "hidden reason" },
      { type: "text", text: "More visible" }
    ]);

    expect(result.visible).toBe("Visible answer\nMore visible");
    expect(result.reasoning).toBe("hidden thought\n\nhidden reason");
    expect(result.reasoningMetadata).toEqual({
      present: true,
      chars: "hidden thought\n\nhidden reason".length,
      format: "mixed"
    });
  });

  it("uses reasoning text for reasoning content-list parts", () => {
    const result = extractReasoningFromContentList([
      { type: "reasoning", text: "text reasoning" },
      { text: "visible convention" }
    ]);

    expect(result.visible).toBe("visible convention");
    expect(result.reasoning).toBe("text reasoning");
  });

  it("does not stringify unknown content-list parts into reasoning or visible output", () => {
    const result = extractReasoningFromContentList([
      { type: "image", text: "alt should not leak as output" },
      { type: "unknown", reasoning: "unknown hidden" },
      { type: "output_text", text: "visible" }
    ]);

    expect(result.visible).toBe("visible");
    expect(result.reasoning).toBeUndefined();
  });

  it("merges reasoning parts deterministically and drops blanks", () => {
    expect(mergeReasoningParts([" one ", "", undefined, "two"])).toBe("one\n\ntwo");
  });

  it("returns safe reasoning metadata only", () => {
    expect(reasoningMetadataFromReasoning("hidden text", "reasoning_content")).toEqual({
      present: true,
      chars: "hidden text".length,
      format: "reasoning_content"
    });
    expect(reasoningMetadataFromReasoning(undefined, "unknown")).toEqual({
      present: false,
      chars: 0,
      format: "unknown"
    });
  });
});

describe("StreamingReasoningFilter", () => {
  it("handles split opening tags", () => {
    const filter = new StreamingReasoningFilter();

    expect(filter.push("Visible <thi")).toBe("Visible ");
    expect(filter.push("nk>hidden</think> answer")).toBe(" answer");
    expect(filter.finish()).toBe("");
    expect(filter.reasoning()).toBe("hidden");
  });

  it("handles split closing tags", () => {
    const filter = new StreamingReasoningFilter();

    expect(filter.push("<think>hidden</thi")).toBe("");
    expect(filter.push("nk>Visible")).toBe("Visible");
    expect(filter.finish()).toBe("");
    expect(filter.reasoning()).toBe("hidden");
  });

  it("does not flush unclosed hidden content at finish", () => {
    const filter = new StreamingReasoningFilter();

    expect(filter.push("Visible <reasoning>hidden")).toBe("Visible ");
    expect(filter.finish()).toBe("");
    expect(filter.reasoning()).toBe("hidden");
  });

  it("emits only visible chunks", () => {
    const filter = new StreamingReasoningFilter();
    const chunks = [
      filter.push("A"),
      filter.push("<think>hidden"),
      filter.push("</think>B"),
      filter.finish()
    ];

    expect(chunks.join("")).toBe("AB");
    expect(chunks.join("")).not.toContain("hidden");
    expect(filter.reasoningMetadata()).toEqual({
      present: true,
      chars: "hidden".length,
      format: "think_block"
    });
  });

  it("does not strip streaming prose that mentions split reasoning tags", () => {
    const filter = new StreamingReasoningFilter();
    const chunks = [
      filter.push("Use <thi"),
      filter.push("nk> as the example tag"),
      filter.finish()
    ];

    expect(chunks.join("")).toBe("Use <think> as the example tag");
    expect(filter.reasoning()).toBeUndefined();
  });
});
