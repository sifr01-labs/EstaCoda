import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import { executeAuxiliaryTask } from "../providers/auxiliary-executor.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";

export type VisionToolOptions = {
  workspaceRoot: string;
  allowedRoots?: string[];
  visionAuxiliaryRoute?: ResolvedAuxiliaryRoute;
  mainRoute?: ResolvedModelRoute;
  providerExecutor?: ProviderExecutor;
  currentSessionId?: () => string;
  maxImageBytes?: number;
  /** @deprecated Use visionAuxiliaryRoute. */
  resolvedVisionRoute?: ResolvedModelRoute;
  /** @deprecated Use visionAuxiliaryRoute.fallbackToMain. */
  fallbackToMain?: boolean;
  /** @deprecated Route preferences are now owned by executeAuxiliaryTask callers. */
  routePreferences?: Parameters<typeof executeAuxiliaryTask>[0]["preferences"];
};

const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

type ResolvedPath =
  | { ok: true; path: string; root?: string }
  | { ok: false; content: string; metadata?: Record<string, unknown> };

export function createVisionTools(options: VisionToolOptions): readonly RegisteredTool[] {
  const workspaceRoot = resolve(options.workspaceRoot);
  const allowedRoots = dedupeRoots([workspaceRoot, ...(options.allowedRoots ?? [])]);

  return [
    {
      name: "vision.analyze",
      description: "Analyze an image with the best available vision-capable model route.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          prompt: { type: "string" }
        },
        required: ["path"]
      },
      riskClass: "read-only-local",
      toolsets: ["media", "research", "telegram", "core"],
      progressLabel: "analyzing image",
      maxResultSizeChars: 8_000,
      isAvailable: async () => resolveVisionAuxiliaryRoute(options).route !== undefined,
      run: (input: { path?: string; prompt?: string }, context) => analyzeImageWithVision(
        options,
        input,
        context?.signal,
        {
          executionSessionId: options.currentSessionId?.(),
          visibleTurnId: context?.visibleTurnId
        }
      )
    }
  ];
}

export const visionToolProvider: SessionToolProvider = {
  name: "vision",
  kind: "session",
  createTools(ctx) {
    return createVisionTools({
      workspaceRoot: ctx.workspaceRoot,
      allowedRoots: [requireProviderDependency("vision", "channelMediaRoot", ctx.channelMediaRoot)],
      visionAuxiliaryRoute: ctx.visionRoute,
      mainRoute: ctx.mainRoute,
      providerExecutor: requireProviderDependency("vision", "providerExecutor", ctx.providerExecutor),
      currentSessionId: () => ctx.currentSessionId()
    });
  }
};

function requireProviderDependency<T>(provider: string, dependency: string, value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError(`${provider}ToolProvider requires ${dependency}.`);
  }
  return value;
}

