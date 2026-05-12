import { readFile, mkdir, rm, cp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import type { PackManifest, PackStatus } from "../contracts/pack.js";
import { PackRegistry } from "./pack-registry.js";
import { validatePackManifest } from "./pack-validator.js";
import { classifyPackRisk } from "./pack-risk-classifier.js";
import { renderPackReview } from "./pack-install-renderer.js";
import { writePackForceAuditRecord } from "./pack-force-audit-log.js";
import type { Prompt } from "../cli/readline-prompt.js";

export type InstallPackOptions = {
  homeDir: string;
  sourcePath: string;
  actor: string;
  force?: boolean;
  prompt?: Prompt;
};

export type EnablePackOptions = {
  homeDir: string;
  id: string;
  actor: string;
  force?: boolean;
  prompt?: Prompt;
};

export type DisablePackOptions = {
  homeDir: string;
  id: string;
};

export type UninstallPackOptions = {
  homeDir: string;
  id: string;
  actor: string;
  keepFiles?: boolean;
};

function hashManifest(manifest: PackManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 16);
}

async function loadManifestFromPath(
  sourcePath: string
): Promise<{ ok: true; manifest: PackManifest } | { ok: false; errors: string[] }> {
  const manifestPath = join(sourcePath, "pack.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, errors: [`pack.json not found in ${sourcePath}`] };
  }
  try {
    const text = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(text);
    return validatePackManifest(parsed);
  } catch (e) {
    return { ok: false, errors: [`Failed to read pack.json: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

async function copyPack(sourcePath: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  await cp(sourcePath, destPath, { recursive: true, force: true });
}

async function createBackup(sourcePath: string, backupsDir: string, id: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `${id}-${timestamp}`;
  const backupPath = join(backupsDir, backupName);
  await mkdir(backupsDir, { recursive: true });
  await cp(sourcePath, backupPath, { recursive: true, force: true });
  return backupPath;
}

async function findSkillDirectories(root: string): Promise<string[]> {
  const results: string[] = [];
  async function scan(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    // Check if the current directory itself is a skill directory
    if (existsSync(join(dir, "SKILL.md"))) {
      results.push(dir);
    }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childPath = join(dir, entry.name);
      await scan(childPath);
    }
  }
  await scan(root);
  return results;
}

async function materializePackSkills(packPath: string, destRoot: string): Promise<void> {
  const skillDirs = await findSkillDirectories(packPath);
  if (skillDirs.length === 0) return;
  await mkdir(destRoot, { recursive: true });
  for (const skillDir of skillDirs) {
    const rel = relative(packPath, skillDir);
    const dest = join(destRoot, rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(skillDir, dest, { recursive: true, force: true });
  }
}

async function runForceOverrideFlow(
  manifest: PackManifest,
  risk: { level: string; reasons: string[] },
  actor: string,
  prompt: Prompt | undefined,
  homeDir: string
): Promise<{ ok: boolean; output: string }> {
  const lines: string[] = [];
  lines.push("DANGER: --force override. This pack is BLOCKED. Intended for expert/local development use only.");
  lines.push("");
  lines.push(renderPackReview(manifest, risk as { level: "low" | "medium" | "high" | "blocked"; reasons: string[] }));
  lines.push("");

  if (prompt === undefined) {
    return { ok: false, output: "Blocked pack requires interactive confirmation. Run without --force or provide an interactive terminal." };
  }

  const confirmation = await prompt(`Type the pack id to confirm override: ${manifest.id}`);
  if (confirmation.trim() !== manifest.id) {
    return { ok: false, output: "Override aborted: id mismatch." };
  }

  await writePackForceAuditRecord(
    { homeDir },
    {
      timestamp: new Date().toISOString(),
      packId: manifest.id,
      version: manifest.version,
      manifestHash: hashManifest(manifest),
      riskReasons: risk.reasons,
      overrideActor: actor
    }
  );

  return { ok: true, output: lines.join("\n") };
}

export async function installPack(
  options: InstallPackOptions
): Promise<{ ok: boolean; exitCode: number; output: string }> {
  const { homeDir, sourcePath, actor, force, prompt } = options;

  if (!existsSync(sourcePath)) {
    return { ok: false, exitCode: 1, output: `Source path does not exist: ${sourcePath}` };
  }

  const manifestResult = await loadManifestFromPath(sourcePath);
  if (!manifestResult.ok) {
    return {
      ok: false,
      exitCode: 1,
      output: `Validation failed:\n${manifestResult.errors.map((e) => `  - ${e}`).join("\n")}`
    };
  }
  const manifest = manifestResult.manifest;

  const risk = classifyPackRisk(manifest);

  if (risk.level === "blocked") {
    if (!force) {
      return {
        ok: false,
        exitCode: 3,
        output: `Blocked: ${risk.reasons.join("; ")}\n\n${renderPackReview(manifest, risk)}`
      };
    }
    const forceResult = await runForceOverrideFlow(manifest, risk, actor, prompt, homeDir);
    if (!forceResult.ok) {
      return { ok: false, exitCode: 2, output: forceResult.output };
    }
  }

  const isExternal = manifest.provenance.origin === "external";

  // Medium/high risk requires confirmation for ALL origins
  const needsConfirmation = risk.level === "medium" || risk.level === "high";
  if (needsConfirmation) {
    if (prompt === undefined) {
      return {
        ok: false,
        exitCode: 2,
        output: "This pack requires interactive confirmation. Run without --force or provide an interactive terminal."
      };
    }
    const review = renderPackReview(manifest, risk);
    const answer = await prompt(`${review}\n\nDo you want to install this pack? (yes/no)`);
    if (answer.trim().toLowerCase() !== "yes") {
      return { ok: false, exitCode: 2, output: "Installation aborted by user." };
    }
  }

  const packsDir = join(homeDir, ".estacoda", "packs");
  const destPath = join(packsDir, manifest.id);

  if (existsSync(destPath)) {
    const backupsDir = join(packsDir, "backups");
    await createBackup(destPath, backupsDir, manifest.id);
    await rm(destPath, { recursive: true, force: true });
  }

  await copyPack(sourcePath, destPath);

  // Risk-aware status policy
  let computedStatus: PackStatus;
  if (isExternal) {
    computedStatus = "disabled";
  } else if (risk.level === "blocked" || risk.level === "medium" || risk.level === "high") {
    computedStatus = "disabled";
  } else {
    computedStatus = "enabled";
  }

  const registry = new PackRegistry({ homeDir });
  const installResult = await registry.install(manifest, actor, { status: computedStatus });
  if (!installResult.ok) {
    await rm(destPath, { recursive: true, force: true });
    return { ok: false, exitCode: 1, output: `Registry error: ${installResult.errors.join("; ")}` };
  }

  const status = installResult.entry.status;
  const skillsDest = join(homeDir, ".estacoda", "skills", "packs", manifest.id);
  if (status === "enabled" && !existsSync(skillsDest)) {
    await materializePackSkills(destPath, skillsDest);
  }

  const lines: string[] = [];
  lines.push(`Installed pack: ${manifest.name} (${manifest.id})`);
  lines.push(`Status: ${status}`);
  lines.push(`Risk: ${risk.level}`);
  if (manifest.evals !== undefined && manifest.evals.length > 0) {
    lines.push("Eval hooks are not executed in EstaCoda v0.1.0");
  }
  if (status === "enabled") {
    lines.push(`Skills copied to: ${skillsDest}`);
    lines.push("Note: Start a new session for skills to be available.");
  } else {
    lines.push(`Enable with: estacoda packs enable ${manifest.id}`);
  }

  return { ok: true, exitCode: 0, output: lines.join("\n") };
}

export async function enablePack(
  options: EnablePackOptions
): Promise<{ ok: boolean; exitCode: number; output: string }> {
  const { homeDir, id, actor, force, prompt } = options;

  const registry = new PackRegistry({ homeDir });
  const entry = await registry.find(id);
  if (entry === undefined) {
    return { ok: false, exitCode: 1, output: `pack not found: ${id}` };
  }

  const packPath = join(homeDir, ".estacoda", "packs", id);
  if (!existsSync(packPath)) {
    return { ok: false, exitCode: 1, output: `pack files missing: ${packPath}` };
  }

  const manifestResult = await loadManifestFromPath(packPath);
  if (!manifestResult.ok) {
    return {
      ok: false,
      exitCode: 1,
      output: `Manifest validation failed:\n${manifestResult.errors.map((e) => `  - ${e}`).join("\n")}`
    };
  }
  const manifest = manifestResult.manifest;

  const risk = classifyPackRisk(manifest);
  if (risk.level === "blocked") {
    if (!force) {
      return {
        ok: false,
        exitCode: 3,
        output: `Blocked: ${risk.reasons.join("; ")}\n\n${renderPackReview(manifest, risk)}`
      };
    }
    const forceResult = await runForceOverrideFlow(manifest, risk, actor, prompt, homeDir);
    if (!forceResult.ok) {
      return { ok: false, exitCode: 2, output: forceResult.output };
    }
  }

  const skillsDest = join(homeDir, ".estacoda", "skills", "packs", id);
  if (existsSync(skillsDest)) {
    const backupsDir = join(homeDir, ".estacoda", "packs", "backups");
    await createBackup(skillsDest, backupsDir, id);
    await rm(skillsDest, { recursive: true, force: true });
  }

  await materializePackSkills(packPath, skillsDest);
  await registry.updateStatus(id, "enabled");

  const lines: string[] = [];
  lines.push(`Enabled pack: ${manifest.name} (${id})`);
  if (manifest.evals !== undefined && manifest.evals.length > 0) {
    lines.push("Eval hooks are not executed in EstaCoda v0.1.0");
  }
  lines.push("Note: Start a new session for skills to be available.");

  return { ok: true, exitCode: 0, output: lines.join("\n") };
}

export async function disablePack(
  options: DisablePackOptions
): Promise<{ ok: boolean; exitCode: number; output: string }> {
  const { homeDir, id } = options;

  const registry = new PackRegistry({ homeDir });
  const entry = await registry.find(id);
  if (entry === undefined) {
    return { ok: false, exitCode: 1, output: `pack not found: ${id}` };
  }

  const skillsDest = join(homeDir, ".estacoda", "skills", "packs", id);
  if (existsSync(skillsDest)) {
    await rm(skillsDest, { recursive: true, force: true });
  }

  await registry.updateStatus(id, "disabled");

  return {
    ok: true,
    exitCode: 0,
    output: `Disabled pack: ${entry.manifest.name} (${id})\nNote: Start a new session for changes to take full effect.`
  };
}

export async function uninstallPack(
  options: UninstallPackOptions
): Promise<{ ok: boolean; exitCode: number; output: string }> {
  const { homeDir, id, actor, keepFiles } = options;

  const registry = new PackRegistry({ homeDir });
  const entry = await registry.find(id);
  if (entry === undefined) {
    return { ok: false, exitCode: 1, output: `pack not found: ${id}` };
  }

  const packPath = join(homeDir, ".estacoda", "packs", id);
  const skillsDest = join(homeDir, ".estacoda", "skills", "packs", id);

  if (existsSync(packPath)) {
    const backupsDir = join(homeDir, ".estacoda", "packs", "backups");
    await createBackup(packPath, backupsDir, id);
  }

  if (existsSync(skillsDest)) {
    await rm(skillsDest, { recursive: true, force: true });
  }

  await registry.remove(id);

  if (!keepFiles && existsSync(packPath)) {
    await rm(packPath, { recursive: true, force: true });
  }

  const lines: string[] = [];
  lines.push(`Uninstalled pack: ${entry.manifest.name} (${id})`);
  if (keepFiles) {
    lines.push(`Pack files preserved at: ${packPath}`);
  }
  lines.push("Note: Start a new session for changes to take full effect.");

  return { ok: true, exitCode: 0, output: lines.join("\n") };
}
