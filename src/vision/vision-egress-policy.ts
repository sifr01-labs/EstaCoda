import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ChannelAttachment } from "../contracts/channel.js";
import type { ContextReference } from "../contracts/context.js";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { SecurityDataEgressContext } from "../contracts/security.js";
import type { ToolSecurityResolution } from "../contracts/tool.js";
import type { ResolvedVisionImageSource, VisionInputProvenanceContext } from "../contracts/vision.js";
import { providerRouteDestination } from "../providers/provider-route-location.js";

export function visionInputProvenanceForTurn(input: {
  attachments?: readonly ChannelAttachment[];
  references?: readonly ContextReference[];
}): VisionInputProvenanceContext {
  return {
    attachmentPaths: (input.attachments ?? [])
      .filter(isCurrentTurnImageAttachment)
      .map((attachment) => attachment.localPath ?? attachment.path)
      .filter((path): path is string => typeof path === "string" && path.length > 0),
    explicitReferencePaths: (input.references ?? [])
      .filter((reference) => reference.kind === "file")
      .map((reference) => reference.target)
      .filter((path) => path.length > 0)
  };
}

function isCurrentTurnImageAttachment(attachment: ChannelAttachment): boolean {
  return (attachment.status === undefined || attachment.status === "ready") &&
    (attachment.kind === "image" || attachment.mimeType?.toLowerCase().startsWith("image/") === true);
}

export async function resolveVisionEgressSecurity(input: {
  source: ResolvedVisionImageSource;
  workspaceRoot: string;
  provenance?: VisionInputProvenanceContext;
  visionRoute: ResolvedAuxiliaryRoute;
  mainRoute?: ResolvedModelRoute;
  additionalRoutes?: readonly ResolvedModelRoute[];
}): Promise<ToolSecurityResolution | undefined> {
  return resolveVisionSourcesEgressSecurity({
    ...input,
    sources: [input.source]
  });
}

export async function resolveVisionSourcesEgressSecurity(input: {
  sources: readonly ResolvedVisionImageSource[];
  workspaceRoot: string;
  provenance?: VisionInputProvenanceContext;
  visionRoute: ResolvedAuxiliaryRoute;
  mainRoute?: ResolvedModelRoute;
  additionalRoutes?: readonly ResolvedModelRoute[];
}): Promise<ToolSecurityResolution | undefined> {
  const sourceProvenances = await Promise.all(input.sources.map((source) => classifySourceProvenance(
    source.canonicalPath,
    input.workspaceRoot,
    input.provenance
  )));
  const sourceProvenance = sourceProvenances.includes("agent-discovered")
    ? "agent-discovered"
    : sourceProvenances[0] ?? "agent-discovered";
  return resolveVisionArtifactEgressSecurity({
    sourceProvenance,
    sourceProvenances,
    sourceCount: input.sources.length,
    sensitivePath: input.sources.some((source) => isSensitiveVisionPath(source.canonicalPath)),
    visionRoute: input.visionRoute,
    mainRoute: input.mainRoute,
    additionalRoutes: input.additionalRoutes
  });
}

export function resolveVisionArtifactEgressSecurity(input: {
  sourceProvenance: SecurityDataEgressContext["sourceProvenance"];
  sourceProvenances?: readonly SecurityDataEgressContext["sourceProvenance"][];
  sourceCount?: number;
  sensitivePath: boolean;
  visionRoute: ResolvedAuxiliaryRoute;
  mainRoute?: ResolvedModelRoute;
  additionalRoutes?: readonly ResolvedModelRoute[];
}): ToolSecurityResolution | undefined {
  const routes = possibleVisionRoutes(input.visionRoute, input.mainRoute, input.additionalRoutes);
  const destinations = [...new Set(routes.map(providerRouteDestination).filter(
    (destination) => destination.inference === "hosted"
  ).map((destination) => destination.key))].sort();
  if (destinations.length === 0) return undefined;

  return {
    riskClass: "external-side-effect",
    targetKey: `vision.analyze:hosted-egress:${destinations.map(encodeURIComponent).join(",")}`,
    targetSummary: `send ${input.sourceCount !== undefined && input.sourceCount > 1 ? `${input.sourceCount} images` : "an image"} to hosted vision destination${destinations.length === 1 ? "" : "s"}: ${destinations.join(", ")}`,
    dataEgress: {
      kind: "vision-image",
      inference: "hosted",
      sourceProvenance: input.sourceProvenance,
      ...(input.sourceProvenances === undefined ? {} : { sourceProvenances: input.sourceProvenances }),
      ...(input.sourceCount === undefined ? {} : { sourceCount: input.sourceCount }),
      sensitivePath: input.sensitivePath,
      destinations
    }
  };
}

function possibleVisionRoutes(
  visionRoute: ResolvedAuxiliaryRoute,
  mainRoute: ResolvedModelRoute | undefined,
  additionalRoutes: readonly ResolvedModelRoute[] | undefined
): ResolvedModelRoute[] {
  const routes = visionRoute.route === undefined ? [] : [visionRoute.route];
  if (visionRoute.fallbackToMain && mainRoute?.profile.supportsVision === true) routes.push(mainRoute);
  routes.push(...(additionalRoutes ?? []).filter((route) => route.profile.supportsVision));
  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = `${route.provider}\0${route.id}\0${route.baseUrl ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function classifySourceProvenance(
  canonicalSource: string,
  workspaceRoot: string,
  context: VisionInputProvenanceContext | undefined
): Promise<SecurityDataEgressContext["sourceProvenance"]> {
  if (await includesCanonicalPath(context?.attachmentPaths ?? [], canonicalSource, workspaceRoot)) {
    return "current-turn-attachment";
  }
  if (await includesCanonicalPath(context?.explicitReferencePaths ?? [], canonicalSource, workspaceRoot)) {
    return "explicit-reference";
  }
  if (await includesCanonicalPath(context?.browserArtifactPaths ?? [], canonicalSource, workspaceRoot)) {
    return "browser-artifact";
  }
  if (await includesCanonicalPath(context?.generatedArtifactPaths ?? [], canonicalSource, workspaceRoot)) {
    return "generated-artifact";
  }
  return "agent-discovered";
}

async function includesCanonicalPath(
  paths: readonly string[],
  canonicalSource: string,
  workspaceRoot: string
): Promise<boolean> {
  for (const path of paths) {
    const candidate = isAbsolute(path) ? path : resolve(workspaceRoot, path);
    const canonical = await realpath(candidate).catch(() => undefined);
    if (canonical === canonicalSource) return true;
  }
  return false;
}

export function isSensitiveVisionPath(path: string): boolean {
  const normalizedPath = path.toLowerCase();
  const segments = normalizedPath.split(/[\\/]+/u).filter(Boolean);
  const basename = segments.at(-1) ?? "";
  if (segments.some((segment) => [".ssh", ".aws", ".gnupg", ".git", "credentials"].includes(segment))) {
    return true;
  }
  return basename === ".env" || basename.startsWith(".env.") ||
    ["auth.json", "credentials.json", "secrets.json"].includes(basename) ||
    /\.(?:key|pem|p12|pfx)$/u.test(basename) || segments.some(
      (segment, index) => segment === ".config" && segments[index + 1] === "gcloud"
    );
}
