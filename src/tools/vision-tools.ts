import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import type { ProviderRoutePreferences } from "../contracts/provider.js";
import type { CredentialPoolRegistry } from "../providers/credential-pool.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import { routeProvider } from "../providers/provider-router.js";

export type VisionToolOptions = {
  workspaceRoot: string;
  allowedRoots?: string[];
  providerRegistry: ProviderRegistry;
  credentialPools?: CredentialPoolRegistry;
  routePreferences?: ProviderRoutePreferences;
  maxImageBytes?: number;
};

const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

type ResolvedPath =
  | { ok: true; path: string; root?: string }
  | { ok: false; content: string; metadata?: Record<string, unknown> };

export function createVisionTools(options: VisionToolOptions): readonly RegisteredTool[] {
  const workspaceRoot = resolve(options.workspaceRoot);
  const allowedRoots = dedupeRoots([workspaceRoot, ...(options.allowedRoots ?? [])]);
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;

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
      isAvailable: async () => (await resolveUsableVisionRoute(options.providerRegistry, options.routePreferences)) !== undefined,
      run: async (input: { path?: string; prompt?: string }, context) => {
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

        const route = await resolveUsableVisionRoute(options.providerRegistry, options.routePreferences);
        if (route === undefined) {
          return {
            ok: false,
            content: "No vision-capable provider route is configured and available in this runtime yet."
          };
        }

        const imageBytes = await readFile(resolved.path);
        const dataUrl = `data:${mimeType};base64,${imageBytes.toString("base64")}`;
        const displayRoot = resolved.root ?? workspaceRoot;
        const relativePath = makeRelativePath(displayRoot, resolved.path);
        const attempts: string[] = [];
        const models = [route.primary, ...route.fallbacks];

        for (const model of models) {
          const provider = options.providerRegistry.get(model.provider);
          if (provider?.endpoint === undefined) {
            continue;
          }

          const credential = options.credentialPools?.resolve(model.provider);
          const response = await provider.complete({
            model: model.id,
            maxTokens: 500,
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
            ] as any
          } as any, {
            credential: credential === undefined
              ? undefined
              : {
                  id: credential.id,
                  value: credential.value
                },
            signal: context?.signal
          });

          attempts.push(`${model.provider}/${model.id}:${response.ok ? "ok" : response.errorClass ?? "error"}`);

          if (response.ok) {
            if (credential !== undefined) {
              options.credentialPools?.reportSuccess(model.provider, credential.id);
            }

            return {
              ok: true,
              content: [
                `Vision analysis: ${relativePath}`,
                response.content.trim()
              ].filter((line) => line.length > 0).join("\n\n"),
              metadata: {
                path: relativePath,
                bytes: fileStat.size,
                mimeType,
                provider: model.provider,
                model: model.id,
                attempts
              }
            };
          }

          if (credential !== undefined) {
            options.credentialPools?.reportFailure(model.provider, credential.id, response.errorClass ?? "unknown");
          }
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
    }
  ];
}

async function resolveUsableVisionRoute(
  registry: ProviderRegistry,
  preferences: ProviderRoutePreferences | undefined
) {
  const models = await registry.listModels();
  const usable = [];

  for (const model of models) {
    if (!model.supportsVision) {
      continue;
    }

    const provider = registry.get(model.provider);
    if (provider?.endpoint === undefined) {
      continue;
    }

    const health = await provider.health();
    if (!health.available) {
      continue;
    }

    usable.push(model);
  }

  return routeProvider(usable, {
    requireVision: true,
    preferFreeOrOpenWeights: true,
    ...(preferences ?? {})
  });
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
