import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import { ChangeManifestStore } from "../../skills/change-manifest-store.js";
import { SkillEvolutionStore } from "../../skills/skill-evolution.js";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { createSkillTools } from "../../skills/skill-tools.js";
import { assertEqual, assertTrue, buildResult } from "../eval-runner.js";

export const skillProposalManifestBridgeCase: EvalCase = {
  id: "skill-proposal-manifest-bridge",
  name: "skill.propose_patch creates a ChangeManifest and links it",
  description: "Proposing a patch auto-creates a manifest and stores changeManifestId in the proposal",
  tags: ["skills", "evolution", "manifest"],
  run: async (): Promise<EvalResult> => {
    const startedAt = Date.now();
    const tmp = await mkdtemp(join(tmpdir(), "estacoda-eval-proposal-bridge-"));
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

    const proposeTool = tools.find((t) => t.name === "skill.propose_patch")!;
    const result = await proposeTool.run!({
      name: "test-skill",
      reason: "Replace old instruction with new one",
      patch: {
        type: "text_patch",
        oldString: "old",
        newString: "new"
      }
    });

    const metadata = result.metadata as { changeManifestId?: string; id: string } | undefined;
    const manifest = metadata?.changeManifestId !== undefined
      ? await changeManifestStore.find(metadata.changeManifestId)
      : undefined;

    const assertions = [
      assertTrue("propose returns ok", result.ok === true),
      assertTrue("proposal has changeManifestId", isNonEmptyString(metadata?.changeManifestId)),
      assertTrue("manifest exists", manifest !== undefined),
      assertEqual("manifest hypothesis", manifest?.hypothesis, "Replace old instruction with new one"),
      assertTrue("manifest has evalCommand", isNonEmptyString(manifest?.evalCommand)),
      assertTrue("manifest has constraintGates", (manifest?.constraintGates?.length ?? 0) > 0)
    ];

    return buildResult(
      "skill-proposal-manifest-bridge",
      "skill.propose_patch creates a ChangeManifest and links it",
      assertions,
      Date.now() - startedAt
    );
  }
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
