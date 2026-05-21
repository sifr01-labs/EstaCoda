import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { explainPathBlock } from "../context/context-security.js";
import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import { runPythonWorker } from "../workers/python-worker.js";

export type PythonToolOptions = {
  workspaceRoot?: string;
  allowedRoots?: string[];
};

export function createPythonTools(options: PythonToolOptions = {}): readonly RegisteredTool[] {
  const allowedRoots = dedupeRoots([options.workspaceRoot, ...(options.allowedRoots ?? [])]);

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
    run: async (input: Record<string, unknown>) =>
      runPythonWorker({
        tool: "python.probe",
        input
      }, {
        cwd: options.workspaceRoot
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
    run: async (input: Record<string, unknown>) => {
      const resolvedPath = await resolveAllowedDocumentPath(allowedRoots, input.path);
      if (!resolvedPath.ok) {
        return resolvedPath;
      }

      return runPythonWorker({
        tool: "document.probe",
        input: {
          ...input,
          path: resolvedPath.path
        }
      }, {
        cwd: options.workspaceRoot
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
  pathValue: unknown
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
    let canonicalRoot = root;
    let canonicalTarget = candidate;

    try {
      canonicalRoot = await realpath(root);
    } catch {
      canonicalRoot = root;
    }

    try {
      canonicalTarget = await realpath(candidate);
    } catch (error) {
      lastError = error instanceof Error ? error.message : "path does not exist";
      continue;
    }

    const blockedReason = explainPathBlock(canonicalRoot, canonicalTarget);
    if (blockedReason === undefined) {
      return {
        ok: true,
        content: "",
        path: canonicalTarget
      };
    }

    lastError = blockedReason;
  }

  return {
    ok: false,
    content: lastError
  };
}
