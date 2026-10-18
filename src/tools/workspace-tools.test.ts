import { isUndispatchedResult } from "./undispatched-result.js";
import { createHash } from "node:crypto";
import type { TaskResult } from "../contracts/task.js";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileStateTracker } from "../delegation/file-state-tracker.js";
import { createWorkspaceTools, type WorkspaceFsAdapter } from "./workspace-tools.js";

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
  it.each(["tsv", "log", "jsonl", "ndjson"])("reads ordinary %s text while retaining binary and path protections", async extension => {
    const root = await makeTempDir();
    const tool = createWorkspaceTools({ workspaceRoot: root }).find(tool => tool.name === "file.read")!;
    await writeFile(join(root, `input.${extension}`), "name\tvalue\nArabic\tمرحبا\n");
    expect(await tool.run({ path: `input.${extension}` })).toMatchObject({ ok: true, metadata: { completeFileRead: true } });
    await writeFile(join(root, `binary.${extension}`), Buffer.from([1, 0, 2]));
    expect((await tool.run({ path: `binary.${extension}` })).ok).toBe(false);
    expect((await tool.run({ path: `../outside.${extension}` })).ok).toBe(false);
  });
  it("copies authorized accepted results exactly and verifies a large file without echoing all bytes", async () => {
    const root = await makeTempDir();
    const content = "العربية 😀 Evidence\n".repeat(4000);
    const readText = vi.fn(async () => ({ result: { disposition: "accepted" } as TaskResult, content }));
    let readAllowed = true;
    const tools = createWorkspaceTools({ workspaceRoot: root, sessionId: () => "current-session", taskResultService: { readText }, canReadTaskResults: () => readAllowed });
    const write = tools.find(tool => tool.name === "file.write")!;
    const read = tools.find(tool => tool.name === "file.read")!;
    const input = { path: "report.md", sourceResult: { taskId: "task", resultId: "result" } };
    expect((await write.run({ ...input, content: "" })).ok).toBe(true);
    expect(readText).toHaveBeenCalledWith({ taskId: "task", resultId: "result", sessionId: "current-session" });
    expect(input).not.toHaveProperty("content");
    readAllowed = false;
    expect((await write.run(input)).ok).toBe(false);
    expect(readText).toHaveBeenCalledTimes(1);
    readAllowed = true;
    expect(await readFile(join(root, "report.md"), "utf8")).toBe(content);
    const result = await read.run({ path: "report.md" });
    expect(result.metadata).toMatchObject({ truncated: true, completeFileRead: true, materialized: true,
      contentSha256: createHash("sha256").update(content).digest("hex") });
    expect((await read.run({ path: "report.md", lineStart: 2, lineEnd: 3 })).metadata?.completeFileRead).toBeUndefined();
    expect((await read.run({ path: "report.md", lineStart: 1, lineEnd: 100000 })).metadata).toMatchObject({ truncated: true, completeFileRead: true, contentSha256: result.metadata!.contentSha256 });
    expect((await read.run({ path: "report.md", lineStart: null, lineEnd: null })).metadata?.completeFileRead).toBe(true);
    await writeFile(join(root, "small.md"), "one\ntwo\n");
    expect((await read.run({ path: "small.md", lineStart: 1, lineEnd: 10000 })).metadata?.completeFileRead).toBe(true);
    expect((await read.run({ path: "small.md", lineStart: 2, lineEnd: 2 })).metadata?.contentSha256).toBeUndefined();
    const ambiguous = await write.run({ ...input, content: "ambiguous" });
    expect(ambiguous.ok).toBe(false);
    expect(isUndispatchedResult(ambiguous)).toBe(true);
    expect((await write.run({ path: "normal.md", content: "ordinary content", sourceResult: null })).ok).toBe(true);
    readText.mockResolvedValue({ result: { disposition: "diagnostic" } as TaskResult, content: "Not accepted" });
    expect((await write.run(input)).ok).toBe(false);
    readText.mockRejectedValue(new Error("private storage path or unauthorized result"));
    const denied = await write.run(input);
    expect(denied.ok).toBe(false);
    expect(denied.content).not.toContain("private storage path");
    expect(await readFile(join(root, "report.md"), "utf8")).toBe(content);
  });

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

  it("applies V4A add and delete file sections atomically", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "old.md"), "remove me\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const result = await patch?.run({
      mode: "patch",
      patch: [
        "*** Begin Patch",
        "*** Add File: new.md",
        "+# New",
        "+content",
        "*** Delete File: old.md",
        "*** End Patch"
      ].join("\n")
    });

    expect(result?.ok).toBe(true);
    expect(result?.metadata).toMatchObject({
      paths: ["new.md", "old.md"],
      operations: ["add", "delete"],
      fileCount: 2
    });
    const preview = result?.metadata?.fileChangePreview as { diff?: string } | undefined;
    expect(preview?.diff).toContain("--- /dev/null");
    expect(preview?.diff).toContain("+++ b/new.md");
    await expect(readFile(join(root, "new.md"), "utf8")).resolves.toBe("# New\ncontent\n");
    await expect(readFile(join(root, "old.md"), "utf8")).rejects.toBeDefined();
  });

  it("validates V4A add/delete operations before writing any file", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "a.md"), "alpha\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const result = await patch?.run({
      mode: "patch",
      patch: [
        "*** Begin Patch",
        "*** Add File: added.md",
        "+created",
        "*** Delete File: missing.md",
        "*** End Patch"
      ].join("\n")
    });

    expect(result?.ok).toBe(false);
    await expect(readFile(join(root, "added.md"), "utf8")).rejects.toBeDefined();
    await expect(readFile(join(root, "a.md"), "utf8")).resolves.toBe("alpha\n");
  });

  it("rolls back applied V4A operations when a later write fails", async () => {
    const root = await makeTempDir();
    const canonicalRoot = await realpath(root);
    const addedPath = join(canonicalRoot, "added.md");
    const oldPath = join(canonicalRoot, "old.md");
    const keepPath = join(canonicalRoot, "keep.md");
    await writeFile(oldPath, "remove me\n", "utf8");
    await writeFile(keepPath, "keep\n", "utf8");
    const files = new Map<string, string>([
      [oldPath, "remove me\n"],
      [keepPath, "keep\n"]
    ]);
    const missing = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
    const fsAdapter: WorkspaceFsAdapter = {
      readTextFile: async ({ path }) => {
        const content = files.get(path);
        if (content === undefined) {
          throw missing(path);
        }
        return content;
      },
      writeTextFile: async ({ path, content }) => {
        if (path === keepPath) {
          throw new Error("simulated write failure");
        }
        files.set(path, content);
      },
      deleteTextFile: async ({ path }) => {
        if (!files.delete(path)) {
          throw missing(path);
        }
      }
    };
    const tools = createWorkspaceTools({ workspaceRoot: root, fsAdapter });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const result = await patch?.run({
      mode: "patch",
      patch: [
        "*** Begin Patch",
        "*** Add File: added.md",
        "+created",
        "*** Delete File: old.md",
        "*** Update File: keep.md",
        "@@ keep @@",
        "-keep",
        "+changed",
        "*** End Patch"
      ].join("\n")
    });

    expect(result?.ok).toBe(false);
    expect(result?.content).toContain("Rolled back previously applied changes");
    expect(result?.metadata).toMatchObject({
      path: "keep.md",
      reason: "patch_apply_failed",
      appliedPaths: ["added.md", "old.md"],
      rollback: {
        attempted: 2,
        ok: true,
        errors: []
      }
    });
    expect(files.has(addedPath)).toBe(false);
    expect(files.get(oldPath)).toBe("remove me\n");
    expect(files.get(keepPath)).toBe("keep\n");
  });

  it("supports append, prepend, and insert modes without whole-file overwrite", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "notes.md"), "middle\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const appended = await patch?.run({
      mode: "append",
      path: "notes.md",
      content: "tail\n"
    });
    const prepended = await patch?.run({
      mode: "prepend",
      path: "notes.md",
      content: "head\n"
    });
    const inserted = await patch?.run({
      mode: "insert",
      path: "notes.md",
      anchor: "middle",
      position: "after",
      content: "\ninserted"
    });

    expect(appended?.ok).toBe(true);
    expect(prepended?.ok).toBe(true);
    expect(inserted?.ok).toBe(true);
    expect(inserted?.metadata).toMatchObject({
      operation: "insert",
      matchStrategy: "exact",
      matchConfidence: 1,
      matchedSnippet: expect.stringContaining("middle")
    });
    await expect(readFile(join(root, "notes.md"), "utf8")).resolves.toBe("head\nmiddle\ninserted\ntail\n");
  });

  it("reports near-match hints when file.patch cannot find text", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "notes.md"), "Function: The action keeps rules.\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const result = await patch?.run({
      path: "notes.md",
      old_string: "Function: The action keeps business rules.",
      new_string: "replacement"
    });

    expect(result?.ok).toBe(false);
    expect(result?.content).toContain("Closest candidate");
    expect(result?.metadata?.nearMatches).toEqual([
      expect.objectContaining({
        line: 1,
        snippet: "Function: The action keeps rules."
      })
    ]);
  });

  it("validates JSON syntax before writing any patch operation", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "valid.json"), "{\"ok\":true}\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const patch = tools.find((tool) => tool.name === "file.patch");

    const result = await patch?.run({
      mode: "patch",
      patch: [
        "*** Begin Patch",
        "*** Update File: valid.json",
        "@@ ok @@",
        "-{\"ok\":true}",
        "+{\"ok\":",
        "*** Add File: other.md",
        "+should not write",
        "*** End Patch"
      ].join("\n")
    });

    expect(result?.ok).toBe(false);
    expect(result?.content).toContain("Syntax check failed");
    expect(result?.metadata?.syntaxCheck).toMatchObject({
      checked: true,
      language: "json",
      ok: false
    });
    await expect(readFile(join(root, "valid.json"), "utf8")).resolves.toBe("{\"ok\":true}\n");
    await expect(readFile(join(root, "other.md"), "utf8")).rejects.toBeDefined();
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

