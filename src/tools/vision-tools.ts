import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type {
  NormalizedVisionImage,
  ResolvedVisionImageSource,
  VisionImageNormalizationError,
  VisionImageSourceError
} from "../contracts/vision.js";
import { executeAuxiliaryTask } from "../providers/auxiliary-executor.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";
import {
  defaultVisionImageNormalizer,
  type VisionImageNormalizer
} from "../vision/image-normalizer.js";
import { resolveVisionImageSource } from "../vision/image-source-resolver.js";

export type VisionToolOptions = {
  workspaceRoot: string;
  profileId?: string;
  allowedRoots?: string[];
  visionAuxiliaryRoute?: ResolvedAuxiliaryRoute;
  mainRoute?: ResolvedModelRoute;
  providerExecutor?: ProviderExecutor;
  currentSessionId?: () => string;
  maxImageBytes?: number;
  imageNormalizer?: VisionImageNormalizer;
  /** @deprecated Use visionAuxiliaryRoute. */
  resolvedVisionRoute?: ResolvedModelRoute;
  /** @deprecated Use visionAuxiliaryRoute.fallbackToMain. */
  fallbackToMain?: boolean;
  /** @deprecated Route preferences are now owned by executeAuxiliaryTask callers. */
  routePreferences?: Parameters<typeof executeAuxiliaryTask>[0]["preferences"];
};

const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function createVisionTools(options: VisionToolOptions): readonly RegisteredTool[] {
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
      profileId: ctx.profileId,
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
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const source = await resolveVisionImageSource({
    workspaceRoot: options.workspaceRoot,
    allowedRoots: options.allowedRoots,
    path: input.path,
    maxBytes: maxImageBytes
  });
  if (!source.ok) {
    return imageSourceErrorResult(source);
  }

  const visionAuxiliaryRoute = resolveVisionAuxiliaryRoute(options);
  if (visionAuxiliaryRoute.route === undefined) {
    return {
      ok: false,
      content: "No vision-capable provider route is configured and available in this runtime yet."
    };
  }

  const relativePath = source.displayPath;

  if (options.providerExecutor === undefined) {
    return {
      ok: false,
      content: `Vision analysis is unavailable right now. Attempts: ${visionAuxiliaryRoute.route.provider}/${visionAuxiliaryRoute.route.id}:no-executor`,
      metadata: {
        path: relativePath,
        bytes: source.byteLength,
        mimeType: source.mimeType,
        attempts: [`${visionAuxiliaryRoute.route.provider}/${visionAuxiliaryRoute.route.id}:no-executor`]
      }
    };
  }

  const normalized = await (options.imageNormalizer ?? defaultVisionImageNormalizer).normalize(source, {
    signal,
    limits: { maxInputBytes: maxImageBytes }
  });
  if (!normalized.ok) {
    return imageNormalizationErrorResult(relativePath, normalized);
  }

  const dataUrl = `data:${normalized.mimeType};base64,${Buffer.from(normalized.bytes).toString("base64")}`;
  const imageMetadata = normalizedImageMetadata(source, normalized);

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
    preferences: {
      ...options.routePreferences,
      requireVision: true
    },
    scopeKey: visionConcurrencyScopeKey(options.profileId, visionAuxiliaryRoute.route),
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
          ...imageMetadata,
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
        ...imageMetadata,
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
      ...imageMetadata,
      attempts
    }
  };
}

function resolveVisionAuxiliaryRoute(options: VisionToolOptions): ResolvedAuxiliaryRoute {
  const resolved = options.visionAuxiliaryRoute ?? synthesizeLegacyRoute(options);
  if (resolved.task !== "vision") {
    return {
      ...resolved,
      route: undefined,
      fallbackToMain: false,
      diagnostics: [...resolved.diagnostics, `Expected a vision auxiliary route, received ${resolved.task}`]
    };
  }

  if (resolved.route !== undefined && !resolved.route.profile.supportsVision) {
    return {
      ...resolved,
      route: undefined,
      fallbackToMain: false,
      diagnostics: [
        ...resolved.diagnostics,
        `Route ${resolved.route.provider}/${resolved.route.id} does not support vision`
      ]
    };
  }

  if (
    resolved.fallbackToMain === true &&
    options.mainRoute?.profile.supportsVision !== true
  ) {
    return {
      ...resolved,
      fallbackToMain: false,
      diagnostics: [...resolved.diagnostics, "Main model route does not support vision fallback"]
    };
  }

  return resolved;
}

function visionConcurrencyScopeKey(profileId: string | undefined, route: ResolvedModelRoute): string {
  return JSON.stringify([
    "profile",
    profileId ?? "unscoped",
    "route",
    route.provider,
    route.id,
    route.baseUrl ?? "",
    route.apiKeyEnv ?? ""
  ]);
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

function imageSourceErrorResult(error: VisionImageSourceError): ToolResult {
  return {
    ok: false,
    content: error.message,
    metadata: {
      errorCode: error.code,
      ...error.details
    }
  };
}

function imageNormalizationErrorResult(
  path: string,
  error: VisionImageNormalizationError
): ToolResult {
  return {
    ok: false,
    content: error.message,
    metadata: {
      path,
      errorCode: error.code,
      ...error.details
    }
  };
}

function normalizedImageMetadata(
  source: ResolvedVisionImageSource,
  normalized: NormalizedVisionImage
): Record<string, unknown> {
  return {
    path: source.displayPath,
    bytes: normalized.byteLength,
    mimeType: normalized.mimeType,
    width: normalized.width,
    height: normalized.height,
    sourceBytes: source.byteLength,
    sourceMimeType: source.mimeType,
    sourceWidth: normalized.sourceWidth,
    sourceHeight: normalized.sourceHeight,
    sourceFrames: normalized.sourceFrames,
    resized: normalized.resized,
    orientationApplied: normalized.orientationApplied,
    metadataStripped: normalized.metadataStripped
  };
}
