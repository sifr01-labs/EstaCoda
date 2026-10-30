import { beginCommandFileObservation, finishCommandFileObservation } from "../execution/command-file-evidence.js";
import type { ToolExecutionContext } from "../contracts/tool.js";
import { undispatchedResult } from "./undispatched-result.js";
import { EditorContentView } from "../execution/editor-content-view.js";
import { HostProcessScope, type HostProcesses } from "../execution/host-processes.js";
import { HostWorkspaceFiles, type WorkspaceFiles, type WorkspacePathOptions } from "../execution/host-workspace-files.js";
import type { HostExecutionLease } from "../execution/host-environment.js";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { platform } from "node:os";
import type { EnvironmentType } from "../contracts/security.js";
import type { SessionToolContext } from "../contracts/tool-context.js";
import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import type { FileChangePreviewViewModel } from "../contracts/view-model.js";
import type { FileStateOperationKind, FileStateTracker } from "../delegation/file-state-tracker.js";
import { isLikelyBinary, isTextyPath } from "../context/context-security.js";
import { assessHardlineFloor } from "../security/command-safety.js";
import { createTerminalInspectTool } from "./terminal-inspect-tool.js";
import type { ProcessManager } from "../process/process-manager.js";
import { errorResult } from "./workspace-paths.js";

export type WorkspaceToolOptions = {
  canReadTaskResults?: () => boolean;
  taskResultService?: Pick<import("../tasks/task-result-service.js").TaskResultService, "readText">;
  executionLease?: HostExecutionLease;
  workspaceRoot: string;
  maxReadBytes?: number;
  maxSearchResults?: number;
  commandTimeoutMs?: number;
  processManager?: ProcessManager;
  fsAdapter?: WorkspaceFsAdapter;
  fileStateTracker?: FileStateTracker;
  sessionId?: string | (() => string);
  parentSessionId?: string;
  childSessionId?: string | (() => string | undefined);
  childProcessEnv?: SessionToolContext["childProcessEnv"];
};

export type WorkspaceFsAdapter = {
  /** Explicit ACP compatibility: approved writes target disk after editor parity checks. */
  writeMode?: "materialized";
  /** Internal prepared transaction view; checks editor parity once before apply/rollback. */
  prepareMaterializedTransaction?: () => Promise<WorkspaceFsAdapter>;
  readTextFile(input: { path: string; lineStart?: number; lineEnd?: number }): Promise<string>;
  writeTextFile?(input: { path: string; content: string }): Promise<void>;
  deleteTextFile?(input: { path: string }): Promise<void>;
};

const DEFAULT_MAX_READ_BYTES = 48_000;
const DEFAULT_MAX_SEARCH_RESULTS = 80;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const FILE_CHANGE_PREVIEW_LINES = 8;
const MAX_TERMINAL_CONTEXT_SUMMARY_CHARS = 500;
const MAX_TERMINAL_CONTEXT_COMMAND_CHARS = 220;
const FILE_WRITE_SHRINK_GUARD_MIN_OLD_BYTES = 500;
const FILE_WRITE_SHRINK_GUARD_MAX_RATIO = 0.5;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo"]);

type PatchMatchStrategy =
  | "exact"
  | "line_trimmed"
  | "whitespace_normalized"
  | "indentation_flexible"
  | "escape_normalized"
  | "trimmed_boundary"
  | "unicode_normalized"
  | "block_anchor"
  | "context_aware";

type PatchMatchRange = {
  start: number;
  end: number;
  strategy: PatchMatchStrategy;
};

type PatchMatchResult =
  | {
      ok: true;
      ranges: PatchMatchRange[];
      strategy: PatchMatchStrategy;
    }
  | {
      ok: false;
      content: string;
      metadata?: ToolResult["metadata"];
    };

type ParsedWorkspacePatch = {
  files: ParsedWorkspacePatchFile[];
};

type ParsedWorkspacePatchFile =
  | ParsedWorkspacePatchUpdateFile
  | ParsedWorkspacePatchAddFile
  | ParsedWorkspacePatchDeleteFile;

type ParsedWorkspacePatchUpdateFile = {
  operation: "update";
  path: string;
  hunks: ParsedWorkspacePatchHunk[];
};

type ParsedWorkspacePatchAddFile = {
  operation: "add";
  path: string;
  lines: string[];
};

type ParsedWorkspacePatchDeleteFile = {
  operation: "delete";
  path: string;
};

type ParsedWorkspacePatchHunk = {
  contextHint?: string;
  lines: ParsedWorkspacePatchLine[];
};

type ParsedWorkspacePatchLine = {
  kind: "context" | "remove" | "add";
  text: string;
};

type PreparedWorkspacePatchFile = {
  operation: "update" | "add" | "delete";
  path: string;
  absolutePath: string;
  before: string;
  after: string;
  hunkCount: number;
  matchDiagnostics: PatchMatchDiagnostic[];
};

type PatchMatchDiagnostic = {
  strategy: PatchMatchStrategy;
  confidence: number;
  matchedSnippet?: string;
};

type PatchFailureTracker = {
  record(result: ToolResult, path: string | undefined): ToolResult;
  clear(path: string): void;
  clearMany(paths: string[]): void;
};

type PatchRollbackStep = {
  path: string;
  operation: "delete_added_file" | "restore_updated_file" | "restore_deleted_file";
  run: () => Promise<void>;
};

