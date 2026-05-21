import { mkdir, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import { setupNeeded } from "../setup/capability-setup.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { defaultImageApiKeyEnv, defaultImageBaseUrl, defaultImageModel } from "../contracts/image-generation.js";
import type { RegisteredTool, SessionToolProvider } from "../contracts/tool.js";

export type ImageGenerationFetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers?: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

export type ImageGenerationToolOptions = {
  imageCacheRoot: string;
  artifactStore: ArtifactStore;
  imageGen?: LoadedRuntimeConfig["imageGen"];
  fetch?: ImageGenerationFetchLike;
  id?: () => string;
};

type ImageAspect = "square" | "landscape" | "portrait";

export function createImageGenerationTools(options: ImageGenerationToolOptions): readonly RegisteredTool[] {
  const imageGen = options.imageGen ?? defaultImageGen();

  return [{
    name: "image.generate",
    description: "Generate an image from a text prompt using the configured image generation provider.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        aspectRatio: { type: "string", enum: ["square", "landscape", "portrait"] },
        model: { type: "string" },
        seed: { type: "number" }
      },
      required: ["prompt"]
    },
    riskClass: "external-side-effect",
    toolsets: ["media", "telegram"],
    progressLabel: "generating image",
    maxResultSizeChars: 4000,
    isAvailable: () => true,
    run: async (input: { prompt?: string; aspectRatio?: string; model?: string; seed?: number }, context) => {
      const prompt = input.prompt?.trim();
      if (prompt === undefined || prompt.length === 0) {
        return { ok: false, content: "image.generate requires a prompt." };
      }
      const aspectRatio = normalizeAspectRatio(input.aspectRatio);
      if (aspectRatio === undefined) {
        return { ok: false, content: "image.generate aspectRatio must be square, landscape, or portrait." };
      }

      const result = await generateImage({
        prompt,
        aspectRatio,
        model: input.model,
        seed: input.seed,
        imageGen,
        fetch: options.fetch,
        signal: context?.signal
      });
      if (!result.ok) {
        return result;
      }

      await mkdir(options.imageCacheRoot, { recursive: true });
      const fileName = `${safeId(options.id?.() ?? randomUUID())}.${extensionForMime(result.mimeType)}`;
      const filePath = join(options.imageCacheRoot, fileName);
      await writeFile(filePath, result.bytes);
      const fileStat = await stat(filePath);
      const artifact = options.artifactStore.record({
        path: filePath,
        kind: "image",
        bytes: fileStat.size,
        mimeType: result.mimeType,
        summary: truncateSummary(`Image generated from prompt: ${prompt}`),
        metadata: {
          provider: imageGen.provider,
          model: result.model,
          aspectRatio: result.aspectRatio,
          seed: result.seed,
          sourceUrl: result.sourceUrl
        }
      });

      return {
        ok: true,
        content: [
          `Generated image: ${artifact.path}`,
          `Provider: ${imageGen.provider}`,
          `Model: ${result.model}`,
          `Aspect ratio: ${result.aspectRatio}`,
          result.seed === undefined ? undefined : `Seed: ${result.seed}`,
          result.sourceUrl === undefined ? undefined : `Source URL: ${result.sourceUrl}`,
          `Artifact: ${artifact.id}`
        ].filter((line) => line !== undefined).join("\n"),
        metadata: artifact
      };
    }
  }];
}

export const imageGenerationToolProvider: SessionToolProvider = {
  name: "imageGeneration",
  kind: "session",
  createTools(ctx) {
    return createImageGenerationTools({
      imageCacheRoot: requireProviderDependency("imageGeneration", "imageCacheRoot", ctx.imageCacheRoot),
      artifactStore: requireProviderDependency("imageGeneration", "artifactStore", ctx.artifactStore),
      imageGen: ctx.imageGen,
      fetch: ctx.imageGenerationFetch
    });
  }
};

function requireProviderDependency<T>(provider: string, dependency: string, value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError(`${provider}ToolProvider requires ${dependency}.`);
  }
  return value;
}

