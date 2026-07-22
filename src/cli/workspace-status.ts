import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type WorkspaceStatusSnapshot = {
  readonly label: string;
  readonly shortLabel: string;
  readonly branch?: string;
};

export async function resolveWorkspaceStatus(
  workspaceRoot: string,
  options: { readonly userHome?: string } = {}
): Promise<WorkspaceStatusSnapshot> {
  const root = resolve(workspaceRoot);
  const branch = await readWorkspaceBranch(root);
  return {
    label: formatWorkspaceLabel(root, options.userHome ?? homedir()),
    shortLabel: sanitizeTerminalText(basename(root) || root),
    ...(branch === undefined ? {} : { branch }),
  };
}

export function formatWorkspaceLabel(workspaceRoot: string, userHome: string): string {
  const root = resolve(workspaceRoot);
  const home = resolve(userHome);
  const homeRelative = relative(home, root);
  if (homeRelative === "") return "~";
  if (!homeRelative.startsWith(`..${sep}`) && homeRelative !== ".." && !isAbsolute(homeRelative)) {
    return sanitizeTerminalText(compactPath(`~/${toForwardSlashes(homeRelative)}`));
  }
  return sanitizeTerminalText(compactPath(toForwardSlashes(root)));
}

async function readWorkspaceBranch(workspaceRoot: string): Promise<string | undefined> {
  const gitEntry = join(workspaceRoot, ".git");
  const directHead = await readBoundedText(join(gitEntry, "HEAD"), 1_024);
  const head = directHead ?? await readWorktreeHead(gitEntry);
  if (head === undefined) return undefined;

  const prefix = "ref: refs/heads/";
  const trimmedHead = head.trim();
  if (!trimmedHead.startsWith(prefix)) return undefined;
  const branch = trimmedHead.slice(prefix.length).trim();
  if (branch.length === 0 || branch.length > 256 || hasUnsafeTerminalCodePoint(branch)) return undefined;
  return branch;
}

async function readWorktreeHead(gitEntry: string): Promise<string | undefined> {
  const pointer = (await readBoundedText(gitEntry, 4_096))?.trim();
  const prefix = "gitdir:";
  if (pointer === undefined || !pointer.startsWith(prefix)) return undefined;
  const gitDirectory = pointer.slice(prefix.length).trim();
  if (gitDirectory.length === 0 || hasUnsafeTerminalCodePoint(gitDirectory)) return undefined;
  return readBoundedText(join(resolve(dirname(gitEntry), gitDirectory), "HEAD"), 1_024);
}

async function readBoundedText(path: string, maxBytes: number): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return undefined;
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function compactPath(value: string): string {
  const prefix = value.startsWith("~/") ? "~/" : value.startsWith("/") ? "/" : "";
  const body = value.slice(prefix.length);
  const parts = body.split("/").filter((part) => part.length > 0);
  if (parts.length <= 3) return `${prefix}${parts.join("/")}`;
  return `${prefix}${parts[0]}/…/${parts.at(-1)}`;
}

function toForwardSlashes(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

function sanitizeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "�");
}

function hasUnsafeTerminalCodePoint(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
}