export function createWorkspaceTools(options: WorkspaceToolOptions): readonly RegisteredTool[] {
  const root = options.executionLease?.workspaceRoot ?? resolve(options.workspaceRoot);
  const processes = options.executionLease?.processes ?? new HostProcessScope(root);
  const files = options.executionLease?.files ?? new HostWorkspaceFiles(root);
  const { isOutputMaterialized, applyWorkspacePatchMode, applyPreparedWorkspacePatchFiles, writePreparedWorkspacePatchFile, deletePreparedWorkspacePatchFile, writeTextFileAtomically, applyWorkspacePatchOperationMode, prepareWorkspacePatchFiles, ensureSafeParentDirectories, readWorkspaceFile, searchDirectory, searchFile, readExistingWorkspaceText, realpath, readFile, writeFile, resolveWorkspacePath } = createWorkspaceIO(files);
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxSearchResults = options.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const contentView = options.executionLease?.content ?? new EditorContentView(files, root);
  const originalAdapter = options.fsAdapter;
  const fsAdapter: WorkspaceFsAdapter | undefined = originalAdapter === undefined ? undefined : {
    ...originalAdapter,
    prepareMaterializedTransaction: originalAdapter.writeMode !== "materialized" ? undefined : async () => {
      await contentView.assertMaterialized();
      return {
        readTextFile: ({ path }) => files.readFile(path, "utf8"),
        writeTextFile: async ({ path, content }) => {
          const blocked = await ensureSafeParentDirectories(path, await realpath(root));
          if (blocked) throw new Error(blocked.content);
          await writeTextFileAtomically(path, content);
        },
        deleteTextFile: ({ path }) => files.rm(path)
      };
    },
    readTextFile: ({ path }) => contentView.read(path, () => originalAdapter.readTextFile({ path })),
    writeTextFile: originalAdapter.writeTextFile?.bind(originalAdapter) ?? (async ({ path, content }) => {
      if (originalAdapter.writeMode !== "materialized") throw new Error("The editor does not support writes. Save the file or use a workspace with write support.");
      await contentView.assertMaterialized();
      const blocked = await ensureSafeParentDirectories(path, await realpath(root));
      if (blocked) throw new Error(blocked.content);
      await writeTextFileAtomically(path, content);
    }),
    deleteTextFile: originalAdapter.deleteTextFile?.bind(originalAdapter) ?? (originalAdapter.writeMode === "materialized" ? async ({ path }) => {
      await contentView.assertMaterialized();
      await files.rm(path);
    } : undefined)
  };
  const patchFailureTracker = createPatchFailureTracker();
  // Only a file.read that actually reached its authorized handler can mint a
  // source-copy reference. A hash supplied by the model alone grants no read.
  const copySources = new Map<string, string>();

  return [
    {
      name: "file.read",
      description: "Read a text file inside the active workspace. For large files, use small lineStart/lineEnd ranges and advance through them; truncated excerpts are not complete file content. The leading # path line is a display label, not file content; do not include it when copying or editing the file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          lineStart: { type: ["number", "null"] },
          lineEnd: { type: ["number", "null"] }
        },
        required: ["path"]
      },
      riskClass: "read-only-local",
      toolsets: ["files", "coding", "research"],
      progressLabel: "reading file",
      maxResultSizeChars: maxReadBytes,
      isAvailable: () => true,
      run: async (input: { path?: string; lineStart?: number | null; lineEnd?: number | null }) => {
        const canonicalRoot = await realpath(root);
        const path = await resolveWorkspacePath(canonicalRoot, input.path);
        if (!path.ok) {
          return path;
        }

        let result: ToolResult;
        if (fsAdapter !== undefined) {
          const content = await fsAdapter.readTextFile({
            path: path.path,
            lineStart: input.lineStart ?? undefined,
            lineEnd: input.lineEnd ?? undefined
          });
          result = renderWorkspaceFile(canonicalRoot, path.path, content, {
            maxReadBytes,
            lineStart: input.lineStart ?? undefined,
            lineEnd: input.lineEnd ?? undefined
          });
        } else {
          result = await readWorkspaceFile(canonicalRoot, path.path, {
            maxReadBytes,
            lineStart: input.lineStart ?? undefined,
            lineEnd: input.lineEnd ?? undefined
          });
        }

        const materialized = fsAdapter === undefined || await contentView.isMaterialized(path.path);
        if (!materialized || typeof result.metadata?.observedContentSha256 !== "string" ||
          copySources.get(path.path) !== result.metadata.observedContentSha256) copySources.delete(path.path);
        if (materialized && typeof result.metadata?.contentSha256 === "string") {
          copySources.set(path.path, result.metadata.contentSha256);
          if (copySources.size > 128) copySources.delete(copySources.keys().next().value!);
        }
        result.metadata = { ...result.metadata, contentSource: fsAdapter === undefined ? "materialized" : "editor", materialized };
        if (!materialized) result.content += "\n[Editor content differs from disk. Save or reload it before command execution.]";
        recordFileStateOperation(options, {
          operation: "read",
          sourceTool: "file.read",
          path: metadataPath(result, canonicalRoot, path.path),
          bytes: metadataNumber(result.metadata?.bytes),
          changed: undefined,
          previewAvailable: false
        });
        return result;
      }
    },
    {
      name: "file.write",
      description: "Write a text file inside the active workspace, creating parent directories as needed. Supply content, sourceFile to copy a workspace UTF-8 text file exactly, or sourceResult to copy an authorized accepted Task result exactly without retyping it. For narrow edits prefer file.patch; preserve explicitly protected fields, types, and whitespace. If requested changes conflict with preservation constraints, ask before changing protected content. Existing files require overwrite=true when content changes; suspicious shrink overwrites also require allowShrink=true.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: ["string", "null"] },
          sourceFile: { type: ["object", "null"], additionalProperties: false,
            properties: { path: { type: "string" } },
            required: ["path"], description: "Exact copy of a workspace text file. First file.read the complete source, then supply its path. The runtime binds the copy to that observed source internally. Preserves Unicode, line endings and all trailing newlines; fails if the source changed. Omit content or supply an empty string." },
          sourceResult: { type: ["object", "null"], additionalProperties: false,
            properties: { taskId: { type: "string" }, resultId: { type: "string" } },
            required: ["taskId", "resultId"], description: "Copy this session-authorized accepted Task result exactly. Omit content or supply an empty string if the provider requires the field." },
          overwrite: {
            type: "boolean",
            description: "Required as true when replacing changed content in an existing file. Creates and same-content writes do not require it.",
            default: false
          },
          allowShrink: {
            type: "boolean",
            description: "Required as true, in addition to overwrite=true, when the new content is much smaller than the existing file.",
            default: false
          }
        },
        required: ["path"]
      },
      riskClass: "workspace-write",
      toolsets: ["files", "coding"],
      progressLabel: "writing file",
      maxResultSizeChars: 2000,
      isAvailable: () => true,
      run: async (input: { path?: string; content?: string | null; sourceResult?: { taskId?: string; resultId?: string } | null; sourceFile?: { path?: string } | null; overwrite?: boolean; allowShrink?: boolean }) => {
        let copiedSource: { path: string; contentSha256: string } | undefined;
        if (input.sourceFile != null) {
          const source = input.sourceFile;
          if (input.sourceResult != null || (input.content != null && input.content !== "") ||
              typeof source.path !== "string" || Object.keys(source).some(key => key !== "path")) {
            return undispatchedResult(errorResult("Use only sourceFile with path after file.read; do not combine it with content or sourceResult."));
          }
          const canonicalRoot = await realpath(root);
          const sourcePath = await resolveWorkspacePath(canonicalRoot, source.path, { forbidSymlinks: true });
          if (!sourcePath.ok) return undispatchedResult(sourcePath);
          const observedDigest = copySources.get(sourcePath.path);
          if (observedDigest === undefined) {
            return undispatchedResult(errorResult("Read the complete source with file.read before using sourceFile. A source path alone does not authorize a read."));
          }
          if (fsAdapter !== undefined && !await contentView.isMaterialized(sourcePath.path).catch(() => false)) {
            return undispatchedResult(errorResult("Save or reload the source editor buffer before copying its disk content."));
          }
          const bytes = await readFile(sourcePath.path).catch(() => undefined);
          if (bytes === undefined) return undispatchedResult(errorResult("Source could not be read. Read it again before copying."));
          const content = bytes.toString("utf8");
          if (isLikelyBinary(bytes) || !Buffer.from(content, "utf8").equals(bytes)) {
            return undispatchedResult(errorResult("Exact text copies require valid UTF-8 text, not binary content."));
          }
          const digest = createHash("sha256").update(bytes).digest("hex");
          if (digest !== observedDigest) return undispatchedResult(errorResult("Source changed since it was read. Read the source again before copying."));
          copiedSource = { path: relative(canonicalRoot, sourcePath.path), contentSha256: digest };
          input = { ...input, content };
        }
        if (input.sourceResult != null) {
          const source = input.sourceResult;
          const sessionId = resolveString(options.sessionId);
          if ((input.content != null && input.content !== "") || !source || typeof source.taskId !== "string" || typeof source.resultId !== "string" ||
              Object.keys(source).some(key => key !== "taskId" && key !== "resultId")) return undispatchedResult(errorResult("Use either content or sourceResult with taskId and resultId."));
          if (!options.taskResultService || !sessionId || options.canReadTaskResults?.() !== true) return undispatchedResult(errorResult("Task result content is unavailable in this session."));
          try {
            const resolved = await options.taskResultService.readText({ taskId: source.taskId, resultId: source.resultId, sessionId });
            if (resolved.result.disposition !== "accepted") return undispatchedResult(errorResult("Only accepted Task results can be copied with sourceResult."));
            input = { ...input, content: resolved.content };
          } catch { return undispatchedResult(errorResult("Task result content is unavailable or failed integrity verification for this session.")); }
        }
        if (typeof input.content !== "string") {
          return undispatchedResult(errorResult("content must be a string"));
        }

        const canonicalRoot = await realpath(root);
        const path = await resolveWorkspacePath(canonicalRoot, input.path, { allowMissingLeaf: true, forbidSymlinks: true });
        if (!path.ok) {
          return undispatchedResult(path);
        }

        const relativePath = relative(canonicalRoot, path.path);
        if (copiedSource?.path === relativePath) return undispatchedResult(errorResult("Source and destination must be different files."));
        const existing = await readExistingWorkspaceText(path.path, fsAdapter);
        const oldBytes = existing === undefined ? 0 : Buffer.byteLength(existing);
        const bytes = Buffer.byteLength(input.content);
        const changed = existing !== input.content;
        const overwritesExisting = existing !== undefined && changed;
        const shrinkAssessment = assessFileWriteShrink(existing, input.content);
        const preview = buildFileWriteChangePreview({
          path: relativePath,
          before: existing,
          after: input.content,
          bytes
        });

        if (overwritesExisting && input.overwrite !== true) {
          return undispatchedResult(errorResult(`file.write would overwrite existing ${relativePath}. Re-read the file if needed, then set overwrite=true only when replacing the entire file is intended.`, {
            path: relativePath,
            oldBytes,
            newBytes: bytes,
            byteDelta: bytes - oldBytes,
            changed,
            existedBefore: true,
            overwriteRequired: true,
            suspiciousShrink: shrinkAssessment.suspicious,
            reason: "overwrite_intent_required",
            fileChangePreview: preview
          }));
        }

        if (overwritesExisting && shrinkAssessment.suspicious && input.allowShrink !== true) {
          return undispatchedResult(errorResult(`Suspicious file.write overwrite blocked for ${relativePath}: new content is much smaller than the existing file. Use file.patch for targeted edits, or set allowShrink=true only when this shrink is intentional.`, {
            path: relativePath,
            oldBytes,
            newBytes: bytes,
            byteDelta: bytes - oldBytes,
            oldLines: shrinkAssessment.oldLines,
            newLines: shrinkAssessment.newLines,
            shrinkRatio: shrinkAssessment.ratio,
            changed,
            existedBefore: true,
            overwriteRequired: true,
            suspiciousShrink: true,
            reason: "suspicious_shrink_overwrite",
            fileChangePreview: preview
          }));
        }

        if (changed) {
          if (fsAdapter?.writeTextFile !== undefined) {
            await fsAdapter.writeTextFile({
              path: path.path,
              content: input.content
            });
          } else {
            const ensureResult = await ensureSafeParentDirectories(path.path, canonicalRoot);
            if (ensureResult !== undefined) {
              return ensureResult;
            }
            await writeFile(path.path, input.content, "utf8");
          }
        }

        const result: ToolResult = {
          ok: true,
          content: changed
            ? `Wrote ${relativePath} (${bytes} bytes).`
            : `No changes to ${relativePath}; content is already up to date (${bytes} bytes).`,
          metadata: {
            path: relativePath,
            contentSha256: createHash("sha256").update(input.content).digest("hex"),
            materialized: await isOutputMaterialized(path.path, input.content, fsAdapter),
            ...(copiedSource === undefined ? {} : { copiedSource }),
            bytes,
            oldBytes,
            newBytes: bytes,
            byteDelta: bytes - oldBytes,
            changed,
            existedBefore: existing !== undefined,
            overwrite: overwritesExisting,
            suspiciousShrink: shrinkAssessment.suspicious,
            fileChangePreview: preview
          }
        };
        recordFileStateOperation(options, {
          operation: "write",
          sourceTool: "file.write",
          path: relativePath,
          bytes,
          changed: existing !== input.content,
          previewAvailable: result.metadata?.fileChangePreview !== undefined
        });
        return result;
      }
    },
    {
      name: "file.patch",
      description: "For narrow edits change only requested content and compare the diff against explicit preservation constraints. Preserve unrelated fields and types. If constraints conflict, clarify before editing. Patch workspace files. Replace and insert modes find anchors with exact matching first, then deterministic fuzzy fallbacks for minor whitespace, indentation, escaping, and Unicode differences. Append/prepend modes add content without rewriting whole files. Patch mode validates every operation before writing and rolls back already-applied changes if a later write/delete fails.",
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["replace", "patch", "append", "prepend", "insert"],
            description: "Edit mode. 'replace' requires path, old_string, and new_string. 'append'/'prepend' require path and content. 'insert' requires path, anchor, content, and optional position. 'patch' requires patch.",
            default: "replace"
          },
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          content: {
            type: "string",
            description: "Content used by append, prepend, and insert modes."
          },
          anchor: {
            type: "string",
            description: "Anchor text used by insert mode. Must match exactly or via a deterministic fuzzy fallback."
          },
          position: {
            type: "string",
            enum: ["before", "after"],
            description: "Where insert mode places content relative to anchor.",
            default: "after"
          },
          replace_all: {
            type: "boolean",
            description: "Replace all occurrences instead of requiring a unique match.",
            default: false
          },
          patch: {
            type: "string",
            description: "Required when mode='patch'. V4A format patch content with *** Begin Patch, *** Update File / *** Add File / *** Delete File sections, optional @@ context @@ update hunks, and *** End Patch."
          }
        },
        required: ["mode"]
      },
      riskClass: "workspace-write",
      toolsets: ["files", "coding"],
      progressLabel: "patching file",
      maxResultSizeChars: 3000,
      isAvailable: () => true,
      run: async (input: { mode?: string; path?: string; old_string?: string; new_string?: string; content?: string; anchor?: string; position?: string; replace_all?: boolean; patch?: string }) => {
        const mode = input.mode ?? "replace";
        if (mode !== "replace" && mode !== "patch" && mode !== "append" && mode !== "prepend" && mode !== "insert") {
          return errorResult("mode must be 'replace', 'patch', 'append', 'prepend', or 'insert'");
        }
        if (mode === "patch") {
          if (typeof input.patch !== "string" || input.patch.trim().length === 0) {
            return errorResult("patch must be a non-empty string when mode='patch'");
          }
          const canonicalRoot = await realpath(root);
          const result = await applyWorkspacePatchMode({
            root: canonicalRoot,
            patch: input.patch,
            fsAdapter,
            recordOperation: (operation) => recordFileStateOperation(options, operation)
          });
          if (!result.ok) {
            return patchFailureTracker.record(result, metadataPathString(result.metadata?.path));
          }
          patchFailureTracker.clearMany(metadataPathList(result.metadata?.paths));
          return result;
        }
        if (mode === "append" || mode === "prepend" || mode === "insert") {
          if (typeof input.content !== "string") {
            return errorResult("content must be a string for append, prepend, and insert modes");
          }
          if (mode === "insert" && (typeof input.anchor !== "string" || input.anchor.length === 0)) {
            return errorResult("anchor must be a non-empty string for insert mode");
          }
          if (input.position !== undefined && input.position !== "before" && input.position !== "after") {
            return errorResult("position must be 'before' or 'after'");
          }

          const canonicalRoot = await realpath(root);
          const result = await applyWorkspacePatchOperationMode({
            root: canonicalRoot,
            path: input.path,
            mode,
            content: input.content,
            anchor: input.anchor,
            position: input.position === "before" ? "before" : "after",
            fsAdapter,
            recordOperation: (operation) => recordFileStateOperation(options, operation)
          });
          if (!result.ok) {
            return patchFailureTracker.record(result, metadataPathString(result.metadata?.path));
          }
          const resultPath = metadataPathString(result.metadata?.path);
          if (resultPath !== undefined) {
            patchFailureTracker.clear(resultPath);
          }
          return result;
        }
        if (typeof input.old_string !== "string" || typeof input.new_string !== "string") {
          return errorResult("old_string and new_string must be strings");
        }
        if (input.old_string.length === 0) {
          return errorResult("old_string must not be empty");
        }

        const canonicalRoot = await realpath(root);
        const path = await resolveWorkspacePath(canonicalRoot, input.path, { forbidSymlinks: true });
        if (!path.ok) {
          return path;
        }

        const existing = fsAdapter !== undefined
          ? await fsAdapter.readTextFile({ path: path.path })
          : await readFile(path.path, "utf8");
        const replaceAll = input.replace_all === true;
        const relativePath = relative(canonicalRoot, path.path);
        const match = findPatchReplacementRanges(existing, input.old_string, {
          path: relativePath,
          replaceAll
        });
        if (!match.ok) {
          return patchFailureTracker.record(errorResult(match.content, match.metadata), relativePath);
        }

        const matchCount = match.ranges.length;
        const next = applyPatchReplacementRanges(existing, match.ranges, input.new_string);
        if (fsAdapter?.writeTextFile !== undefined) {
          await fsAdapter.writeTextFile({
            path: path.path,
            content: next
          });
        } else {
          await writeFile(path.path, next, "utf8");
        }

        const result: ToolResult = {
          ok: true,
          content: `Updated ${relativePath}.`,
          metadata: {
            path: relativePath,
            contentSha256: createHash("sha256").update(next).digest("hex"),
            materialized: await isOutputMaterialized(path.path, next, fsAdapter),
            oldBytes: Buffer.byteLength(existing),
            newBytes: Buffer.byteLength(next),
            matchCount,
            matchStrategy: match.strategy,
            matchConfidence: matchConfidence(match.strategy),
            matchedSnippet: buildMatchedSnippet(existing, match.ranges[0]),
            fileChangePreview: buildFileReplaceChangePreview({
              path: relativePath,
              oldString: input.old_string,
              newString: input.new_string,
              oldBytes: Buffer.byteLength(existing),
              newBytes: Buffer.byteLength(next),
              matchCount,
              matchStrategy: match.strategy
            })
          }
        };
        recordFileStateOperation(options, {
          operation: "replace",
          sourceTool: "file.patch",
          path: relativePath,
          bytes: Buffer.byteLength(next),
          changed: next !== existing,
          previewAvailable: result.metadata?.fileChangePreview !== undefined
        });
        patchFailureTracker.clear(relativePath);
        return result;
      }
    },
    {
      name: "file.search",
      description: "Search text files inside the active workspace with a simple literal or regex query. For ripgrep-backed search, file filtering, output modes, context, and pagination, prefer file.grep.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          regex: { type: "boolean" },
          path: { type: "string" }
        },
        required: ["query"]
      },
      riskClass: "read-only-local",
      toolsets: ["files", "coding", "research"],
      progressLabel: "searching files",
      maxResultSizeChars: 12_000,
      isAvailable: () => true,
      run: async (input: { query?: string; regex?: boolean; path?: string }) => {
        if (typeof input.query !== "string" || input.query.length === 0) {
          return errorResult("query must be a non-empty string");
        }

        const canonicalRoot = await realpath(root);
        const start = await resolveWorkspacePath(canonicalRoot, input.path ?? ".", { allowDirectory: true });
        if (!start.ok) {
          return start;
        }

        let matcher: RegExp | undefined;
        if (input.regex === true) {
          try {
            matcher = new RegExp(input.query, "i");
          } catch (error) {
            return errorResult(`invalid regex: ${error instanceof Error ? error.message : "failed to compile query"}`);
          }
        }
        try { await contentView.assertMaterialized(); } catch (error) { return errorResult(error instanceof Error ? error.message : "Editor content is not materialized."); }
        const results: string[] = [];

        await searchDirectory(canonicalRoot, start.path, {
          matcher,
          query: input.query,
          results,
          maxSearchResults,
          visitedDirectories: new Set()
        });

        return {
          ok: true,
          content: results.length === 0
            ? `No matches for ${input.query}.`
            : results.join("\n"),
          metadata: {
            query: input.query,
            results: results.length,
            truncated: results.length >= maxSearchResults
          }
        };
      }
    },
    createTerminalInspectTool({
      workspaceRoot: root,
      signal: options.executionLease?.signal,
      assertMaterialized: () => contentView.assertMaterialized(),
      files,
      processes,
      timeoutMs: Math.min(commandTimeoutMs, 10_000)
    }),
    {
      name: "terminal.run",
      // Let the command timer collect its outcome before the outer tool deadline.
      executionTimeoutMs: commandTimeoutMs + 5_000,
      description: options.processManager
        ? `Run a shell command in the active workspace. With timeoutMs omitted or null, wait up to ${Math.min(commandTimeoutMs, 30_000)} ms, then return a managed process ID if still running. Use process.logs (bounded wait) until it exits; process.stop cancels it. A running process is not task completion. An explicit timeoutMs is a hard execution limit.`
        : `Run a shell command in the active workspace for at most ${commandTimeoutMs} ms. For longer jobs, discover and request managed process tools, then start and poll the process within the task budget.`,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          verification: { type: ["string", "null"], pattern: "^[a-z][a-z0-9-]{0,79}$", description: "Stable name of the task requirement this command checks, e.g. package-installation or unit-tests. Reuse the same name for alternative implementations and rechecks of that requirement. Omit or use null for exploration or debugging a method. Each declared requirement needs a successful check on current output; unrelated checks cannot clear it. Preserve the check exit status. This grants no execution authority." },
          timeoutMs: { type: ["number", "null"], minimum: 1, maximum: commandTimeoutMs, description: `Explicit hard execution limit in milliseconds, maximum ${commandTimeoutMs}. Omit or use null for the default behavior described above.` }
        },
        required: ["command"]
      },
      riskClass: "workspace-write",
      toolsets: ["shell-readonly", "shell-write", "coding", "research"],
      progressLabel: "running command",
      maxResultSizeChars: 16_000,
      isAvailable: () => true,
      // A collected process exit is a failed command, not a lost execution.
      // Its output may describe partial changes; every later call still passes
      // normal authorization. Signals, deadlines and cancellation stay uncertain.
      isFailureOutcomeKnown: result => Number.isInteger(result.metadata?.code) &&
        result.metadata?.signal === null && result.metadata.timedOut === false && result.metadata.cancelled === false,
      run: async (input: { command?: string; timeoutMs?: number | null; verification?: string | null }, context) => {
        if (typeof input.command !== "string" || input.command.trim().length === 0) {
          return errorResult("command must be a non-empty string");
        }
        if (input.verification != null && (typeof input.verification !== "string" || !/^[a-z][a-z0-9-]{0,79}$/u.test(input.verification))) {
          return undispatchedResult(errorResult("verification must be a requirement name using 1–80 lowercase letters, digits, or hyphens, beginning with a letter"));
        }

        const blockedReason = explainCommandBlock(input.command, context?.environmentType);
        if (blockedReason !== undefined) {
          return errorResult(blockedReason);
        }

        if (input.timeoutMs != null && (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > commandTimeoutMs)) {
          return undispatchedResult(errorResult(`Command was not started: timeoutMs must be between 1 and ${commandTimeoutMs}. For longer jobs, discover and request managed process tools, then start and poll the process within the task budget.`));
        }

        try { await contentView.assertMaterialized(); } catch (error) { return errorResult(error instanceof Error ? error.message : "Editor content is not materialized."); }
        const signal = AbortSignal.any([...[context?.signal, options.executionLease?.signal].filter((value): value is AbortSignal => value !== undefined)]);
        if (options.processManager && input.timeoutMs == null) {
          return runManagedCommand(options.processManager, input.command, Math.min(commandTimeoutMs, 30_000), signal, context?.continuationSignal ?? options.executionLease?.signal, context, input.verification ?? undefined);
        }
        const ownedProcesses = options.executionLease ? undefined : new HostProcessScope(root);
        const observation = await beginCommandFileObservation(files, context?.requestContract?.requirements, context?.visibleTurnId);
        try { const result = await runCommand(
          await realpath(root),
          input.command,
          Math.max(1, Math.min(Number.isFinite(input.timeoutMs) ? input.timeoutMs! : commandTimeoutMs, commandTimeoutMs)),
          options.childProcessEnv,
          options.executionLease?.processes ?? ownedProcesses!,
          signal
        );
          return { ...result, metadata: { ...result.metadata, command: input.command, cwd: root, verification: input.verification ?? undefined, commandFileObservation: await finishCommandFileObservation(files, observation) } };
        } finally { await ownedProcesses?.release(); }
      }
    }
  ];
}