export async function analyzeImageWithVision(
  options: VisionToolOptions,
  input: { path?: string; prompt?: string },
  signal?: AbortSignal,
  usage: { executionSessionId?: string; visibleTurnId?: string } = {}
): Promise<ToolResult> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const allowedRoots = dedupeRoots([workspaceRoot, ...(options.allowedRoots ?? [])]);
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const resolved = await resolveAllowedPath(allowedRoots, input.path);
  if (!resolved.ok) {
    return resolved;
  }

  const fileStat = await stat(resolved.path);
  if (fileStat.size > maxImageBytes) {
    return {
      ok: false,
      content: `This image is too large for the current vision workflow. The limit is ${formatBytes(maxImageBytes)}.`,
      metadata: {
        bytes: fileStat.size,
        limitBytes: maxImageBytes
      }
    };
  }

  const mimeType = inferImageMimeType(resolved.path);
  if (mimeType === undefined) {
    return {
      ok: false,
      content: "This file does not look like a supported image for vision analysis.",
      metadata: {
        path: resolved.path
      }
    };
  }

  const visionAuxiliaryRoute = resolveVisionAuxiliaryRoute(options);
  if (visionAuxiliaryRoute.route === undefined) {
    return {
      ok: false,
      content: "No vision-capable provider route is configured and available in this runtime yet."
    };
  }

  const imageBytes = await readFile(resolved.path);
  const dataUrl = `data:${mimeType};base64,${imageBytes.toString("base64")}`;
  const displayRoot = resolved.root ?? workspaceRoot;
  const relativePath = makeRelativePath(displayRoot, resolved.path);

  if (options.providerExecutor === undefined) {
    return {
      ok: false,
      content: `Vision analysis is unavailable right now. Attempts: ${visionAuxiliaryRoute.route.provider}/${visionAuxiliaryRoute.route.id}:no-executor`,
      metadata: {
        path: relativePath,
        bytes: fileStat.size,
        mimeType,
        attempts: [`${visionAuxiliaryRoute.route.provider}/${visionAuxiliaryRoute.route.id}:no-executor`]
      }
    };
  }

  const auxiliaryResult = await executeAuxiliaryTask({
    route: visionAuxiliaryRoute,
    mainRoute: options.mainRoute ?? visionAuxiliaryRoute.route,
    providerExecutor: options.providerExecutor,
    usage: {
      ...(usage.executionSessionId === undefined ? {} : {
        executionSessionId: usage.executionSessionId,
      }),
      ...(usage.visibleTurnId === undefined ? {} : { visibleTurnId: usage.visibleTurnId })
    },
    preferences: options.routePreferences,
    request: {
      model: visionAuxiliaryRoute.route.id,
      messages: [
        {
          role: "system",
          content: "You are EstaCoda's vision analysis lane. Describe the image directly and concretely. Mention visible text if present. Stay concise but useful."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: input.prompt?.trim().length
                ? input.prompt.trim()
                : "Describe this image so EstaCoda can help the user."
            },
            {
              type: "image_url",
              image_url: {
                url: dataUrl
              }
            }
          ]
        }
      ] as any,
      maxTokens: 500
    },
    signal
  });

  const attempts = auxiliaryResult.attempts.map((attempt) =>
    `${attempt.provider}/${attempt.model}:${attempt.ok ? "ok" : attempt.errorClass ?? "error"}`
  );

  if (auxiliaryResult.ok && auxiliaryResult.response !== undefined) {
    const analysis = auxiliaryResult.response.content.trim();
    if (analysis.length === 0) {
      return {
        ok: false,
        content: `Vision analysis returned no usable content. Attempts: ${attempts.join(", ") || "none"}`,
        metadata: {
          path: relativePath,
          bytes: fileStat.size,
          mimeType,
          provider: auxiliaryResult.response.provider,
          model: auxiliaryResult.response.model,
          attempts
        }
      };
    }

    return {
      ok: true,
      content: [
        `Vision analysis: ${relativePath}`,
        analysis
      ].filter((line) => line.length > 0).join("\n\n"),
      metadata: {
        path: relativePath,
        bytes: fileStat.size,
        mimeType,
        provider: auxiliaryResult.response.provider,
        model: auxiliaryResult.response.model,
        attempts
      }
    };
  }

  return {
    ok: false,
    content: `Vision analysis is unavailable right now. Attempts: ${attempts.join(", ") || "none"}`,
    metadata: {
      path: relativePath,
      bytes: fileStat.size,
      mimeType,
      attempts
    }
  };
}

function resolveVisionAuxiliaryRoute(options: VisionToolOptions): ResolvedAuxiliaryRoute {
  if (options.visionAuxiliaryRoute !== undefined) {
    return options.visionAuxiliaryRoute;
  }
  return synthesizeLegacyRoute(options);
}

function synthesizeLegacyRoute(options: VisionToolOptions): ResolvedAuxiliaryRoute {
  return {
    task: "vision",
    route: options.resolvedVisionRoute,
    source: options.resolvedVisionRoute === undefined ? "disabled" : "explicit",
    fallbackToMain: options.fallbackToMain === true &&
      options.mainRoute !== undefined &&
      options.mainRoute.profile.supportsVision,
    diagnostics: options.resolvedVisionRoute === undefined ? ["No legacy vision route configured"] : []
  };
}

async function resolveAllowedPath(roots: string[], path: string | undefined): Promise<ResolvedPath> {
  if (typeof path !== "string" || path.length === 0) {
    return errorResult("path must be a non-empty string");
  }

  for (const root of roots) {
    const candidate = resolve(root, path);
    const canonicalRoot = await realpath(root).catch(() => root);
    const canonical = await realpath(candidate).catch(() => undefined);

    if (canonical === undefined) {
      continue;
    }

    if (canonical === canonicalRoot || canonical.startsWith(`${canonicalRoot}/`)) {
      return {
        ok: true,
        path: canonical,
        root: canonicalRoot
      };
    }
  }

  return errorResult("path is outside the trusted workspace");
}

function inferImageMimeType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return undefined;
  }
}

function dedupeRoots(roots: string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))];
}

function makeRelativePath(root: string, path: string): string {
  const relativePath = path.startsWith(root) ? path.slice(root.length).replace(/^\/+/u, "") : path;
  return relativePath.length > 0 ? relativePath : path;
}

function errorResult(content: string): ResolvedPath {
  return {
    ok: false,
    content
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${bytes} B`;
}
