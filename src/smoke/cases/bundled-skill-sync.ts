import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SmokeCase } from "../smoke-case.js";
import { hashSkillDirectory, resetBundledSkill, syncBundledSkills } from "../../skills/skill-bundled-sync.js";
import { buildSkillFileContent } from "../../skills/skill-tools.js";

export const bundled_skill_sync_case: SmokeCase = {
  id: "bundled-skill-sync",
  name: "Bundled skill sync, update, and reset",
  tags: ["skills", "bundled", "sync"],
  run: async () => {
    const bundledSyncRoot = await mkdtemp(join(tmpdir(), "estacoda-bundled-sync-"));
    const bundledSyncLocalRoot = await mkdtemp(join(tmpdir(), "estacoda-bundled-local-"));
    const bundledNestedSkillDir = join(bundledSyncRoot, "media", "proof-skill");
    const bundledLocalSkillDir = join(bundledSyncLocalRoot, "media", "proof-skill");

    await mkdir(bundledNestedSkillDir, { recursive: true });
    await writeFile(
      join(bundledNestedSkillDir, "SKILL.md"),
      buildSkillFileContent({
        name: "bundled-proof-skill",
        description: "Bundled sync proof skill.",
        category: "research",
        whenToUse: ["when proving bundled sync"],
        requiredToolsets: ["core"],
        instructions: "Bundled instructions v1."
      }),
      "utf8"
    );

    const bundledSyncInitial = await syncBundledSkills({
      bundledSkillsDir: bundledSyncRoot,
      localSkillsRoot: bundledSyncLocalRoot
    });
    if (bundledSyncInitial.copied !== 1) {
      throw new Error("expected missing bundled skill to copy into local root");
    }

    const localSkillFile = await stat(join(bundledLocalSkillDir, "SKILL.md")).then((s) => s.isFile()).catch(() => false);
    if (!localSkillFile) {
      throw new Error("expected bundled sync to preserve relative skill path");
    }

    const manifest = await readFile(join(bundledSyncLocalRoot, ".bundled_manifest.json"), "utf8");
    if (!manifest.includes("bundled-proof-skill")) {
      throw new Error("expected bundled manifest to record synced skill");
    }

    // Update bundled source and re-sync
    await writeFile(
      join(bundledNestedSkillDir, "SKILL.md"),
      buildSkillFileContent({
        name: "bundled-proof-skill",
        description: "Bundled sync proof skill.",
        category: "research",
        whenToUse: ["when proving bundled sync"],
        requiredToolsets: ["core"],
        instructions: "Bundled instructions v2."
      }),
      "utf8"
    );

    const bundledSyncUpdated = await syncBundledSkills({
      bundledSkillsDir: bundledSyncRoot,
      localSkillsRoot: bundledSyncLocalRoot
    });
    if (bundledSyncUpdated.updated !== 1) {
      throw new Error("expected unmodified local bundled copy to receive bundled update");
    }

    const updatedContent = await readFile(join(bundledLocalSkillDir, "SKILL.md"), "utf8");
    if (!updatedContent.includes("Bundled instructions v2.")) {
      throw new Error("expected local bundled copy to contain updated bundled instructions");
    }

    const mediaEntries = await readdir(join(bundledSyncLocalRoot, "media"));
    if (mediaEntries.some((entry: string) => entry.includes(".bundled-backup-"))) {
      throw new Error("expected bundled sync to remove successful update backups");
    }

    // User modifies local copy; bundled update should not overwrite
    await writeFile(
      join(bundledLocalSkillDir, "SKILL.md"),
      buildSkillFileContent({
        name: "bundled-proof-skill",
        description: "Locally evolved bundled skill.",
        category: "research",
        whenToUse: ["when proving bundled sync"],
        requiredToolsets: ["core"],
        instructions: "Locally evolved instructions."
      }),
      "utf8"
    );
    await writeFile(
      join(bundledNestedSkillDir, "SKILL.md"),
      buildSkillFileContent({
        name: "bundled-proof-skill",
        description: "Bundled sync proof skill.",
        category: "research",
        whenToUse: ["when proving bundled sync"],
        requiredToolsets: ["core"],
        instructions: "Bundled instructions v3."
      }),
      "utf8"
    );

    const bundledSyncUserModified = await syncBundledSkills({
      bundledSkillsDir: bundledSyncRoot,
      localSkillsRoot: bundledSyncLocalRoot
    });
    if (bundledSyncUserModified.userModified !== 1) {
      throw new Error("expected user-modified bundled working copy to be preserved");
    }

    const userModifiedContent = await readFile(join(bundledLocalSkillDir, "SKILL.md"), "utf8");
    if (!userModifiedContent.includes("Locally evolved instructions.")) {
      throw new Error("expected bundled sync not to overwrite user-modified local skill");
    }

    // Rebaseline resets to bundled version
    const rebaselineResult = await resetBundledSkill({
      name: "bundled-proof-skill",
      mode: "rebaseline",
      bundledSkillsDir: bundledSyncRoot,
      localSkillsRoot: bundledSyncLocalRoot
    });
    if (!rebaselineResult.ok) {
      throw new Error("expected bundled rebaseline reset to succeed");
    }

    const rebaselineHash = await hashSkillDirectory(bundledLocalSkillDir);
    if (rebaselineHash.length !== 32) {
      throw new Error("expected bundled skill directory hash to be stable");
    }

    // Restore resets to bundled version
    const restoreResult = await resetBundledSkill({
      name: "bundled-proof-skill",
      mode: "restore",
      bundledSkillsDir: bundledSyncRoot,
      localSkillsRoot: bundledSyncLocalRoot
    });
    if (!restoreResult.ok) {
      throw new Error("expected bundled restore reset to succeed");
    }

    const restoredContent = await readFile(join(bundledLocalSkillDir, "SKILL.md"), "utf8");
    if (!restoredContent.includes("Bundled instructions v3.")) {
      throw new Error("expected bundled restore to replace local copy with bundled baseline");
    }

    // Ambiguous skill name should fail
    const ambiguousBundledRoot = await mkdtemp(join(tmpdir(), "estacoda-bundled-ambiguous-"));
    const ambiguousLocalRoot = await mkdtemp(join(tmpdir(), "estacoda-bundled-ambiguous-local-"));
    for (const relativeDir of ["alpha/duplicate", "beta/duplicate"]) {
      const skillDir = join(ambiguousBundledRoot, relativeDir);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        buildSkillFileContent({
          name: "duplicate-reset-skill",
          description: "Duplicate bundled reset smoke skill.",
          category: "testing",
          whenToUse: ["when proving ambiguous bundled reset names"],
          requiredToolsets: ["core"],
          instructions: `Duplicate bundled reset instructions from ${relativeDir}.`
        }),
        "utf8"
      );
    }
    await syncBundledSkills({
      bundledSkillsDir: ambiguousBundledRoot,
      localSkillsRoot: ambiguousLocalRoot
    });
    const ambiguousResetResult = await resetBundledSkill({
      name: "duplicate-reset-skill",
      mode: "restore",
      bundledSkillsDir: ambiguousBundledRoot,
      localSkillsRoot: ambiguousLocalRoot
    });
    if (ambiguousResetResult.ok) {
      throw new Error("expected ambiguous skill.reset name to fail");
    }
    if (!ambiguousResetResult.message.includes("alpha/duplicate") || !ambiguousResetResult.message.includes("beta/duplicate")) {
      throw new Error("expected ambiguous skill.reset error to include matching bundled paths");
    }

    // Deleted local skill should not be re-added
    await rm(bundledLocalSkillDir, { recursive: true, force: true });
    const bundledSyncDeletedLocal = await syncBundledSkills({
      bundledSkillsDir: bundledSyncRoot,
      localSkillsRoot: bundledSyncLocalRoot
    });
    if (bundledSyncDeletedLocal.skipped < 1) {
      throw new Error("expected deleted-by-user bundled skill not to be re-added");
    }
    const stillAbsent = await stat(bundledLocalSkillDir).then(() => false).catch(() => true);
    if (!stillAbsent) {
      throw new Error("expected deleted-by-user bundled skill to remain absent");
    }

    // Removed bundled source should clean manifest
    await rm(bundledNestedSkillDir, { recursive: true, force: true });
    const bundledSyncRemovedSource = await syncBundledSkills({
      bundledSkillsDir: bundledSyncRoot,
      localSkillsRoot: bundledSyncLocalRoot
    });
    if (bundledSyncRemovedSource.cleaned < 1) {
      throw new Error("expected removed bundled skill to clean manifest entry");
    }
    const cleanedManifest = await readFile(join(bundledSyncLocalRoot, ".bundled_manifest.json"), "utf8");
    if (cleanedManifest.includes("bundled-proof-skill")) {
      throw new Error("expected cleaned bundled manifest to omit removed skill");
    }
  }
};

async function stat(path: string) {
  const { stat: fsStat } = await import("node:fs/promises");
  return fsStat(path);
}
