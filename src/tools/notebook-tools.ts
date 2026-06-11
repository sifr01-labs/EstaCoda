import { mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import type { FileChangePreviewViewModel } from "../contracts/view-model.js";
import type { FileStateOperationKind, FileStateTracker } from "../delegation/file-state-tracker.js";
import { errorResult, resolveWorkspacePath } from "./workspace-paths.js";

export type NotebookEditInput = {
  notebook_path?: string;
  cell_id?: string;
  new_source?: string;
  cell_type?: "code" | "markdown";
  edit_mode?: "replace" | "insert" | "delete";
  expected_mtime_ms?: number;
};

export type NotebookCell = {
  cell_type: string;
  source: string | string[];
  id?: string;
  metadata?: unknown;
  outputs?: unknown[];
  execution_count?: number | null;
  [key: string]: unknown;
};

export type NotebookContent = {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
  [key: string]: unknown;
};

export type NotebookToolOptions = {
  workspaceRoot: string;
  fileStateTracker?: FileStateTracker;
  sessionId?: string | (() => string);
  parentSessionId?: string;
  childSessionId?: string | (() => string | undefined);
};

type ToolFailure = ToolResult & { ok: false };
type ValidationResult = { ok: true } | ToolFailure;
type ParsedNotebookResult = { ok: true; notebook: NotebookContent } | ToolFailure;
type NotebookEditResult = { ok: true; cellId: string } | ToolFailure;

const MAX_RESULT_CHARS = 4_000;
const PREVIEW_LINES = 8;

export function createNotebookTools(options: NotebookToolOptions): readonly RegisteredTool[] {
  const root = resolve(options.workspaceRoot);

  return [
    {
      name: "notebook.edit",
      description: "Edit cells in a Jupyter .ipynb notebook inside the active workspace.",
      inputSchema: {
        type: "object",
        properties: {
          notebook_path: { type: "string" },
          cell_id: { type: "string" },
          new_source: { type: "string" },
          cell_type: { type: "string", enum: ["code", "markdown"] },
          edit_mode: { type: "string", enum: ["replace", "insert", "delete"] },
          expected_mtime_ms: { type: "number" }
        },
        required: ["notebook_path"]
      },
      riskClass: "workspace-write",
      toolsets: ["files", "coding"],
      progressLabel: "editing notebook",
      maxResultSizeChars: MAX_RESULT_CHARS,
      isAvailable: () => true,
      run: async (input: NotebookEditInput) => {
        const mode = input.edit_mode ?? "replace";
        const inputValidation = validateInput(input, mode);
        if (!inputValidation.ok) {
          return inputValidation;
        }

        const canonicalRoot = await realpath(root);
        const resolved = await resolveWorkspacePath(canonicalRoot, input.notebook_path);
        if (!resolved.ok) {
          return resolved;
        }

        if (extname(resolved.path) !== ".ipynb") {
          return errorResult("notebook_path must point to a .ipynb file");
        }

        const beforeStat = await stat(resolved.path);
        if (input.expected_mtime_ms !== undefined && beforeStat.mtimeMs !== input.expected_mtime_ms) {
          return errorResult("notebook has changed since expected_mtime_ms", {
            path: relative(canonicalRoot, resolved.path),
            expectedMtimeMs: input.expected_mtime_ms,
            currentMtimeMs: beforeStat.mtimeMs
          });
        }

        const raw = await readFile(resolved.path, "utf8");
        const parsed = parseNotebook(raw);
        if (!parsed.ok) {
          return parsed;
        }

        const notebook = parsed.notebook;
        const beforeCellCount = notebook.cells.length;
        const edit = applyNotebookEdit(notebook, {
          mode,
          cellId: input.cell_id,
          newSource: input.new_source,
          cellType: input.cell_type ?? "code"
        });
        if (!edit.ok) {
          return edit;
        }

        const nextContent = `${JSON.stringify(notebook, null, 2)}\n`;
        await writeNotebookAtomically(resolved.path, nextContent);
        const afterStat = await stat(resolved.path);
        const relativePath = relative(canonicalRoot, resolved.path);

        const result: ToolResult = {
          ok: true,
          content: renderNotebookEditResult({
            path: relativePath,
            editMode: mode,
            cellId: edit.cellId,
            beforeCellCount,
            afterCellCount: notebook.cells.length
          }),
          metadata: {
            path: relativePath,
            editMode: mode,
            cellId: edit.cellId,
            previousMtimeMs: beforeStat.mtimeMs,
            newMtimeMs: afterStat.mtimeMs,
            beforeCellCount,
            afterCellCount: notebook.cells.length,
            fileChangePreview: buildNotebookChangePreview({
              path: relativePath,
              editMode: mode,
              cellId: edit.cellId,
              beforeCellCount,
              afterCellCount: notebook.cells.length
            })
          }
        };
        recordNotebookFileStateOperation(options, {
          operation: notebookOperationForMode(mode),
          path: relativePath,
          bytes: afterStat.size,
          previewAvailable: result.metadata?.fileChangePreview !== undefined
        });
        return result;
      }
    }
  ];
}

export const notebookToolProvider: SessionToolProvider = {
  name: "notebook",
  kind: "session",
  createTools(ctx) {
    return createNotebookTools({
      workspaceRoot: ctx.workspaceRoot,
      fileStateTracker: ctx.fileStateTracker,
      sessionId: ctx.currentSessionId,
      parentSessionId: ctx.parentSessionId,
      childSessionId: ctx.childSessionId
    });
  }
};

function recordNotebookFileStateOperation(
  options: NotebookToolOptions,
  input: {
    operation: FileStateOperationKind;
    path: string;
    bytes: number;
    previewAvailable: boolean;
  }
): void {
  const sessionId = resolveString(options.sessionId);
  if (options.fileStateTracker === undefined || sessionId === undefined) {
    return;
  }
  options.fileStateTracker.recordOperation({
    sessionId,
    parentSessionId: options.parentSessionId,
    childSessionId: resolveString(options.childSessionId),
    path: input.path,
    operation: input.operation,
    sourceTool: "notebook.edit",
    metadata: {
      bytes: input.bytes,
      changed: true,
      previewAvailable: input.previewAvailable
    }
  });
}

function notebookOperationForMode(mode: "replace" | "insert" | "delete"): FileStateOperationKind {
  if (mode === "delete") {
    return "delete";
  }
  return mode === "insert" ? "write" : "replace";
}

function resolveString(value: string | (() => string | undefined) | undefined): string | undefined {
  return typeof value === "function" ? value() : value;
}

function validateInput(input: NotebookEditInput, mode: "replace" | "insert" | "delete"): ValidationResult {
  if (typeof input.notebook_path !== "string" || input.notebook_path.length === 0) {
    return notebookErrorResult("notebook_path must be a non-empty string");
  }
  if (mode !== "replace" && mode !== "insert" && mode !== "delete") {
    return notebookErrorResult("edit_mode must be \"replace\", \"insert\", or \"delete\"");
  }
  if ((mode === "replace" || mode === "insert") && typeof input.new_source !== "string") {
    return notebookErrorResult("new_source must be a string for replace and insert");
  }
  if (input.cell_type !== undefined && input.cell_type !== "code" && input.cell_type !== "markdown") {
    return notebookErrorResult("cell_type must be \"code\" or \"markdown\"");
  }
  if (input.expected_mtime_ms !== undefined && !Number.isFinite(input.expected_mtime_ms)) {
    return notebookErrorResult("expected_mtime_ms must be a finite number");
  }
  return { ok: true };
}

function parseNotebook(raw: string): ParsedNotebookResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return notebookErrorResult(`invalid notebook JSON: ${error instanceof Error ? error.message : "failed to parse JSON"}`);
  }

  if (!isNotebookContent(parsed)) {
    return notebookErrorResult("invalid notebook shape: expected object with cells array, numeric nbformat, and numeric nbformat_minor");
  }

  return {
    ok: true,
    notebook: parsed
  };
}

