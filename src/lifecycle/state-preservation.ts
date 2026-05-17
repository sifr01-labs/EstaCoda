import { mkdir, copyFile, stat, readdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

export type ProtectedPath = {
  source: string;
  label: string;
};

export function getProtectedPaths(homeDir: string, workspaceRoot?: string): ProtectedPath[] {
  const root = join(homeDir, ".estacoda");
  const paths: ProtectedPath[] = [
    { source: join(root, "active-profile.json"), label: "active profile pointer" },
    { source: join(root, "profiles"), label: "profile state directories" },
    { source: join(root, "trust.json"), label: "trust store" },
    { source: join(root, "workspace-approvals.json"), label: "workspace approvals" },
    { source: join(root, "sessions.sqlite"), label: "session database" },
    { source: join(root, "memory", "shared"), label: "shared memory directory" },
    { source: join(root, "packs", "registry.jsonl"), label: "pack registry" }
  ];

  if (workspaceRoot !== undefined) {
    paths.push({
      source: join(workspaceRoot, ".estacoda", "config.json"),
      label: "project config"
    });
  }

  return paths;
}

export async function backupState(options: {
  homeDir: string;
  workspaceRoot?: string;
  label?: string;
}): Promise<{ backupPath: string; backedUp: string[]; skipped: string[] }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const label = options.label ?? `update-${timestamp}`;
  const backupPath = join(options.homeDir, ".estacoda", ".backups", label);
  const protectedPaths = getProtectedPaths(options.homeDir, options.workspaceRoot);
  const backedUp: string[] = [];
  const skipped: string[] = [];

  await mkdir(backupPath, { recursive: true });

  for (const item of protectedPaths) {
    if (!existsSync(item.source)) {
      skipped.push(`${item.label} (${item.source}) — not found`);
      continue;
    }

    try {
      const relative = item.source.replace(join(options.homeDir, ".estacoda"), "").replace(/^\//, "");
      const dest = join(backupPath, relative);
      await mkdir(dirname(dest), { recursive: true });
      const s = await stat(item.source);

      if (s.isDirectory()) {
        await copyDirectory(item.source, dest);
      } else {
        await copyFile(item.source, dest);
      }

      backedUp.push(`${item.label} (${relative})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skipped.push(`${item.label} — ${message}`);
    }
  }

  return { backupPath, backedUp, skipped };
}

export async function restoreState(backupPath: string): Promise<{ restored: string[]; failed: string[] }> {
  const restored: string[] = [];
  const failed: string[] = [];

  if (!existsSync(backupPath)) {
    return { restored, failed: [`Backup path does not exist: ${backupPath}`] };
  }

  const homeDir = join(backupPath, "..", "..", "..");
  const estacodaRoot = join(homeDir, ".estacoda");

  const entries = await readdir(backupPath, { recursive: true, withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) continue;

    const relativePath = entry.parentPath.replace(backupPath, "").replace(/^\//, "");
    const destPath = join(estacodaRoot, relativePath, entry.name);

    try {
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(join(entry.parentPath, entry.name), destPath);
      restored.push(destPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push(`${destPath}: ${message}`);
    }
  }

  return { restored, failed };
}

async function copyDirectory(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

export async function isBackupReady(homeDir: string): Promise<{ ok: boolean; reason?: string }> {
  const backupsDir = join(homeDir, ".estacoda", ".backups");
  try {
    await mkdir(backupsDir, { recursive: true });
    const testFile = join(backupsDir, ".write-test");
    await writeFileAtomic(testFile, "ok");
    await rm(testFile, { force: true });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message };
  }
}

async function writeFileAtomic(path: string, data: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, data, "utf8");
}
