import type { HostExecutionLease } from "../execution/host-environment.js";
import { HostWorkspaceFiles } from "../execution/host-workspace-files.js";
import { resolve } from "node:path";
import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import { runPythonWorker } from "../workers/python-worker.js";

export type PythonToolOptions = {
  executionLease?: HostExecutionLease;
  workspaceRoot?: string;
  allowedRoots?: string[];
};

export function createPythonTools(options: PythonToolOptions = {}): readonly RegisteredTool[] {
  const root = options.executionLease?.workspaceRoot ?? options.workspaceRoot;
  const allowedRoots = dedupeRoots([root, ...(options.allowedRoots ?? [])]);

  return [
  {
    name: "python.probe",
    description: "Probe the Python execution lane and return worker metadata.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string" }
      }
    },
    riskClass: "read-only-local",
    toolsets: ["core", "research"],
    progressLabel: "probing python worker",
    maxResultSizeChars: 2000,
    isAvailable: () => true,
    run: async (input: Record<string, unknown>, context) =>
      runPythonWorker({
        tool: "python.probe",
        input
      }, {
        cwd: root,
        executionLease: options.executionLease,
        signal: context?.signal
      })
  },
  {
    name: "document.probe",
    description: "Inspect a local document path and return basic metadata plus a text preview when safe.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxPreviewChars: { type: "number" }
      },
      required: ["path"]
    },
    riskClass: "read-only-local",
    toolsets: ["files", "media", "research"],
    progressLabel: "probing document",
    maxResultSizeChars: 4000,
    isAvailable: () => true,
    run: async (input: Record<string, unknown>, context) => {
      const resolvedPath = await resolveAllowedDocumentPath(allowedRoots, input.path, options.executionLease);
      if (!resolvedPath.ok) {
        return resolvedPath;
      }

      return runPythonWorker({
        tool: "document.probe",
        input: {
          ...input,
          path: resolvedPath.path,
          maxPreviewChars: typeof input.maxPreviewChars === "number" && Number.isFinite(input.maxPreviewChars)
            ? Math.max(0, Math.min(2000, Math.floor(input.maxPreviewChars))) : 500
        }
      }, {
        cwd: root,
        executionLease: options.executionLease,
        signal: context?.signal
      });
    }
  }
  ];
}

export const pythonTools: readonly RegisteredTool[] = createPythonTools();

export const pythonToolProvider: SessionToolProvider = {
  name: "python",
  kind: "session",
  createTools(ctx) {
    return createPythonTools({
      workspaceRoot: ctx.workspaceRoot,
      executionLease: ctx.executionLease,
      allowedRoots: [requireProviderDependency("python", "channelMediaRoot", ctx.channelMediaRoot)]
    });
  }
};

function requireProviderDependency<T>(provider: string, dependency: string, value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError(`${provider}ToolProvider requires ${dependency}.`);
  }
  return value;
}

function dedupeRoots(roots: Array<string | undefined>): string[] {
  return [...new Set(
    roots
      .filter((root): root is string => typeof root === "string" && root.length > 0)
      .map((root) => resolve(root))
  )];
}

async function resolveAllowedDocumentPath(
  roots: string[],
  pathValue: unknown,
  lease?: HostExecutionLease
): Promise<ToolResult & { path?: string }> {
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    return {
      ok: false,
      content: "path must be a non-empty string"
    };
  }

  if (roots.length === 0) {
    return {
      ok: false,
      content: "No allowed roots are configured for document inspection."
    };
  }

  let lastError = "path is outside the trusted workspace";

  for (const root of roots) {
    const candidate = resolve(root, pathValue);
    // Additional roots are explicit profile capability inputs (channel media),
    // never a fallback to the caller's workspace when a lease is selected.
    const files = root === lease?.workspaceRoot ? lease.files : new HostWorkspaceFiles(root);
    try {
      const resolved = await files.resolvePath(candidate);
      if (resolved.ok) return { ok: true, content: "", path: resolved.path };
      lastError = resolved.content;
    } catch { lastError = "Document root is unavailable."; }
  }

  return {
    ok: false,
    content: lastError
  };
}