export const workspaceToolProvider: SessionToolProvider = {
  name: "workspace",
  kind: "session",
  createTools(ctx) {
    return createWorkspaceTools({
      canReadTaskResults: ctx.canReadTaskResults,
      taskResultService: ctx.taskResultService,
      workspaceRoot: ctx.workspaceRoot,
      executionLease: ctx.executionLease,
      processManager: ctx.processManager,
      fsAdapter: ctx.workspaceFsAdapter,
      fileStateTracker: ctx.fileStateTracker,
      sessionId: ctx.currentSessionId,
      parentSessionId: ctx.parentSessionId,
      childSessionId: ctx.childSessionId,
      childProcessEnv: ctx.childProcessEnv
    });
  }
};

function recordFileStateOperation(
  options: WorkspaceToolOptions,
  input: {
    operation: FileStateOperationKind;
    sourceTool: string;
    path: string;
    bytes?: number;
    changed?: boolean;
    previewAvailable?: boolean;
  }
): void {
  const sessionId = resolveString(options.sessionId);
  if (options.fileStateTracker === undefined || sessionId === undefined) {
    return;
  }
  const childSessionId = resolveString(options.childSessionId);
  options.fileStateTracker.recordOperation({
    sessionId,
    parentSessionId: options.parentSessionId,
    childSessionId,
    path: input.path,
    operation: input.operation,
    sourceTool: input.sourceTool,
    metadata: {
      bytes: input.bytes,
      changed: input.changed,
      previewAvailable: input.previewAvailable
    }
  });
}

function resolveString(value: string | (() => string | undefined) | undefined): string | undefined {
  return typeof value === "function" ? value() : value;
}

function metadataPath(result: ToolResult, root: string, path: string): string {
  return typeof result.metadata?.path === "string" ? result.metadata.path : relative(root, path);
}

function metadataNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataPathString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataPathList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((path): path is string => typeof path === "string" && path.length > 0)
    : [];
}

function createPatchFailureTracker(): PatchFailureTracker {
  const failuresByPath = new Map<string, number>();

  return {
    record(result, path) {
      if (path === undefined) {
        return result;
      }

      const failureCount = (failuresByPath.get(path) ?? 0) + 1;
      failuresByPath.set(path, failureCount);
      const escalated = failureCount >= 3;
      const recoveryHint = escalated
        ? `This is failure #${failureCount} patching '${path}'. Stop retrying. Re-read the file or use file.write only if replacing the entire file is intended.`
        : "Use file.read to verify current content, or file.search to locate the text.";
      const content = result.content.includes(recoveryHint)
        ? result.content
        : `${result.content}\n\n${recoveryHint}`;

      return {
        ...result,
        content,
        metadata: {
          ...(result.metadata ?? {}),
          path,
          patchFailureCount: failureCount,
          patchFailureEscalated: escalated
        }
      };
    },
    clear(path) {
      failuresByPath.delete(path);
    },
    clearMany(paths) {
      for (const path of paths) {
        failuresByPath.delete(path);
      }
    }
  };
}

