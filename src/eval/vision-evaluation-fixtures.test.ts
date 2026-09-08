import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveVisionImageSource } from "../vision/image-source-resolver.js";
import {
  generateVisionEvaluationFixtures,
  VISION_EVALUATION_FIXTURE_MAX_BYTES
} from "./vision-evaluation-fixtures.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("vision evaluation fixtures", () => {
  it("generates stable quality and security inputs with declared expectations", async () => {
    const first = await tempDir();
    const second = await tempDir();
    const firstManifest = await generateVisionEvaluationFixtures(first);
    const secondManifest = await generateVisionEvaluationFixtures(second);

    expect(firstManifest).toEqual(secondManifest);
    expect(firstManifest.fixtures.map((fixture) => fixture.file)).toEqual(expect.arrayContaining([
      "english-ocr.png",
      "arabic-mixed-ocr.png",
      "chart.png",
      "screenshot.png",
      "dense-document.png",
      "rotation.png",
      "prompt-injection.png",
      "extension-spoof.jpg",
      "corrupt.png",
      "oversized.png"
    ]));
  });

  it("exercises magic-byte detection and bounded-source failures", async () => {
    const workspaceRoot = await tempDir();
    await generateVisionEvaluationFixtures(workspaceRoot);

    const spoofed = await resolveVisionImageSource({
      workspaceRoot,
      path: "extension-spoof.jpg",
      maxBytes: VISION_EVALUATION_FIXTURE_MAX_BYTES
    });
    const corrupt = await resolveVisionImageSource({
      workspaceRoot,
      path: "corrupt.png",
      maxBytes: VISION_EVALUATION_FIXTURE_MAX_BYTES
    });
    const oversized = await resolveVisionImageSource({
      workspaceRoot,
      path: "oversized.png",
      maxBytes: VISION_EVALUATION_FIXTURE_MAX_BYTES
    });

    expect(spoofed).toMatchObject({ ok: true, mimeType: "image/png" });
    expect(corrupt).toMatchObject({ ok: false, code: "source-corrupt" });
    expect(oversized).toMatchObject({ ok: false, code: "source-too-large" });
  });
});

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "estacoda-vision-eval-"));
  cleanupPaths.push(path);
  return path;
}
