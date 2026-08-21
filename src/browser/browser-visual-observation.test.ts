import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { captureGovernedBrowserScreenshot, inspectCurrentVisualSurface } from "./browser-visual-observation.js";

async function solidPng(): Promise<Buffer> {
  return sharp({
    create: { width: 100, height: 80, channels: 4, background: { r: 240, g: 20, b: 20, alpha: 1 } }
  }).png().toBuffer();
}

describe("governed browser visual observations", () => {
  it("captures only the viewport and masks sensitive rectangles before returning bytes", async () => {
    const png = await solidPng();
    const send = vi.fn(async (method: string) => {
      if (method === "Runtime.evaluate") {
        return { result: { value: JSON.stringify({
          cssWidth: 100,
          cssHeight: 80,
          scrollX: 0,
          scrollY: 12,
          mutationRevision: 0,
          rects: [{ left: 10, top: 10, width: 20, height: 16 }]
        }) } };
      }
      return { data: png.toString("base64") };
    });

    const result = await captureGovernedBrowserScreenshot({
      client: { send },
      sessionId: "session-1",
      tabRef: "@t1",
      identity: { documentEpoch: 2, actionRevision: 4, observationId: 7 }
    });

    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false
    });
    expect(result.screenshot.observation).toMatchObject({
      sessionId: "session-1",
      tabRef: "@t1",
      captureScope: "viewport",
      sanitized: true,
      maskedRegionCount: 1,
      viewport: { cssWidth: 100, cssHeight: 80, pixelWidth: 100, pixelHeight: 80 }
    });
    expect(result.lease).toMatchObject({ scrollY: 12, mutationRevision: 0 });
    const pixel = await sharp(Buffer.from(result.screenshot.base64, "base64")).extract({ left: 15, top: 15, width: 1, height: 1 }).raw().toBuffer();
    expect([...pixel.slice(0, 3)]).toEqual([24, 24, 27]);
  });

  it("reports the current lease signals used to expire visual targets", async () => {
    const send = vi.fn(async () => ({ result: { value: JSON.stringify({
      cssWidth: 319,
      cssHeight: 640,
      scrollX: 14,
      scrollY: 28,
      mutationRevision: 3
    }) } }));

    await expect(inspectCurrentVisualSurface({ send })).resolves.toEqual({
      cssWidth: 319,
      cssHeight: 640,
      scrollX: 14,
      scrollY: 28,
      mutationRevision: 3
    });
  });

  it("discards a screenshot when the page changes after mask inspection", async () => {
    const png = await solidPng();
    let inspection = 0;
    const send = vi.fn(async (method: string) => {
      if (method === "Page.captureScreenshot") return { data: png.toString("base64") };
      inspection += 1;
      return { result: { value: JSON.stringify({
        cssWidth: 100,
        cssHeight: 80,
        scrollX: 0,
        scrollY: 0,
        mutationRevision: inspection - 1,
        rects: []
      }) } };
    });

    await expect(captureGovernedBrowserScreenshot({ client: { send } }))
      .rejects.toThrow(/changed during sanitized capture/u);
  });
});
