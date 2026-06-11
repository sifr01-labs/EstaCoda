import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStateTracker } from "../delegation/file-state-tracker.js";
import { createNotebookTools, notebookToolProvider, type NotebookCell, type NotebookContent } from "./notebook-tools.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix = "estacoda-notebook-tools-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("notebook.edit", () => {
  it("accepts a workspace-relative notebook path", async () => {
    const root = await makeNotebookWorkspace();
    const tool = createNotebookTool(root);

    const result = await tool.run({
      notebook_path: "analysis.ipynb",
      cell_id: "setup",
      new_source: "print('changed')",
      edit_mode: "replace"
    });

    const notebook = await readNotebook(join(root, "analysis.ipynb"));
    expect(result.ok).toBe(true);
    expect(result.metadata?.path).toBe("analysis.ipynb");
    expect(notebook.cells[0]?.source).toBe("print('changed')");
  });

  it("rejects traversal outside the workspace", async () => {
    const root = await makeNotebookWorkspace();
    const tool = createNotebookTool(root);

    const result = await tool.run({
      notebook_path: "../outside.ipynb",
      cell_id: "setup",
      new_source: "print('changed')",
      edit_mode: "replace"
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("outside the trusted workspace");
  });

  it("rejects an absolute notebook path outside the workspace", async () => {
    const root = await makeNotebookWorkspace();
    const outside = await makeTempDir("estacoda-notebook-outside-");
    await writeNotebook(join(outside, "outside.ipynb"), createNotebook());
    const tool = createNotebookTool(root);

    const result = await tool.run({
      notebook_path: join(outside, "outside.ipynb"),
      cell_id: "setup",
      new_source: "print('changed')",
      edit_mode: "replace"
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("outside the trusted workspace");
  });

  it("rejects non-.ipynb paths", async () => {
    const root = await makeNotebookWorkspace();
    await writeFile(join(root, "notes.json"), JSON.stringify(createNotebook()), "utf8");
    const tool = createNotebookTool(root);

    const result = await tool.run({
      notebook_path: "notes.json",
      cell_id: "setup",
      new_source: "print('changed')",
      edit_mode: "replace"
    });

    expect(result.ok).toBe(false);
    expect(result.content).toBe("notebook_path must point to a .ipynb file");
  });

  it("rejects a missing notebook path", async () => {
    const root = await makeNotebookWorkspace();
    const tool = createNotebookTool(root);

    const result = await tool.run({
      cell_id: "setup",
      new_source: "print('changed')",
      edit_mode: "replace"
    });

    expect(result.ok).toBe(false);
    expect(result.content).toBe("notebook_path must be a non-empty string");
  });

  it("rejects invalid JSON", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "broken.ipynb"), "{ nope", "utf8");
    const tool = createNotebookTool(root);

    const result = await tool.run({
      notebook_path: "broken.ipynb",
      cell_id: "setup",
      new_source: "print('changed')",
      edit_mode: "replace"
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("invalid notebook JSON");
  });

  it("rejects invalid notebook shape", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "bad.ipynb"), JSON.stringify({ cells: "not-array", nbformat: 4, nbformat_minor: 5 }), "utf8");
    const tool = createNotebookTool(root);

    const result = await tool.run({
      notebook_path: "bad.ipynb",
      cell_id: "setup",
      new_source: "print('changed')",
      edit_mode: "replace"
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("invalid notebook shape");
  });

  it("replaces a target cell by real cell id", async () => {
    const root = await makeNotebookWorkspace();
    const tool = createNotebookTool(root);

    const result = await tool.run({
      notebook_path: "analysis.ipynb",
      cell_id: "notes",
      new_source: "# Updated\n\nNew markdown",
      edit_mode: "replace"
    });

    const notebook = await readNotebook(join(root, "analysis.ipynb"));
    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({
      editMode: "replace",
      cellId: "notes",
      beforeCellCount: 2,
      afterCellCount: 2
    });
    expect(notebook.cells[1]?.source).toEqual(["# Updated\n", "\n", "New markdown"]);
  });

  it("inserts at the beginning when cell_id is omitted", async () => {
    const root = await makeNotebookWorkspace();
    const tool = createNotebookTool(root);

    const result = await tool.run({
      notebook_path: "analysis.ipynb",
      new_source: "import pandas as pd",
      edit_mode: "insert"
    });

    const notebook = await readNotebook(join(root, "analysis.ipynb"));
    expect(result.ok).toBe(true);
    expect(notebook.cells).toHaveLength(3);
    expect(notebook.cells[0]).toMatchObject({
      cell_type: "code",
      source: "import pandas as pd",
      execution_count: null,
      outputs: []
    });
    expect(typeof notebook.cells[0]?.id).toBe("string");
  });

  it("inserts after a target cell with cell_id", async () => {
    const root = await makeNotebookWorkspace();
    const tool = createNotebookTool(root);

    const result = await tool.run({
      notebook_path: "analysis.ipynb",
      cell_id: "setup",
      new_source: "Inserted note",
      cell_type: "markdown",
      edit_mode: "insert"
    });

    const notebook = await readNotebook(join(root, "analysis.ipynb"));
    expect(result.ok).toBe(true);
    expect(notebook.cells[1]).toMatchObject({
      cell_type: "markdown",
      source: "Inserted note",
      metadata: {}
    });
    expect(notebook.cells[1]).not.toHaveProperty("outputs");
  });

  it("deletes a target cell", async () => {
    const root = await makeNotebookWorkspace();
    const tool = createNotebookTool(root);

    const result = await tool.run({
      notebook_path: "analysis.ipynb",
      cell_id: "notes",
      edit_mode: "delete"
    });

    const notebook = await readNotebook(join(root, "analysis.ipynb"));
    expect(result.ok).toBe(true);
    expect(notebook.cells.map((cell) => cell.id)).toEqual(["setup"]);
  });

  it("records successful notebook edits as bounded file-state operations", async () => {
    const root = await makeNotebookWorkspace();
    const tracker = new FileStateTracker();
    const tool = createNotebookTools({
      workspaceRoot: root,
      fileStateTracker: tracker,
      sessionId: "child-session",
      parentSessionId: "parent-session",
      childSessionId: "child-session"
    })[0]!;

    const result = await tool.run({
      notebook_path: "analysis.ipynb",
      cell_id: "setup",
      new_source: "answer = 99",
      edit_mode: "replace"
    });

    expect(result.ok).toBe(true);
    expect(tracker.listWrites("child-session")).toEqual([
      expect.objectContaining({
        sessionId: "child-session",
        parentSessionId: "parent-session",
        childSessionId: "child-session",
        path: "analysis.ipynb",
        normalizedPath: "analysis.ipynb",
        operation: "replace",
        sourceTool: "notebook.edit",
        metadata: expect.objectContaining({
          changed: true,
          previewAvailable: true
        })
      })
    ]);
    expect(JSON.stringify(tracker.listOperations())).not.toContain("answer = 99");
  });

  it("falls back to cell-N lookup when a real cell id is unavailable", async () => {
    const root = await makeTempDir();
    await writeNotebook(join(root, "legacy.ipynb"), createNotebook({
      nbformat_minor: 4,
      cells: [
        codeCell(undefined, "a = 1"),
        markdownCell(undefined, "old")
      ]
    }));
    const tool = createNotebookTool(root);

    const result = await tool.run({
      notebook_path: "legacy.ipynb",
      cell_id: "cell-1",
      new_source: "new",
      edit_mode: "replace"
    });

    const notebook = await readNotebook(join(root, "legacy.ipynb"));
    expect(result.ok).toBe(true);
    expect(result.metadata?.cellId).toBe("cell-1");
    expect(notebook.cells[1]?.source).toBe("new");
  });

  it("rejects invalid cell_id for replace and delete", async () => {
    const root = await makeNotebookWorkspace();
    const tool = createNotebookTool(root);

    const replace = await tool.run({
      notebook_path: "analysis.ipynb",
      cell_id: "missing",
      new_source: "print('changed')",
      edit_mode: "replace"
    });
    const deletion = await tool.run({
      notebook_path: "analysis.ipynb",
      cell_id: "missing",
      edit_mode: "delete"
    });

    expect(replace.ok).toBe(false);
    expect(replace.content).toBe("Could not find cell_id missing.");
    expect(deletion.ok).toBe(false);
    expect(deletion.content).toBe("Could not find cell_id missing.");
  });

  it("preserves notebook-level and cell-level unknown fields", async () => {
    const root = await makeTempDir();
    await writeNotebook(join(root, "custom.ipynb"), createNotebook({
      custom_top_level: { keep: true },
      cells: [
        {
          ...codeCell("setup", "x = 1"),
          attachments: { "note.txt": { "text/plain": "kept" } },
          custom_cell_field: "keep-me"
        }
      ]
    }));
    const tool = createNotebookTool(root);

    const result = await tool.run({
      notebook_path: "custom.ipynb",
      cell_id: "setup",
      new_source: "x = 2",
      edit_mode: "replace"
    });

    const notebook = await readNotebook(join(root, "custom.ipynb"));
    expect(result.ok).toBe(true);
    expect(notebook.custom_top_level).toEqual({ keep: true });
    expect(notebook.cells[0]?.attachments).toEqual({ "note.txt": { "text/plain": "kept" } });
    expect(notebook.cells[0]?.custom_cell_field).toBe("keep-me");
  });

  it("resets code cell outputs on replace", async () => {
    const root = await makeNotebookWorkspace();
    const tool = createNotebookTool(root);

    const result = await tool.run({
      notebook_path: "analysis.ipynb",
      cell_id: "setup",
      new_source: "answer = 43",
      edit_mode: "replace"
    });

    const notebook = await readNotebook(join(root, "analysis.ipynb"));
    expect(result.ok).toBe(true);
    expect(notebook.cells[0]).toMatchObject({
      source: "answer = 43",
      execution_count: null,
      outputs: []
    });
  });

  it("does not invent code outputs for markdown replacements", async () => {
    const root = await makeNotebookWorkspace();
    const tool = createNotebookTool(root);

    const result = await tool.run({
      notebook_path: "analysis.ipynb",
      cell_id: "notes",
      new_source: "changed markdown",
      edit_mode: "replace"
    });

    const notebook = await readNotebook(join(root, "analysis.ipynb"));
    expect(result.ok).toBe(true);
    expect(notebook.cells[1]?.cell_type).toBe("markdown");
    expect(notebook.cells[1]).not.toHaveProperty("outputs");
    expect(notebook.cells[1]).not.toHaveProperty("execution_count");
  });

  it("rejects stale edits when expected_mtime_ms does not match", async () => {
    const root = await makeNotebookWorkspace();
    const path = join(root, "analysis.ipynb");
    const before = await stat(path);
    const tool = createNotebookTool(root);

    const result = await tool.run({
      notebook_path: "analysis.ipynb",
      cell_id: "setup",
      new_source: "answer = 43",
      edit_mode: "replace",
      expected_mtime_ms: before.mtimeMs + 1
    });

    const notebook = await readNotebook(path);
    expect(result.ok).toBe(false);
    expect(result.content).toBe("notebook has changed since expected_mtime_ms");
    expect(result.metadata).toMatchObject({
      expectedMtimeMs: before.mtimeMs + 1,
      currentMtimeMs: before.mtimeMs
    });
    expect(notebook.cells[0]?.source).toBe("answer = 42");
  });

  it("does not record failed notebook edits as successful file-state operations", async () => {
    const root = await makeNotebookWorkspace();
    const path = join(root, "analysis.ipynb");
    const before = await stat(path);
    const tracker = new FileStateTracker();
    const tool = createNotebookTools({
      workspaceRoot: root,
      fileStateTracker: tracker,
      sessionId: "session-1"
    })[0]!;

    const result = await tool.run({
      notebook_path: "analysis.ipynb",
      cell_id: "setup",
      new_source: "answer = 100",
      edit_mode: "replace",
      expected_mtime_ms: before.mtimeMs + 1
    });

    expect(result.ok).toBe(false);
    expect(tracker.listOperations()).toEqual([]);
  });

  it("writes through a temporary file and leaves valid notebook JSON behind", async () => {
    const root = await makeNotebookWorkspace();
    const tool = createNotebookTool(root);

    const result = await tool.run({
      notebook_path: "analysis.ipynb",
      cell_id: "setup",
      new_source: "answer = 44",
      edit_mode: "replace"
    });

    const entries = await readdir(root);
    const notebook = await readNotebook(join(root, "analysis.ipynb"));
    expect(result.ok).toBe(true);
    expect(entries.filter((entry) => entry.startsWith(".analysis.ipynb."))).toEqual([]);
    expect(notebook.cells[0]?.source).toBe("answer = 44");
  });

  it("exposes the notebook provider for runtime registration", () => {
    expect(notebookToolProvider.name).toBe("notebook");
    expect(notebookToolProvider.kind).toBe("session");

    const tools = notebookToolProvider.createTools({
      workspaceRoot: resolve("/"),
      profileId: "test-profile",
      sessionId: "test-session",
      currentSessionId: () => "test-session"
    });
    expect(tools.map((tool) => tool.name)).toEqual(["notebook.edit"]);
    expect(tools[0]?.riskClass).toBe("workspace-write");
    expect(tools[0]?.toolsets).toEqual(["files", "coding"]);
  });
});

async function makeNotebookWorkspace(): Promise<string> {
  const root = await makeTempDir();
  await mkdir(root, { recursive: true });
  await writeNotebook(join(root, "analysis.ipynb"), createNotebook());
  return root;
}

function createNotebookTool(root: string) {
  const tool = createNotebookTools({ workspaceRoot: root })[0];
  expect(tool).toBeDefined();
  return tool!;
}

function createNotebook(overrides: Partial<NotebookContent> = {}): NotebookContent {
  return {
    cells: [
      codeCell("setup", "answer = 42"),
      markdownCell("notes", "Original notes")
    ],
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3"
      }
    },
    nbformat: 4,
    nbformat_minor: 5,
    ...overrides
  };
}

function codeCell(id: string | undefined, source: string): NotebookCell {
  return {
    cell_type: "code",
    ...(id === undefined ? {} : { id }),
    execution_count: 7,
    metadata: { trusted: true },
    outputs: [
      {
        output_type: "stream",
        name: "stdout",
        text: "old output\n"
      }
    ],
    source
  };
}

function markdownCell(id: string | undefined, source: string): NotebookCell {
  return {
    cell_type: "markdown",
    ...(id === undefined ? {} : { id }),
    metadata: { editable: true },
    source
  };
}

async function writeNotebook(path: string, notebook: NotebookContent): Promise<void> {
  await writeFile(path, `${JSON.stringify(notebook, null, 2)}\n`, "utf8");
}

async function readNotebook(path: string): Promise<NotebookContent> {
  return JSON.parse(await readFile(path, "utf8")) as NotebookContent;
}
