import type { Metadata, OutputInfo } from "sharp";
import type {
  NormalizedVisionImage,
  ResolvedVisionImageSource,
  VisionImageMimeType,
  VisionImageNormalizationError,
  VisionImageNormalizationErrorCode,
  VisionImageNormalizationLimits,
  VisionImageNormalizationResult
} from "../contracts/vision.js";

type SharpFactory = typeof import("sharp")["default"];

export type VisionImageNormalizerCallOptions = {
  signal?: AbortSignal;
  limits?: Partial<Omit<VisionImageNormalizationLimits, "maxConcurrency">>;
};

export type VisionImageNormalizer = {
  normalize(
    source: ResolvedVisionImageSource,
    options?: VisionImageNormalizerCallOptions
  ): Promise<VisionImageNormalizationResult>;
};

export type VisionImageProcessor = (
  source: ResolvedVisionImageSource,
  limits: VisionImageNormalizationLimits
) => Promise<VisionImageNormalizationResult>;

export type CreateVisionImageNormalizerOptions = {
  limits?: Partial<VisionImageNormalizationLimits>;
  sharpLoader?: () => Promise<SharpFactory>;
  processor?: VisionImageProcessor;
};

type QueueWaiter = {
  signal?: AbortSignal;
  resolve: (acquired: boolean) => void;
  onAbort?: () => void;
};

type HostedVisionImageFormat = "jpeg" | "png" | "webp";

export const DEFAULT_VISION_IMAGE_NORMALIZATION_LIMITS: Readonly<VisionImageNormalizationLimits> =
  Object.freeze({
    maxSourceBytes: 32 * 1024 * 1024,
    maxInputDimension: 20_000,
    maxInputPixels: 50_000_000,
    maxDecodedBytes: 256 * 1024 * 1024,
    maxAnimationFrames: 100,
    maxAnimationPixels: 100_000_000,
    maxOutputDimension: 7_680,
    maxNormalizedBytes: 4 * 1024 * 1024,
    maxConcurrency: 2
  });

export function createVisionImageNormalizer(
  options: CreateVisionImageNormalizerOptions = {}
): VisionImageNormalizer {
  const baseLimits = resolveLimits(options.limits);
  const processor = options.processor ?? createSharpProcessor(options.sharpLoader ?? loadSharp);
  let active = 0;
  const waiters: QueueWaiter[] = [];

  return {
    async normalize(source, callOptions = {}) {
      const limits = resolveLimits({ ...baseLimits, ...callOptions.limits });
      const acquired = await acquire(callOptions.signal);
      if (!acquired) {
        return normalizationError(
          "normalization-cancelled",
          "Vision image normalization was cancelled."
        );
      }

      try {
        if (isSignalAborted(callOptions.signal)) {
          return normalizationError(
            "normalization-cancelled",
            "Vision image normalization was cancelled."
          );
        }
        const result = await processor(source, limits);
        if (isSignalAborted(callOptions.signal)) {
          return normalizationError(
            "normalization-cancelled",
            "Vision image normalization was cancelled."
          );
        }
        return result;
      } catch {
        return normalizationError(
          "normalization-invalid-image",
          "This image could not be decoded safely for vision analysis."
        );
      } finally {
        release();
      }
    }
  };

  function acquire(signal: AbortSignal | undefined): Promise<boolean> {
    if (signal?.aborted === true) {
      return Promise.resolve(false);
    }
    if (active < baseLimits.maxConcurrency) {
      active += 1;
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolveAcquired) => {
      const waiter: QueueWaiter = { signal, resolve: resolveAcquired };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          resolveAcquired(false);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      waiters.push(waiter);
    });
  }

  function release(): void {
    active = Math.max(0, active - 1);
    while (waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (waiter.onAbort !== undefined) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
      }
      if (waiter.signal?.aborted === true) {
        waiter.resolve(false);
        continue;
      }
      active += 1;
      waiter.resolve(true);
      return;
    }
  }
}

export const defaultVisionImageNormalizer = createVisionImageNormalizer();

function createSharpProcessor(loader: () => Promise<SharpFactory>): VisionImageProcessor {
  return async (source, limits) => {
    let sharp: SharpFactory;
    try {
      sharp = await loader();
    } catch {
      return normalizationError(
        "normalization-unavailable",
        "Vision image processing is unavailable in this installation. Reinstall EstaCoda to restore it."
      );
    }

    return normalizeWithSharp(sharp, source, limits);
  };
}

