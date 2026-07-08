import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStateTracker } from "../delegation/file-state-tracker.js";
import { createWorkspaceTools } from "./workspace-tools.js";

let tempDir: string | undefined;

async function makeTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "estacoda-workspace-tools-test-"));
  return tempDir;
}

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("workspace file change preview metadata", () => {
  it("attaches bounded preview metadata for file.write", async () => {
    const root = await makeTempDir();
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const write = tools.find((tool) => tool.name === "file.write");

    const result = await write?.run({
      path: "notes.md",
      content: Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"),
    });

    expect(result?.ok).toBe(true);
    expect(result?.metadata?.path).toBe("notes.md");
    expect(result?.metadata?.fileChangePreview).toMatchObject({
      kind: "fileChangePreview",
      path: "notes.md",
      changeType: "added",
      omittedLineCount: 2,
    });
    const preview = result?.metadata?.fileChangePreview as { diff?: string } | undefined;
    expect(preview?.diff).toContain("+ line 1");
    expect(preview?.diff).not.toContain("+ line 10");
  });

  it("does not expose the retired file.replace tool", async () => {
    const root = await makeTempDir();
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const retiredToolName = ["file", "replace"].join(".");

    expect(tools.find((tool) => tool.name === retiredToolName)).toBeUndefined();
  });

  it("attaches exact replacement preview metadata for file.patch", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "app.ts"), "const value = 1;\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const result = await patch?.run({
      path: "app.ts",
      old_string: "const value = 1;",
      new_string: "const value = 2;",
    });

    expect(result?.ok).toBe(true);
    expect(result?.metadata?.matchCount).toBe(1);
    expect(result?.metadata?.fileChangePreview).toMatchObject({
      kind: "fileChangePreview",
      path: "app.ts",
      changeType: "modified",
      omittedLineCount: 0,
    });
    const preview = result?.metadata?.fileChangePreview as { diff?: string } | undefined;
    expect(preview?.diff).toContain("- const value = 1;");
    expect(preview?.diff).toContain("+ const value = 2;");
  });

  it("requires unique file.patch matches unless replace_all is true", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "notes.md"), "todo\ntodo\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const ambiguous = await patch?.run({
      path: "notes.md",
      old_string: "todo",
      new_string: "done"
    });
    const replaced = await patch?.run({
      path: "notes.md",
      old_string: "todo",
      new_string: "done",
      replace_all: true
    });

    expect(ambiguous?.ok).toBe(false);
    expect(ambiguous?.content).toContain("old_string appears more than once");
    expect(replaced?.ok).toBe(true);
    expect(replaced?.metadata?.matchCount).toBe(2);
  });
});

describe("workspace file-state tracking", () => {
  it("records successful file.read metadata without file contents", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "notes.md"), "secret file contents", "utf8");
    const tracker = new FileStateTracker();
    const tools = createWorkspaceTools({
      workspaceRoot: root,
      fileStateTracker: tracker,
      sessionId: "session-1"
    });
    const read = tools.find((tool) => tool.name === "file.read");

    const result = await read?.run({ path: "notes.md" });

    expect(result?.ok).toBe(true);
    expect(tracker.listOperations()).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        path: "notes.md",
        normalizedPath: "notes.md",
        operation: "read",
        sourceTool: "file.read",
        metadata: {
          bytes: 20,
          previewAvailable: false
        }
      })
    ]);
    expect(JSON.stringify(tracker.listOperations())).not.toContain("secret file contents");
  });

  it("records successful file.write metadata with changed and preview flags", async () => {
    const root = await makeTempDir();
    const tracker = new FileStateTracker();
    const tools = createWorkspaceTools({
      workspaceRoot: root,
      fileStateTracker: tracker,
      sessionId: "session-1"
    });
    const write = tools.find((tool) => tool.name === "file.write");

    const result = await write?.run({ path: "notes.md", content: "new content" });

    expect(result?.ok).toBe(true);
    expect(tracker.listWrites("session-1")).toEqual([
      expect.objectContaining({
        path: "notes.md",
        operation: "write",
        sourceTool: "file.write",
        metadata: {
          bytes: 11,
          changed: true,
          previewAvailable: true
        }
      })
    ]);
  });

  it("records successful file.patch metadata", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "app.ts"), "const value = 1;\n", "utf8");
    const tracker = new FileStateTracker();
    const tools = createWorkspaceTools({
      workspaceRoot: root,
      fileStateTracker: tracker,
      sessionId: "session-1"
    });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const result = await patch?.run({
      path: "app.ts",
      old_string: "const value = 1;",
      new_string: "const value = 2;"
    });

    expect(result?.ok).toBe(true);
    expect(tracker.listWrites("session-1")).toEqual([
      expect.objectContaining({
        path: "app.ts",
        operation: "replace",
        sourceTool: "file.patch",
        metadata: {
          bytes: 17,
          changed: true,
          previewAvailable: true
        }
      })
    ]);
  });

  it("does not record failed file operations as successful state", async () => {
    const root = await makeTempDir();
    const tracker = new FileStateTracker();
    const tools = createWorkspaceTools({
      workspaceRoot: root,
      fileStateTracker: tracker,
      sessionId: "session-1"
    });
    const read = tools.find((tool) => tool.name === "file.read");
    const patch = tools.find((tool) => tool.name === "file.patch");

    await read?.run({ path: "../outside.md" });
    await patch?.run({ path: "missing.md", old_string: "a", new_string: "b" });

    expect(tracker.listOperations()).toEqual([]);
  });

  it("does not claim shell writes are tracked by structured file-state tracking", async () => {
    const root = await makeTempDir();
    const tracker = new FileStateTracker();
    const tools = createWorkspaceTools({
      workspaceRoot: root,
      commandTimeoutMs: 1000,
      fileStateTracker: tracker,
      sessionId: "session-1"
    });
    const terminal = tools.find((tool) => tool.name === "terminal.run");

    const result = await terminal?.run({ command: "printf shell > shell.txt" });

    expect(result?.ok).toBe(true);
    expect(tracker.listOperations()).toEqual([]);
  });
});

