import { describe, expect, it } from "vitest";
import { readReleaseRoutingCorpus, measureReleaseRouting, researchRoutingReleaseCase } from "./research-routing-release.js";
import { MAX_PROVIDER_SCHEMA_TOKENS, MAX_PROVIDER_TOOLS } from "../../tools/tool-schema.js";
import { measureResearchWorkflow } from "./research-workflow-release.js";

describe("frozen PR6 release gates", () => {
  it("enforces corpus size, language coverage and seed isolation before measuring", async () => {
    const { cases } = await readReleaseRoutingCorpus();
    expect(cases).toHaveLength(180);
    expect(new Set(cases.map((row) => row.id)).size).toBe(180);
    expect(cases.filter((row) => row.language === "ar").length).toBeGreaterThanOrEqual(40);
    expect(cases.filter((row) => row.language === "mixed").length).toBeGreaterThanOrEqual(20);
    expect(cases.filter((row) => row.noActions).length).toBeGreaterThanOrEqual(60);
    expect(cases.filter((row) => row.split === "development")).toHaveLength(120);
    expect(cases.filter((row) => row.split === "heldout")).toHaveLength(60);
    const development = new Set(cases.filter((row) => row.split === "development").map((row) => JSON.stringify([row.previousPrompt, row.prompt])));
    expect(cases.filter((row) => row.split === "heldout").some((row) => development.has(JSON.stringify([row.previousPrompt, row.prompt])))).toBe(false);
    for (const seed of new Set(cases.map((row) => row.seed))) expect(new Set(cases.filter((row) => row.seed === seed).map((row) => row.split)).size).toBe(1);
  });
  it("enforces first-pass held-out thresholds without counting recovery as routing success", async () => {
    const report = await measureReleaseRouting("heldout");
    expect(report.metrics.requestedCapabilityRecall.value).toBeGreaterThanOrEqual(.95);
    expect(report.metrics.primarySkillPrecision.value).toBeGreaterThanOrEqual(.98);
    expect(report.metrics.safetyViolations).toBe(0);
    expect(report.skillsLoaded).toBeGreaterThan(2);
    expect(report.definitions).toBeGreaterThan(100);
    expect(report.recovery.every((row) => row.passed && row.rounds <= 2)).toBe(true);
    for (const row of report.cases) {
      expect(row.schemaTokensRough).toBeLessThanOrEqual(MAX_PROVIDER_SCHEMA_TOKENS);
      expect(row.schemaCount).toBeLessThanOrEqual(MAX_PROVIDER_TOOLS);
    }
    expect((await researchRoutingReleaseCase.run()).passed).toBe(true);
  });
  it("runs workers, synthesis and verified save after restart without redelegation", async () => {
    expect(await measureResearchWorkflow()).toMatchObject({ workers: 3, acceptedResults: 4, searches: 3, tasks: 1, restarted: true, finalOutcome: "completed", sourceTable: true, liveModelCalls: 0 });
  });
});
