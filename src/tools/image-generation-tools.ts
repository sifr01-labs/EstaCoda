import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import {
  isAlwaysBlockedUrl,
  isPrivateOrInternalIp,
  normalizeHostname,
  normalizeIpForChecks,
  parseHttpUrl,
  scanUrlForSecrets
} from "../browser/url-safety.js";
import { setupNeeded } from "../capabilities/capability-setup.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { defaultImageApiKeyEnv, defaultImageBaseUrl, defaultImageModel, imageModelOption, resolveImageModel, type FalPayloadValue, type ImageModelOption } from "../contracts/image-generation.js";
import type { RegisteredTool, SessionToolProvider } from "../contracts/tool.js";

export type ImageGenerationFetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string | FormData;
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
type ResolvedSourceImage = {
  reference: string;
  url?: string;
  localPath?: string;
  mimeType?: string;
};

const OPENAI_IMAGE_EDIT_MAX_SOURCE_IMAGES = 16;
const OPENAI_IMAGE_EDIT_MAX_SOURCE_BYTES = 50 * 1024 * 1024;

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

      const artifact = await storeImageArtifact(options, result, {
        summary: truncateSummary(`Image generated from prompt: ${prompt}`),
        metadata: {
          visionProvenance: "generated-artifact",
          ...(context?.visibleTurnId === undefined ? {} : { visionTurnId: context.visibleTurnId }),
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
  }, {
    name: "image.edit",
    description: "Edit or blend one or more source images with the configured image provider using a text instruction.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        sourceImages: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "HTTPS image URLs, artifact:// references, or artifact ids for prior generated images with source URLs."
        },
        sourceImage: {
          type: "string",
          description: "Single HTTPS image URL, artifact:// reference, or artifact id."
        },
        aspectRatio: { type: "string", enum: ["square", "landscape", "portrait"] },
        model: { type: "string" }
      },
      required: ["prompt"]
    },
    riskClass: "external-side-effect",
    toolsets: ["media", "telegram"],
    progressLabel: "editing image",
    maxResultSizeChars: 4000,
    isAvailable: () => true,
    run: async (input: { prompt?: string; sourceImages?: string[]; sourceImage?: string; aspectRatio?: string; model?: string }, context) => {
      const prompt = input.prompt?.trim();
      if (prompt === undefined || prompt.length === 0) {
        return { ok: false, content: "image.edit requires a prompt." };
      }
      const aspectRatio = normalizeAspectRatio(input.aspectRatio);
      if (aspectRatio === undefined) {
        return { ok: false, content: "image.edit aspectRatio must be square, landscape, or portrait." };
      }

      const sourceImages = resolveSourceImages(input, options.artifactStore, {
        provider: imageGen.provider,
        imageCacheRoot: options.imageCacheRoot
      });
      if (!sourceImages.ok) {
        return sourceImages;
      }

      const result = await editImage({
        prompt,
        sourceImages: sourceImages.sources,
        aspectRatio,
        model: input.model,
        imageGen,
        fetch: options.fetch,
        signal: context?.signal
      });
      if (!result.ok) {
        return result;
      }

      const artifact = await storeImageArtifact(options, result, {
        summary: truncateSummary(`Image edited from ${sourceImages.sources.length} source image(s): ${prompt}`),
        metadata: {
          visionProvenance: "generated-artifact",
          ...(context?.visibleTurnId === undefined ? {} : { visionTurnId: context.visibleTurnId }),
          provider: imageGen.provider,
          model: result.model,
          aspectRatio: result.aspectRatio,
          sourceImages: sourceImages.sources.map((source) => source.url ?? source.reference),
          sourceUrl: result.sourceUrl
        }
      });

      return {
        ok: true,
        content: [
          `Edited image: ${artifact.path}`,
          `Provider: ${imageGen.provider}`,
          `Model: ${result.model}`,
          `Aspect ratio: ${result.aspectRatio}`,
          `Source images: ${sourceImages.sources.length}`,
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
    : provider === "openai"
      ? await submitOpenAIRequest(input, fetcher)
      : await submitFalRequest(input, fetcher);
  if (!generated.ok) {
    return generated;
  }

  if ("bytes" in generated) {
    return {
      ok: true,
      bytes: generated.bytes,
      mimeType: generated.mimeType,
      model: generated.model,
      aspectRatio: input.aspectRatio,
      seed: provider === "fal" ? generated.seed ?? input.seed : undefined
    };
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
    seed: provider === "fal" ? generated.seed ?? input.seed : undefined,
    sourceUrl: generated.url
  };
}

async function editImage(input: {
  prompt: string;
  sourceImages: ResolvedSourceImage[];
  aspectRatio: ImageAspect;
  model?: string;
  imageGen: LoadedRuntimeConfig["imageGen"];
  fetch?: ImageGenerationFetchLike;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; bytes: Buffer; mimeType: string; model: string; aspectRatio: ImageAspect; sourceUrl?: string }
  | { ok: false; content: string; metadata?: Record<string, unknown> }
> {
  const provider = input.imageGen.provider;
  const fetcher = input.fetch ?? globalImageFetch;
  const generated = provider === "byteplus"
    ? await submitBytePlusRequest({
      prompt: input.prompt,
      sourceImages: input.sourceImages.map((source) => source.url!),
      resumeIntent: "image.edit",
      aspectRatio: input.aspectRatio,
      model: input.model,
      imageGen: input.imageGen,
      signal: input.signal
    }, fetcher)
    : provider === "openai"
      ? await submitOpenAIEditRequest({
        prompt: input.prompt,
        sourceImages: input.sourceImages,
        aspectRatio: input.aspectRatio,
        model: input.model,
        imageGen: input.imageGen,
        signal: input.signal
      }, fetcher)
      : await submitFalEditRequest({
        prompt: input.prompt,
        sourceImages: input.sourceImages.map((source) => source.url!),
        aspectRatio: input.aspectRatio,
        model: input.model,
        imageGen: input.imageGen,
        signal: input.signal
      }, fetcher);
  if (!generated.ok) {
    return generated;
  }

  if ("bytes" in generated) {
    return {
      ok: true,
      bytes: generated.bytes,
      mimeType: generated.mimeType,
      model: generated.model,
      aspectRatio: input.aspectRatio
    };
  }

  const imageBytes = await fetcher(generated.url, { signal: input.signal });
  if (!imageBytes.ok) {
    return {
      ok: false,
      content: `Edited image URL could not be downloaded: ${imageBytes.status} ${imageBytes.statusText}`,
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
): Promise<GeneratedImageReference | { ok: false; content: string; metadata?: Record<string, unknown> }> {
  const model = resolveImageModel("fal", input.model ?? input.imageGen.fal?.model ?? input.imageGen.model)
    ?? defaultImageModel("fal");
  const option = imageModelOption("fal", model);
  const apiKeyEnv = input.imageGen.fal?.apiKeyEnv ?? input.imageGen.apiKeyEnv ?? defaultImageApiKeyEnv("fal");
  const apiKey = process.env[apiKeyEnv];
  if (apiKey === undefined || apiKey.length === 0) {
    return imageSetupNeeded({
      provider: "fal",
      model,
      requiredSecret: apiKeyEnv
    });
  }

  const baseUrl = (input.imageGen.fal?.baseUrl ?? input.imageGen.baseUrl ?? defaultImageBaseUrl("fal")).replace(/\/$/, "");
  const response = await fetcher(`${baseUrl}/${model}`, {
    method: "POST",
    headers: {
      authorization: `Key ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(buildFalGenerationPayload({
      prompt: input.prompt,
      aspectRatio: input.aspectRatio,
      seed: input.seed,
      option
    })),
    signal: input.signal
  });
  return parseImageResponse(response, "fal", model);
}

async function submitFalEditRequest(
  input: {
    prompt: string;
    sourceImages: string[];
    aspectRatio: ImageAspect;
    model?: string;
    imageGen: LoadedRuntimeConfig["imageGen"];
    signal?: AbortSignal;
  },
  fetcher: ImageGenerationFetchLike
): Promise<GeneratedImageReference | { ok: false; content: string; metadata?: Record<string, unknown> }> {
  const model = resolveImageModel("fal", input.model ?? input.imageGen.fal?.model ?? input.imageGen.model)
    ?? defaultImageModel("fal");
  const option = imageModelOption("fal", model);
  const editEndpoint = option?.fal?.editEndpoint;
  if (editEndpoint === undefined) {
    return {
      ok: false,
      content: `FAL model ${model} does not have a cataloged image editing endpoint. Choose an edit-capable FAL model with estacoda image models --provider fal.`,
      metadata: { provider: "fal", model, reason: "unsupported-edit-model" }
    };
  }

  const maxReferenceImages = option?.fal?.maxReferenceImages;
  if (maxReferenceImages !== undefined && input.sourceImages.length > maxReferenceImages) {
    return {
      ok: false,
      content: `FAL model ${model} supports at most ${maxReferenceImages} source image(s) for editing.`,
      metadata: { provider: "fal", model, maxReferenceImages }
    };
  }

  const apiKeyEnv = input.imageGen.fal?.apiKeyEnv ?? input.imageGen.apiKeyEnv ?? defaultImageApiKeyEnv("fal");
  const apiKey = process.env[apiKeyEnv];
  if (apiKey === undefined || apiKey.length === 0) {
    return imageSetupNeeded({
      provider: "fal",
      model,
      requiredSecret: apiKeyEnv,
      resumeIntent: "image.edit"
    });
  }

  const baseUrl = (input.imageGen.fal?.baseUrl ?? input.imageGen.baseUrl ?? defaultImageBaseUrl("fal")).replace(/\/$/, "");
  const response = await fetchWithTransientRetry(fetcher, `${baseUrl}/${editEndpoint}`, {
    method: "POST",
    headers: {
      authorization: `Key ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(buildFalEditPayload({
      prompt: input.prompt,
      sourceImages: input.sourceImages,
      aspectRatio: input.aspectRatio,
      option
    })),
    signal: input.signal
  });
  return parseImageResponse(response, "fal", editEndpoint);
}

async function submitBytePlusRequest(
  input: {
    prompt: string;
    aspectRatio: ImageAspect;
    sourceImages?: string[];
    resumeIntent?: string;
    model?: string;
    seed?: number;
    imageGen: LoadedRuntimeConfig["imageGen"];
    signal?: AbortSignal;
  },
  fetcher: ImageGenerationFetchLike
): Promise<GeneratedImageReference | { ok: false; content: string; metadata?: Record<string, unknown> }> {
  const model = resolveImageModel("byteplus", input.model ?? input.imageGen.byteplus?.model ?? input.imageGen.model)
    ?? defaultImageModel("byteplus");
  const apiKeyEnv = input.imageGen.byteplus?.apiKeyEnv ?? input.imageGen.apiKeyEnv ?? defaultImageApiKeyEnv("byteplus");
  const apiKey = process.env[apiKeyEnv];
  if (apiKey === undefined || apiKey.length === 0) {
    return imageSetupNeeded({
      provider: "byteplus",
      model,
      requiredSecret: apiKeyEnv,
      resumeIntent: input.resumeIntent
    });
  }

  const baseUrl = (input.imageGen.byteplus?.baseUrl ?? input.imageGen.baseUrl ?? defaultImageBaseUrl("byteplus")).replace(/\/$/, "");
  const body: Record<string, unknown> = {
    model,
    prompt: input.prompt,
    size: bytePlusSize(input.aspectRatio),
    output_format: "png",
    response_format: "url",
    watermark: false
  };
  if (input.sourceImages !== undefined && input.sourceImages.length > 0) {
    body.image = input.sourceImages.length === 1 ? input.sourceImages[0] : input.sourceImages;
    body.sequential_image_generation = "disabled";
  }

  const response = await fetchWithTransientRetry(fetcher, `${baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    signal: input.signal
  });
  return parseImageResponse(response, "byteplus", model);
}

async function submitOpenAIRequest(
  input: {
    prompt: string;
    aspectRatio: ImageAspect;
    model?: string;
    seed?: number;
    imageGen: LoadedRuntimeConfig["imageGen"];
    signal?: AbortSignal;
  },
  fetcher: ImageGenerationFetchLike
): Promise<GeneratedImageReference | { ok: false; content: string; metadata?: Record<string, unknown> }> {
  const model = resolveImageModel("openai", input.model ?? input.imageGen.openai?.model ?? input.imageGen.model)
    ?? defaultImageModel("openai");
  const option = imageModelOption("openai", model);
  const metadata = option?.openai;
  const apiKeyEnv = input.imageGen.openai?.apiKeyEnv ?? input.imageGen.apiKeyEnv ?? defaultImageApiKeyEnv("openai");
  const apiKey = process.env[apiKeyEnv];
  if (apiKey === undefined || apiKey.length === 0) {
    return imageSetupNeeded({
      provider: "openai",
      model,
      requiredSecret: apiKeyEnv
    });
  }

  const baseUrl = (input.imageGen.openai?.baseUrl ?? input.imageGen.baseUrl ?? defaultImageBaseUrl("openai")).replace(/\/$/, "");
  const response = await fetchWithTransientRetry(fetcher, `${baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: metadata?.apiModel ?? "gpt-image-2",
      prompt: input.prompt,
      size: metadata?.sizes[input.aspectRatio] ?? openAIImageSize(input.aspectRatio),
      n: 1,
      quality: metadata?.quality ?? "medium"
    }),
    signal: input.signal
  });
  return parseImageResponse(response, "openai", model);
}

async function submitOpenAIEditRequest(
  input: {
    prompt: string;
    sourceImages: ResolvedSourceImage[];
    aspectRatio: ImageAspect;
    model?: string;
    imageGen: LoadedRuntimeConfig["imageGen"];
    signal?: AbortSignal;
  },
  fetcher: ImageGenerationFetchLike
): Promise<GeneratedImageReference | { ok: false; content: string; metadata?: Record<string, unknown> }> {
  const model = resolveImageModel("openai", input.model ?? input.imageGen.openai?.model ?? input.imageGen.model)
    ?? defaultImageModel("openai");
  const option = imageModelOption("openai", model);
  const metadata = option?.openai;
  const maxReferenceImages = metadata?.maxReferenceImages ?? OPENAI_IMAGE_EDIT_MAX_SOURCE_IMAGES;
  if (input.sourceImages.length > maxReferenceImages) {
    return {
      ok: false,
      content: `OpenAI image editing supports at most ${maxReferenceImages} source image(s).`,
      metadata: { provider: "openai", model, maxReferenceImages }
    };
  }

  const apiKeyEnv = input.imageGen.openai?.apiKeyEnv ?? input.imageGen.apiKeyEnv ?? defaultImageApiKeyEnv("openai");
  const apiKey = process.env[apiKeyEnv];
  if (apiKey === undefined || apiKey.length === 0) {
    return imageSetupNeeded({
      provider: "openai",
      model,
      requiredSecret: apiKeyEnv,
      resumeIntent: "image.edit"
    });
  }

  const parts = await openAIImageSourceParts(input.sourceImages, fetcher, input.signal);
  if (!parts.ok) {
    return parts;
  }

  const form = new FormData();
  form.append("model", metadata?.apiModel ?? "gpt-image-2");
  form.append("prompt", input.prompt);
  form.append("size", metadata?.sizes[input.aspectRatio] ?? openAIImageSize(input.aspectRatio));
  form.append("n", "1");
  form.append("quality", metadata?.quality ?? "medium");
  for (const [index, source] of parts.sources.entries()) {
    form.append("image[]", new Blob([bufferToArrayBuffer(source.bytes)], { type: source.mimeType }), source.fileName ?? `source-${index + 1}.${extensionForMime(source.mimeType)}`);
  }

  const baseUrl = (input.imageGen.openai?.baseUrl ?? input.imageGen.baseUrl ?? defaultImageBaseUrl("openai")).replace(/\/$/, "");
  const response = await fetcher(`${baseUrl}/images/edits`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`
    },
    body: form,
    signal: input.signal
  });
  return parseImageResponse(response, "openai", model);
}

async function fetchWithTransientRetry(
  fetcher: ImageGenerationFetchLike,
  url: string,
  init: Parameters<ImageGenerationFetchLike>[1],
  maxAttempts = 3
): ReturnType<ImageGenerationFetchLike> {
  let lastResponse: Awaited<ReturnType<ImageGenerationFetchLike>> | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetcher(url, init);
    lastResponse = response;
    if (!isTransientProviderFailure(response.status) || attempt === maxAttempts - 1) {
      return response;
    }
    await sleep(250 * (attempt + 1), init?.signal);
  }
  return lastResponse!;
}

function isTransientProviderFailure(status: number): boolean {
  return status === 429 || status >= 500;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

type GeneratedImageReference =
  | { ok: true; url: string; model: string; seed?: number }
  | { ok: true; bytes: Buffer; mimeType: string; model: string; seed?: number };

async function parseImageResponse(
  response: Awaited<ReturnType<ImageGenerationFetchLike>>,
  provider: string,
  model: string
): Promise<GeneratedImageReference | { ok: false; content: string; metadata?: Record<string, unknown> }> {
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
  if (url !== undefined) {
    const dataUriImage = imageDataUriBytes(url);
    if (dataUriImage !== undefined) {
      return { ok: true, bytes: dataUriImage.bytes, mimeType: dataUriImage.mimeType, model, seed: imageResponseSeed(parsed) };
    }
    return { ok: true, url, model, seed: imageResponseSeed(parsed) };
  }
  const b64Json = firstImageB64Json(parsed);
  if (b64Json === undefined) {
    return {
      ok: false,
      content: "Image generation response did not include an image URL or b64_json payload.",
      metadata: { provider, model, response: parsed ?? raw }
    };
  }

  return { ok: true, bytes: Buffer.from(b64Json, "base64"), mimeType: "image/png", model, seed: imageResponseSeed(parsed) };
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

function firstImageB64Json(value: any): string | undefined {
  if (typeof value?.images?.[0]?.b64_json === "string") return value.images[0].b64_json;
  if (typeof value?.image?.b64_json === "string") return value.image.b64_json;
  if (typeof value?.data?.[0]?.b64_json === "string") return value.data[0].b64_json;
  if (typeof value?.b64_json === "string") return value.b64_json;
  return undefined;
}

function imageDataUriBytes(value: string): { bytes: Buffer; mimeType: string } | undefined {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/u.exec(value);
  if (match === null) return undefined;
  return {
    mimeType: match[1]!,
    bytes: Buffer.from(match[2]!, "base64")
  };
}

function imageResponseSeed(value: any): number | undefined {
  return typeof value?.seed === "number" ? value.seed : undefined;
}

function buildFalGenerationPayload(input: {
  prompt: string;
  aspectRatio: ImageAspect;
  seed?: number;
  option?: ImageModelOption;
}): Record<string, FalPayloadValue> {
  const metadata = input.option?.fal;
  const payload: Record<string, FalPayloadValue> = {
    prompt: input.prompt,
    ...(metadata?.defaults ?? {}),
    ...falSizeField(input.aspectRatio, input.option)
  };
  if (input.seed !== undefined) {
    payload.seed = input.seed;
  }
  return filterFalPayload(payload, metadata?.supports);
}

function buildFalEditPayload(input: {
  prompt: string;
  sourceImages: string[];
  aspectRatio: ImageAspect;
  option: ImageModelOption | undefined;
}): Record<string, FalPayloadValue | string[]> {
  const metadata = input.option?.fal;
  const payload: Record<string, FalPayloadValue | string[]> = {
    prompt: input.prompt,
    ...(metadata?.defaults ?? {}),
    image_urls: input.sourceImages,
    ...falSizeField(input.aspectRatio, input.option)
  };
  return filterFalPayload(payload, metadata?.editSupports);
}

function falSizeField(aspectRatio: ImageAspect, option: ImageModelOption | undefined): Record<string, string> {
  const metadata = option?.fal;
  const size = metadata?.sizes[aspectRatio] ?? fallbackFalImageSize(aspectRatio);
  return metadata?.sizeStyle === "aspect_ratio"
    ? { aspect_ratio: size }
    : { image_size: size };
}

function fallbackFalImageSize(aspectRatio: ImageAspect): string {
  if (aspectRatio === "landscape") return "landscape_16_9";
  if (aspectRatio === "portrait") return "portrait_16_9";
  return "square_hd";
}

function filterFalPayload<T extends Record<string, FalPayloadValue | string[]>>(
  payload: T,
  supports: readonly string[] | undefined
): T {
  if (supports === undefined) return payload;
  const allowed = new Set(supports);
  return Object.fromEntries(Object.entries(payload).filter(([key]) => allowed.has(key))) as T;
}

function bytePlusSize(aspectRatio: ImageAspect): string {
  if (aspectRatio === "landscape") return "2560x1440";
  if (aspectRatio === "portrait") return "1440x2560";
  return "1920x1920";
}

function openAIImageSize(aspectRatio: ImageAspect): string {
  if (aspectRatio === "landscape") return "1536x1024";
  if (aspectRatio === "portrait") return "1024x1536";
  return "1024x1024";
}

async function openAIImageSourceParts(
  sources: readonly ResolvedSourceImage[],
  fetcher: ImageGenerationFetchLike,
  signal?: AbortSignal
): Promise<
  | { ok: true; sources: Array<{ bytes: Buffer; mimeType: string; fileName?: string }> }
  | { ok: false; content: string; metadata?: Record<string, unknown> }
> {
  const parts: Array<{ bytes: Buffer; mimeType: string; fileName?: string }> = [];
  for (const [index, source] of sources.entries()) {
    const part = source.localPath !== undefined
      ? await openAILocalImageSourcePart(source)
      : await openAIRemoteImageSourcePart(source, fetcher, signal);
    if (!part.ok) return part;
    parts.push({
      bytes: part.bytes,
      mimeType: part.mimeType,
      fileName: part.fileName ?? `source-${index + 1}.${extensionForMime(part.mimeType)}`
    });
  }
  return { ok: true, sources: parts };
}

async function openAILocalImageSourcePart(
  source: ResolvedSourceImage
): Promise<
  | { ok: true; bytes: Buffer; mimeType: string; fileName?: string }
  | { ok: false; content: string; metadata?: Record<string, unknown> }
> {
  const localPath = source.localPath;
  if (localPath === undefined) {
    return { ok: false, content: "OpenAI image editing requires an HTTPS source image or local image artifact.", metadata: { reason: "missing-source" } };
  }
  const fileStat = await stat(localPath).catch(() => undefined);
  if (fileStat === undefined || !fileStat.isFile()) {
    return {
      ok: false,
      content: `OpenAI image editing could not read source artifact ${source.reference}.`,
      metadata: { source: source.reference, reason: "source-artifact-unreadable" }
    };
  }
  if (fileStat.size > OPENAI_IMAGE_EDIT_MAX_SOURCE_BYTES) {
    return openAIImageSourceTooLarge(source.reference, fileStat.size);
  }
  const bytes = await readFile(localPath);
  const mimeType = normalizeOpenAIImageInputMime(source.mimeType ?? mimeFromImageDownload(localPath, undefined));
  if (mimeType === undefined) {
    return openAIUnsupportedImageSource(source.reference, source.mimeType);
  }
  return {
    ok: true,
    bytes,
    mimeType,
    fileName: `source-${safeId(source.reference)}.${extensionForMime(mimeType)}`
  };
}

async function openAIRemoteImageSourcePart(
  source: ResolvedSourceImage,
  fetcher: ImageGenerationFetchLike,
  signal?: AbortSignal
): Promise<
  | { ok: true; bytes: Buffer; mimeType: string; fileName?: string }
  | { ok: false; content: string; metadata?: Record<string, unknown> }
> {
  const url = source.url;
  if (url === undefined) {
    return { ok: false, content: "OpenAI image editing requires an HTTPS source image or local image artifact.", metadata: { source: source.reference } };
  }
  const response = await fetcher(url, { signal });
  if (!response.ok) {
    return {
      ok: false,
      content: `OpenAI image editing could not download source image ${url}: ${response.status} ${response.statusText}`,
      metadata: { source: source.reference, status: response.status }
    };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > OPENAI_IMAGE_EDIT_MAX_SOURCE_BYTES) {
    return openAIImageSourceTooLarge(url, bytes.byteLength);
  }
  const mimeType = normalizeOpenAIImageInputMime(mimeFromImageDownload(url, response.headers?.get("content-type") ?? undefined));
  if (mimeType === undefined) {
    return openAIUnsupportedImageSource(url, response.headers?.get("content-type") ?? undefined);
  }
  return {
    ok: true,
    bytes,
    mimeType,
    fileName: `source-${safeId(new URL(url).pathname || "image")}.${extensionForMime(mimeType)}`
  };
}

function normalizeOpenAIImageInputMime(value: string | undefined): string | undefined {
  const normalized = value?.split(";")[0]?.trim().toLowerCase();
  if (normalized === "image/png" || normalized === "image/jpeg" || normalized === "image/webp") {
    return normalized;
  }
  return undefined;
}

function openAIUnsupportedImageSource(source: string, mimeType: string | undefined): { ok: false; content: string; metadata: Record<string, unknown> } {
  return {
    ok: false,
    content: "OpenAI image editing supports PNG, JPEG, or WebP source images.",
    metadata: { source, mimeType, reason: "unsupported-source-mime" }
  };
}

function openAIImageSourceTooLarge(source: string, bytes: number): { ok: false; content: string; metadata: Record<string, unknown> } {
  return {
    ok: false,
    content: "OpenAI image editing source images must be 50 MB or smaller.",
    metadata: { source, bytes, maxBytes: OPENAI_IMAGE_EDIT_MAX_SOURCE_BYTES, reason: "source-too-large" }
  };
}

function bufferToArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function imageGenerationFailureMessage(
  status: number,
  statusText: string,
  raw: string,
  provider: string,
  model: string
): string {
  const parsed = tryJson(raw);
  const code = typeof parsed?.error?.code === "string" ? parsed.error.code : undefined;
  if (provider === "byteplus" && code === "ModelNotOpen") {
    return [
      `Image generation request failed: ${status} ${statusText}`,
      `BytePlus ModelArk says model ${model} is not activated for this account.`,
      "Activate this model in the Ark Console, or choose another enabled image model with `estacoda image models --provider byteplus` and `estacoda image setup --provider byteplus --model-version seedream-5`.",
      raw
    ].join("\n");
  }
  if (provider === "byteplus" && (status === 429 || code?.toLowerCase().includes("rate") === true)) {
    return [
      `Image generation request failed: ${status} ${statusText}`,
      "BytePlus ModelArk rate-limited the request. Retry after a short wait or check the image model RPM quota.",
      raw
    ].join("\n");
  }
  if (provider === "byteplus" && code !== undefined && /quota|balance|insufficient/i.test(code)) {
    return [
      `Image generation request failed: ${status} ${statusText}`,
      "BytePlus ModelArk reported a quota or balance problem for this account.",
      raw
    ].join("\n");
  }
  if (provider === "byteplus" && code !== undefined && /content|policy|safety|sensitive/i.test(code)) {
    return [
      `Image generation request failed: ${status} ${statusText}`,
      "BytePlus ModelArk rejected the prompt or image request under its content policy.",
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

async function storeImageArtifact(
  options: ImageGenerationToolOptions,
  image: { bytes: Buffer; mimeType: string },
  details: {
    summary: string;
    metadata: Record<string, unknown>;
  }
) {
  await mkdir(options.imageCacheRoot, { recursive: true });
  const fileName = `${safeId(options.id?.() ?? randomUUID())}.${extensionForMime(image.mimeType)}`;
  const filePath = join(options.imageCacheRoot, fileName);
  await writeFile(filePath, image.bytes);
  const fileStat = await stat(filePath);
  return options.artifactStore.record({
    path: filePath,
    kind: "image",
    bytes: fileStat.size,
    mimeType: image.mimeType,
    summary: details.summary,
    metadata: details.metadata
  });
}

function resolveSourceImages(
  input: { sourceImages?: string[]; sourceImage?: string },
  artifactStore: ArtifactStore,
  options: {
    provider: LoadedRuntimeConfig["imageGen"]["provider"];
    imageCacheRoot: string;
  }
): { ok: true; sources: ResolvedSourceImage[] } | { ok: false; content: string; metadata?: Record<string, unknown> } {
  const requested = [
    ...(Array.isArray(input.sourceImages) ? input.sourceImages : []),
    input.sourceImage
  ].filter((source): source is string => typeof source === "string" && source.trim().length > 0);

  if (requested.length === 0) {
    return {
      ok: false,
      content: "image.edit requires at least one source image URL, artifact:// reference, or artifact id."
    };
  }

  const sources: ResolvedSourceImage[] = [];
  for (const source of requested) {
    const resolved = resolveSourceImage(source.trim(), artifactStore, options);
    if (!resolved.ok) return resolved;
    sources.push(resolved.source);
  }

  return { ok: true, sources };
}

function resolveSourceImage(
  source: string,
  artifactStore: ArtifactStore,
  options: {
    provider: LoadedRuntimeConfig["imageGen"]["provider"];
    imageCacheRoot: string;
  }
): { ok: true; source: ResolvedSourceImage } | { ok: false; content: string; metadata?: Record<string, unknown> } {
  if (isSafeRemoteImageUrl(source)) {
    return { ok: true, source: { reference: source, url: source } };
  }

  const artifactId = source.startsWith("artifact://") ? source.slice("artifact://".length) : source;
  const artifact = artifactStore.list().find((candidate) => candidate.id === artifactId || candidate.path === source);
  const sourceUrl = typeof artifact?.metadata?.sourceUrl === "string" ? artifact.metadata.sourceUrl : undefined;
  if (sourceUrl !== undefined && isSafeRemoteImageUrl(sourceUrl)) {
    return {
      ok: true,
      source: {
        reference: source.startsWith("artifact://") ? source : `artifact://${artifact?.id ?? artifactId}`,
        url: sourceUrl,
        localPath: localImageArtifactPath(artifact, options.imageCacheRoot),
        mimeType: artifact?.mimeType
      }
    };
  }

  const localPath = options.provider === "openai" ? localImageArtifactPath(artifact, options.imageCacheRoot) : undefined;
  if (localPath !== undefined) {
    return {
      ok: true,
      source: {
        reference: source.startsWith("artifact://") ? source : `artifact://${artifact?.id ?? artifactId}`,
        localPath,
        mimeType: artifact?.mimeType
      }
    };
  }

  if (artifact !== undefined) {
    const openAIHint = options.provider === "openai"
      ? " OpenAI can use local image artifacts only when they were created in the selected profile image cache."
      : "";
    return {
      ok: false,
      content: [
        `image.edit cannot send artifact ${artifact.id} to the image provider because it does not have a safe HTTPS source URL.`,
        `Use an image URL, or first generate/select an image artifact that includes provider sourceUrl metadata.${openAIHint}`
      ].join("\n"),
      metadata: { artifactId: artifact.id }
    };
  }

  return {
    ok: false,
    content: "image.edit source images must be safe HTTPS URLs, artifact:// references, or artifact ids with source URL metadata.",
    metadata: { reason: "invalid-source-image" }
  };
}

function localImageArtifactPath(
  artifact: ReturnType<ArtifactStore["list"]>[number] | undefined,
  imageCacheRoot: string
): string | undefined {
  if (artifact?.kind !== "image" || artifact.localPath === undefined) return undefined;
  const candidate = resolve(artifact.localPath);
  const root = resolve(imageCacheRoot);
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return candidate;
  }
  return undefined;
}

function isSafeRemoteImageUrl(value: string): boolean {
  const parsed = parseHttpUrl(value);
  if (parsed === undefined || parsed.protocol !== "https:") return false;
  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  if (scanUrlForSecrets(value) !== undefined || isAlwaysBlockedUrl(value)) return false;

  const hostname = normalizeHostname(parsed.hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  const literalIp = normalizeIpForChecks(hostname);
  return literalIp === undefined || !isPrivateOrInternalIp(literalIp);
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
    },
    openai: {
      model: defaultImageModel("openai"),
      apiKeyEnv: defaultImageApiKeyEnv("openai"),
      baseUrl: defaultImageBaseUrl("openai")
    }
  };
}

function imageSetupNeeded(input: {
  provider: "fal" | "byteplus" | "openai";
  model: string;
  requiredSecret: string;
  resumeIntent?: string;
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
      providerOptions: ["fal", "byteplus", "openai"],
      requiredSecret: input.requiredSecret,
      resumeIntent: input.resumeIntent ?? "image.generate",
      suggestedCommand: `estacoda image setup --provider ${input.provider} --model ${input.model} --api-key-env ${input.requiredSecret}`,
      suggestedTool: "config.image.setup",
      provider: input.provider,
      model: input.model
    })
  };
}
