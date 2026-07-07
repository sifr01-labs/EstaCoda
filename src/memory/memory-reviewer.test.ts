import { describe, expect, it } from "vitest";
import { DEFAULT_MEMORY_CONFIG } from "../config/memory-config.js";
import type { ExtractedFact } from "./extracted-fact.js";
import { reviewMemoryFacts } from "./memory-reviewer.js";
import { MemoryStore } from "./memory-store.js";

const messages = [
  {
    id: "m1",
    content: "Please remember that I prefer pnpm for this repo."
  }
];

describe("reviewMemoryFacts", () => {
  it("auto-applies explicit low-risk facts with source evidence", () => {
    const store = new MemoryStore();

    const [candidate] = reviewMemoryFacts({
      facts: [fact()],
      memoryStore: store,
      messages,
      config: DEFAULT_MEMORY_CONFIG.curation,
      id: () => "candidate-1"
    });

    expect(candidate).toEqual({
      id: "candidate-1",
      factId: "fact-1",
      target: "USER.md",
      operation: "append",
      content: "- User prefers pnpm for this repo.",
      disposition: "auto-apply",
      reason: "explicit low-risk fact passed curation policy",
      risk: "low"
    });
  });

  it("routes project and technical defaults to MEMORY.md", () => {
    const [candidate] = reviewMemoryFacts({
      facts: [fact({
        category: "technical-default",
        statement: "The repo uses pnpm",
        evidence: [{ messageId: "m2", exactSpan: "The repo uses pnpm" }]
      })],
      memoryStore: new MemoryStore(),
      messages: [{ id: "m2", content: "The repo uses pnpm" }],
      config: DEFAULT_MEMORY_CONFIG.curation
    });

    expect(candidate?.target).toBe("MEMORY.md");
    expect(candidate?.content).toBe("- The repo uses pnpm.");
    expect(candidate?.disposition).toBe("auto-apply");
  });

  it("queues facts without exact evidence for review", () => {
    const [candidate] = reviewMemoryFacts({
      facts: [fact()],
      memoryStore: new MemoryStore(),
      messages: [{ id: "m1", content: "Different text." }],
      config: DEFAULT_MEMORY_CONFIG.curation
    });

    expect(candidate?.disposition).toBe("pending-review");
    expect(candidate?.reason).toBe("fact evidence span was not found in source messages");
  });

  it("queues low-confidence facts under the 0.7 default threshold", () => {
    const [candidate] = reviewMemoryFacts({
      facts: [fact({ confidence: 0.69 })],
      memoryStore: new MemoryStore(),
      messages,
      config: DEFAULT_MEMORY_CONFIG.curation
    });

    expect(candidate?.disposition).toBe("pending-review");
    expect(candidate?.reason).toBe("fact confidence 0.69 is below 0.7");
  });

  it("queues sensitive or personal facts for review", () => {
    const [candidate] = reviewMemoryFacts({
      facts: [fact({
        statement: "User has a medical diagnosis",
        category: "personal",
        evidence: [{ messageId: "m2", exactSpan: "medical diagnosis" }]
      })],
      memoryStore: new MemoryStore(),
      messages: [{ id: "m2", content: "User mentioned a medical diagnosis" }],
      config: DEFAULT_MEMORY_CONFIG.curation
    });

    expect(candidate?.disposition).toBe("pending-review");
    expect(candidate?.risk).toBe("medium");
  });

  it("ignores duplicates already present in memory", () => {
    const store = new MemoryStore();
    store.write("USER.md", "- User prefers pnpm for this repo.");

    const [candidate] = reviewMemoryFacts({
      facts: [fact()],
      memoryStore: store,
      messages,
      config: DEFAULT_MEMORY_CONFIG.curation
    });

    expect(candidate?.disposition).toBe("ignore");
    expect(candidate?.reason).toBe("USER.md already contains this memory");
  });

  it("honors review and manual modes", () => {
    const reviewCandidate = reviewMemoryFacts({
      facts: [fact()],
      memoryStore: new MemoryStore(),
      messages,
      config: { ...DEFAULT_MEMORY_CONFIG.curation, mode: "review" }
    })[0];
    const manualCandidate = reviewMemoryFacts({
      facts: [fact()],
      memoryStore: new MemoryStore(),
      messages,
      config: { ...DEFAULT_MEMORY_CONFIG.curation, mode: "manual" }
    })[0];

    expect(reviewCandidate?.disposition).toBe("pending-review");
    expect(manualCandidate?.disposition).toBe("ignore");
  });
});

function fact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    id: "fact-1",
    statement: "User prefers pnpm for this repo",
    category: "preference",
    evidence: [{ messageId: "m1", exactSpan: "I prefer pnpm" }],
    explicitness: "explicit",
    sensitivity: "none",
    confidence: 0.7,
    ...overrides
  };
}
