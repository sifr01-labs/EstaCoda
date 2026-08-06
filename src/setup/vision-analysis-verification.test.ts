import { describe, expect, it } from "vitest";
import {
  loadVisionAnalysisVerificationImageDataUrl,
  VISION_ANALYSIS_VERIFICATION_TEXT,
} from "./vision-analysis-verification.js";

describe("Vision Analysis setup verification fixture", () => {
  it("ships a bounded benign bilingual PNG for route checks", async () => {
    const dataUrl = await loadVisionAnalysisVerificationImageDataUrl();
    const encoded = dataUrl.slice("data:image/png;base64,".length);
    const image = Buffer.from(encoded, "base64");

    expect(dataUrl).toMatch(/^data:image\/png;base64,/u);
    expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(image.byteLength).toBeLessThan(2_000_000);
    expect(VISION_ANALYSIS_VERIFICATION_TEXT).toEqual({
      en: "VISION READY",
      ar: "الرؤية جاهزة",
    });
  });
});
