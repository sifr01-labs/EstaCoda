import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type {
  NormalizedVisionImage,
  ResolvedVisionImageSource,
  VisionImageMimeType
} from "../contracts/vision.js";
import {
  createVisionImageNormalizer,
  DEFAULT_VISION_IMAGE_NORMALIZATION_LIMITS
} from "./image-normalizer.js";

function source(
  bytes: Uint8Array,
  mimeType: VisionImageMimeType = "image/png"
): ResolvedVisionImageSource {
  return {
    ok: true,
    canonicalPath: "/workspace/image.test",
    displayPath: "image.test",
    bytes,
    byteLength: bytes.byteLength,
    mimeType
  };
}

function normalizedResult(bytes: Uint8Array = Uint8Array.from([1])): NormalizedVisionImage {
  return {
    ok: true,
    bytes,
    byteLength: bytes.byteLength,
    mimeType: "image/png",
    width: 1,
    height: 1,
    sourceWidth: 1,
    sourceHeight: 1,
    sourceFrames: 1,
    resized: false,
    orientationApplied: false,
    metadataStripped: true
  };
}

async function createPng(
  width: number,
  height: number,
  background = { r: 20, g: 80, b: 140, alpha: 0.8 }
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background
    }
  }).png().toBuffer();
}

describe("vision image normalizer", () => {
  it("applies EXIF orientation and strips image metadata", async () => {
    const orientedJpeg = await sharp({
      create: {
        width: 8,
        height: 4,
        channels: 3,
        background: { r: 120, g: 30, b: 10 }
      }
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer();

    const result = await createVisionImageNormalizer().normalize(
      source(orientedJpeg, "image/jpeg")
    );

    expect(result).toMatchObject({
      ok: true,
      width: 4,
      height: 8,
      sourceWidth: 8,
      sourceHeight: 4,
      orientationApplied: true,
      metadataStripped: true,
      mimeType: "image/jpeg"
    });
    if (!result.ok) {
      throw new Error(result.message);
    }
    const outputMetadata = await sharp(result.bytes).metadata();
    expect(outputMetadata.orientation).toBeUndefined();
    expect(outputMetadata.exif).toBeUndefined();
    expect(outputMetadata.iptc).toBeUndefined();
    expect(outputMetadata.xmp).toBeUndefined();
  });

  it("resizes within the hosted dimension cap without enlarging", async () => {
    const png = await createPng(200, 100);
    const result = await createVisionImageNormalizer({
      limits: { maxOutputDimension: 50 }
    }).normalize(source(png));

    expect(result).toMatchObject({
      ok: true,
      width: 50,
      height: 25,
      sourceWidth: 200,
      sourceHeight: 100,
      resized: true,
      mimeType: "image/png"
    });
  });

  it("re-encodes noisy PNG input under the hosted byte cap", async () => {
    const width = 256;
    const height = 256;
    const pixels = Buffer.allocUnsafe(width * height * 3);
    let state = 0x1234abcd;
    for (let index = 0; index < pixels.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels[index] = state >>> 24;
    }
    const png = await sharp(pixels, {
      raw: { width, height, channels: 3 }
    }).png().toBuffer();

    const result = await createVisionImageNormalizer({
      limits: { maxNormalizedBytes: 20_000 }
    }).normalize(source(png));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.byteLength).toBeLessThanOrEqual(20_000);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.resized).toBe(true);
  });

  it("enforces input byte, dimension, pixel, and decoded-memory limits", async () => {
    const png = await createPng(20, 10);

    const inputBytes = await createVisionImageNormalizer({
      limits: { maxSourceBytes: png.byteLength - 1 }
    }).normalize(source(png));
    const dimension = await createVisionImageNormalizer({
      limits: { maxInputDimension: 19 }
    }).normalize(source(png));
    const pixels = await createVisionImageNormalizer({
      limits: { maxInputPixels: 199 }
    }).normalize(source(png));
    const decodedMemory = await createVisionImageNormalizer({
      limits: { maxDecodedBytes: 799 }
    }).normalize(source(png));

    expect(inputBytes).toMatchObject({
      ok: false,
      code: "normalization-source-byte-limit"
    });
    expect(dimension).toMatchObject({
      ok: false,
      code: "normalization-dimension-limit",
      details: { actual: 20, limit: 19, unit: "pixels" }
    });
    expect(pixels).toMatchObject({
      ok: false,
      code: "normalization-pixel-limit",
      details: { actual: 200, limit: 199, unit: "pixels" }
    });
    expect(decodedMemory).toMatchObject({
      ok: false,
      code: "normalization-decoded-memory-limit",
      details: { actual: 800, limit: 799, unit: "bytes" }
    });
  });

  it("uses actual buffers for input and hosted output byte enforcement", async () => {
    const png = await createPng(20, 10);
    const input = source(png);
    input.byteLength = 1;

    const inputLimit = await createVisionImageNormalizer({
      limits: { maxSourceBytes: png.byteLength - 1 }
    }).normalize(input);
    const outputLimit = await createVisionImageNormalizer({
      limits: { maxNormalizedBytes: 1 }
    }).normalize(source(png));

    expect(inputLimit).toMatchObject({
      ok: false,
      code: "normalization-source-byte-limit",
      details: { actual: png.byteLength, limit: png.byteLength - 1, unit: "bytes" }
    });
    expect(outputLimit).toMatchObject({
      ok: false,
      code: "normalization-output-byte-limit",
      details: { limit: 1, unit: "bytes" }
    });
    if (!outputLimit.ok) {
      expect(outputLimit.details?.actual).toBeGreaterThan(1);
    }
  });

  it("rejects animations beyond the configured frame limit", async () => {
    const firstFrame = await createPng(4, 4, { r: 255, g: 0, b: 0, alpha: 1 });
    const secondFrame = await createPng(4, 4, { r: 0, g: 0, b: 0, alpha: 1 });
    const animatedGif = await sharp(
      [firstFrame, secondFrame],
      { join: { animated: true } }
    ).gif({ delay: [20, 20], loop: 0 }).toBuffer();

    const result = await createVisionImageNormalizer({
      limits: { maxAnimationFrames: 1 }
    }).normalize(source(animatedGif, "image/gif"));

    expect(result).toMatchObject({
      ok: false,
      code: "normalization-animation-limit",
      details: { actual: 2, limit: 1, unit: "frames" }
    });
  });

  it("rejects animations beyond the aggregate animation pixel limit", async () => {
    const firstFrame = await createPng(4, 4, { r: 255, g: 0, b: 0, alpha: 1 });
    const secondFrame = await createPng(4, 4, { r: 0, g: 0, b: 0, alpha: 1 });
    const animatedGif = await sharp(
      [firstFrame, secondFrame],
      { join: { animated: true } }
    ).gif({ delay: [20, 20], loop: 0 }).toBuffer();

    const result = await createVisionImageNormalizer({
      limits: { maxAnimationPixels: 31 }
    }).normalize(source(animatedGif, "image/gif"));

    expect(result).toMatchObject({
      ok: false,
      code: "normalization-animation-pixel-limit",
      details: { actual: 32, limit: 31, unit: "pixels" }
    });
  });

  it("normalizes an accepted animation to a static hosted format", async () => {
    const firstFrame = await createPng(4, 4, { r: 0, g: 0, b: 255, alpha: 1 });
    const secondFrame = await createPng(4, 4, { r: 0, g: 0, b: 0, alpha: 1 });
    const animatedGif = await sharp(
      [firstFrame, secondFrame],
      { join: { animated: true } }
    ).gif({ delay: [20, 20], loop: 0 }).toBuffer();

    const result = await createVisionImageNormalizer().normalize(
      source(animatedGif, "image/gif")
    );

    expect(result).toMatchObject({
      ok: true,
      mimeType: "image/png",
      width: 4,
      height: 4,
      sourceFrames: 2
    });
  });

  it("normalizes WebP input to a static WebP hosted payload", async () => {
    const webp = await sharp({
      create: {
        width: 6,
        height: 3,
        channels: 4,
        background: { r: 10, g: 20, b: 30, alpha: 0.5 }
      }
    }).webp().toBuffer();

    const result = await createVisionImageNormalizer().normalize(
      source(webp, "image/webp")
    );

    expect(result).toMatchObject({
      ok: true,
      mimeType: "image/webp",
      width: 6,
      height: 3
    });
    if (!result.ok) {
      throw new Error(result.message);
    }
    await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ format: "webp" });
  });

  it("bounds concurrent processing across queued calls", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const processor = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return normalizedResult();
    });
    const normalizer = createVisionImageNormalizer({
      limits: { maxConcurrency: 2 },
      processor
    });

    const runs = Array.from({ length: 4 }, () => normalizer.normalize(source(Uint8Array.from([1]))));
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(2));
    expect(peak).toBe(2);

    releases.shift()?.();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(3));
    releases.shift()?.();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(4));
    for (const release of releases.splice(0)) {
      release();
    }

    await expect(Promise.all(runs)).resolves.toHaveLength(4);
    expect(peak).toBe(2);
  });

  it("cancels a queued normalization without dispatching it", async () => {
    let releaseFirst!: () => void;
    const processor = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return normalizedResult();
    });
    const normalizer = createVisionImageNormalizer({
      limits: { maxConcurrency: 1 },
      processor
    });
    const first = normalizer.normalize(source(Uint8Array.from([1])));
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const queued = normalizer.normalize(source(Uint8Array.from([2])), {
      signal: controller.signal
    });

    controller.abort();
    await expect(queued).resolves.toMatchObject({
      ok: false,
      code: "normalization-cancelled"
    });
    expect(processor).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
  });

  it("does not publish a native result after active processing is cancelled", async () => {
    let release!: () => void;
    const normalizer = createVisionImageNormalizer({
      processor: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return normalizedResult();
      }
    });
    const controller = new AbortController();
    const running = normalizer.normalize(source(Uint8Array.from([1])), {
      signal: controller.signal
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    controller.abort();
    release();

    await expect(running).resolves.toMatchObject({
      ok: false,
      code: "normalization-cancelled"
    });
  });

  it("degrades clearly when the native image processor cannot load", async () => {
    const png = await createPng(2, 2);
    const normalizer = createVisionImageNormalizer({
      sharpLoader: async () => {
        throw new Error("native binary unavailable");
      }
    });

    await expect(normalizer.normalize(source(png))).resolves.toMatchObject({
      ok: false,
      code: "normalization-unavailable"
    });
  });

  it("uses conservative non-zero production limits", () => {
    expect(DEFAULT_VISION_IMAGE_NORMALIZATION_LIMITS).toEqual({
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
  });
});