function validatePatchTransactionSupport(
  files: PreparedWorkspacePatchFile[],
  fsAdapter: WorkspaceFsAdapter | undefined
): ToolResult | undefined {
  if (fsAdapter?.writeTextFile !== undefined && fsAdapter.deleteTextFile === undefined && files.some((file) => file.operation === "add")) {
    return errorResult("workspace file adapter does not support transactional rollback for added files", {
      reason: "patch_transaction_unsupported",
      operation: "add"
    });
  }
  if (fsAdapter?.deleteTextFile !== undefined && fsAdapter.writeTextFile === undefined && files.some((file) => file.operation === "delete")) {
    return errorResult("workspace file adapter does not support transactional rollback for deleted files", {
      reason: "patch_transaction_unsupported",
      operation: "delete"
    });
  }
  return undefined;
}

function formatPatchApplyError(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

function patchOperationPastTense(mode: "append" | "prepend" | "insert"): string {
  if (mode === "append") return "Appended";
  if (mode === "prepend") return "Prepended";
  return "Inserted";
}

function parseWorkspacePatch(patch: string): { ok: true; patch: ParsedWorkspacePatch } | ToolResult {
  const lines = patch.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") {
    return errorResult("patch must start with *** Begin Patch");
  }

  const files: ParsedWorkspacePatchFile[] = [];
  const seenPaths = new Set<string>();
  let currentFile: ParsedWorkspacePatchFile | undefined;
  let currentHunk: ParsedWorkspacePatchHunk | undefined;
  let ended = false;

  const finishHunk = () => {
    if (currentHunk !== undefined && currentFile?.operation === "update") {
      currentFile?.hunks.push(currentHunk);
      currentHunk = undefined;
    }
  };

  const finishFile = () => {
    finishHunk();
    if (currentFile !== undefined) {
      if (currentFile.operation === "update" && currentFile.hunks.length === 0) {
        throw new Error(`patch file ${currentFile.path} has no hunks`);
      }
      if (currentFile.operation === "add" && currentFile.lines.length === 0) {
        throw new Error(`patch add file ${currentFile.path} has no content lines`);
      }
      files.push(currentFile);
      currentFile = undefined;
    }
  };

  try {
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (ended) {
        if (line.trim().length !== 0) {
          return errorResult("patch contains content after *** End Patch");
        }
        continue;
      }

      if (line === "*** End Patch") {
        finishFile();
        ended = true;
        continue;
      }

      if (line.startsWith("*** Update File: ")) {
        finishFile();
        const path = line.slice("*** Update File: ".length).trim();
        if (path.length === 0) {
          return errorResult("patch update file path must be non-empty");
        }
        if (seenPaths.has(path)) {
          return errorResult(`patch updates ${path} more than once; combine hunks under one file section`);
        }
        seenPaths.add(path);
        currentFile = { operation: "update", path, hunks: [] };
        continue;
      }

      if (line.startsWith("*** Add File: ")) {
        finishFile();
        const path = line.slice("*** Add File: ".length).trim();
        if (path.length === 0) {
          return errorResult("patch add file path must be non-empty");
        }
        if (seenPaths.has(path)) {
          return errorResult(`patch touches ${path} more than once; combine operations under one file section`);
        }
        seenPaths.add(path);
        currentFile = { operation: "add", path, lines: [] };
        continue;
      }

      if (line.startsWith("*** Delete File: ")) {
        finishFile();
        const path = line.slice("*** Delete File: ".length).trim();
        if (path.length === 0) {
          return errorResult("patch delete file path must be non-empty");
        }
        if (seenPaths.has(path)) {
          return errorResult(`patch touches ${path} more than once; combine operations under one file section`);
        }
        seenPaths.add(path);
        currentFile = { operation: "delete", path };
        continue;
      }

      if (line.startsWith("@@")) {
        if (currentFile === undefined || currentFile.operation !== "update") {
          return errorResult("patch hunk appears before an update file section");
        }
        finishHunk();
        currentHunk = {
          contextHint: parsePatchContextHint(line),
          lines: []
        };
        continue;
      }

      if (currentFile?.operation === "add") {
        if (!line.startsWith("+")) {
          return errorResult(`patch add file line must start with '+': ${line}`);
        }
        currentFile.lines.push(line.slice(1));
        continue;
      }

      if (currentFile?.operation === "delete") {
        return errorResult(`patch delete file section must not contain body lines: ${line}`);
      }

      if (currentHunk === undefined) {
        return errorResult(`patch line appears outside a hunk: ${line}`);
      }

      if (line.startsWith(" ")) {
        currentHunk.lines.push({ kind: "context", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({ kind: "remove", text: line.slice(1) });
      } else if (line.startsWith("+")) {
        currentHunk.lines.push({ kind: "add", text: line.slice(1) });
      } else {
        return errorResult(`patch hunk line must start with space, '-', or '+': ${line}`);
      }
    }
    finishFile();
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : "failed to parse patch");
  }

  if (!ended) {
    return errorResult("patch must end with *** End Patch");
  }
  if (files.length === 0) {
    return errorResult("patch must touch at least one file");
  }
  return { ok: true, patch: { files } };
}

function parsePatchContextHint(line: string): string | undefined {
  const match = /^@@(?:\s*(.*?)\s*)?@@$/u.exec(line);
  if (match === null) {
    return undefined;
  }
  const hint = match[1]?.trim() ?? "";
  return hint.length === 0 ? undefined : hint;
}

function materializePatchHunk(
  hunk: ParsedWorkspacePatchHunk
): { ok: true; oldString: string; newString: string } | ToolResult {
  if (hunk.lines.length === 0) {
    return errorResult("hunk must contain at least one line");
  }

  const hasRemove = hunk.lines.some((line) => line.kind === "remove");
  const hasAdd = hunk.lines.some((line) => line.kind === "add");
  if (!hasRemove && !hasAdd) {
    return errorResult("hunk must add or remove at least one line");
  }

  const oldLines = hunk.lines
    .filter((line) => line.kind === "context" || line.kind === "remove")
    .map((line) => line.text);
  const newLines = hunk.lines
    .filter((line) => line.kind === "context" || line.kind === "add")
    .map((line) => line.text);
  const oldString = oldLines.join("\n");
  if (oldString.length === 0) {
    return errorResult("hunk old content must include context or removed lines");
  }

  return {
    ok: true,
    oldString,
    newString: newLines.join("\n")
  };
}

function findPatchReplacementRanges(
  content: string,
  oldString: string,
  options: { path: string; replaceAll: boolean; contextHint?: string }
): PatchMatchResult {
  const strategies: Array<{
    strategy: PatchMatchStrategy;
    find: () => PatchMatchRange[];
  }> = [
    { strategy: "exact", find: () => findExactRanges(content, oldString, "exact") },
    { strategy: "line_trimmed", find: () => findLineTrimmedRanges(content, oldString) },
    { strategy: "whitespace_normalized", find: () => findWhitespaceNormalizedRanges(content, oldString, "whitespace_normalized") },
    { strategy: "indentation_flexible", find: () => findIndentationFlexibleRanges(content, oldString) },
    { strategy: "escape_normalized", find: () => findEscapeNormalizedRanges(content, oldString) },
    { strategy: "trimmed_boundary", find: () => findTrimmedBoundaryRanges(content, oldString) },
    { strategy: "unicode_normalized", find: () => findUnicodeNormalizedRanges(content, oldString) },
    { strategy: "block_anchor", find: () => findBlockAnchorRanges(content, oldString) },
    { strategy: "context_aware", find: () => findContextAwareRanges(content, oldString) }
  ];

  const attemptedStrategies = strategies.map(({ strategy }) => strategy);

  for (const { strategy, find } of strategies) {
    const ranges = filterPatchRangesByContextHint(
      uniquePatchRanges(find()).sort((left, right) => left.start - right.start || left.end - right.end),
      content,
      options.contextHint
    );
    if (ranges.length === 0) {
      continue;
    }

    if (hasOverlappingPatchRanges(ranges)) {
      return {
        ok: false,
        content: `old_string produced overlapping ${strategy} matches in ${options.path}; provide a more specific segment.`,
        metadata: {
          path: options.path,
          matchStrategy: strategy,
          matchCount: ranges.length,
          attemptedStrategies
        }
      };
    }

    if (!options.replaceAll && ranges.length > 1) {
      return {
        ok: false,
        content: `old_string matched ${ranges.length} locations in ${options.path} using ${strategy}; provide a more specific segment or set replace_all=true.`,
        metadata: {
          path: options.path,
          matchStrategy: strategy,
          matchCount: ranges.length,
          attemptedStrategies
        }
      };
    }

    return {
      ok: true,
      ranges: options.replaceAll ? ranges : [ranges[0]!],
      strategy
    };
  }

  const nearMatches = buildNearMatchHints(content, oldString);
  return {
    ok: false,
    content: [
      `old_string not found in ${options.path}. Use file.read to verify current content, or file.search to locate the text.`,
      ...formatNearMatchHints(nearMatches)
    ].join("\n"),
    metadata: {
      path: options.path,
      matchCount: 0,
      attemptedStrategies,
      nearMatches
    }
  };
}

function formatNearMatchHints(nearMatches: Array<{ line: number; score: number; snippet: string }>): string[] {
  if (nearMatches.length === 0) {
    return [];
  }
  return [
    "Closest candidate(s):",
    ...nearMatches.map((match) => `- line ${match.line}, score ${match.score}: ${match.snippet.replace(/\s+/gu, " ").trim()}`)
  ];
}

function matchConfidence(strategy: PatchMatchStrategy): number {
  switch (strategy) {
    case "exact":
      return 1;
    case "line_trimmed":
    case "trimmed_boundary":
      return 0.95;
    case "escape_normalized":
    case "unicode_normalized":
      return 0.9;
    case "whitespace_normalized":
    case "indentation_flexible":
      return 0.85;
    case "block_anchor":
      return 0.8;
    case "context_aware":
      return 0.75;
  }
}

function buildMatchedSnippet(content: string, range: PatchMatchRange | undefined): string | undefined {
  if (range === undefined) {
    return undefined;
  }
  const windowChars = 120;
  const start = Math.max(0, range.start - windowChars);
  const end = Math.min(content.length, range.end + windowChars);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  return `${prefix}${content.slice(start, end)}${suffix}`;
}

function buildNearMatchHints(content: string, oldString: string): Array<{ line: number; score: number; snippet: string }> {
  const oldLines = splitBlockLines(oldString);
  const windowSize = Math.max(1, Math.min(8, oldLines.length));
  const needle = normalizeWhitespaceValue(oldString).trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }

  const lines = splitLinesWithRanges(content);
  const candidates: Array<{ line: number; score: number; snippet: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const window = lines.slice(index, index + windowSize);
    if (window.length === 0) {
      continue;
    }
    const snippet = window.map((line) => line.text).join("\n");
    const score = textSimilarity(needle, normalizeWhitespaceValue(snippet).trim().toLowerCase());
    if (score >= 0.35) {
      candidates.push({
        line: index + 1,
        score: Number(score.toFixed(3)),
        snippet: snippet.length > 240 ? `${snippet.slice(0, 240)}...` : snippet
      });
    }
  }

  return candidates
    .sort((left, right) => right.score - left.score || left.line - right.line)
    .slice(0, 3);
}

function textSimilarity(left: string, right: string): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  if (left === right) {
    return 1;
  }
  const leftTokens = new Set(left.split(/\s+/u).filter(Boolean));
  const rightTokens = new Set(right.split(/\s+/u).filter(Boolean));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const tokenScore = union === 0 ? 0 : intersection / union;
  const substringScore = left.includes(right) || right.includes(left)
    ? Math.min(left.length, right.length) / Math.max(left.length, right.length)
    : 0;
  return Math.max(tokenScore, substringScore);
}

function applyPatchReplacementRanges(content: string, ranges: PatchMatchRange[], newString: string): string {
  let next = content;
  for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
    next = next.slice(0, range.start) + newString + next.slice(range.end);
  }
  return next;
}