async function loadSharp(): Promise<SharpFactory> {
  return (await import("sharp")).default;
}

async function normalizeWithSharp(
  sharp: SharpFactory,
  source: ResolvedVisionImageSource,
  limits: VisionImageNormalizationLimits
): Promise<VisionImageNormalizationResult> {
  const input = Buffer.from(source.bytes);
  if (input.byteLength > limits.maxSourceBytes) {
    return limitError(
      "normalization-source-byte-limit",
      "This image exceeds the safe input size for vision processing.",
      input.byteLength,
      limits.maxSourceBytes,
      "bytes"
    );
  }

  const inputOptions = {
    failOn: "warning" as const,
    limitInputPixels: limits.maxInputPixels,
    limitInputChannels: 4,
    unlimited: false,
    pages: 1,
    page: 0,
    sequentialRead: true
  };
  const metadataInputOptions = {
    ...inputOptions,
    limitInputPixels: Math.max(
      limits.maxInputPixels,
      DEFAULT_VISION_IMAGE_NORMALIZATION_LIMITS.maxInputPixels
    )
  };

  let metadata: Metadata;
  try {
    metadata = await sharp(input, metadataInputOptions).metadata();
  } catch {
    return normalizationError(
      "normalization-invalid-image",
      "This image could not be decoded safely for vision analysis."
    );
  }

  const sourceWidth = metadata.width;
  const sourceHeight = metadata.pageHeight ?? metadata.height;
  const sourceFrames = metadata.pages ?? 1;
  if (!isPositiveInteger(sourceWidth) || !isPositiveInteger(sourceHeight)) {
    return normalizationError(
      "normalization-invalid-image",
      "This image does not contain valid dimensions."
    );
  }
  if (!isPositiveInteger(sourceFrames)) {
    return normalizationError(
      "normalization-invalid-image",
      "This image contains invalid animation metadata."
    );
  }

  const largestInputDimension = Math.max(sourceWidth, sourceHeight);
  if (largestInputDimension > limits.maxInputDimension) {
    return limitError(
      "normalization-dimension-limit",
      "This image has a dimension that is too large to process safely.",
      largestInputDimension,
      limits.maxInputDimension,
      "pixels"
    );
  }

  const inputPixels = safeProduct(sourceWidth, sourceHeight);
  if (inputPixels === undefined || inputPixels > limits.maxInputPixels) {
    return limitError(
      "normalization-pixel-limit",
      "This image contains too many pixels to process safely.",
      inputPixels ?? Number.MAX_SAFE_INTEGER,
      limits.maxInputPixels,
      "pixels"
    );
  }

  if (sourceFrames > limits.maxAnimationFrames) {
    return limitError(
      "normalization-animation-limit",
      "This animated image contains too many frames for vision analysis.",
      sourceFrames,
      limits.maxAnimationFrames,
      "frames"
    );
  }

  const animationPixels = safeProduct(sourceWidth, sourceHeight, sourceFrames);
  if (animationPixels === undefined || animationPixels > limits.maxAnimationPixels) {
    return limitError(
      "normalization-animation-pixel-limit",
      "This animated image contains too many aggregate pixels for safe vision analysis.",
      animationPixels ?? Number.MAX_SAFE_INTEGER,
      limits.maxAnimationPixels,
      "pixels"
    );
  }

  const decodedBytes = safeProduct(
    inputPixels,
    Number(metadata.channels),
    bytesPerSample(metadata.depth)
  );
  if (decodedBytes === undefined || decodedBytes > limits.maxDecodedBytes) {
    return limitError(
      "normalization-decoded-memory-limit",
      "This image would require too much decoded memory to process safely.",
      decodedBytes ?? Number.MAX_SAFE_INTEGER,
      limits.maxDecodedBytes,
      "bytes"
    );
  }

  const orientationApplied = metadata.orientation !== undefined && metadata.orientation !== 1;
  const orientedWidth = metadata.autoOrient.width;
  const orientedHeight = metadata.autoOrient.height;
  let targetDimension = Math.min(
    limits.maxOutputDimension,
    Math.max(orientedWidth, orientedHeight)
  );
  let outputFormat = preferredOutputFormat(source.mimeType);
  let lastOutputBytes = input.byteLength;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    let encoded: { data: Buffer; info: OutputInfo };
    try {
      encoded = await encodeHostedImage(
        sharp,
        input,
        inputOptions,
        outputFormat,
        targetDimension
      );
    } catch {
      return normalizationError(
        "normalization-invalid-image",
        "This image could not be decoded safely for vision analysis."
      );
    }
    lastOutputBytes = encoded.data.byteLength;

    if (encoded.data.byteLength <= limits.maxNormalizedBytes) {
      return {
        ok: true,
        bytes: encoded.data,
        byteLength: encoded.data.byteLength,
        mimeType: outputMimeType(outputFormat),
        width: encoded.info.width,
        height: encoded.info.height,
        sourceWidth,
        sourceHeight,
        sourceFrames,
        resized: encoded.info.width !== orientedWidth || encoded.info.height !== orientedHeight,
        orientationApplied,
        metadataStripped: true
      };
    }

    const compactFormat = metadata.hasAlpha ? "webp" : "jpeg";
    if (outputFormat === "png") {
      outputFormat = compactFormat;
      continue;
    }

    const longestOutputEdge = Math.max(encoded.info.width, encoded.info.height);
    if (longestOutputEdge <= 1) {
      break;
    }
    const scale = Math.min(0.9, Math.sqrt(limits.maxNormalizedBytes / encoded.data.byteLength) * 0.92);
    targetDimension = Math.max(1, Math.min(targetDimension - 1, Math.floor(longestOutputEdge * scale)));
  }

  return limitError(
    "normalization-output-byte-limit",
    "This image could not be reduced to a safe hosted payload size.",
    lastOutputBytes,
    limits.maxNormalizedBytes,
    "bytes"
  );
}