describe("safe nested file.write", () => {
  it("creates a/b/c/d.txt when no parent exists", async () => {
    const root = await makeTempDir();
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const write = tools.find((tool) => tool.name === "file.write");

    const result = await write?.run({
      path: "a/b/c/d.txt",
      content: "nested content",
    });

    expect(result?.ok).toBe(true);
    expect(result?.metadata?.path).toBe("a/b/c/d.txt");
  });

  it("rejects ../outside.txt", async () => {
    const root = await makeTempDir();
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const write = tools.find((tool) => tool.name === "file.write");

    const result = await write?.run({
      path: "../outside.txt",
      content: "escaped",
    });

    expect(result?.ok).toBe(false);
    expect(result?.content).toContain("outside the trusted workspace");
  });

  it("rejects symlink escape through parent directories", async () => {
    const root = await makeTempDir();
    const outsideDir = await mkdtemp(join(tmpdir(), "estacoda-outside-"));
    await symlink(outsideDir, join(root, "escape"), "dir");

    const tools = createWorkspaceTools({ workspaceRoot: root });
    const write = tools.find((tool) => tool.name === "file.write");

    const result = await write?.run({
      path: "escape/sub/file.txt",
      content: "escaped",
    });

    expect(result?.ok).toBe(false);
    expect(result?.content).toContain("symlink");

    await rm(outsideDir, { recursive: true, force: true });
  });

  it("rejects when an intermediate existing parent is a symlink to outside workspace", async () => {
    const root = await makeTempDir();
    const outsideDir = await mkdtemp(join(tmpdir(), "estacoda-outside-"));
    await mkdir(join(root, "a"));
    await symlink(outsideDir, join(root, "a", "b"), "dir");

    const tools = createWorkspaceTools({ workspaceRoot: root });
    const write = tools.find((tool) => tool.name === "file.write");

    const result = await write?.run({
      path: "a/b/c/d.txt",
      content: "escaped",
    });

    expect(result?.ok).toBe(false);
    expect(result?.content).toContain("symlink");

    await rm(outsideDir, { recursive: true, force: true });
  });

  it("does not create outside directories through a symlinked intermediate parent", async () => {
    const root = await makeTempDir();
    const outsideDir = await mkdtemp(join(tmpdir(), "estacoda-outside-"));
    await mkdir(join(root, "a"));
    await symlink(outsideDir, join(root, "a", "b"), "dir");

    const tools = createWorkspaceTools({ workspaceRoot: root });
    const write = tools.find((tool) => tool.name === "file.write");

    await write?.run({
      path: "a/b/c/d.txt",
      content: "escaped",
    });

    await expect(access(join(outsideDir, "c"))).rejects.toBeDefined();

    await rm(outsideDir, { recursive: true, force: true });
  });

  it("verifies final parent containment after creating missing directories", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "a"));
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const write = tools.find((tool) => tool.name === "file.write");

    const result = await write?.run({
      path: "a/b/c/d.txt",
      content: "nested content",
    });

    expect(result?.ok).toBe(true);
    expect(result?.metadata?.path).toBe("a/b/c/d.txt");
  });
});