function isNotebookContent(value: unknown): value is NotebookContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { cells?: unknown; nbformat?: unknown; nbformat_minor?: unknown };
  return Array.isArray(candidate.cells)
    && typeof candidate.nbformat === "number"
    && typeof candidate.nbformat_minor === "number";
}

function applyNotebookEdit(notebook: NotebookContent, input: {
  mode: "replace" | "insert" | "delete";
  cellId?: string;
  newSource?: string;
  cellType: "code" | "markdown";
}): NotebookEditResult {
  if (input.mode === "insert") {
    const nextCell = createNotebookCell(notebook, input.cellType, input.newSource ?? "");
    const insertIndex = input.cellId === undefined
      ? 0
      : findCellIndex(notebook, input.cellId);
    if (insertIndex === -1) {
      return notebookErrorResult(`Could not find cell_id ${input.cellId}.`);
    }
    const targetIndex = input.cellId === undefined ? 0 : insertIndex + 1;
    notebook.cells.splice(targetIndex, 0, nextCell);
    return {
      ok: true,
      cellId: nextCell.id ?? `cell-${targetIndex}`
    };
  }

  if (typeof input.cellId !== "string" || input.cellId.length === 0) {
    return notebookErrorResult("cell_id must be a non-empty string for replace and delete");
  }

  const cellIndex = findCellIndex(notebook, input.cellId);
  if (cellIndex === -1) {
    return notebookErrorResult(`Could not find cell_id ${input.cellId}.`);
  }

  const existing = notebook.cells[cellIndex]!;
  const cellId = existing.id ?? `cell-${cellIndex}`;
  if (input.mode === "delete") {
    notebook.cells.splice(cellIndex, 1);
    return {
      ok: true,
      cellId
    };
  }

  existing.source = sourceToNotebookField(input.newSource ?? "");
  if (existing.cell_type === "code") {
    existing.execution_count = null;
    existing.outputs = [];
  }
  return {
    ok: true,
    cellId
  };
}