async function encodeHostedImage(
  sharp: SharpFactory,
  input: Buffer,
  inputOptions: Parameters<SharpFactory>[1],
  format: HostedVisionImageFormat,
  targetDimension: number
): Promise<{ data: Buffer; info: OutputInfo }> {
  let pipeline = sharp(input, inputOptions)
    .autoOrient()
    .resize({
      width: targetDimension,
      height: targetDimension,
      fit: "inside",
      withoutEnlargement: true
    })
    .toColorspace("srgb");

  switch (format) {
    case "jpeg":
      pipeline = pipeline.jpeg({ quality: 85, progressive: true });
      break;
    case "png":
      pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
      break;
    case "webp":
      pipeline = pipeline.webp({ quality: 85, alphaQuality: 90, effort: 4 });
      break;
  }

  return pipeline.toBuffer({ resolveWithObject: true });
}

function preferredOutputFormat(mimeType: VisionImageMimeType): HostedVisionImageFormat {
  switch (mimeType) {
    case "image/jpeg":
      return "jpeg";
    case "image/webp":
      return "webp";
    case "image/gif":
    case "image/png":
      return "png";
  }
}

function outputMimeType(
  format: HostedVisionImageFormat
): NormalizedVisionImage["mimeType"] {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
  }
}

function resolveLimits(
  overrides: Partial<VisionImageNormalizationLimits> | undefined
): VisionImageNormalizationLimits {
  const limits = {
    ...DEFAULT_VISION_IMAGE_NORMALIZATION_LIMITS,
    ...overrides
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

function bytesPerSample(depth: Metadata["depth"]): number {
  switch (depth) {
    case "uchar":
    case "char":
      return 1;
    case "ushort":
    case "short":
      return 2;
    case "uint":
    case "int":
    case "float":
      return 4;
    default:
      return 8;
  }
}

function safeProduct(...values: number[]): number | undefined {
  let product = 1;
  for (const value of values) {
    product *= value;
    if (!Number.isSafeInteger(product)) {
      return undefined;
    }
  }
  return product;
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function limitError(
  code: VisionImageNormalizationErrorCode,
  message: string,
  actual: number,
  limit: number,
  unit: NonNullable<VisionImageNormalizationError["details"]>["unit"]
): VisionImageNormalizationError {
  return normalizationError(code, message, { actual, limit, unit });
}

function normalizationError(
  code: VisionImageNormalizationErrorCode,
  message: string,
  details?: VisionImageNormalizationError["details"]
): VisionImageNormalizationError {
  return {
    ok: false,
    code,
    message,
    ...(details === undefined ? {} : { details })
  };
}