describe("terminal.run hardline floor", () => {
  it("allows approved non-hardline destructive-local commands to reach execution", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "build"));
    const tools = createWorkspaceTools({ workspaceRoot: root, commandTimeoutMs: 1000 });
    const terminal = tools.find((tool) => tool.name === "terminal.run");

    const result = await terminal?.run({ command: "rm -rf ./build" });

    expect(result?.ok).toBe(true);
    expect(result?.metadata?.command).toBe("rm -rf ./build");
    await expect(access(join(root, "build"))).rejects.toBeDefined();
  });

  it("emits bounded terminal context summary metadata", async () => {
    const root = await makeTempDir();
    const tools = createWorkspaceTools({ workspaceRoot: root, commandTimeoutMs: 1000 });
    const terminal = tools.find((tool) => tool.name === "terminal.run");

    const result = await terminal?.run({ command: "printf 'one\\ntwo\\n'; printf 'err\\n' >&2" });

    expect(result?.ok).toBe(true);
    expect(result?.metadata?._estacoda_context_summary).toContain("exited with code 0.");
    expect(result?.metadata?._estacoda_context_summary).toContain("stdout: 2 lines / 8 chars.");
    expect(result?.metadata?._estacoda_context_summary).toContain("stderr: 1 lines / 4 chars.");
  });

  it("bounds terminal context summaries for very long commands", async () => {
    const root = await makeTempDir();
    const tools = createWorkspaceTools({ workspaceRoot: root, commandTimeoutMs: 1000 });
    const terminal = tools.find((tool) => tool.name === "terminal.run");
    const longComment = "long-command-fragment ".repeat(80);
    const command = `printf 'ok\\n'; # ${longComment}`;

    const result = await terminal?.run({ command });
    const summary = result?.metadata?._estacoda_context_summary;

    expect(result?.ok).toBe(true);
    expect(typeof summary).toBe("string");
    expect(summary?.length).toBeLessThanOrEqual(500);
    expect(summary).toContain("exited with code 0.");
    expect(summary).toContain("stdout: 1 lines / 3 chars.");
    expect(summary).toContain("stderr: 0 lines / 0 chars.");
    expect(summary).not.toContain(longComment);
  });

  it("rejects hardBlock commands inside the tool handler", async () => {
    const root = await makeTempDir();
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const terminal = tools.find((tool) => tool.name === "terminal.run");

    const result = await terminal?.run({ command: "rm -rf /" });

    expect(result?.ok).toBe(false);
    expect(result?.content).toContain("filesystem root");
  });

  it("ignores environmentType supplied through tool input", async () => {
    const root = await makeTempDir();
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const terminal = tools.find((tool) => tool.name === "terminal.run");

    const result = await terminal?.run({ command: "sudo apt update", environmentType: "docker" } as never);

    expect(result?.ok).toBe(false);
    expect(result?.content).toContain("privilege escalation");
  });

  it("still rejects hardBlock commands when child env isolation is enabled", async () => {
    const root = await makeTempDir();
    const isolatedHome = join(root, "home");
    const tools = createWorkspaceTools({
      workspaceRoot: root,
      childProcessEnv: {
        mode: "isolated",
        homeDir: isolatedHome
      }
    });
    const terminal = tools.find((tool) => tool.name === "terminal.run");

    const result = await terminal?.run({ command: "rm -rf /" });

    expect(result?.ok).toBe(false);
    expect(result?.content).toContain("filesystem root");
  });
});

describe("terminal.run child process environment", () => {
  it("inherits the parent process environment by default", async () => {
    const root = await makeTempDir();
    const previous = process.env.ESTACODA_BENCHMARK_TEST_SECRET;
    process.env.ESTACODA_BENCHMARK_TEST_SECRET = "visible-parent-env";
    const tools = createWorkspaceTools({ workspaceRoot: root, commandTimeoutMs: 2000 });
    const terminal = tools.find((tool) => tool.name === "terminal.run");

    try {
      const result = await terminal?.run({
        command: "node -e \"process.stdout.write(process.env.ESTACODA_BENCHMARK_TEST_SECRET || 'missing')\""
      });

      expect(result?.ok).toBe(true);
      expect(result?.content).toBe("visible-parent-env");
    } finally {
      if (previous === undefined) {
        delete process.env.ESTACODA_BENCHMARK_TEST_SECRET;
      } else {
        process.env.ESTACODA_BENCHMARK_TEST_SECRET = previous;
      }
    }
  });

  it("uses an isolated HOME and omits parent secrets when requested", async () => {
    const root = await makeTempDir();
    const isolatedHome = join(root, "isolated-home");
    const previous = process.env.ESTACODA_BENCHMARK_TEST_SECRET;
    process.env.ESTACODA_BENCHMARK_TEST_SECRET = "hidden-parent-env";
    const tools = createWorkspaceTools({
      workspaceRoot: root,
      commandTimeoutMs: 2000,
      childProcessEnv: {
        mode: "isolated",
        homeDir: isolatedHome
      }
    });
    const terminal = tools.find((tool) => tool.name === "terminal.run");

    try {
      const result = await terminal?.run({
        command: "node -e \"process.stdout.write([process.env.HOME, process.env.ESTACODA_BENCHMARK_TEST_SECRET || 'missing'].join('\\n'))\""
      });

      expect(result?.ok).toBe(true);
      expect(result?.content).toBe(`${isolatedHome}\nmissing`);
    } finally {
      if (previous === undefined) {
        delete process.env.ESTACODA_BENCHMARK_TEST_SECRET;
      } else {
        process.env.ESTACODA_BENCHMARK_TEST_SECRET = previous;
      }
    }
  });
});
