import { readFile } from "node:fs/promises";

export const VISION_ANALYSIS_VERIFICATION_TEXT = {
  en: "VISION READY",
  ar: "الرؤية جاهزة",
} as const;

const VERIFICATION_IMAGE_URL = new URL("../../assets/vision-analysis-verification.png", import.meta.url);

export async function loadVisionAnalysisVerificationImageDataUrl(): Promise<string> {
  const image = await readFile(VERIFICATION_IMAGE_URL);
  return `data:image/png;base64,${image.toString("base64")}`;
}
