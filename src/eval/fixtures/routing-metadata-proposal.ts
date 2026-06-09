import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import { ChangeManifestStore } from "../../skills/change-manifest-store.js";
import { SkillEvolutionStore } from "../../skills/skill-evolution.js";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { SkillProposalService } from "../../skills/skill-proposal-service.js";
import { assertEqual, assertTrue, buildResult } from "../eval-runner.js";

export const routingMetadataProposalCase: EvalCase = {
  id: "routing-metadata-proposal",
  name: "Routing metadata proposal manifest can be created and inspected",
  description: "SkillProposalService.createManifestForRoutingMetadata stores a manifest with target routing_metadata",
  tags: ["runtime", "evolution", "manifest"],
  run: async (): Promise<EvalResult> => {
    const startedAt = Date.now();
    const tmp = await mkdtemp(join(tmpdir(), "estacoda-eval-routing-"));
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

    const service = new SkillProposalService({
      registry,
      localSkillsRoot,
      skillEvolutionStore,
      changeManifestStore
    });

    const result = await service.createManifestForRoutingMetadata({
      skillName: "test-skill",
      proposedRoutingChange: "Add 'research' label to trigger patterns",
      hypothesis: "Skill is under-triggered for research prompts",
      predictedImpact: "Higher routing accuracy for research-oriented queries",
      evidenceTraceIds: ["trace_xyz789"]
    });

    const manifests = await changeManifestStore.list({ target: "routing_metadata" });
    const manifest = manifests[0];

    const assertions = [
      assertTrue("manifest created", result !== undefined),
      assertEqual("manifest target is routing_metadata", manifest?.target, "routing_metadata"),
      assertEqual("manifest hypothesis", manifest?.hypothesis, "Skill is under-triggered for research prompts"),
      assertEqual("manifest predictedImpact", manifest?.predictedImpact, "Higher routing accuracy for research-oriented queries"),
      assertEqual("manifest riskLevel", manifest?.riskLevel, "medium"),
      assertEqual("manifest evalCommand is allowlisted", manifest?.evalCommand, "pnpm run eval:fixtures"),
      assertEqual("manifest first constraint gate is allowlisted", manifest?.constraintGates?.[0], "pnpm run typecheck"),
      assertEqual("manifest second constraint gate is allowlisted", manifest?.constraintGates?.[1], "pnpm run smoke"),
      assertTrue("manifest has evidence trace", manifest?.evidence?.traces?.includes("trace_xyz789") ?? false),
      assertTrue("manifest has rollbackPlan", manifest?.rollbackPlan?.includes("Revert") ?? false),
      assertEqual("manifest status", manifest?.status, "proposed")
    ];

    return buildResult(
      "routing-metadata-proposal",
      "Routing metadata proposal manifest can be created and inspected",
      assertions,
      Date.now() - startedAt
    );
  }
};
