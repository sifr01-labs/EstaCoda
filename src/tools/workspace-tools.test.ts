import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    expect(result?.metadata?.matchStrategy).toBe("exact");
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
    expect(ambiguous?.content).toContain("using exact");
    expect(replaced?.ok).toBe(true);
    expect(replaced?.metadata?.matchCount).toBe(2);
  });

  it("uses whitespace-normalized matching when exact file.patch matching fails", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "notes.md"), "Function:  The action keeps rules.\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const result = await patch?.run({
      path: "notes.md",
      old_string: "Function: The action keeps rules.",
      new_string: "Function: The action keeps stricter rules."
    });

    expect(result?.ok).toBe(true);
    expect(result?.metadata?.matchStrategy).toBe("whitespace_normalized");
    expect(result?.metadata?.matchCount).toBe(1);
    await expect(readFile(join(root, "notes.md"), "utf8")).resolves.toBe("Function: The action keeps stricter rules.\n");
  });

  it("uses escape-normalized matching for escaped newline anchors", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "app.ts"), "const value = \"alpha\nbeta\";\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const result = await patch?.run({
      path: "app.ts",
      old_string: "const value = \"alpha\\nbeta\";",
      new_string: "const value = \"done\";"
    });

    expect(result?.ok).toBe(true);
    expect(result?.metadata?.matchStrategy).toBe("escape_normalized");
    await expect(readFile(join(root, "app.ts"), "utf8")).resolves.toBe("const value = \"done\";\n");
  });

  it("uses unicode-normalized matching for equivalent text forms", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "notes.md"), "Cafe\u0301 costs\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const result = await patch?.run({
      path: "notes.md",
      old_string: "Caf\u00e9 costs",
      new_string: "Coffee costs"
    });

    expect(result?.ok).toBe(true);
    expect(result?.metadata?.matchStrategy).toBe("unicode_normalized");
    await expect(readFile(join(root, "notes.md"), "utf8")).resolves.toBe("Coffee costs\n");
  });

  it("reports ambiguous fuzzy matches unless replace_all is true", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "notes.md"), "alpha  beta\nalpha   beta\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const ambiguous = await patch?.run({
      path: "notes.md",
      old_string: "alpha beta",
      new_string: "done"
    });
    const replaced = await patch?.run({
      path: "notes.md",
      old_string: "alpha beta",
      new_string: "done",
      replace_all: true
    });

    expect(ambiguous?.ok).toBe(false);
    expect(ambiguous?.content).toContain("whitespace_normalized");
    expect(ambiguous?.metadata?.matchCount).toBe(2);
    expect(replaced?.ok).toBe(true);
    expect(replaced?.metadata?.matchCount).toBe(2);
    expect(replaced?.metadata?.matchStrategy).toBe("whitespace_normalized");
    await expect(readFile(join(root, "notes.md"), "utf8")).resolves.toBe("done\ndone\n");
  });

  it("returns recovery metadata when no file.patch strategy matches", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "notes.md"), "current text\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const result = await patch?.run({
      path: "notes.md",
      old_string: "missing text",
      new_string: "replacement"
    });

    expect(result?.ok).toBe(false);
    expect(result?.content).toContain("Use file.read");
    expect(result?.metadata?.attemptedStrategies).toEqual([
      "exact",
      "line_trimmed",
      "whitespace_normalized",
      "indentation_flexible",
      "escape_normalized",
      "trimmed_boundary",
      "unicode_normalized",
      "block_anchor",
      "context_aware"
    ]);
  });

  it("escalates repeated file.patch replace failures on the same file", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "notes.md"), "current text\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const first = await patch?.run({
      path: "notes.md",
      old_string: "missing text",
      new_string: "replacement"
    });
    const second = await patch?.run({
      path: "notes.md",
      old_string: "still missing",
      new_string: "replacement"
    });
    const third = await patch?.run({
      path: "notes.md",
      old_string: "also missing",
      new_string: "replacement"
    });

    expect(first?.metadata?.patchFailureCount).toBe(1);
    expect(first?.metadata?.patchFailureEscalated).toBe(false);
    expect(second?.metadata?.patchFailureCount).toBe(2);
    expect(third?.metadata?.patchFailureCount).toBe(3);
    expect(third?.metadata?.patchFailureEscalated).toBe(true);
    expect(third?.content).toContain("Stop retrying. Re-read the file");
  });

  it("resets file.patch failure counts after a successful patch", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "notes.md"), "current text\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    await patch?.run({
      path: "notes.md",
      old_string: "missing text",
      new_string: "replacement"
    });
    const success = await patch?.run({
      path: "notes.md",
      old_string: "current text",
      new_string: "updated text"
    });
    const nextFailure = await patch?.run({
      path: "notes.md",
      old_string: "missing text",
      new_string: "replacement"
    });

    expect(success?.ok).toBe(true);
    expect(nextFailure?.metadata?.patchFailureCount).toBe(1);
    expect(nextFailure?.metadata?.patchFailureEscalated).toBe(false);
  });

  it("applies V4A patch mode across multiple files after validation", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "a.md"), "alpha\nbeta\n", "utf8");
    await writeFile(join(root, "b.md"), "one\ntwo\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const result = await patch?.run({
      mode: "patch",
      patch: [
        "*** Begin Patch",
        "*** Update File: a.md",
        "@@ alpha @@",
        " alpha",
        "-beta",
        "+gamma",
        "*** Update File: b.md",
        "@@ one @@",
        " one",
        "-two",
        "+three",
        "*** End Patch"
      ].join("\n")
    });

    expect(result?.ok).toBe(true);
    expect(result?.metadata).toMatchObject({
      paths: ["a.md", "b.md"],
      fileCount: 2,
      hunkCount: 2
    });
    expect(result?.metadata?.fileChangePreview).toMatchObject({
      kind: "fileChangePreview",
      path: "multiple files",
      changeType: "modified"
    });
    await expect(readFile(join(root, "a.md"), "utf8")).resolves.toBe("alpha\ngamma\n");
    await expect(readFile(join(root, "b.md"), "utf8")).resolves.toBe("one\nthree\n");
  });

  it("validates all V4A patch hunks before writing any file", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "a.md"), "alpha\nbeta\n", "utf8");
    await writeFile(join(root, "b.md"), "one\ntwo\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const result = await patch?.run({
      mode: "patch",
      patch: [
        "*** Begin Patch",
        "*** Update File: a.md",
        "@@ alpha @@",
        " alpha",
        "-beta",
        "+gamma",
        "*** Update File: b.md",
        "@@ one @@",
        " one",
        "-missing",
        "+three",
        "*** End Patch"
      ].join("\n")
    });

    expect(result?.ok).toBe(false);
    expect(result?.content).toContain("b.md hunk 1");
    await expect(readFile(join(root, "a.md"), "utf8")).resolves.toBe("alpha\nbeta\n");
    await expect(readFile(join(root, "b.md"), "utf8")).resolves.toBe("one\ntwo\n");
  });

  it("escalates repeated V4A patch hunk failures on the same file without writing", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "a.md"), "alpha\nbeta\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");
    const badPatch = [
      "*** Begin Patch",
      "*** Update File: a.md",
      "@@ alpha @@",
      " alpha",
      "-missing",
      "+gamma",
      "*** End Patch"
    ].join("\n");

    await patch?.run({ mode: "patch", patch: badPatch });
    await patch?.run({ mode: "patch", patch: badPatch });
    const third = await patch?.run({ mode: "patch", patch: badPatch });

    expect(third?.ok).toBe(false);
    expect(third?.metadata?.patchFailureCount).toBe(3);
    expect(third?.metadata?.patchFailureEscalated).toBe(true);
    expect(third?.content).toContain("Stop retrying. Re-read the file");
    await expect(readFile(join(root, "a.md"), "utf8")).resolves.toBe("alpha\nbeta\n");
  });

  it("uses V4A context hints to disambiguate patch hunks", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "app.ts"), [
      "function first() {",
      "  return 1;",
      "}",
      "",
      "function second() {",
      "  return 1;",
      "}",
      ""
    ].join("\n"), "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const result = await patch?.run({
      mode: "patch",
      patch: [
        "*** Begin Patch",
        "*** Update File: app.ts",
        "@@ function second() @@",
        "-  return 1;",
        "+  return 2;",
        "*** End Patch"
      ].join("\n")
    });

    expect(result?.ok).toBe(true);
    await expect(readFile(join(root, "app.ts"), "utf8")).resolves.toBe([
      "function first() {",
      "  return 1;",
      "}",
      "",
      "function second() {",
      "  return 2;",
      "}",
      ""
    ].join("\n"));
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
