import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalInspectTool } from "./terminal-inspect-tool.js";

const execFileAsync = promisify(execFile);

let tempDir: string | undefined;

async function makeTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "estacoda-terminal-inspect-test-"));
  return tempDir;
}

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("terminal.inspect", () => {
  it("registers as read-only local shell inspection", async () => {
    const root = await makeTempDir();
    const tool = createTerminalInspectTool({ workspaceRoot: root });

    expect(tool.name).toBe("terminal.inspect");
    expect(tool.riskClass).toBe("read-only-local");
    expect(tool.toolsets).toEqual(["shell-readonly", "coding", "research"]);
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      required: ["argv"],
      additionalProperties: false
    });
  });

  it("runs allowed argv commands without a shell", async () => {
    const root = await makeTempDir();
    const calls: Array<{ command: unknown; args: unknown; options: { shell?: unknown; cwd?: unknown } }> = [];
    const spawnImpl = ((command: unknown, args: unknown, options: { shell?: unknown; cwd?: unknown }) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      queueMicrotask(() => {
        child.stdout.end("workspace\n");
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    }) as unknown as typeof spawn;
    const tool = createTerminalInspectTool({ workspaceRoot: root, spawnImpl });
    const canonicalRoot = await realpath(root);

    const result = await tool.run({ argv: ["pwd"] });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("workspace");
    expect(calls).toEqual([
      expect.objectContaining({
        command: "pwd",
        args: [],
        options: expect.objectContaining({
          cwd: canonicalRoot,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"]
        })
      })
    ]);
  });

  it("allows bounded file inspection commands inside the workspace", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "notes.txt"), "alpha\nbeta\n", "utf8");
    const tool = createTerminalInspectTool({ workspaceRoot: root });

    const result = await tool.run({ argv: ["cat", "src/notes.txt"] });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("alpha");
    expect(result.content).toContain("beta");
    expect(result.metadata).toMatchObject({
      code: 0,
      signal: null,
      timedOut: false
    });
  });

  it("rejects shell syntax, wrappers, package scripts, and arbitrary binaries", async () => {
    const root = await makeTempDir();
    const tool = createTerminalInspectTool({ workspaceRoot: root });

    await expect(tool.run({ argv: ["ls", "|", "cat"] })).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("shell syntax")
    });
    await expect(tool.run({ argv: ["bash", "-lc", "ls"] })).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("not allowed")
    });
    await expect(tool.run({ argv: ["node", "-e", "console.log(1)"] })).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("not allowed")
    });
    await expect(tool.run({ argv: ["pnpm", "run", "build"] })).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("not allowed")
    });
  });

  it("rejects path traversal and path globs before execution", async () => {
    const root = await makeTempDir();
    const tool = createTerminalInspectTool({ workspaceRoot: root });

    await expect(tool.run({ argv: ["cat", "../outside.txt"] })).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("outside the trusted workspace")
    });
    await expect(tool.run({ argv: ["ls", "*.ts"] })).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("globs are not allowed")
    });
  });

  it("does not execute rejected shell redirection", async () => {
    const root = await makeTempDir();
    const tool = createTerminalInspectTool({ workspaceRoot: root });

    const result = await tool.run({ argv: ["ls", ">", "owned.txt"] });

    expect(result.ok).toBe(false);
    await expect(readFile(join(root, "owned.txt"), "utf8")).rejects.toBeDefined();
  });

  it("redacts secret-looking output before returning content or metadata", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "secret.txt"), "OPENAI_API_KEY=super-secret-value\n", "utf8");
    const tool = createTerminalInspectTool({ workspaceRoot: root });

    const result = await tool.run({ argv: ["cat", "secret.txt"] });
    const serialized = JSON.stringify(result);

    expect(result.ok).toBe(true);
    expect(serialized).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(serialized).not.toContain("super-secret-value");
  });

  it("bounds stdout by line and character count", async () => {
    const root = await makeTempDir();
    await writeFile(
      join(root, "long.txt"),
      Array.from({ length: 90 }, (_, index) => `line-${index + 1}`).join("\n"),
      "utf8"
    );
    const tool = createTerminalInspectTool({ workspaceRoot: root, maxOutputLines: 50, maxOutputChars: 1_000 });

    const result = await tool.run({ argv: ["cat", "long.txt"] });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("[output truncated]");
    expect(result.content).toContain("line-50");
    expect(result.content).not.toContain("line-90");
    expect(result.metadata).toMatchObject({
      stdoutTruncated: true
    });
  });

  it("allows hardened git inspection commands and rejects mutating or unsafe git subcommands", async () => {
    const root = await makeTempDir();
    await initGitRepo(root);
    const tool = createTerminalInspectTool({ workspaceRoot: root });

    await expect(tool.run({ argv: ["git", "status", "--short"] })).resolves.toMatchObject({
      ok: expect.any(Boolean),
      metadata: expect.objectContaining({
        argv: ["git", "status", "--short"]
      })
    });
    await expect(tool.run({ argv: ["git", "show", "HEAD"] })).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("git subcommand is not allowed")
    });
    await expect(tool.run({ argv: ["git", "checkout", "-b", "unsafe"] })).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("git subcommand is not allowed")
    });
  });

  it("does not execute repo-configured git diff.external helpers", async () => {
    const root = await makeTempDir();
    await initGitRepo(root);
    await writeFile(join(root, "a.txt"), "two\n", "utf8");
    const marker = join(root, "marker-diff-external");
    const helper = join(root, "extdiff.sh");
    await writeFile(helper, `#!/bin/sh\nprintf ran > "${marker}"\n`, "utf8");
    await chmod(helper, 0o700);
    await execFileAsync("git", ["config", "diff.external", helper], { cwd: root });
    const tool = createTerminalInspectTool({ workspaceRoot: root });

    const result = await tool.run({ argv: ["git", "diff"] });

    expect(result.metadata).toMatchObject({ argv: ["git", "diff"] });
    expect(result.content).toContain("two");
    await expect(access(marker)).rejects.toBeDefined();
  });

  it("does not execute repo-configured git core.fsmonitor helpers", async () => {
    const root = await makeTempDir();
    await initGitRepo(root);
    const marker = join(root, "marker-fsmonitor");
    const helper = join(root, "fsmonitor.sh");
    await writeFile(helper, `#!/bin/sh\nprintf ran > "${marker}"\n`, "utf8");
    await chmod(helper, 0o700);
    await execFileAsync("git", ["config", "core.fsmonitor", helper], { cwd: root });
    const tool = createTerminalInspectTool({ workspaceRoot: root });

    const result = await tool.run({ argv: ["git", "status", "--short"] });

    expect(result.metadata).toMatchObject({ argv: ["git", "status", "--short"] });
    await expect(access(marker)).rejects.toBeDefined();
  });

  it("rejects git show object reads that could escape a nested workspace root", async () => {
    const repoRoot = await makeTempDir();
    const workspaceRoot = join(repoRoot, "work");
    await mkdir(workspaceRoot);
    await writeFile(join(repoRoot, "secret.txt"), "outside-secret\n", "utf8");
    await writeFile(join(workspaceRoot, "inside.txt"), "inside\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.email", "a@example.com"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.name", "A"], { cwd: repoRoot });
    await execFileAsync("git", ["add", "secret.txt", "work/inside.txt"], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoRoot });
    const tool = createTerminalInspectTool({ workspaceRoot });

    await expect(tool.run({ argv: ["git", "show", "HEAD:secret.txt"] })).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("git subcommand is not allowed")
    });
    await expect(tool.run({ argv: ["git", "show", "HEAD"] })).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("git subcommand is not allowed")
    });
  });

  it("keeps git grep pathspecs workspace-contained and rejects revision object syntax", async () => {
    const repoRoot = await makeTempDir();
    const workspaceRoot = join(repoRoot, "work");
    await mkdir(workspaceRoot);
    await writeFile(join(repoRoot, "secret.txt"), "outside-secret\n", "utf8");
    await writeFile(join(workspaceRoot, "inside.txt"), "inside\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.email", "a@example.com"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.name", "A"], { cwd: repoRoot });
    await execFileAsync("git", ["add", "secret.txt", "work/inside.txt"], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoRoot });
    const tool = createTerminalInspectTool({ workspaceRoot });

    await expect(tool.run({ argv: ["git", "grep", "outside", "HEAD:secret.txt"] })).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("revision or magic pathspec syntax is not allowed")
    });

    const broadSearch = await tool.run({ argv: ["git", "grep", "outside"] });
    expect(JSON.stringify(broadSearch)).not.toContain("outside-secret");

    const containedSearch = await tool.run({ argv: ["git", "grep", "inside", "inside.txt"] });
    expect(containedSearch.ok).toBe(true);
    expect(containedSearch.content).toContain("inside.txt:inside");
  });

  it("passes git grep path arguments only after a pathspec separator", async () => {
    const root = await makeTempDir();
    await initGitRepo(root);
    const calls: Array<{ command: unknown; args: unknown }> = [];
    const spawnImpl = ((command: unknown, args: unknown) => {
      calls.push({ command, args });
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      queueMicrotask(() => {
        child.stdout.end("a.txt:one\n");
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    }) as unknown as typeof spawn;
    const tool = createTerminalInspectTool({ workspaceRoot: root, spawnImpl });

    const result = await tool.run({ argv: ["git", "grep", "-n", "one", "a.txt"] });

    expect(result.ok).toBe(true);
    expect(calls[0]?.command).toBe("git");
    const args = calls[0]?.args as string[];
    const grepIndex = args.indexOf("grep");
    expect(args.slice(grepIndex, grepIndex + 5)).toEqual(["grep", "-n", "one", "--", "a.txt"]);
  });
});

async function initGitRepo(root: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "a@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "A"], { cwd: root });
  await writeFile(join(root, "a.txt"), "one\n", "utf8");
  await execFileAsync("git", ["add", "a.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
}
