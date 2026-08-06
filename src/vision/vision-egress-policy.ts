import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ChannelAttachment } from "../contracts/channel.js";
import type { ContextReference } from "../contracts/context.js";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { ToolSecurityResolution } from "../contracts/tool.js";
import type { ResolvedVisionImageSource, VisionInputProvenanceContext } from "../contracts/vision.js";
import { getProviderDefaultBaseUrl } from "../providers/provider-metadata.js";

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
  const routes = possibleVisionRoutes(input.visionRoute, input.mainRoute, input.additionalRoutes);
  const destinations = [...new Set(routes.map(routeDestination).filter(
    (destination): destination is VisionDestination => destination !== undefined && destination.inference === "hosted"
  ).map((destination) => destination.key))].sort();
  if (destinations.length === 0) return undefined;

  const sourceProvenance = await classifySourceProvenance(
    input.source.canonicalPath,
    input.workspaceRoot,
    input.provenance
  );
  const sensitivePath = isSensitiveVisionPath(input.source.canonicalPath);
  return {
    riskClass: "external-side-effect",
    targetKey: `vision.analyze:hosted-egress:${destinations.map(encodeURIComponent).join(",")}`,
    targetSummary: `send an image to hosted vision destination${destinations.length === 1 ? "" : "s"}: ${destinations.join(", ")}`,
    dataEgress: {
      kind: "vision-image",
      inference: "hosted",
      sourceProvenance,
      sensitivePath,
      destinations
    }
  };
}

type VisionDestination = {
  inference: "local" | "hosted";
  key: string;
};

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

function routeDestination(route: ResolvedModelRoute): VisionDestination | undefined {
  const rawBaseUrl = route.baseUrl ?? getProviderDefaultBaseUrl(route.provider);
  if (rawBaseUrl === undefined) {
    return route.provider === "local"
      ? { inference: "local", key: "local@loopback" }
      : { inference: "hosted", key: `${route.provider}@provider-default` };
  }
  try {
    const url = new URL(rawBaseUrl);
    const hostname = url.hostname.toLowerCase();
    const local = hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const path = url.pathname.replace(/\/+$/u, "") || "/";
    return {
      inference: local ? "local" : "hosted",
      key: `${route.provider}@${url.origin}${path}`
    };
  } catch {
    return { inference: "hosted", key: `${route.provider}@custom-endpoint` };
  }
}

async function classifySourceProvenance(
  canonicalSource: string,
  workspaceRoot: string,
  context: VisionInputProvenanceContext | undefined
): Promise<"current-turn-attachment" | "explicit-reference" | "agent-discovered"> {
  if (await includesCanonicalPath(context?.attachmentPaths ?? [], canonicalSource, workspaceRoot)) {
    return "current-turn-attachment";
  }
  if (await includesCanonicalPath(context?.explicitReferencePaths ?? [], canonicalSource, workspaceRoot)) {
    return "explicit-reference";
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
