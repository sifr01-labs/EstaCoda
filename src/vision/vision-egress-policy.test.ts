import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { ResolvedVisionImageSource } from "../contracts/vision.js";
import {
  isSensitiveVisionPath,
  resolveVisionEgressSecurity,
  resolveVisionSourcesEgressSecurity,
  visionInputProvenanceForTurn
} from "./vision-egress-policy.js";

describe("vision egress security resolution", () => {
  let root: string;
  let imagePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "estacoda-vision-provenance-"));
    imagePath = join(root, "image.png");
    await writeFile(imagePath, "image");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("distinguishes local inference from hosted inference", async () => {
    await expect(resolveVisionEgressSecurity({
      source: source(imagePath),
      workspaceRoot: root,
      visionRoute: auxiliary(route("local", "http://localhost:11434/v1")),
      mainRoute: route("local", "http://localhost:11434/v1")
    })).resolves.toBeUndefined();

    await expect(resolveVisionEgressSecurity({
      source: source(imagePath),
      workspaceRoot: root,
      visionRoute: auxiliary(route("openai")),
      mainRoute: route("openai")
    })).resolves.toMatchObject({
      riskClass: "external-side-effect",
      dataEgress: { inference: "hosted", destinations: ["openai@https://api.openai.com/v1"] }
    });
  });

  it("derives attachment and explicit-reference provenance from current-turn runtime context", async () => {
    const attachment = visionInputProvenanceForTurn({
      attachments: [{
        id: "image-1",
        kind: "file",
        status: "ready",
        mimeType: "image/png",
        localPath: imagePath
      }]
    });
    const attachmentResolution = await hostedResolution(imagePath, attachment);
    expect(attachmentResolution?.dataEgress?.sourceProvenance).toBe("current-turn-attachment");

    const reference = visionInputProvenanceForTurn({
      references: [{ raw: "@file:image.png", kind: "file", target: "image.png" }]
    });
    const referenceResolution = await hostedResolution(imagePath, reference);
    expect(referenceResolution?.dataEgress?.sourceProvenance).toBe("explicit-reference");
    expect((await hostedResolution(imagePath))?.dataEgress?.sourceProvenance).toBe("agent-discovered");
  });

  it("derives browser and generated artifact provenance only from runtime-owned paths", async () => {
    const browserResolution = await hostedResolution(imagePath, {
      attachmentPaths: [],
      explicitReferencePaths: [],
      browserArtifactPaths: [imagePath]
    });
    expect(browserResolution?.dataEgress?.sourceProvenance).toBe("browser-artifact");

    const generatedPathResolution = await hostedResolution(imagePath, {
      attachmentPaths: [],
      explicitReferencePaths: [],
      generatedArtifactPaths: [imagePath]
    });
    expect(generatedPathResolution?.dataEgress?.sourceProvenance).toBe("generated-artifact");

    const imageCacheRoot = join(root, "image-cache");
    await mkdir(imageCacheRoot);
    const generatedPath = join(imageCacheRoot, "generated.png");
    await writeFile(generatedPath, "image");
    const unregisteredCacheResolution = await resolveVisionEgressSecurity({
      source: source(await realpath(generatedPath)),
      workspaceRoot: root,
      visionRoute: auxiliary(route("openai")),
      mainRoute: route("openai")
    });
    expect(unregisteredCacheResolution?.dataEgress?.sourceProvenance).toBe("agent-discovered");
  });

  it("binds a fallback chain to every possible hosted destination", async () => {
    const result = await resolveVisionEgressSecurity({
      source: source(imagePath),
      workspaceRoot: root,
      visionRoute: { ...auxiliary(route("openai")), fallbackToMain: true },
      mainRoute: route("anthropic")
    });
    expect(result?.dataEgress?.destinations).toEqual([
      "anthropic@https://api.anthropic.com/v1",
      "openai@https://api.openai.com/v1"
    ]);
    expect(result?.targetKey).toContain(encodeURIComponent("anthropic@https://api.anthropic.com/v1"));
  });

  it("binds native multimodal fallbacks while ignoring text-only fallbacks", async () => {
    const textOnlyFallback = route("anthropic");
    textOnlyFallback.profile = { ...textOnlyFallback.profile, supportsVision: false };
    const result = await resolveVisionEgressSecurity({
      source: source(imagePath),
      workspaceRoot: root,
      visionRoute: auxiliary(route("openai")),
      additionalRoutes: [route("anthropic"), textOnlyFallback, route("local", "http://localhost:11434/v1")]
    });

    expect(result?.dataEgress?.destinations).toEqual([
      "anthropic@https://api.anthropic.com/v1",
      "openai@https://api.openai.com/v1"
    ]);
  });

  it("recognizes sensitive local path families without exposing them in the target summary", async () => {
    const sensitiveDir = join(root, ".ssh");
    await mkdir(sensitiveDir);
    const sensitivePath = join(sensitiveDir, "camera.png");
    await writeFile(sensitivePath, "image");
    const result = await hostedResolution(sensitivePath);
    expect(isSensitiveVisionPath(sensitivePath)).toBe(true);
    expect(result?.dataEgress?.sensitivePath).toBe(true);
    expect(result?.targetSummary).not.toContain(sensitivePath);
    expect(result?.targetKey).not.toContain(sensitivePath);
  });

  it("classifies every comparison source and uses the most restrictive provenance", async () => {
    const secondPath = join(root, "second.png");
    await writeFile(secondPath, "image");
    const result = await resolveVisionSourcesEgressSecurity({
      sources: [source(await realpath(imagePath)), source(await realpath(secondPath))],
      workspaceRoot: root,
      provenance: {
        attachmentPaths: [imagePath],
        explicitReferencePaths: []
      },
      visionRoute: auxiliary(route("openai")),
      mainRoute: route("openai")
    });

    expect(result).toMatchObject({
      targetSummary: expect.stringContaining("send 2 images"),
      dataEgress: {
        sourceProvenance: "agent-discovered",
        sourceProvenances: ["current-turn-attachment", "agent-discovered"],
        sourceCount: 2
      }
    });
  });

  async function hostedResolution(
    path: string,
    provenance?: Parameters<typeof resolveVisionEgressSecurity>[0]["provenance"]
  ) {
    return await resolveVisionEgressSecurity({
      source: source(await realpath(path)),
      workspaceRoot: root,
      provenance,
      visionRoute: auxiliary(route("openai")),
      mainRoute: route("openai")
    });
  }
});

function source(path: string): ResolvedVisionImageSource {
  return {
    ok: true,
    canonicalPath: path,
    displayPath: "image.png",
    bytes: new Uint8Array(),
    byteLength: 0,
    mimeType: "image/png"
  };
}

function route(provider: "local" | "openai" | "anthropic", baseUrl?: string): ResolvedModelRoute {
  return {
    provider,
    id: `${provider}-vision`,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    profile: {
      id: `${provider}-vision`,
      provider,
      contextWindowTokens: 32_000,
      supportsTools: true,
      supportsVision: true,
      supportsStructuredOutput: true
    }
  };
}

function auxiliary(modelRoute: ResolvedModelRoute): ResolvedAuxiliaryRoute {
  return {
    task: "vision",
    route: modelRoute,
    source: "explicit",
    fallbackToMain: false,
    diagnostics: []
  };
}
