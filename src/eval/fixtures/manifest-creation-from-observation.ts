import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import { ChangeManifestStore } from "../../skills/change-manifest-store.js";
import { SkillEvolutionStore } from "../../skills/skill-evolution.js";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { createSkillTools } from "../../tools/skill-tools.js";
import { assertEqual, assertTrue, buildResult } from "../eval-runner.js";

export const manifestCreationFromObservationCase: EvalCase = {
  id: "manifest-creation-from-observation",
  name: "Observation with candidateImprovement creates a ChangeManifest",
  description: "skill.observe with candidateImprovement auto-creates a manifest via ChangeManifestStore",
  tags: ["skills", "evolution", "manifest"],
  run: async (): Promise<EvalResult> => {
    const startedAt = Date.now();
    const tmp = await mkdtemp(join(tmpdir(), "estacoda-eval-manifest-obs-"));
    const evolutionRoot = join(tmp, "evolution");
    const manifestRoot = join(evolutionRoot, "manifests");
    const localSkillsRoot = join(tmp, "skills");
    await mkdir(localSkillsRoot, { recursive: true });

    const skillEvolutionStore = new SkillEvolutionStore({
      usagePath: join(localSkillsRoot, ".usage.json"),
      evolutionRoot
    });
    const changeManifestStore = new ChangeManifestStore({ root: manifestRoot });
    const registry = new SkillRegistry();

    const tools = createSkillTools({
      registry,
      localSkillsRoot,
      skillEvolutionStore,
      changeManifestStore
    });

    const observeTool = tools.find((t) => t.name === "skill.observe")!;
    const result = await observeTool.run!({
      name: "test-skill",
      type: "note",
      lesson: "Test observation lesson",
      candidateImprovement: "Add step 3 to the workflow"
    });

    const manifests = await changeManifestStore.list({ status: "proposed" });
    const manifest = manifests[0];

    const assertions = [
      assertTrue("observe returns ok", result.ok === true),
      assertEqual("manifest created", manifests.length, 1),
      assertEqual("manifest target is skill", manifest?.target, "skill"),
      assertEqual("manifest hypothesis", manifest?.hypothesis, "Test observation lesson"),
      assertEqual("manifest predictedImpact", manifest?.predictedImpact, "Add step 3 to the workflow"),
      assertEqual("manifest evalCommand is allowlisted", manifest?.evalCommand, "pnpm run eval:fixtures"),
      assertEqual("manifest first constraint gate is allowlisted", manifest?.constraintGates?.[0], "pnpm run typecheck"),
      assertEqual("manifest second constraint gate is allowlisted", manifest?.constraintGates?.[1], "pnpm run smoke"),
      assertTrue("manifest has rollbackPlan", manifest?.rollbackPlan?.includes("Revert") ?? false),
      assertEqual("manifest evidence traces length", manifest?.evidence?.traces?.length, 1)
    ];

    return buildResult(
      "manifest-creation-from-observation",
      "Observation with candidateImprovement creates a ChangeManifest",
      assertions,
      Date.now() - startedAt
    );
  }
};
