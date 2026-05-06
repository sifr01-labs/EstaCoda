import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SmokeCase } from "../smoke-case.js";
import { evolutionCommand } from "../../cli/evolution-commands.js";
import { ChangeManifestStore } from "../../skills/change-manifest-store.js";
import { SkillEvolutionStore } from "../../skills/skill-evolution.js";

async function setupTempHome(): Promise<string> {
  const tempHome = mkdtempSync(join(tmpdir(), "estacoda-smoke-safety-"));
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

export const evolution_safety_case: SmokeCase = {
  id: "evolution-safety",
  name: "Evolution commands reject unsafe or unsupported operations",
  tags: ["evolution", "safety", "lifecycle"],
  run: async () => {
    const tempHome = await setupTempHome();

    try {
      const manifestStore = new ChangeManifestStore({
        root: join(tempHome, ".estacoda", "skills", ".evolution", "manifests")
      });
      const skillEvolutionStore = new SkillEvolutionStore({
        usagePath: join(tempHome, ".estacoda", "skills", ".usage.json"),
        evolutionRoot: join(tempHome, ".estacoda", "skills", ".evolution")
      });

      // ── 1. runtime_code target is blocked from promotion ──
      const runtimeManifest = await manifestStore.propose({
        target: "runtime_code",
        hypothesis: "test runtime_code block",
        predictedImpact: "none",
        riskLevel: "low",
        filesChanged: [],
        evidence: { traces: [], failures: [], evalCases: [] },
        rollbackPlan: "none",
        evalCommand: "bun run typecheck",
        constraintGates: ["bun run typecheck"]
      });
      await manifestStore.updateStatus(runtimeManifest.id, "approved");
      const runtimeResult = await evolutionCommand(cliOptions(tempHome), ["promote", runtimeManifest.id]);
      if (runtimeResult.exitCode !== 1 || !runtimeResult.output.includes("not permitted")) {
        throw new Error(`Expected runtime_code promotion blocked, got: ${runtimeResult.output}`);
      }

      // ── 2. Disallowed gate is blocked, no subprocess spawned ──
      const disallowedManifest = await manifestStore.propose({
        target: "skill",
        hypothesis: "test disallowed gate block",
        predictedImpact: "none",
        riskLevel: "low",
        filesChanged: [],
        evidence: { traces: [], failures: [], evalCases: [] },
        rollbackPlan: "none",
        evalCommand: "bun run typecheck",
        constraintGates: ["cat /etc/passwd"]
      });
      const disallowedResult = await evolutionCommand(cliOptions(tempHome), ["test", disallowedManifest.id]);
      if (disallowedResult.exitCode !== 1 || !disallowedResult.output.includes("BLOCKED")) {
        throw new Error(`Expected disallowed gate blocked, got: ${disallowedResult.output}`);
      }

      // ── 3. No gates defined fails with explicit message ──
      const noGatesManifest = await manifestStore.propose({
        target: "skill",
        hypothesis: "test no gates failure",
        predictedImpact: "none",
        riskLevel: "low",
        filesChanged: [],
        evidence: { traces: [], failures: [], evalCases: [] },
        rollbackPlan: "none",
        evalCommand: "",
        constraintGates: []
      });
      const noGatesResult = await evolutionCommand(cliOptions(tempHome), ["test", noGatesManifest.id]);
      if (noGatesResult.exitCode !== 1 || !noGatesResult.output.includes("No allowed gates defined")) {
        throw new Error(`Expected no-gates error, got: ${noGatesResult.output}`);
      }

      // ── 4. Missing snapshot rollback fails ──
      const missingSnapshotManifest = await manifestStore.propose({
        target: "skill",
        hypothesis: "test missing snapshot rollback",
        predictedImpact: "none",
        riskLevel: "low",
        filesChanged: [],
        evidence: { traces: [], failures: [], evalCases: [] },
        rollbackPlan: "restore previous version",
        evalCommand: "bun run typecheck",
        constraintGates: ["bun run typecheck"]
      });
      const proposal = await skillEvolutionStore.proposePatch({
        skillName: "missing-snapshot-skill",
        reason: "test rollback without snapshot",
        patch: { type: "text_patch", oldString: "old", newString: "new" },
        changeManifestId: missingSnapshotManifest.id
      });
      await skillEvolutionStore.recordPromotion({
        proposal,
        skillName: proposal.skillName,
        snapshotPath: join(tempHome, "nonexistent-snapshot")
      });
      await manifestStore.updateStatus(missingSnapshotManifest.id, "promoted");
      const missingSnapshotResult = await evolutionCommand(cliOptions(tempHome), ["rollback", missingSnapshotManifest.id]);
      if (missingSnapshotResult.exitCode !== 1 || !missingSnapshotResult.output.includes("snapshot missing SKILL.md")) {
        throw new Error(`Expected missing snapshot error, got: ${missingSnapshotResult.output}`);
      }

      // ── 5. tool_description promotion is rejected in v0.1.0 ──
      const toolDescManifest = await manifestStore.propose({
        target: "tool_description",
        hypothesis: "test tool_description block",
        predictedImpact: "none",
        riskLevel: "low",
        filesChanged: [],
        evidence: { traces: [], failures: [], evalCases: [] },
        rollbackPlan: "none",
        evalCommand: "bun run typecheck",
        constraintGates: ["bun run typecheck"]
      });
      await manifestStore.updateStatus(toolDescManifest.id, "approved");
      const toolDescResult = await evolutionCommand(cliOptions(tempHome), ["promote", toolDescManifest.id]);
      if (toolDescResult.exitCode !== 1 || !toolDescResult.output.includes("not supported in v0.1.0")) {
        throw new Error(`Expected tool_description not supported, got: ${toolDescResult.output}`);
      }

      // ── 6. tool_description rollback is also rejected ──
      await manifestStore.updateStatus(toolDescManifest.id, "promoted");
      const toolDescRollbackResult = await evolutionCommand(cliOptions(tempHome), ["rollback", toolDescManifest.id]);
      if (toolDescRollbackResult.exitCode !== 1 || !toolDescRollbackResult.output.includes("Rollback not supported because promotion was not supported")) {
        throw new Error(`Expected tool_description rollback blocked, got: ${toolDescRollbackResult.output}`);
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  }
};
