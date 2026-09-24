import { describe, expect, it } from "vitest";
import { buildResearchCapabilityBaseline, researchRoutingCases } from "./research-capability-baseline.js";
import { routingEvolutionBaselineCase } from "./routing-evolution-baseline.js";

describe("executed research capability baseline", () => {
  it("executes real bundled skills and reports reproducible observations", () => {
    const report = buildResearchCapabilityBaseline();
    expect(report).toEqual(buildResearchCapabilityBaseline());
    expect(new Set(report.cases.map((row) => row.id)).size).toBe(researchRoutingCases.length);
    expect(report.cases.find((row) => row.id === "compound-research")).toMatchObject({ taskClass: "research", selectedSkill: null, missingTools: ["delegate_task"] });
    expect(report.cases.find((row) => row.id === "prepare-markdown")).toMatchObject({ missingTools: ["file.write"], falseCompleteWithoutExecution: true });
    expect(report.cases.find((row) => row.id === "discovery-slash")).toMatchObject({ selectedSkill: "research-discovery", missingTools: [] });
  });

  it("keeps misses in denominators rather than scoring known failures as successes", () => {
    const { metrics } = buildResearchCapabilityBaseline();
    expect(metrics.primarySkillPrecision).toEqual({ numerator: 5, denominator: 5, value: 1 });
    expect(metrics.primarySkillRecall).toEqual({ numerator: 5, denominator: 8, value: 5 / 8 });
    expect(metrics.requestedCapabilityRecall).toEqual({ numerator: 15, denominator: 22, value: 15 / 22 });
    expect(metrics.falseCompleteWithoutExecution).toEqual({ numerator: 6, denominator: 9, value: 6 / 9 });
    expect(metrics.forbiddenExposureCount).toBe(0);
  });

  it("reports Arabic and mixed-language misses separately and undefined precision honestly", () => {
    const { perLanguage } = buildResearchCapabilityBaseline();
    expect(perLanguage.ar).toMatchObject({ caseCount: 3, primarySkillPrecision: { numerator: 0, denominator: 0, value: null }, requestedCapabilityRecall: { numerator: 2, denominator: 4 } });
    expect(perLanguage.mixed).toMatchObject({ caseCount: 2, requestedCapabilityRecall: { numerator: 2, denominator: 4 } });
  });

  it("distinguishes zero greeting schemas from estimates for actionable turns", () => {
    const report = buildResearchCapabilityBaseline();
    expect(report.cases.find((row) => row.id === "greeting-control")).toMatchObject({ exposedTools: [], schemaTokensRough: 0 });
    expect(report.cases.find((row) => row.id === "compound-research")?.schemaTokensRough).toBeGreaterThan(0);
    expect(report.schemaTokensRough.p95).toBeGreaterThanOrEqual(report.schemaTokensRough.median);
  });

  it("runs through the existing eval fixture entry point", async () => {
    const result = await routingEvolutionBaselineCase.run();
    expect(result.passed).toBe(true);
    expect(result.assertions.some((assertion) => assertion.name.startsWith("research capability baseline"))).toBe(true);
  });
});
