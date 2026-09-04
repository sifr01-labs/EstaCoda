import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSkillFile } from "../skills/skill-loader.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { IntentRouter } from "./intent-router.js";

const skillUrl = new URL("../../skills/official/api-integration/SKILL.md", import.meta.url);
const skillPath = fileURLToPath(skillUrl);
const apiIntegrationSkill = parseSkillFile(skillPath, readFileSync(skillUrl, "utf8"), {
  sourceKind: "bundled",
  sourceRoot: fileURLToPath(new URL("../../skills/official", import.meta.url))
});

function route(prompt: string) {
  const registry = new SkillRegistry();
  registry.register(apiIntegrationSkill);
  return new IntentRouter({ skillRegistry: registry }).route(prompt);
}

describe("bundled api-integration skill routing", () => {
  it("plans source discovery and destination reconciliation before import without an all-items gate", () => {
    const steps = apiIntegrationSkill.playbook;
    expect(steps.slice(0, 3).map((step) => step.id)).toEqual(["discover-api-source", "reconcile-destination", "import-description"]);
    expect(steps[0]?.description).toContain("browser.extract");
    expect(steps[0]?.description).toContain("exact hrefs");
    expect(steps[0]?.description).toContain("must not prevent safe progress");
    expect(steps[1]?.description).toContain("create, update, verify, or skip");
    expect(steps[2]?.description).toContain("Do not re-import merely to verify");
  });
  it.each([
    "Set up these products in our Postman collection.",
    "Add these APIs to my Postman workspace.",
    "Import these products and configure their credentials.",
    "Create Postman collections from the developer portal.",
    "Generate a collection from these Swagger files.",
    "Transfer these API specifications and keys into Postman."
  ])("selects API integration for operation and destination evidence: %s", (prompt) => {
    const result = route(prompt);

    expect(result.primarySkill?.name).toBe("api-integration");
    expect(result.suggestedToolsets).toEqual(["browser", "mcp"]);
  });

  it.each([
    "What is wrong with my Postman collection?",
    "Explain how Postman environments work.",
    "Explain how to import an API into Postman.",
    "Write documentation about importing APIs into Postman.",
    "Review this Postman request.",
    "Build an API endpoint.",
    "Write documentation about Postman."
  ])("rejects diagnostic, educational, or implementation requests: %s", (prompt) => {
    const result = route(prompt);

    expect(result.primarySkill).toBeUndefined();
    expect(result.rejectedCandidates).toEqual([
      expect.objectContaining({
        skill: apiIntegrationSkill,
        role: "rejected"
      })
    ]);
  });

  it.each([
    "Set up my account.",
    "Create a collection in my workspace.",
    "Set up credentials and keys."
  ])("does not route on generic operation language alone: %s", (prompt) => {
    const result = route(prompt);

    expect(result.primarySkill).toBeUndefined();
    expect(result.rejectedCandidates).toEqual([]);
  });
});