async function generateImage(input: {
  prompt: string;
  aspectRatio: ImageAspect;
  model?: string;
  seed?: number;
  imageGen: LoadedRuntimeConfig["imageGen"];
  fetch?: ImageGenerationFetchLike;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; bytes: Buffer; mimeType: string; model: string; aspectRatio: ImageAspect; seed?: number; sourceUrl?: string }
  | { ok: false; content: string; metadata?: Record<string, unknown> }
> {
  const provider = input.imageGen.provider;
  const fetcher = input.fetch ?? globalImageFetch;
  const generated = provider === "byteplus"
    ? await submitBytePlusRequest(input, fetcher)
    : await submitFalRequest(input, fetcher);
  if (!generated.ok) {
    return generated;
  }

  const imageBytes = await fetcher(generated.url, { signal: input.signal });
  if (!imageBytes.ok) {
    return {
      ok: false,
      content: `Generated image URL could not be downloaded: ${imageBytes.status} ${imageBytes.statusText}`,
      metadata: {
        provider,
        model: generated.model,
        url: generated.url
      }
    };
  }

  return {
    ok: true,
    bytes: Buffer.from(await imageBytes.arrayBuffer()),
    mimeType: mimeFromImageDownload(generated.url, imageBytes.headers?.get("content-type") ?? undefined),
    model: generated.model,
    aspectRatio: input.aspectRatio,
    seed: input.seed,
    sourceUrl: generated.url
  };
}

async function submitFalRequest(
  input: {
    prompt: string;
    aspectRatio: ImageAspect;
    model?: string;
    seed?: number;
    imageGen: LoadedRuntimeConfig["imageGen"];
    signal?: AbortSignal;
  },
  fetcher: ImageGenerationFetchLike
): Promise<{ ok: true; url: string; model: string } | { ok: false; content: string; metadata?: Record<string, unknown> }> {
  const model = input.model ?? input.imageGen.fal?.model ?? input.imageGen.model;
  const apiKeyEnv = input.imageGen.fal?.apiKeyEnv ?? input.imageGen.apiKeyEnv ?? "FAL_KEY";
  const apiKey = process.env[apiKeyEnv];
  if (apiKey === undefined || apiKey.length === 0) {
    return imageSetupNeeded({
      provider: "fal",
      model,
      requiredSecret: apiKeyEnv
    });
  }

  const baseUrl = (input.imageGen.fal?.baseUrl ?? input.imageGen.baseUrl ?? "https://fal.run").replace(/\/$/, "");
  const response = await fetcher(`${baseUrl}/${model}`, {
    method: "POST",
    headers: {
      authorization: `Key ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      prompt: input.prompt,
      image_size: falImageSize(input.aspectRatio),
      seed: input.seed
    }),
    signal: input.signal
  });
  return parseImageResponse(response, "fal", model);
}

async function submitBytePlusRequest(
  input: {
    prompt: string;
    aspectRatio: ImageAspect;
    model?: string;
    seed?: number;
    imageGen: LoadedRuntimeConfig["imageGen"];
    signal?: AbortSignal;
  },
  fetcher: ImageGenerationFetchLike
): Promise<{ ok: true; url: string; model: string } | { ok: false; content: string; metadata?: Record<string, unknown> }> {
  const model = input.model ?? input.imageGen.byteplus?.model ?? input.imageGen.model;
  const apiKeyEnv = input.imageGen.byteplus?.apiKeyEnv ?? input.imageGen.apiKeyEnv ?? defaultImageApiKeyEnv("byteplus");
  const apiKey = process.env[apiKeyEnv];
  if (apiKey === undefined || apiKey.length === 0) {
    return imageSetupNeeded({
      provider: "byteplus",
      model,
      requiredSecret: apiKeyEnv
    });
  }

  const baseUrl = (input.imageGen.byteplus?.baseUrl ?? input.imageGen.baseUrl ?? defaultImageBaseUrl("byteplus")).replace(/\/$/, "");
  const response = await fetcher(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      prompt: input.prompt,
      size: bytePlusSize(input.aspectRatio),
      seed: input.seed,
      response_format: "url"
    }),
    signal: input.signal
  });
  return parseImageResponse(response, "byteplus", model);
}

async function parseImageResponse(
  response: Awaited<ReturnType<ImageGenerationFetchLike>>,
  provider: string,
  model: string
): Promise<{ ok: true; url: string; model: string } | { ok: false; content: string; metadata?: Record<string, unknown> }> {
  const raw = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      content: imageGenerationFailureMessage(response.status, response.statusText, raw, provider, model),
      metadata: { provider, model }
    };
  }

  const parsed = tryJson(raw);
  const url = firstImageUrl(parsed);
  if (url === undefined) {
    return {
      ok: false,
      content: "Image generation response did not include an image URL.",
      metadata: { provider, model, response: parsed ?? raw }
    };
  }

  return { ok: true, url, model };
}

async function globalImageFetch(url: string, init?: Parameters<ImageGenerationFetchLike>[1]): ReturnType<ImageGenerationFetchLike> {
  const response = await fetch(url, init as RequestInit);
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    arrayBuffer: async () => await response.arrayBuffer(),
    text: async () => await response.text()
  };
}

function firstImageUrl(value: any): string | undefined {
  if (typeof value?.images?.[0]?.url === "string") return value.images[0].url;
  if (typeof value?.image?.url === "string") return value.image.url;
  if (typeof value?.data?.[0]?.url === "string") return value.data[0].url;
  if (typeof value?.url === "string") return value.url;
  return undefined;
}

function falImageSize(aspectRatio: ImageAspect): string {
  if (aspectRatio === "landscape") return "landscape_16_9";
  if (aspectRatio === "portrait") return "portrait_16_9";
  return "square_hd";
}

function bytePlusSize(aspectRatio: ImageAspect): string {
  if (aspectRatio === "landscape") return "2560x1440";
  if (aspectRatio === "portrait") return "1440x2560";
  return "1920x1920";
}

function imageGenerationFailureMessage(
  status: number,
  statusText: string,
  raw: string,
  provider: string,
  model: string
): string {
  const parsed = tryJson(raw);
  const code = parsed?.error?.code;
  if (provider === "byteplus" && code === "ModelNotOpen") {
    return [
      `Image generation request failed: ${status} ${statusText}`,
      `BytePlus ModelArk says model ${model} is not activated for this account.`,
      "Activate this model in the Ark Console, or choose another enabled image model with `estacoda image models --provider byteplus` and `estacoda image setup --provider byteplus --model-version seedream-5`.",
      raw
    ].join("\n");
  }
  return `Image generation request failed: ${status} ${statusText}\n${raw}`;
}

function normalizeAspectRatio(value: string | undefined): ImageAspect | undefined {
  if (value === undefined || value === "square") return "square";
  if (value === "landscape" || value === "portrait") return value;
  return undefined;
}

function mimeFromImageDownload(url: string, contentType: string | undefined): string {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  if (normalized !== undefined && normalized.startsWith("image/")) {
    return normalized;
  }

  let ext = "";
  try {
    ext = extname(new URL(url).pathname).toLowerCase();
  } catch {
    ext = extname(url).toLowerCase();
  }
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/svg+xml") return "svg";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "image";
}

function truncateSummary(value: string, maxChars = 240): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function tryJson(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function defaultImageGen(): LoadedRuntimeConfig["imageGen"] {
  return {
    provider: "fal",
    model: defaultImageModel("fal"),
    useGateway: false,
    fal: {
      model: defaultImageModel("fal"),
      apiKeyEnv: defaultImageApiKeyEnv("fal"),
      baseUrl: defaultImageBaseUrl("fal")
    },
    byteplus: {
      model: defaultImageModel("byteplus"),
      apiKeyEnv: defaultImageApiKeyEnv("byteplus"),
      baseUrl: defaultImageBaseUrl("byteplus")
    }
  };
}

function imageSetupNeeded(input: {
  provider: "fal" | "byteplus";
  model: string;
  requiredSecret: string;
}): { ok: false; content: string; metadata: Record<string, unknown> } {
  return {
    ok: false,
    content: [
      "Image generation is not configured yet.",
      `Missing required secret: ${input.requiredSecret}.`,
      "Use a protected credential prompt or run estacoda image setup, then retry the original image request."
    ].join("\n"),
    metadata: setupNeeded({
      kind: "setup_needed",
      capability: "image_generation",
      providerOptions: ["fal", "byteplus"],
      requiredSecret: input.requiredSecret,
      resumeIntent: "image.generate",
      suggestedCommand: `estacoda image setup --provider ${input.provider} --model ${input.model} --api-key-env ${input.requiredSecret}`,
      suggestedTool: "config.image.setup",
      provider: input.provider,
      model: input.model
    })
  };
}