describe("guarded file.write overwrites", () => {
  it("allows safe creates without overwrite intent", async () => {
    const root = await makeTempDir();
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const write = tools.find((tool) => tool.name === "file.write");

    const result = await write?.run({
      path: "created.md",
      content: "new document\n"
    });

    expect(result?.ok).toBe(true);
    expect(result?.metadata).toMatchObject({
      path: "created.md",
      oldBytes: 0,
      newBytes: 13,
      byteDelta: 13,
      changed: true,
      existedBefore: false,
      overwrite: false,
      suspiciousShrink: false
    });
    await expect(readFile(join(root, "created.md"), "utf8")).resolves.toBe("new document\n");
  });

  it("allows same-content writes without overwrite intent", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "notes.md"), "same content\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const write = tools.find((tool) => tool.name === "file.write");

    const result = await write?.run({
      path: "notes.md",
      content: "same content\n"
    });

    expect(result?.ok).toBe(true);
    expect(result?.content).toContain("No changes");
    expect(result?.metadata).toMatchObject({
      path: "notes.md",
      changed: false,
      existedBefore: true,
      overwrite: false,
      suspiciousShrink: false
    });
    await expect(readFile(join(root, "notes.md"), "utf8")).resolves.toBe("same content\n");
  });

  it("requires explicit overwrite intent before changing an existing file", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "notes.md"), "original content\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const write = tools.find((tool) => tool.name === "file.write");

    const result = await write?.run({
      path: "notes.md",
      content: "replacement content\n"
    });

    expect(result?.ok).toBe(false);
    expect(result?.content).toContain("would overwrite existing notes.md");
    expect(result?.metadata).toMatchObject({
      path: "notes.md",
      reason: "overwrite_intent_required",
      overwriteRequired: true,
      changed: true,
      existedBefore: true,
      suspiciousShrink: false
    });
    expect(result?.metadata?.fileChangePreview).toMatchObject({
      kind: "fileChangePreview",
      path: "notes.md",
      changeType: "modified"
    });
    await expect(readFile(join(root, "notes.md"), "utf8")).resolves.toBe("original content\n");
  });

  it("allows intentional non-shrinking overwrites", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "notes.md"), "original content\n", "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const write = tools.find((tool) => tool.name === "file.write");

    const result = await write?.run({
      path: "notes.md",
      content: "replacement content\n",
      overwrite: true
    });

    expect(result?.ok).toBe(true);
    expect(result?.metadata).toMatchObject({
      path: "notes.md",
      changed: true,
      existedBefore: true,
      overwrite: true,
      suspiciousShrink: false
    });
    await expect(readFile(join(root, "notes.md"), "utf8")).resolves.toBe("replacement content\n");
  });

  it("blocks suspicious shrink overwrites even with overwrite intent", async () => {
    const root = await makeTempDir();
    const original = Array.from({ length: 80 }, (_, index) => `## Section ${index + 1}\nUseful transcript line ${index + 1}.`).join("\n");
    await writeFile(join(root, "transcript.md"), original, "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const write = tools.find((tool) => tool.name === "file.write");

    const result = await write?.run({
      path: "transcript.md",
      content: "# Summary\n",
      overwrite: true
    });

    expect(result?.ok).toBe(false);
    expect(result?.content).toContain("Suspicious file.write overwrite blocked");
    expect(result?.metadata).toMatchObject({
      path: "transcript.md",
      reason: "suspicious_shrink_overwrite",
      overwriteRequired: true,
      suspiciousShrink: true,
      changed: true,
      existedBefore: true
    });
    expect(result?.metadata?.oldBytes).toBeGreaterThan(500);
    expect(result?.metadata?.newBytes).toBe(Buffer.byteLength("# Summary\n"));
    await expect(readFile(join(root, "transcript.md"), "utf8")).resolves.toBe(original);
  });

  it("allows suspicious shrink overwrites only with explicit shrink intent", async () => {
    const root = await makeTempDir();
    const original = Array.from({ length: 80 }, (_, index) => `## Section ${index + 1}\nUseful transcript line ${index + 1}.`).join("\n");
    await writeFile(join(root, "transcript.md"), original, "utf8");
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const write = tools.find((tool) => tool.name === "file.write");

    const result = await write?.run({
      path: "transcript.md",
      content: "# Summary\n",
      overwrite: true,
      allowShrink: true
    });

    expect(result?.ok).toBe(true);
    expect(result?.metadata).toMatchObject({
      path: "transcript.md",
      changed: true,
      existedBefore: true,
      overwrite: true,
      suspiciousShrink: true
    });
    await expect(readFile(join(root, "transcript.md"), "utf8")).resolves.toBe("# Summary\n");
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
  it("omits parent secrets by default", async () => {
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
      expect(result?.content).toBe("missing");
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

describe("exact workspace text copies", () => {
  it.each(["# قرار — Décision\r\n\r\nKeep café and العربية.\r\n\r\n", "", "large\n".repeat(12000)])("copies source bytes without retyping a preview %#", async content => {
    const root = await makeTempDir();
    await writeFile(join(root, "source.md"), content);
    const tools = createWorkspaceTools({ workspaceRoot: root, maxReadBytes: 100 });
    const read = tools.find(t => t.name === "file.read")!;
    const write = tools.find(t => t.name === "file.write")!;
    const source = await read.run({ path: "source.md" });
    const result = await write.run({ path: "copy.md", sourceFile: { path: "source.md" } });
    expect(result).toMatchObject({ ok: true, metadata: { copiedSource: { path: "source.md", contentSha256: source.metadata!.contentSha256 } } });
    expect(await readFile(join(root, "copy.md"))).toEqual(await readFile(join(root, "source.md")));
    expect((await read.run({ path: "copy.md" })).metadata!.contentSha256).toBe(source.metadata!.contentSha256);
  });
  it("rejects stale sources, source aliases, escape paths, binary and lossy UTF-8, with no write", async () => {
    const root = await makeTempDir();
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const write = tools.find(t => t.name === "file.write")!;
    const original = Buffer.from("original\n");
    await writeFile(join(root, "source.txt"), original);
    await symlink(join(root, "source.txt"), join(root, "alias.txt"));
    await tools.find(t => t.name === "file.read")!.run({ path: "source.txt" });
    const input = { path: "copy.txt", sourceFile: { path: "source.txt" } };
    for (const source of ["../outside.txt", "/etc/passwd", "alias.txt"]) expect((await write.run({ ...input, sourceFile: { path: source } })).ok).toBe(false);
    expect((await write.run({ ...input, path: "source.txt" })).ok).toBe(false);
    expect((await write.run({ ...input, content: "conflict" })).ok).toBe(false);
    expect((await write.run({ ...input, sourceResult: { taskId: "t", resultId: "r" } })).ok).toBe(false);
    for (const bytes of [Buffer.from("changed\n"), Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe])]) {
      await writeFile(join(root, "source.txt"), bytes);
      expect((await write.run(input)).ok).toBe(false);
    }
    await expect(access(join(root, "copy.txt"))).rejects.toThrow();
  });
  it("preserves overwrite and shrink guards for copies", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "source.txt"), "x");
    await writeFile(join(root, "copy.txt"), "original\n".repeat(200));
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const write = tools.find(t => t.name === "file.write")!;
    await tools.find(t => t.name === "file.read")!.run({ path: "source.txt" });
    const input = { path: "copy.txt", sourceFile: { path: "source.txt" } };
    expect((await write.run(input)).metadata?.overwriteRequired).toBe(true);
    expect((await write.run({ ...input, overwrite: true })).metadata?.suspiciousShrink).toBe(true);
    expect((await write.run({ ...input, overwrite: true, allowShrink: true })).ok).toBe(true);
  });
  it("does not copy unsaved editor text as disk evidence", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "source.txt"), "disk");
    const writeTextFile = vi.fn();
    let editorContent = "disk";
    const tools = createWorkspaceTools({ workspaceRoot: root, fsAdapter: { readTextFile: async () => editorContent, writeTextFile } });
    await tools.find(t => t.name === "file.read")!.run({ path: "source.txt" });
    editorContent = "unsaved";
    const write = tools.find(t => t.name === "file.write")!;
    expect((await write.run({ path: "copy.txt", sourceFile: { path: "source.txt" } })).ok).toBe(false);
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});

it("requires an actual source read before copying", async () => {
  const root = await makeTempDir();
  await writeFile(join(root, "source.txt"), "known");
  const write = createWorkspaceTools({ workspaceRoot: root }).find(t => t.name === "file.write")!;
  const result = await write.run({ path: "copy.txt", sourceFile: { path: "source.txt" } });
  expect(result.ok).toBe(false);
  expect(isUndispatchedResult(result)).toBe(true);
  await expect(access(join(root, "copy.txt"))).rejects.toThrow();
});

it("refuses lossy UTF-8 copies even after a successful source read", async () => {
  const root = await makeTempDir();
  await writeFile(join(root, "source.txt"), Buffer.from([0x61, 0xff, 0x0a]));
  const tools = createWorkspaceTools({ workspaceRoot: root });
  const read = await tools.find(t => t.name === "file.read")!.run({ path: "source.txt" });
  expect(read.ok).toBe(true);
  const result = await tools.find(t => t.name === "file.write")!.run({ path: "copy.txt", sourceFile: { path: "source.txt" } });
  expect(result).toMatchObject({ ok: false });
  expect(result.content).toContain("valid UTF-8");
  await expect(access(join(root, "copy.txt"))).rejects.toThrow();
});