function findExactRanges(content: string, oldString: string, strategy: PatchMatchStrategy): PatchMatchRange[] {
  const ranges: PatchMatchRange[] = [];
  let index = content.indexOf(oldString);
  while (index !== -1) {
    ranges.push({ start: index, end: index + oldString.length, strategy });
    index = content.indexOf(oldString, index + oldString.length);
  }
  return ranges;
}

function findLineTrimmedRanges(content: string, oldString: string): PatchMatchRange[] {
  const oldLines = splitBlockLines(oldString);
  const oldTrimmed = oldString.trim();
  if (oldLines.length !== 1 || oldTrimmed.length === 0) {
    return [];
  }
  return splitLinesWithRanges(content)
    .filter((line) => line.text.trim() === oldTrimmed)
    .map((line) => ({ start: line.start, end: line.end, strategy: "line_trimmed" }));
}

function findWhitespaceNormalizedRanges(
  content: string,
  oldString: string,
  strategy: PatchMatchStrategy
): PatchMatchRange[] {
  const haystack = normalizeWhitespaceWithMap(content);
  const needle = normalizeWhitespaceWithMap(oldString).text;
  if (needle.trim().length === 0) {
    return [];
  }
  return findAllIndexes(haystack.text, needle).map((index) => ({
    start: haystack.startMap[index] ?? 0,
    end: haystack.endMap[index + needle.length - 1] ?? content.length,
    strategy
  }));
}

function findIndentationFlexibleRanges(content: string, oldString: string): PatchMatchRange[] {
  const oldLines = splitBlockLines(oldString);
  if (oldLines.length === 0) {
    return [];
  }
  const oldNormalized = normalizeIndentBlock(oldString);
  if (oldNormalized.trim().length === 0) {
    return [];
  }

  const lines = splitLinesWithRanges(content);
  const ranges: PatchMatchRange[] = [];
  for (let index = 0; index <= lines.length - oldLines.length; index += 1) {
    const candidateLines = lines.slice(index, index + oldLines.length);
    const candidate = candidateLines.map((line) => line.text).join("\n");
    if (normalizeIndentBlock(candidate) === oldNormalized) {
      ranges.push({
        start: candidateLines[0]!.start,
        end: candidateLines[candidateLines.length - 1]!.end,
        strategy: "indentation_flexible"
      });
    }
  }
  return ranges;
}

function findEscapeNormalizedRanges(content: string, oldString: string): PatchMatchRange[] {
  const decoded = decodeCommonEscapes(oldString);
  if (decoded === oldString || decoded.length === 0) {
    return [];
  }
  return findExactRanges(content, decoded, "escape_normalized");
}

function findTrimmedBoundaryRanges(content: string, oldString: string): PatchMatchRange[] {
  const trimmed = oldString.trim();
  if (trimmed.length === 0 || trimmed === oldString) {
    return [];
  }
  return findExactRanges(content, trimmed, "trimmed_boundary");
}

function findUnicodeNormalizedRanges(content: string, oldString: string): PatchMatchRange[] {
  const oldLines = splitBlockLines(oldString);
  if (oldLines.length === 0) {
    return [];
  }
  const oldNormalized = oldString.normalize("NFC");
  const lines = splitLinesWithRanges(content);
  const ranges: PatchMatchRange[] = [];
  for (let index = 0; index <= lines.length - oldLines.length; index += 1) {
    const candidateLines = lines.slice(index, index + oldLines.length);
    const candidate = candidateLines.map((line) => line.text).join("\n");
    if (candidate !== oldString && candidate.normalize("NFC") === oldNormalized) {
      ranges.push({
        start: candidateLines[0]!.start,
        end: candidateLines[candidateLines.length - 1]!.end,
        strategy: "unicode_normalized"
      });
    }
  }
  return ranges;
}

function findBlockAnchorRanges(content: string, oldString: string): PatchMatchRange[] {
  const oldLines = splitBlockLines(oldString);
  if (oldLines.length < 2) {
    return [];
  }
  const anchors = firstAndLastNonBlankTrimmedLines(oldLines);
  if (anchors === undefined) {
    return [];
  }

  const oldNormalized = normalizeWhitespaceValue(oldString).trim();
  const lines = splitLinesWithRanges(content);
  const ranges: PatchMatchRange[] = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start]!.text.trim() !== anchors.first) {
      continue;
    }
    for (let end = start; end < lines.length; end += 1) {
      if (lines[end]!.text.trim() !== anchors.last) {
        continue;
      }
      const candidateLines = lines.slice(start, end + 1);
      const candidate = candidateLines.map((line) => line.text).join("\n");
      if (normalizeWhitespaceValue(candidate).trim() === oldNormalized) {
        ranges.push({
          start: candidateLines[0]!.start,
          end: candidateLines[candidateLines.length - 1]!.end,
          strategy: "block_anchor"
        });
      }
    }
  }
  return ranges;
}

function findContextAwareRanges(content: string, oldString: string): PatchMatchRange[] {
  const oldLines = splitBlockLines(oldString);
  const oldNonBlank = oldLines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (oldNonBlank.length < 3) {
    return [];
  }
  const first = oldNonBlank[0]!;
  const last = oldNonBlank[oldNonBlank.length - 1]!;
  const oldCompact = normalizeWhitespaceValue(oldString).trim();
  const lines = splitLinesWithRanges(content);
  const ranges: PatchMatchRange[] = [];

  for (let start = 0; start <= lines.length - oldLines.length; start += 1) {
    const candidateLines = lines.slice(start, start + oldLines.length);
    const candidateNonBlank = candidateLines.map((line) => line.text.trim()).filter((line) => line.length > 0);
    if (candidateNonBlank[0] !== first || candidateNonBlank[candidateNonBlank.length - 1] !== last) {
      continue;
    }
    const candidate = candidateLines.map((line) => line.text).join("\n");
    if (normalizeWhitespaceValue(candidate).trim() === oldCompact) {
      ranges.push({
        start: candidateLines[0]!.start,
        end: candidateLines[candidateLines.length - 1]!.end,
        strategy: "context_aware"
      });
    }
  }
  return ranges;
}

function uniquePatchRanges(ranges: PatchMatchRange[]): PatchMatchRange[] {
  const seen = new Set<string>();
  const unique: PatchMatchRange[] = [];
  for (const range of ranges) {
    if (range.start < 0 || range.end <= range.start) {
      continue;
    }
    const key = `${range.start}:${range.end}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(range);
  }
  return unique;
}

function filterPatchRangesByContextHint(
  ranges: PatchMatchRange[],
  content: string,
  contextHint: string | undefined
): PatchMatchRange[] {
  const hint = contextHint?.trim();
  if (hint === undefined || hint.length === 0 || ranges.length <= 1) {
    return ranges;
  }

  const hintIndexes = contextHintIndexes(content, hint);
  if (hintIndexes.length === 0) {
    return ranges;
  }

  const windowChars = 4_000;
  const atOrAfterHint = ranges.filter((range) =>
    hintIndexes.some((index) =>
      (index >= range.start && index <= range.end) ||
      (range.start >= index && range.start - index <= windowChars)
    )
  );
  if (atOrAfterHint.length > 0) {
    return atOrAfterHint;
  }

  const beforeHint = ranges.filter((range) =>
    hintIndexes.some((index) => range.end <= index && index - range.end <= windowChars)
  );
  return beforeHint.length === 0 ? ranges : beforeHint;
}

function contextHintIndexes(content: string, hint: string): number[] {
  const exact = findAllIndexes(content, hint);
  if (exact.length > 0) {
    return exact;
  }

  return splitLinesWithRanges(content)
    .filter((line) => line.text.trim() === hint)
    .map((line) => line.start);
}

function hasOverlappingPatchRanges(ranges: PatchMatchRange[]): boolean {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.start < sorted[index - 1]!.end) {
      return true;
    }
  }
  return false;
}

function findAllIndexes(content: string, search: string): number[] {
  const indexes: number[] = [];
  let index = content.indexOf(search);
  while (index !== -1) {
    indexes.push(index);
    index = content.indexOf(search, index + search.length);
  }
  return indexes;
}

function normalizeWhitespaceWithMap(content: string): { text: string; startMap: number[]; endMap: number[] } {
  let text = "";
  const startMap: number[] = [];
  const endMap: number[] = [];
  let inWhitespace = false;

  for (let index = 0; index < content.length;) {
    const codePoint = content.codePointAt(index);
    const char = String.fromCodePoint(codePoint ?? content.charCodeAt(index));
    const nextIndex = index + char.length;
    if (/\s/u.test(char)) {
      if (!inWhitespace) {
        text += " ";
        startMap.push(index);
        endMap.push(nextIndex);
        inWhitespace = true;
      } else {
        endMap[endMap.length - 1] = nextIndex;
      }
    } else {
      text += char;
      startMap.push(index);
      endMap.push(nextIndex);
      inWhitespace = false;
    }
    index = nextIndex;
  }

  return { text, startMap, endMap };
}

function normalizeWhitespaceValue(content: string): string {
  return normalizeWhitespaceWithMap(content).text;
}

function splitLinesWithRanges(content: string): Array<{ text: string; start: number; end: number }> {
  if (content.length === 0) {
    return [{ text: "", start: 0, end: 0 }];
  }

  const lines: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  while (start < content.length) {
    let end = start;
    while (end < content.length && content[end] !== "\n" && content[end] !== "\r") {
      end += 1;
    }
    lines.push({ text: content.slice(start, end), start, end });
    if (end >= content.length) {
      break;
    }
    start = content[end] === "\r" && content[end + 1] === "\n" ? end + 2 : end + 1;
  }
  return lines;
}

function splitBlockLines(content: string): string[] {
  return content.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
}

function normalizeIndentBlock(content: string): string {
  const lines = splitBlockLines(content).map((line) => line.replace(/[ \t]+$/u, ""));
  while (lines.length > 0 && lines[0]!.trim().length === 0) {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) {
    lines.pop();
  }

  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^[ \t]*/u)?.[0].length ?? 0);
  const commonIndent = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(Math.min(commonIndent, line.length))).join("\n");
}

function decodeCommonEscapes(content: string): string {
  return content
    .replace(/\\r\\n/gu, "\n")
    .replace(/\\n/gu, "\n")
    .replace(/\\r/gu, "\r")
    .replace(/\\t/gu, "\t")
    .replace(/\\"/gu, "\"")
    .replace(/\\'/gu, "'")
    .replace(/\\\\/gu, "\\");
}

function firstAndLastNonBlankTrimmedLines(lines: string[]): { first: string; last: string } | undefined {
  const nonBlank = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (nonBlank.length === 0) {
    return undefined;
  }
  return {
    first: nonBlank[0]!,
    last: nonBlank[nonBlank.length - 1]!
  };
}

function renderWorkspaceFile(
  root: string,
  path: string,
  content: string,
  options: {
    maxReadBytes: number;
    lineStart?: number;
    lineEnd?: number;
    originalBytes?: number;
    alreadyRanged?: boolean;
  }
): ToolResult {
  const byteLength = options.originalBytes ?? Buffer.byteLength(content);
  const truncated = byteLength > options.maxReadBytes;
  const trimmed = truncated ? content.slice(0, options.maxReadBytes) : content;
  const ranged = options.alreadyRanged === true
    ? trimmed
    : applyLineRange(trimmed, options.lineStart, options.lineEnd);

  return {
    ok: true,
    content: [
      `# ${relative(root, path)}${truncated ? " (truncated)" : ""}`,
      ranged
    ].join("\n"),
    metadata: {
      path: relative(root, path),
      bytes: byteLength,
      ...(!truncated && options.lineStart === undefined && options.lineEnd === undefined && options.alreadyRanged !== true
        ? { contentSha256: createHash("sha256").update(content).digest("hex") } : {}),
      truncated
    }
  };
}