function notebookErrorResult(content: string, metadata?: ToolResult["metadata"]): ToolFailure {
  return errorResult(content, metadata) as ToolFailure;
}

function findCellIndex(notebook: NotebookContent, cellId: string): number {
  const idIndex = notebook.cells.findIndex((cell) => cell.id === cellId);
  if (idIndex !== -1) {
    return idIndex;
  }
  const fallback = /^cell-(\d+)$/u.exec(cellId);
  if (fallback === null) {
    return -1;
  }
  const index = Number.parseInt(fallback[1]!, 10);
  return Number.isInteger(index) && index >= 0 && index < notebook.cells.length ? index : -1;
}

function createNotebookCell(notebook: NotebookContent, cellType: "code" | "markdown", source: string): NotebookCell {
  const base: NotebookCell = {
    cell_type: cellType,
    id: generateCellId(notebook),
    metadata: {},
    source: sourceToNotebookField(source)
  };
  if (cellType === "code") {
    base.execution_count = null;
    base.outputs = [];
  }
  return base;
}

function generateCellId(notebook: NotebookContent): string | undefined {
  if (notebook.nbformat < 4 || (notebook.nbformat === 4 && notebook.nbformat_minor < 5)) {
    return undefined;
  }
  const existing = new Set(notebook.cells.map((cell) => cell.id).filter((id): id is string => typeof id === "string"));
  for (let index = notebook.cells.length + 1; ; index += 1) {
    const id = `cell-${index}`;
    if (!existing.has(id)) {
      return id;
    }
  }
}

function sourceToNotebookField(source: string): string | string[] {
  if (source.length === 0) {
    return "";
  }
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.includes("\n")) {
    return normalized;
  }
  const parts = normalized.split("\n");
  return parts.map((part, index) => index === parts.length - 1 ? part : `${part}\n`);
}

async function writeNotebookAtomically(path: string, content: string): Promise<void> {
  const tempDir = await mkdtemp(join(dirname(path), `.${basename(path)}.`));
  const tempPath = join(tempDir, basename(path));
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, path);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function renderNotebookEditResult(input: {
  path: string;
  editMode: string;
  cellId: string;
  beforeCellCount: number;
  afterCellCount: number;
}): string {
  return [
    `Updated ${input.path}.`,
    `Mode: ${input.editMode}.`,
    `Cell: ${input.cellId}.`,
    `Cells: ${input.beforeCellCount} -> ${input.afterCellCount}.`
  ].join("\n");
}

function buildNotebookChangePreview(input: {
  path: string;
  editMode: string;
  cellId: string;
  beforeCellCount: number;
  afterCellCount: number;
}): FileChangePreviewViewModel {
  return {
    kind: "fileChangePreview",
    path: input.path,
    changeType: "modified",
    summary: [
      `Notebook ${input.editMode}.`,
      `Cell ${input.cellId}.`,
      `${input.beforeCellCount} cell(s) -> ${input.afterCellCount} cell(s).`
    ],
    diff: [
      `@@ notebook ${input.editMode} @@`,
      `cell: ${input.cellId}`,
      `cells: ${input.beforeCellCount} -> ${input.afterCellCount}`
    ].slice(0, PREVIEW_LINES).join("\n"),
    omittedLineCount: 0
  };
}
