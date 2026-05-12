import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SmokeCase } from "../smoke-case.js";
import { evolutionCommand } from "../../cli/evolution-commands.js";
import { manifestCommand } from "../../cli/manifest-commands.js";
import { ChangeManifestStore } from "../../skills/change-manifest-store.js";
import { SkillEvolutionStore } from "../../skills/skill-evolution.js";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { loadSkillsFromDirectory } from "../../skills/skill-loader.js";

async function setupTempHome(): Promise<string> {
  const tempHome = mkdtempSync(join(tmpdir(), "estacoda-smoke-lifecycle-"));
  const estacodaRoot = join(tempHome, ".estacoda");
  const skillsRoot = join(estacodaRoot, "skills");
  mkdirSync(join(skillsRoot, "local"), { recursive: true });
  mkdirSync(join(skillsRoot, ".evolution"), { recursive: true });
  writeFileSync(join(estacodaRoot, "sessions.sqlite"), "", "utf8");
  return tempHome;
}

function cliOptions(homeDir: string): import("../../cli/cli.js").CliOptions {
  return { argv: [], homeDir, workspaceRoot: process.cwd() };
}

function makeSkillMd(name: string, description: string): string {
  return [
    "---",
    JSON.stringify({ name, description, version: "1.0.0" }, null, 2),
    "---",
    "",
    `# ${name}`,
    "",
    "This is a smoke-test skill. ORIGINAL_MARKER",
    ""
  ].join("\n");
}

export const evolution_lifecycle_case: SmokeCase = {
  id: "evolution-lifecycle",
  name: "Evolution full lifecycle: test, approve, promote, rollback",
  tags: ["evolution", "lifecycle", "integration"],
  run: async () => {
    const tempHome = await setupTempHome();

    try {
      const localSkillsRoot = join(tempHome, ".estacoda", "skills");
      const skillDir = join(localSkillsRoot, "local", "test-smoke-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), makeSkillMd("test-smoke-skill", "A smoke test skill"), "utf8");

      // Pre-load skills so proposal service can resolve the skill path
      const registry = new SkillRegistry();
      const loaded = await loadSkillsFromDirectory(join(localSkillsRoot, "local"), {
        sourceKind: "local",
        sourceRoot: localSkillsRoot
      });
      for (const skill of loaded.skills) {
        registry.register(skill);
      }

      const skillEvolutionStore = new SkillEvolutionStore({
        usagePath: join(localSkillsRoot, ".usage.json"),
        evolutionRoot: join(localSkillsRoot, ".evolution")
      });
      const changeManifestStore = new ChangeManifestStore({
        root: join(localSkillsRoot, ".evolution", "manifests")
      });

      // Create manifest and linked proposal directly through stores
      const manifest = await changeManifestStore.propose({
        target: "skill",
        hypothesis: "patch smoke-test skill marker",
        predictedImpact: "replace ORIGINAL_MARKER with PATCHED_MARKER",
        riskLevel: "low",
        filesChanged: [join(skillDir, "SKILL.md")],
        evidence: { traces: [], failures: [], evalCases: [] },
        rollbackPlan: "restore previous version",
        evalCommand: "pnpm run typecheck",
        constraintGates: ["pnpm run typecheck"]
      });

      const proposal = await skillEvolutionStore.proposePatch({
        skillName: "test-smoke-skill",
        reason: "update marker for smoke test",
        patch: { type: "text_patch", oldString: "ORIGINAL_MARKER", newString: "PATCHED_MARKER" },
        changeManifestId: manifest.id
      });

      const manifestId = manifest.id;

      // ── Test: run constraint gates ──
      const testResult = await evolutionCommand(cliOptions(tempHome), ["test", manifestId]);
      if (testResult.exitCode !== 0) {
        throw new Error(`evolution test failed: ${testResult.output}`);
      }

      // ── Approve ──
      const approveResult = await evolutionCommand(cliOptions(tempHome), ["approve", manifestId]);
      if (approveResult.exitCode !== 0) {
        throw new Error(`evolution approve failed: ${approveResult.output}`);
      }

      // ── Promote ──
      const promoteResult = await evolutionCommand(cliOptions(tempHome), ["promote", manifestId]);
      if (promoteResult.exitCode !== 0) {
        throw new Error(`evolution promote failed: ${promoteResult.output}`);
      }
      if (!promoteResult.output.includes("Snapshot:")) {
        throw new Error(`Expected promotion to create snapshot, got: ${promoteResult.output}`);
      }

      // Verify the skill file was patched
      const { readFileSync } = await import("node:fs");
      const afterPromote = readFileSync(join(skillDir, "SKILL.md"), "utf8");
      if (!afterPromote.includes("PATCHED_MARKER")) {
        throw new Error("Skill file was not patched after promotion");
      }

      // ── Rollback ──
      const rollbackResult = await evolutionCommand(cliOptions(tempHome), ["rollback", manifestId]);
      if (rollbackResult.exitCode !== 0) {
        throw new Error(`evolution rollback failed: ${rollbackResult.output}`);
      }
      if (!rollbackResult.output.includes("Rolled back")) {
        throw new Error(`Expected rollback confirmation, got: ${rollbackResult.output}`);
      }

      // Verify the skill file was restored
      const afterRollback = readFileSync(join(skillDir, "SKILL.md"), "utf8");
      if (!afterRollback.includes("ORIGINAL_MARKER")) {
        throw new Error("Skill file was not restored after rollback");
      }
      if (afterRollback.includes("PATCHED_MARKER")) {
        throw new Error("Skill file still contains patched marker after rollback");
      }

      // ── Manifest diff (read-only) ──
      const diffResult = await manifestCommand(cliOptions(tempHome), ["diff", manifestId]);
      if (diffResult.exitCode !== 0) {
        throw new Error(`manifest diff failed: ${diffResult.output}`);
      }
      if (!diffResult.output.includes("Proposed patch:")) {
        throw new Error(`Expected diff to show proposed patch, got: ${diffResult.output}`);
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  }
};