function assessFileWriteShrink(existing: string | undefined, next: string): {
  suspicious: boolean;
  oldLines: number;
  newLines: number;
  ratio: number;
} {
  if (existing === undefined) {
    return {
      suspicious: false,
      oldLines: 0,
      newLines: splitPreviewLines(next).length,
      ratio: 1
    };
  }

  const oldBytes = Buffer.byteLength(existing);
  const newBytes = Buffer.byteLength(next);
  const oldLines = splitPreviewLines(existing).length;
  const newLines = splitPreviewLines(next).length;
  const ratio = oldBytes === 0 ? 1 : newBytes / oldBytes;
  const lineRatio = oldLines === 0 ? 1 : newLines / oldLines;
  const suspicious = oldBytes >= FILE_WRITE_SHRINK_GUARD_MIN_OLD_BYTES &&
    (ratio <= FILE_WRITE_SHRINK_GUARD_MAX_RATIO || lineRatio <= FILE_WRITE_SHRINK_GUARD_MAX_RATIO);

  return {
    suspicious,
    oldLines,
    newLines,
    ratio: Number(ratio.toFixed(4))
  };
}

function buildFileWriteChangePreview(input: {
  path: string;
  before: string | undefined;
  after: string;
  bytes: number;
}): FileChangePreviewViewModel {
  const afterLines = splitPreviewLines(input.after);
  const previewLines = afterLines.slice(0, FILE_CHANGE_PREVIEW_LINES).map((line) => `+ ${line}`);
  const previousLineCount = input.before === undefined ? 0 : splitPreviewLines(input.before).length;
  const changeType = input.before === undefined ? "added" : "modified";
  const omittedLineCount = Math.max(0, afterLines.length - previewLines.length);
  const summary = input.before === undefined
    ? [`Added ${afterLines.length} line(s).`, `Wrote ${input.bytes} byte(s).`]
    : [`Replaced file content.`, `${previousLineCount} line(s) -> ${afterLines.length} line(s).`];

  return {
    kind: "fileChangePreview",
    path: input.path,
    changeType,
    summary,
    diff: previewLines.join("\n"),
    omittedLineCount,
  };
}

function buildPatchModeChangePreview(input: {
  files: PreparedWorkspacePatchFile[];
  oldBytes: number;
  newBytes: number;
}): FileChangePreviewViewModel {
  const fileCount = input.files.length;
  const hunkCount = input.files.reduce((total, file) => total + file.hunkCount, 0);
  return buildUnifiedFileChangePreview({
    files: input.files,
    oldBytes: input.oldBytes,
    newBytes: input.newBytes,
    summary: [
      `Applied ${hunkCount} hunk(s) across ${fileCount} file(s).`,
      `${input.oldBytes} byte(s) -> ${input.newBytes} byte(s).`
    ]
  });
}

function buildUnifiedFileChangePreview(input: {
  files: PreparedWorkspacePatchFile[];
  oldBytes: number;
  newBytes: number;
  summary?: readonly string[];
}): FileChangePreviewViewModel {
  const diffLines = input.files.flatMap((file) => buildUnifiedFileDiffLines(file));
  const previewLines = diffLines.slice(0, FILE_CHANGE_PREVIEW_LINES);
  const changeTypes = new Set(input.files.map((file) =>
    file.operation === "add" ? "added" : file.operation === "delete" ? "deleted" : "modified"
  ));
  const changeType = changeTypes.size === 1
    ? [...changeTypes][0] as FileChangePreviewViewModel["changeType"]
    : "modified";

  return {
    kind: "fileChangePreview",
    path: input.files.length === 1 ? input.files[0]!.path : "multiple files",
    changeType,
    summary: input.summary ?? [
      `${input.oldBytes} byte(s) -> ${input.newBytes} byte(s).`
    ],
    diff: previewLines.join("\n"),
    omittedLineCount: Math.max(0, diffLines.length - previewLines.length)
  };
}

