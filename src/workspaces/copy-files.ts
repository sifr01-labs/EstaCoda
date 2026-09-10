import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { explainPathBlock } from "../context/context-security.js";

export const COPY_LIMITS = { files: 512, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 } as const;
export type FileSnapshot = { sha256: string; content: string; mode: number };
export type DirectoryStamp = { dev: number; ino: number };
export const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export function copyPath(path: unknown): string {
  if (typeof path !== "string" || !path || path.length > 1024 || isAbsolute(path) || /[\\\x00-\x1f]/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === ".." || [".git", ".estacoda", ".ssh", ".aws", ".docker", ".gnupg", ".config"].includes(part) || /^\.env(?:\.|$)/u.test(part)) ||
    explainPathBlock("/workspace", resolve("/workspace", path))) throw new Error("Unsafe copy/application path.");
  return path;
}
export function stamp(root: string): DirectoryStamp {
  const info = fs.lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error("Workspace directory identity changed.");
  return { dev: info.dev, ino: info.ino };
}
export function checkStamp(root: string, expected: DirectoryStamp): void {
  const current = stamp(root);
  if (current.dev !== expected.dev || current.ino !== expected.ino) throw new Error("Workspace directory was replaced.");
}
export function checkedFile(root: string, path: string, allowLinked = false): string {
  copyPath(path); stamp(root);
  const parts = path.split("/"); let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const info = fs.lstatSync(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile()) || (info.nlink > (allowLinked ? 2 : 1)) && info.isFile()) throw new Error("Copy paths require directories and unlinked regular files; symlinks and special files are forbidden.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return current;
}
export function snapshot(root: string, path: string, allowLinked = false): FileSnapshot | null {
  const file = checkedFile(root, path, allowLinked);
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink > (allowLinked ? 2 : 1) || before.size > COPY_LIMITS.fileBytes || before.mode & 0o7000) throw new Error("Copy file exceeds limits or has unsafe mode/type.");
    const bytes = Buffer.alloc(before.size + 1); let count = 0;
    while (count < bytes.length) { const n = fs.readSync(fd, bytes, count, bytes.length - count, count); if (!n) break; count += n; }
    const after = fs.fstatSync(fd);
    if (count !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Source changed during snapshot. Retry preparation.");
    const content = bytes.subarray(0, count);
    return { sha256: hash(content), content: content.toString("base64"), mode: before.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}
export function sameFile(a: FileSnapshot | null, b: FileSnapshot | null): boolean { return a === null || b === null ? a === b : a.sha256 === b.sha256 && a.mode === b.mode; }
export function validateSnapshot(value: FileSnapshot | null): void {
  if (value === null) return;
  if (!value || typeof value.content !== "string" || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777 ||
    Buffer.byteLength(value.content) > Math.ceil(COPY_LIMITS.fileBytes / 3) * 4 || Buffer.from(value.content, "base64").toString("base64") !== value.content || hash(Buffer.from(value.content, "base64")) !== value.sha256) throw new Error("Invalid file snapshot.");
}
export function writeNew(root: string, path: string, file: FileSnapshot): void {
  const destination = checkedFile(root, path);
  fs.mkdirSync(dirname(destination), { recursive: true }); checkedFile(root, path);
  const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, file.mode);
  try { fs.writeFileSync(fd, Buffer.from(file.content, "base64")); fs.fchmodSync(fd, file.mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function separateRoots(a: string, b: string): void {
  for (const [left, right] of [[a, b], [b, a]]) {
    const rel = relative(left!, right!);
    if (rel === "" || rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) throw new Error("Source and copy must be separate, non-nested directories.");
  }
}
