import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalCase } from "../../contracts/eval.js";
import { resolveVisionImageSource } from "../../vision/image-source-resolver.js";
import { assertEqual, buildResult } from "../eval-runner.js";
import {
  generateVisionEvaluationFixtures,
  VISION_EVALUATION_FIXTURE_MAX_BYTES
} from "../vision-evaluation-fixtures.js";

export const visionImageSecurityCase: EvalCase = {
  id: "vision-image-security",
  name: "Vision image security fixtures",
  description: "Checks deterministic magic-byte, corruption, and source-size boundaries without provider dispatch.",
  tags: ["vision", "security", "deterministic"],
  async run() {
    const startedAt = Date.now();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-vision-eval-case-"));
    try {
      const manifest = await generateVisionEvaluationFixtures(workspaceRoot);
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

      return buildResult("vision-image-security", "Vision image security fixtures", [
        assertEqual("fixture corpus is complete", manifest.fixtures.length, 10),
        assertEqual("extension spoof uses magic-byte MIME", spoofed.ok ? spoofed.mimeType : spoofed.code, "image/png"),
        assertEqual("corrupt PNG fails closed", corrupt.ok ? "ok" : corrupt.code, "source-corrupt"),
        assertEqual("oversized source fails before decode", oversized.ok ? "ok" : oversized.code, "source-too-large")
      ], Date.now() - startedAt);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
};
