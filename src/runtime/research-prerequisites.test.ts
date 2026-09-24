import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../contracts/tool.js";
import { buildProviderToolSchemaCatalog } from "../tools/tool-schema.js";
import { deriveRequestRequirements } from "./request-requirements.js";
import { researchPrerequisiteBlockers } from "./research-request-evidence.js";

const search: ToolDefinition = {
  name: "web.search", description: "Search", inputSchema: { type: "object", properties: {} },
  riskClass: "read-only-network", toolsets: ["web"], progressLabel: "Search", maxResultSizeChars: 1000
};
const requirements = () => deriveRequestRequirements("Research current battery recycling.");

describe("research prerequisite admission", () => {
  it("keeps available but unexposed search recoverable", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools: [search], maxTools: 0 });
    expect(catalog.tools).toHaveLength(0);
    expect(researchPrerequisiteBlockers({ requestRequirements: requirements() }, catalog)).toEqual([]);
  });

  it("does not mistake registered unavailable metadata for usable search", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools: [], unavailableTools: [search] });
    expect(researchPrerequisiteBlockers({ requestRequirements: requirements() }, catalog)).toHaveLength(1);
  });

  it("allows reading an accepted Task result even when search is now unavailable", () => {
    expect(researchPrerequisiteBlockers({ requestRequirements: { ...requirements(), sourceTaskId: "existing-task" } },
      buildProviderToolSchemaCatalog({ tools: [] }))).toEqual([]);
  });

  it("leaves ambiguous skill resolution and instruction recovery to the provider", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools: [search] });
    for (const status of ["ambiguous", "resolved"] as const) {
      expect(researchPrerequisiteBlockers({ requestRequirements: requirements(),
        skillRequests: [{ reference: "research", status, candidates: ["researcher", "research-discovery"] }] }, catalog)).toEqual([]);
    }
  });

  it("does not block non-fresh research or a plain file request on missing search", () => {
    for (const prompt of ["Research battery recycling.", "Save this report to report.md."]) {
      expect(researchPrerequisiteBlockers({ requestRequirements: deriveRequestRequirements(prompt) },
        buildProviderToolSchemaCatalog({ tools: [] }))).toEqual([]);
    }
  });
});
