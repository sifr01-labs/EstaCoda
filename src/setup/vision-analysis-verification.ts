import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

export const VISION_ANALYSIS_VERIFICATION_TEXT = {
  en: "VISION READY",
  ar: "الرؤية جاهزة",
} as const;

const VERIFICATION_IMAGE_URL = new URL("../../assets/vision-analysis-verification.png", import.meta.url);

export type VisionAnalysisVerificationFixture = {
  readonly path: string;
  readonly dataUrl: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
};

export async function loadVisionAnalysisVerificationFixture(): Promise<VisionAnalysisVerificationFixture> {
  const image = await readFile(VERIFICATION_IMAGE_URL);
  const metadata = await sharp(image).metadata();
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new Error("Vision Analysis verification image dimensions are unavailable.");
  }
  return {
    path: fileURLToPath(VERIFICATION_IMAGE_URL),
    dataUrl: `data:image/png;base64,${image.toString("base64")}`,
    sha256: createHash("sha256").update(image).digest("hex"),
    width: metadata.width,
    height: metadata.height,
    bytes: image.byteLength,
  };
}

export async function loadVisionAnalysisVerificationImageDataUrl(): Promise<string> {
  return (await loadVisionAnalysisVerificationFixture()).dataUrl;
}