function buildUnifiedFileDiffLines(file: PreparedWorkspacePatchFile): string[] {
  const beforeLines = splitPreviewLines(file.before);
  const afterLines = splitPreviewLines(file.after);
  const oldCount = file.operation === "add" ? 0 : beforeLines.length;
  const newCount = file.operation === "delete" ? 0 : afterLines.length;
  return [
    `--- ${file.operation === "add" ? "/dev/null" : `a/${file.path}`}`,
    `+++ ${file.operation === "delete" ? "/dev/null" : `b/${file.path}`}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...(file.operation === "add" ? [] : beforeLines.map((line) => `- ${line}`)),
    ...(file.operation === "delete" ? [] : afterLines.map((line) => `+ ${line}`))
  ];
}

function validatePatchSyntax(path: string, content: string): ToolResult | undefined {
  if (!/\.json$/iu.test(path)) {
    return undefined;
  }
  try {
    JSON.parse(content);
    return undefined;
  } catch (error) {
    return errorResult(`Syntax check failed for ${path}: invalid JSON (${error instanceof Error ? error.message : "parse failed"}).`, {
      path,
      reason: "syntax_check_failed",
      syntaxCheck: {
        checked: true,
        language: "json",
        ok: false
      }
    });
  }
}

function syntaxCheckMetadata(path: string, content: string): { checked: boolean; language?: string; ok?: boolean } {
  if (!/\.json$/iu.test(path)) {
    return { checked: false };
  }
  try {
    JSON.parse(content);
    return { checked: true, language: "json", ok: true };
  } catch {
    return { checked: true, language: "json", ok: false };
  }
}

function buildFileReplaceChangePreview(input: {
  path: string;
  oldString: string;
  newString: string;
  oldBytes: number;
  newBytes: number;
  matchCount: number;
  matchStrategy: PatchMatchStrategy;
}): FileChangePreviewViewModel {
  const removed = splitPreviewLines(input.oldString).map((line) => `- ${line}`);
  const added = splitPreviewLines(input.newString).map((line) => `+ ${line}`);
  const diffLines = ["@@ exact replacement @@", ...removed, ...added];
  const previewLines = diffLines.slice(0, FILE_CHANGE_PREVIEW_LINES);
  const omittedLineCount = Math.max(0, diffLines.length - previewLines.length);

  return {
    kind: "fileChangePreview",
    path: input.path,
    changeType: "modified",
    summary: [
      `Replaced ${input.matchCount} segment(s) using ${input.matchStrategy}.`,
      `${input.oldBytes} byte(s) -> ${input.newBytes} byte(s).`
    ],
    diff: previewLines.join("\n"),
    omittedLineCount,
  };
}

function splitPreviewLines(content: string): string[] {
  if (content.length === 0) {
    return [""];
  }
  return content.replace(/\r\n/g, "\n").split("\n");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

async function runManagedCommand(manager: ProcessManager, command: string, waitMs: number, signal: AbortSignal, continuationSignal?: AbortSignal, context?: ToolExecutionContext, verification?: string | null): Promise<ToolResult> {
  const started = await manager.start(command, signal, { input: false, continuationSignal, requirements: context?.requestContract?.requirements, visibleTurnId: context?.visibleTurnId, verification: verification ?? undefined });
  const process = (await manager.wait(started.id, waitMs, signal))!;
  const logs = manager.logs(process.id, { tailChars: 16_000 }) ?? [];
  const stdout = logs.filter(log => log.stream === "stdout").map(log => log.text).join("");
  const stderr = logs.filter(log => log.stream === "stderr").map(log => log.text).join("");
  const running = process.status === "running";
  const content = [
    running ? `Command is still running as ${process.id}. Use process.logs to wait for completion; process.stop cancels it. Do not restart the command.`
      : process.status === "exited" ? undefined : `Command failed: exit code ${process.exitCode ?? "none"}, status ${process.status}.`,
    ...logs.map(log => log.stream === "stderr" ? `stderr: ${log.text.trimEnd()}` : log.text.trimEnd())
  ].filter(Boolean).join("\n\n");
  return {
    ok: running || process.status === "exited",
    content: content.slice(0, 16_000) || "(no output)",
    metadata: {
      commandFileObservation: await manager.fileObservation(process.id),
      command, process, running, code: process.exitCode ?? null, signal: process.signal ?? null,
      timedOut: false, cancelled: false,
      _estacoda_context_summary: running
        ? `Command is still running as ${process.id}; its exit status has not been collected.`
        : terminalContextSummary({ command, code: process.exitCode ?? null, timedOut: false, timeoutMs: waitMs, cancelled: false, stdout, stderr })
    }
  };
}

async function runCommand(
  root: string,
  command: string,
  timeoutMs: number,
  childProcessEnv: WorkspaceToolOptions["childProcessEnv"],
  processes: HostProcesses,
  abortSignal?: AbortSignal
): Promise<ToolResult> {
  if (abortSignal?.aborted) return errorResult("Command cancelled before dispatch.");
  return new Promise((resolveResult) => {
    const shell = processes.shell?.() ?? resolveShell();
    const child = processes.spawn(shell.command, [...shell.args, command], {
      env: processes.environment({ homeDir: childProcessEnv?.homeDir, extra: { ...childProcessEnv?.extra, PWD: root } })
    });
    let stdout = "", stderr = "";
    let outputTruncated = false;
    const onAbort = () => { void processes.terminate(child).catch(() => resolveResult(errorResult("Command termination could not be confirmed."))); };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void processes.terminate(child).catch((error) => resolveResult(errorResult(String(error))));
    }, timeoutMs);

    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { outputTruncated ||= stdout.length + chunk.length > 16_000; stdout = (stdout + chunk).slice(0, 16_000); });
    child.stderr.on("data", (chunk: string) => { outputTruncated ||= stderr.length + chunk.length > 16_000; stderr = (stderr + chunk).slice(0, 16_000); });
    child.on("error", (error) => { abortSignal?.removeEventListener("abort", onAbort); clearTimeout(timeout); resolveResult(errorResult(`Failed to start command: ${error.message}`)); });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", onAbort);
      const content = [
        timedOut ? `Command timed out after ${timeoutMs} ms and was terminated. Inspect partial changes before retrying; use managed process tools for longer jobs.`
          : abortSignal?.aborted ? "Command cancelled and terminated. Inspect partial changes before retrying."
          : code !== 0 || signal !== null ? `Command failed: exit code ${code ?? "none"}${signal === null ? "" : `, signal ${signal}`}.` : undefined,
        stdout.trimEnd(),
        stderr.length === 0 ? undefined : `stderr:\n${stderr.trimEnd()}`
      ]
        .filter((line) => line !== undefined && line.length > 0)
        .join("\n\n");

      resolveResult({
        ok: code === 0 && signal === null && !timedOut && !abortSignal?.aborted,
        content: content.length === 0 ? "(no output)" : content.slice(0, 16_000),
        metadata: {
          command,
          code,
          signal,
          timeoutMs,
          timedOut,
          cancelled: abortSignal?.aborted ?? false,
          outputTruncated,
          _estacoda_context_summary: terminalContextSummary({
            command,
            code,
            timedOut,
            timeoutMs,
            cancelled: abortSignal?.aborted ?? false,
            stdout,
            stderr
          })
        }
      });
    });
  });
}

function terminalContextSummary(input: {
  command: string;
  code: number | null;
  timedOut: boolean;
  timeoutMs: number;
  cancelled: boolean;
  stdout: string;
  stderr: string;
}): string {
  return boundText([
    `Command ${terminalCommandLabel(input.command)} ${input.timedOut ? `timed out after ${input.timeoutMs} ms` : input.cancelled ? "was cancelled" : `exited with code ${input.code ?? "signal"}`}.`,
    `stdout: ${lineCount(input.stdout)} lines / ${input.stdout.length} chars.`,
    `stderr: ${lineCount(input.stderr)} lines / ${input.stderr.length} chars.`
  ].join(" "), MAX_TERMINAL_CONTEXT_SUMMARY_CHARS);
}

function terminalCommandLabel(command: string): string {
  return boundText(JSON.stringify(command), MAX_TERMINAL_CONTEXT_COMMAND_CHARS);
}

function boundText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function lineCount(value: string): number {
  const trimmed = value.replace(/(?:\r\n|\r|\n)$/u, "");
  return trimmed.length === 0 ? 0 : trimmed.split(/\r\n|\r|\n/u).length;
}

function resolveShell(): { command: string; args: string[] } {
  const shell = process.env.SHELL;
  if (typeof shell === "string" && shell.trim().length > 0) {
    return {
      command: shell,
      args: ["-lc"]
    };
  }

  if (platform() === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c"]
    };
  }

  return {
    command: "/bin/sh",
    args: ["-lc"]
  };
}

function applyLineRange(content: string, lineStart?: number, lineEnd?: number): string {
  if (lineStart === undefined) {
    return content;
  }

  const lines = content.split("\n");
  const start = Math.max(1, lineStart);
  const end = Math.min(lines.length, Math.max(start, lineEnd ?? start));

  return lines.slice(start - 1, end).join("\n");
}

function explainCommandBlock(command: string, environmentType?: EnvironmentType): string | undefined {
  return assessHardlineFloor(command, { environmentType })?.reason;
}

function createWorkspaceIO(files: WorkspaceFiles) {
  // An editor write may only change an unsaved buffer. Inspect the execution
  // view directly, including new files that have no prior editor observation.
  async function isOutputMaterialized(path: string, content: string, adapter?: WorkspaceFsAdapter): Promise<boolean> {
    if (adapter === undefined) return true;
    try { return await files.readFile(path, "utf8") === content; } catch { return false; }
  }
  const realpath = files.realpath.bind(files);
  const readFile = files.readFile.bind(files);
  const writeFile = files.writeFile.bind(files);
  const lstat = files.lstat.bind(files);
  const stat = files.stat.bind(files);
  const readdir = files.readdir.bind(files);
  const mkdir = files.mkdir.bind(files);
  const rm = files.rm.bind(files);
  const rename = files.rename.bind(files);
  const resolveWorkspacePath = (_root: string, path: string | undefined, options?: WorkspacePathOptions) => files.resolvePath(path, options);
  async function applyWorkspacePatchMode(input: {
    root: string;
    patch: string;
    fsAdapter: WorkspaceFsAdapter | undefined;
    recordOperation: (operation: {
      operation: FileStateOperationKind;
      sourceTool: string;
      path: string;
      bytes?: number;
      changed?: boolean;
      previewAvailable?: boolean;
    }) => void;
  }): Promise<ToolResult> {
    const parsed = parseWorkspacePatch(input.patch);
    if (!("patch" in parsed)) {
      return parsed;
    }

    const prepared = await prepareWorkspacePatchFiles(input.root, parsed.patch, input.fsAdapter);
    if (!("files" in prepared)) {
      return prepared;
    }

    if (input.fsAdapter === undefined) {
      for (const file of prepared.files) {
        if (file.operation === "delete") {
          continue;
        }
        const ensureResult = await ensureSafeParentDirectories(file.absolutePath, input.root);
        if (ensureResult !== undefined) {
          return ensureResult;
        }
      }
    }

    const transactionSupport = validatePatchTransactionSupport(prepared.files, input.fsAdapter);
    if (transactionSupport !== undefined) {
      return transactionSupport;
    }

    const applied = await applyPreparedWorkspacePatchFiles(prepared.files, input.fsAdapter);
    if (applied !== undefined) {
      return applied;
    }

    const fileCount = prepared.files.length;
    const hunkCount = prepared.files.reduce((total, file) => total + file.hunkCount, 0);
    const oldBytes = prepared.files.reduce((total, file) => total + Buffer.byteLength(file.before), 0);
    const newBytes = prepared.files.reduce((total, file) => total + Buffer.byteLength(file.after), 0);
    const preview = buildPatchModeChangePreview({
      files: prepared.files,
      oldBytes,
      newBytes
    });
    const result: ToolResult = {
      ok: true,
      content: `Applied patch to ${fileCount} file(s), ${hunkCount} hunk(s).`,
      metadata: {
        paths: prepared.files.map((file) => file.path),
        fileOutputs: await Promise.all(prepared.files.filter((file) => file.operation !== "delete").map(async (file) => ({
          path: file.path, contentSha256: createHash("sha256").update(file.after).digest("hex"),
          materialized: await isOutputMaterialized(file.absolutePath, file.after, input.fsAdapter)
        }))),
        fileCount,
        hunkCount,
        oldBytes,
        newBytes,
        operations: prepared.files.map((file) => file.operation),
        matchDiagnostics: prepared.files.flatMap((file) => file.matchDiagnostics.map((diagnostic) => ({
          path: file.path,
          ...diagnostic
        }))),
        syntaxChecks: prepared.files
          .filter((file) => file.operation !== "delete")
          .map((file) => syntaxCheckMetadata(file.path, file.after))
          .filter((check) => check.checked),
        fileChangePreview: preview
      }
    };

    for (const file of prepared.files) {
      input.recordOperation({
        operation: file.operation === "delete" ? "delete" : file.operation === "add" ? "write" : "replace",
        sourceTool: "file.patch",
        path: file.path,
        bytes: Buffer.byteLength(file.after),
        changed: file.before !== file.after,
        previewAvailable: result.metadata?.fileChangePreview !== undefined
      });
    }

    return result;
  }

  async function applyPreparedWorkspacePatchFiles(
    files: PreparedWorkspacePatchFile[],
    fsAdapter: WorkspaceFsAdapter | undefined
  ): Promise<ToolResult | undefined> {
    if (fsAdapter?.prepareMaterializedTransaction) {
      try { fsAdapter = await fsAdapter.prepareMaterializedTransaction(); }
      catch (error) { return errorResult(error instanceof Error ? error.message : "Editor content is not materialized."); }
    }
    const rollbackStack: PatchRollbackStep[] = [];
    const appliedPaths: string[] = [];

    for (const file of files) {
      try {
        if (file.operation === "delete") {
          await deletePreparedWorkspacePatchFile(file, fsAdapter);
          rollbackStack.push({
            path: file.path,
            operation: "restore_deleted_file",
            run: async () => writePreparedWorkspacePatchFile(file, file.before, fsAdapter)
          });
        } else {
          await writePreparedWorkspacePatchFile(file, file.after, fsAdapter);
          rollbackStack.push(file.operation === "add"
            ? {
                path: file.path,
                operation: "delete_added_file",
                run: async () => deletePreparedWorkspacePatchFile(file, fsAdapter)
              }
            : {
                path: file.path,
                operation: "restore_updated_file",
                run: async () => writePreparedWorkspacePatchFile(file, file.before, fsAdapter)
              });
        }
        appliedPaths.push(file.path);
      } catch (error) {
        const rollbackErrors: Array<{ path: string; operation: PatchRollbackStep["operation"]; error: string }> = [];
        for (const step of [...rollbackStack].reverse()) {
          try {
            await step.run();
          } catch (rollbackError) {
            rollbackErrors.push({
              path: step.path,
              operation: step.operation,
              error: formatPatchApplyError(rollbackError)
            });
          }
        }

        const rollbackOk = rollbackErrors.length === 0;
        return errorResult(
          [
            `Patch apply failed while ${file.operation === "delete" ? "deleting" : "writing"} ${file.path}: ${formatPatchApplyError(error)}.`,
            rollbackOk
              ? "Rolled back previously applied changes."
              : "Rollback failed for some previously applied changes; inspect the files before retrying."
          ].join(" "),
          {
            path: file.path,
            reason: "patch_apply_failed",
            operation: file.operation,
            appliedPaths,
            rollback: {
              attempted: rollbackStack.length,
              ok: rollbackOk,
              errors: rollbackErrors
            }
          }
        );
      }
    }

    return undefined;
  }

  async function writePreparedWorkspacePatchFile(
    file: PreparedWorkspacePatchFile,
    content: string,
    fsAdapter: WorkspaceFsAdapter | undefined
  ): Promise<void> {
    if (fsAdapter?.writeTextFile !== undefined) {
      await fsAdapter.writeTextFile({ path: file.absolutePath, content });
      return;
    }
    await writeTextFileAtomically(file.absolutePath, content);
  }

  async function deletePreparedWorkspacePatchFile(
    file: PreparedWorkspacePatchFile,
    fsAdapter: WorkspaceFsAdapter | undefined
  ): Promise<void> {
    if (fsAdapter?.deleteTextFile !== undefined) {
      await fsAdapter.deleteTextFile({ path: file.absolutePath });
      return;
    }
    await rm(file.absolutePath);
  }

  async function writeTextFileAtomically(path: string, content: string): Promise<void> {
    const tempPath = join(
      dirname(path),
      `.${basename(path)}.estacoda-patch-${process.pid}-${randomUUID()}.tmp`
    );
    try {
      await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
      await rename(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function applyWorkspacePatchOperationMode(input: {
    root: string;
    path: string | undefined;
    mode: "append" | "prepend" | "insert";
    content: string;
    anchor: string | undefined;
    position: "before" | "after";
    fsAdapter: WorkspaceFsAdapter | undefined;
    recordOperation: (operation: {
      operation: FileStateOperationKind;
      sourceTool: string;
      path: string;
      bytes?: number;
      changed?: boolean;
      previewAvailable?: boolean;
    }) => void;
  }): Promise<ToolResult> {
    const resolved = await resolveWorkspacePath(input.root, input.path, { allowMissingLeaf: input.mode !== "insert", forbidSymlinks: true });
    if (!resolved.ok) {
      return resolved;
    }

    const relativePath = relative(input.root, resolved.path);
    const before = await readExistingWorkspaceText(resolved.path, input.fsAdapter);
    if (before === undefined && input.mode === "insert") {
      return errorResult(`Cannot insert into missing file ${relativePath}.`, {
        path: relativePath,
        reason: "missing_file"
      });
    }

    const existing = before ?? "";
    let after: string;
    let matchStrategy: PatchMatchStrategy | undefined;
    let matchedSnippet: string | undefined;
    let matchConfidenceValue: number | undefined;
    if (input.mode === "append") {
      after = `${existing}${input.content}`;
    } else if (input.mode === "prepend") {
      after = `${input.content}${existing}`;
    } else {
      const anchor = input.anchor ?? "";
      const match = findPatchReplacementRanges(existing, anchor, {
        path: relativePath,
        replaceAll: false
      });
      if (!match.ok) {
        return errorResult(match.content, {
          ...(match.metadata ?? {}),
          path: relativePath,
          operation: "insert"
        });
      }
      const range = match.ranges[0]!;
      const replacement = input.position === "before"
        ? `${input.content}${existing.slice(range.start, range.end)}`
        : `${existing.slice(range.start, range.end)}${input.content}`;
      after = applyPatchReplacementRanges(existing, [range], replacement);
      matchStrategy = match.strategy;
      matchedSnippet = buildMatchedSnippet(existing, range);
      matchConfidenceValue = matchConfidence(match.strategy);
    }

    const syntax = validatePatchSyntax(relativePath, after);
    if (syntax !== undefined) {
      return syntax;
    }

    if (input.fsAdapter?.writeTextFile !== undefined) {
      await input.fsAdapter.writeTextFile({
        path: resolved.path,
        content: after
      });
    } else {
      const ensureResult = await ensureSafeParentDirectories(resolved.path, input.root);
      if (ensureResult !== undefined) {
        return ensureResult;
      }
      await writeFile(resolved.path, after, "utf8");
    }

    const oldBytes = Buffer.byteLength(existing);
    const newBytes = Buffer.byteLength(after);
    const preview = buildUnifiedFileChangePreview({
      files: [{
        operation: before === undefined ? "add" : "update",
        path: relativePath,
        absolutePath: resolved.path,
        before: existing,
        after,
        hunkCount: 1,
        matchDiagnostics: []
      }],
      oldBytes,
      newBytes
    });
    const metadata: Record<string, unknown> = {
      path: relativePath,
      contentSha256: createHash("sha256").update(after).digest("hex"),
      materialized: await isOutputMaterialized(resolved.path, after, input.fsAdapter),
      operation: input.mode,
      oldBytes,
      newBytes,
      fileChangePreview: preview,
      syntaxChecks: syntaxCheckMetadata(relativePath, after)
    };
    if (matchStrategy !== undefined) {
      metadata.matchStrategy = matchStrategy;
      metadata.matchConfidence = matchConfidenceValue;
      metadata.matchedSnippet = matchedSnippet;
    }

    const result: ToolResult = {
      ok: true,
      content: `${patchOperationPastTense(input.mode)} ${relativePath}.`,
      metadata
    };
    input.recordOperation({
      operation: before === undefined ? "write" : "replace",
      sourceTool: "file.patch",
      path: relativePath,
      bytes: newBytes,
      changed: after !== existing,
      previewAvailable: true
    });
    return result;
  }

  async function prepareWorkspacePatchFiles(
    root: string,
    patch: ParsedWorkspacePatch,
    fsAdapter: WorkspaceFsAdapter | undefined
  ): Promise<{ ok: true; files: PreparedWorkspacePatchFile[] } | ToolResult> {
    const prepared: PreparedWorkspacePatchFile[] = [];

    for (const file of patch.files) {
      const resolved = await resolveWorkspacePath(root, file.path, {
        allowMissingLeaf: file.operation === "add",
        forbidSymlinks: true
      });
      if (!resolved.ok) {
        return resolved;
      }

      const relativePath = relative(root, resolved.path);
      if (file.operation === "delete" && fsAdapter !== undefined && fsAdapter.deleteTextFile === undefined) {
        return errorResult("workspace file adapter does not support delete operations", {
          path: relativePath,
          operation: "delete"
        });
      }
      if (file.operation === "add") {
        const existing = await readExistingWorkspaceText(resolved.path, fsAdapter);
        if (existing !== undefined) {
          return errorResult(`patch add file target already exists: ${relativePath}`, {
            path: relativePath,
            operation: "add"
          });
        }
        const after = `${file.lines.join("\n")}\n`;
        const syntax = validatePatchSyntax(relativePath, after);
        if (syntax !== undefined) {
          return syntax;
        }
        prepared.push({
          operation: "add",
          path: relativePath,
          absolutePath: resolved.path,
          before: "",
          after,
          hunkCount: 1,
          matchDiagnostics: []
        });
        continue;
      }

      const before = fsAdapter !== undefined
        ? await fsAdapter.readTextFile({ path: resolved.path })
        : await readFile(resolved.path, "utf8");
      if (file.operation === "delete") {
        prepared.push({
          operation: "delete",
          path: relativePath,
          absolutePath: resolved.path,
          before,
          after: "",
          hunkCount: 1,
          matchDiagnostics: []
        });
        continue;
      }

      let after = before;
      const matchDiagnostics: PatchMatchDiagnostic[] = [];

      for (const [index, hunk] of file.hunks.entries()) {
        const materialized = materializePatchHunk(hunk);
        if (!("oldString" in materialized)) {
          return errorResult(`${relativePath} hunk ${index + 1}: ${materialized.content}`, {
            path: relativePath,
            hunkIndex: index + 1
          });
        }

        const match = findPatchReplacementRanges(after, materialized.oldString, {
          path: relativePath,
          replaceAll: false,
          contextHint: hunk.contextHint
        });
        if (!match.ok) {
          return errorResult(`${relativePath} hunk ${index + 1}: ${match.content}`, {
            ...(match.metadata ?? {}),
            path: relativePath,
            hunkIndex: index + 1
          });
        }

        const range = match.ranges[0]!;
        matchDiagnostics.push({
          strategy: match.strategy,
          confidence: matchConfidence(match.strategy),
          matchedSnippet: buildMatchedSnippet(after, range)
        });
        after = applyPatchReplacementRanges(after, match.ranges, materialized.newString);
      }

      const syntax = validatePatchSyntax(relativePath, after);
      if (syntax !== undefined) {
        return syntax;
      }

      prepared.push({
        operation: "update",
        path: relativePath,
        absolutePath: resolved.path,
        before,
        after,
        hunkCount: file.hunks.length,
        matchDiagnostics
      });
    }

    return { ok: true, files: prepared };
  }

  async function ensureSafeParentDirectories(
    targetPath: string,
    workspaceRoot: string
  ): Promise<ToolResult | undefined> {
    const parent = dirname(targetPath);

    // Walk up to find deepest existing directory and collect missing segments
    const missingSegments: string[] = [];
    let current = parent;

    while (true) {
      try {
        const statResult = await lstat(current);
        if (statResult.isSymbolicLink()) {
          return errorResult("path contains a symlink in parent directories");
        }
        if (!statResult.isDirectory()) {
          return errorResult("path parent contains a non-directory segment");
        }
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          return errorResult(error instanceof Error ? error.message : "failed to inspect path segment");
        }
        missingSegments.unshift(basename(current));
        const next = dirname(current);
        if (next === current) {
          return errorResult("unable to resolve parent directory");
        }
        current = next;
      }
    }

    // Verify deepest existing directory is inside workspace
    let resolvedCurrent: string;
    try {
      resolvedCurrent = await realpath(current);
    } catch {
      return errorResult("unable to resolve parent directory");
    }

    const resolvedRoot = await realpath(workspaceRoot).catch(() => workspaceRoot);
    const currentRel = relative(resolvedRoot, resolvedCurrent);
    if (currentRel.startsWith("..") || isAbsolute(currentRel)) {
      return errorResult("path is outside the trusted workspace");
    }

    // Create missing segments one by one
    for (const segment of missingSegments) {
      const nextPath = resolve(resolvedCurrent, segment);

      // Check again in case a symlink was created concurrently
      try {
        const nextStat = await lstat(nextPath);
        if (nextStat.isSymbolicLink()) {
          return errorResult("path contains a symlink in parent directories");
        }
        if (!nextStat.isDirectory()) {
          return errorResult("path parent contains a non-directory segment");
        }
        resolvedCurrent = await realpath(nextPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          return errorResult(error instanceof Error ? error.message : "failed to inspect path segment");
        }

        await mkdir(nextPath);

        // Verify containment after creation
        const resolvedNext = await realpath(nextPath);
        const nextRel = relative(resolvedRoot, resolvedNext);
        if (nextRel.startsWith("..") || isAbsolute(nextRel)) {
          return errorResult("path is outside the trusted workspace");
        }
        resolvedCurrent = resolvedNext;
      }
    }

    // Final parent verification
    const finalParent = await realpath(parent);
    const finalRel = relative(resolvedRoot, finalParent);
    if (finalRel.startsWith("..") || isAbsolute(finalRel)) {
      return errorResult("path is outside the trusted workspace");
    }

    return undefined;
  }

  async function readWorkspaceFile(
    root: string,
    path: string,
    options: { maxReadBytes: number; lineStart?: number; lineEnd?: number }
  ): Promise<ToolResult> {
    const bytes = await readFile(path);
    if (isLikelyBinary(bytes)) {
      return errorResult("file appears to be binary");
    }

    if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
      return errorResult("file is not valid UTF-8 text");
    }
    const content = bytes.subarray(0, options.maxReadBytes).toString("utf8");
    const result = renderWorkspaceFile(root, path, content, {
      ...options,
      originalBytes: bytes.length
    });
    // The host read materialized all bytes even when the model receives only a
    // bounded preview. Verification hashes the file, never a truncated preview.
    let totalLines = 1;
    for (const byte of bytes) if (byte === 10) totalLines++;
    const complete = options.lineStart === undefined ||
      (Number.isInteger(options.lineStart) && options.lineStart <= 1 &&
        Number.isInteger(options.lineEnd ?? 1) && (options.lineEnd ?? 1) >= totalLines);
    const observedContentSha256 = createHash("sha256").update(bytes).digest("hex");
    // A range read observes the on-disk version without becoming a full readback.
    result.metadata = { ...result.metadata, observedContentSha256,
      ...(complete ? { completeFileRead: true, contentSha256: observedContentSha256 } : {}) };
    return result;
  }

  async function searchDirectory(
    root: string,
    path: string,
    options: {
      query: string;
      matcher: RegExp | undefined;
      results: string[];
      maxSearchResults: number;
      visitedDirectories: Set<string>;
    }
  ): Promise<void> {
    if (options.results.length >= options.maxSearchResults) {
      return;
    }

    const resolved = await files.resolvePath(path, { allowDirectory: true });
    if (!resolved.ok) return;
    const canonicalPath = resolved.path;
    const targetStat = await stat(canonicalPath);
    if (targetStat.isFile()) {
      await searchFile(root, canonicalPath, options);
      return;
    }

    if (!targetStat.isDirectory()) {
      return;
    }

    if (options.visitedDirectories.has(canonicalPath)) {
      return;
    }
    options.visitedDirectories.add(canonicalPath);

    const entries = await readdir(canonicalPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (options.results.length >= options.maxSearchResults) {
        return;
      }

      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
        continue;
      }

      await searchDirectory(root, join(canonicalPath, entry.name), options);
    }
  }

  async function searchFile(
    root: string,
    path: string,
    options: {
      query: string;
      matcher: RegExp | undefined;
      results: string[];
      maxSearchResults: number;
    }
  ): Promise<void> {
    if (!isTextyPath(path)) {
      return;
    }

    const bytes = await readFile(path);
    if (isLikelyBinary(bytes)) {
      return;
    }

    const lines = bytes.toString("utf8").split("\n");

    for (const [index, line] of lines.entries()) {
      if (options.results.length >= options.maxSearchResults) {
        return;
      }

      const matched = options.matcher === undefined
        ? line.toLowerCase().includes(options.query.toLowerCase())
        : options.matcher.test(line);

      if (matched) {
        options.results.push(`${relative(root, path)}:${index + 1}: ${line}`);
      }
    }
  }

  async function readExistingWorkspaceText(
    path: string,
    fsAdapter: WorkspaceFsAdapter | undefined
  ): Promise<string | undefined> {
    if (fsAdapter !== undefined) {
      try {
        return await fsAdapter.readTextFile({ path });
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw error;
      }
    }

    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }
  return { isOutputMaterialized, applyWorkspacePatchMode, applyPreparedWorkspacePatchFiles, writePreparedWorkspacePatchFile, deletePreparedWorkspacePatchFile, writeTextFileAtomically, applyWorkspacePatchOperationMode, prepareWorkspacePatchFiles, ensureSafeParentDirectories, readWorkspaceFile, searchDirectory, searchFile, readExistingWorkspaceText, realpath, readFile, writeFile, resolveWorkspacePath };
}
