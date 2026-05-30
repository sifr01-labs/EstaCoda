import { describe, expect, it } from "vitest";
import type { EvolutionChangeManifest } from "../contracts/evolution.js";
import type { SessionDB, SessionEvent } from "../contracts/session.js";
import { populateTraces } from "./export-format.js";

describe("populateTraces", () => {
  it("strips reasoning from exported session events", async () => {
    const traces = await populateTraces([
      {
        evidence: {
          traces: ["session-1"]
        }
      } as EvolutionChangeManifest
    ], fakeSessionDb([
      {
        kind: "provider-completion",
        timestamp: "2030-01-01T00:00:00.000Z",
        content: "<think>private chain</think>Visible output",
        reasoning: "raw private reasoning",
        reasoning_content: "raw private reasoning content",
        reasoningMetadata: {
          present: true,
          chars: 12,
          format: "reasoning_content"
        },
        raw: {
          output: [
            {
              type: "reasoning",
              text: "private output item"
            },
            {
              type: "text",
              text: "Visible output item"
            }
          ]
        },
        ordinary: "Use <think> as the example tag."
      } as unknown as SessionEvent
    ]));

    const exported = JSON.stringify(traces);
    expect(exported).toContain("Visible output");
    expect(exported).toContain("Visible output item");
    expect(exported).toContain("Use <think> as the example tag.");
    expect(exported).not.toContain("private");
    expect(exported).not.toContain("reasoning_content");
    expect(exported).not.toContain("reasoningMetadata");
  });
});

function fakeSessionDb(events: SessionEvent[]): SessionDB {
  return {
    listEvents: async () => events
  } as unknown as SessionDB;
}
