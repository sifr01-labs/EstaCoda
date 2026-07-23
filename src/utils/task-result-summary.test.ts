import { describe, expect, it } from "vitest";
import { deriveTaskResultSummary } from "./task-result-summary.js";

describe("deriveTaskResultSummary", () => {
  it("uses the first meaningful paragraph and removes presentation Markdown", () => {
    const result = [
      "## Summary",
      "",
      "**Compared [leading agent harnesses](https://example.com) across extension systems, persistent memory, lifecycle hooks, and trust boundaries.**",
      "",
      "## Detailed findings",
      "",
      "- Supporting detail that does not belong in the card summary."
    ].join("\n");

    expect(deriveTaskResultSummary(result)).toBe(
      "Compared leading agent harnesses across extension systems, persistent memory, lifecycle hooks, and trust boundaries."
    );
  });

  it("ends at a complete sentence when bounding a long paragraph", () => {
    const result = "Found strong file and profile boundaries. Memory writes still need explicit provenance and review semantics before broad rollout.";

    expect(deriveTaskResultSummary(result, 70)).toBe("Found strong file and profile boundaries.");
  });

  it("rejects an apparent tail fragment instead of presenting it as a summary", () => {
    const result = "…firmation gates are not optional because durable work crosses several trust boundaries without a final punctuation mark";

    expect(deriveTaskResultSummary(result, 60)).toBeUndefined();
  });
});
