import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillEvolutionStore } from "./skill-evolution.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-skill-evolution-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("SkillEvolutionStore", () => {
  it("strips hidden reasoning from observations and evidence", async () => {
    const root = await makeTempDir();
    const store = new SkillEvolutionStore({
      usagePath: join(root, "usage.json"),
      evolutionRoot: join(root, "evolution")
    });

    await store.appendObservation({
      skillName: "demo",
      type: "note",
      promptSummary: "<think>private prompt</think>Visible prompt",
      lesson: "<reasoning>private lesson</reasoning>Visible lesson",
      candidateImprovement: "<thinking>private improvement</thinking>Visible improvement",
      evidence: {
        reasoning_content: "raw private reasoning",
        summary: "<think>private evidence</think>Visible evidence",
        ordinary: "Use <think> as the example tag.",
        nested: {
          reasoning: "nested private reasoning",
          safe: "Visible nested value",
          values: [
            {
              reasoning_details: {
                hidden: "nested details"
              },
              kept: "<thinking>private nested text</thinking>Visible nested text"
            }
          ]
        }
      }
    });

    const [observation] = await store.listObservations();
    expect(observation?.promptSummary).toBe("Visible prompt");
    expect(observation?.lesson).toBe("Visible lesson");
    expect(observation?.candidateImprovement).toBe("Visible improvement");
    expect(observation?.evidence?.summary).toBe("Visible evidence");
    expect(observation?.evidence?.ordinary).toBe("Use <think> as the example tag.");
    expect(observation?.evidence).not.toHaveProperty("reasoning_content");
    expect(observation?.evidence?.nested).toEqual({
      safe: "Visible nested value",
      values: [
        {
          kept: "Visible nested text"
        }
      ]
    });
    expect(JSON.stringify(observation)).not.toContain("private");
  });
});
