import { homedir } from "node:os";
import { relative, isAbsolute, join } from "node:path";
import { resolveGlobalStateHome } from "../config/profile-home.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmdirSync, lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ExecutionTargetStore, targetBinding } from "./execution-target.js";
import type { TemporaryCopyTarget } from "../contracts/workspace.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { COPY_LIMITS, checkStamp, copyPath, hash, snapshot, stamp, writeNew, separateRoots, type FileSnapshot, type DirectoryStamp } from "./copy-files.js";

function safeCopyRoot(root: string, homeDir?: string): void {
  const protectedRoots = [resolveGlobalStateHome({ homeDir }).stateRoot, "/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/etc", "/proc", "/sys", "/dev", "/run", "/var/run", "/var/lib/docker", ...[".ssh", ".aws", ".docker", ".gnupg", ".config"].map((name) => join(homedir(), name))];
  if (root === "/" || root === homedir()) throw new Error("Copy roots cannot be host or home roots.");
  for (const protectedRoot of protectedRoots) {
    let canonical = protectedRoot; try { canonical = realpathSync(protectedRoot); } catch { /* Absent protected roots still reserve their path. */ }
    const rel = relative(canonical, root);
    if (rel === "" || rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) throw new Error("Copy roots cannot use runtime or credential state.");
  }
}

export type CopyInputManifest = { version: 1; files: Array<{ path: string; origin: "tracked" | "untracked" | "dependency" }> };
export type SourceManifest = { version: 1; sourceStamp: DirectoryStamp; entries: Array<{ path: string; origin: "tracked" | "untracked" | "dependency"; baseline: FileSnapshot }> };
export function parseCopyInput(value: unknown): CopyInputManifest {
  const input = value as CopyInputManifest;
  if (!input || input.version !== 1 || !Array.isArray(input.files) || !input.files.length || input.files.length > COPY_LIMITS.files) throw new Error("Copy manifest requires 1–512 explicit files.");
  const seen = new Set<string>();
  for (const entry of input.files) {
    copyPath(entry?.path);
    if (!["tracked", "untracked", "dependency"].includes(entry.origin) || seen.has(entry.path) || entry.path.split("/").includes("node_modules") && entry.origin !== "dependency") throw new Error("Invalid/duplicate manifest entry or undeclared dependency.");
    seen.add(entry.path);
  }
  return structuredClone(input);
}
export async function prepareTemporaryCopy(options: { homeDir?: string; profileId: string; source: string; destination: string; manifest: unknown }): Promise<TemporaryCopyTarget> {
  const input = parseCopyInput(options.manifest);
  const store = new ExecutionTargetStore(options);
  let created = false;
  const destination = resolve(realpathSync(dirname(resolve(options.destination))), resolve(options.destination).split("/").at(-1)!);
  try {
    const source = await store.resolve(options.source);
    if (!await new WorkspaceTrustStore(options).isTrusted(source.identity.canonicalPath)) throw new Error("Trust the source workspace through local setup first.");
    safeCopyRoot(source.identity.canonicalPath, options.homeDir); safeCopyRoot(destination, options.homeDir);
    separateRoots(source.identity.canonicalPath, destination);
    try { lstatSync(destination); throw new Error("Copy destination must not exist."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const sourceStamp = stamp(source.identity.canonicalPath);
    const git = (args: string[]) => execFileSync("git", ["-C", source.identity.canonicalPath, ...args], { cwd: "/", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).toString();
    let gitSource = true;
    try { git(["rev-parse", "--is-inside-work-tree"]); }
    catch (error) {
      if ((error as { status?: number }).status === 128 && String((error as { stderr?: Buffer }).stderr).includes("not a git repository")) gitSource = false;
      else throw new Error("Git source inspection failed.");
    }
    let tracked = new Set<string>();
    if (input.files.some((entry) => entry.origin === "tracked")) tracked = new Set(git(["ls-files", "-z", "--cached"]).split("\0"));
    let bytes = 0;
    const entries = input.files.map((entry) => {
      if (entry.origin === "tracked" && !tracked.has(entry.path)) throw new Error("Manifest tracked input is not tracked by Git.");
      if (entry.origin === "untracked" && gitSource) {
        try { git(["check-ignore", "--quiet", "--", entry.path]); throw new Error("Ignored files require explicit dependency selection and cannot become application inputs."); }
        catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
      }
      const baseline = snapshot(source.identity.canonicalPath, entry.path);
      if (!baseline) throw new Error("Manifest input is missing.");
      bytes += Buffer.from(baseline.content, "base64").length;
      if (bytes > COPY_LIMITS.totalBytes) throw new Error("Copy exceeds the 32 MiB total limit.");
      return { ...entry, baseline };
    }).sort((a, b) => a.path.localeCompare(b.path));
    checkStamp(source.identity.canonicalPath, sourceStamp);
    const manifest: SourceManifest = { version: 1, sourceStamp, entries };
    mkdirSync(destination, { mode: 0o700 }); created = true;
    for (const entry of entries) writeNew(destination, entry.path, entry.baseline);
    const target = await store.registerCopy({ id: `target_${randomUUID()}`, source: { identity: source.identity, registeredWorkspaceId: source.id, registeredWorkspaceRevision: source.locationRevision },
      workspaceRoot: destination, manifest, manifestHash: hash(JSON.stringify(manifest)), directoryStamp: stamp(destination) });
    await store.validate(targetBinding(target), destination);
    return target;
  } catch (error) {
    // Never recursively erase partially prepared files: they are reviewable evidence.
    if (created) { try { rmdirSync(destination); } catch { /* Nonempty copy retained; no target or authority is inferred. */ } }
    throw error;
  } finally { store.close(); }
}
