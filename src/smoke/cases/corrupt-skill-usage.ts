import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SmokeCase } from "../smoke-case.js";
import { SkillEvolutionStore } from "../../skills/skill-evolution.js";

export const corrupt_skill_usage_case: SmokeCase = {
  id: "corrupt-skill-usage",
  name: "Corrupt skill usage sidecar recovery",
  tags: ["skills", "evolution", "resilience"],
  run: async () => {
    const corruptSkillUsageRoot = await mkdtemp(join(tmpdir(), "estacoda-corrupt-skill-usage-"));
    const corruptSkillUsagePath = join(corruptSkillUsageRoot, ".usage.json");
    await writeFile(corruptSkillUsagePath, "{not-json", "utf8");
    const corruptSkillUsageStore = new SkillEvolutionStore({
      usagePath: corruptSkillUsagePath,
      evolutionRoot: join(corruptSkillUsageRoot, "evolution")
    });

    const usage = await corruptSkillUsageStore.usage();
    if (usage.length !== 0) {
      throw new Error("expected corrupt skill usage sidecar to start fresh");
    }

    const entries = await readdir(corruptSkillUsageRoot);
    if (!entries.some((entry: string) => entry.startsWith(".usage.json.corrupt-"))) {
      throw new Error("expected corrupt skill usage sidecar to be moved aside");
    }
  }
};
