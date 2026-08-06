import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { ProviderUsage, ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { ToolResult } from "../contracts/tool.js";
import { resolveAuxiliaryModelRoute } from "../providers/auxiliary-model-resolver.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { getProviderMetadata } from "../providers/provider-metadata.js";
import { providerRouteDestination } from "../providers/provider-route-location.js";
import { estimateProviderUsage } from "../providers/provider-usage-estimator.js";
import { resolveRuntimeCredential } from "../providers/runtime-credential-resolver.js";
import { analyzeImageWithVision } from "../tools/vision-tools.js";
import {
  loadVisionAnalysisVerificationFixture,
  VISION_ANALYSIS_VERIFICATION_TEXT,
} from "./vision-analysis-verification.js";

export type VisionRouteVerificationStatus =
  | "configuration-blocked"
  | "credential-blocked"
  | "consent-required"
  | "passed"
  | "failed";

export type VisionRouteVerificationPlan = {
  readonly provider?: string;
  readonly model?: string;
  readonly routeSource: ResolvedAuxiliaryRoute["source"];
  readonly dispatch: "native" | "auxiliary" | "unavailable";
  readonly inference: "local" | "hosted" | "unavailable";
  readonly hostedDestinations: readonly string[];
  readonly credentialReady: boolean;
  readonly credentialDiagnostic?: string;
  readonly visionCapable: boolean;
  readonly configurationFingerprint: string;
  readonly diagnostics: readonly string[];
  readonly route?: ResolvedModelRoute;
  readonly auxiliaryRoute: ResolvedAuxiliaryRoute;
};

export type VisionRouteVerificationReport = Omit<VisionRouteVerificationPlan, "route" | "auxiliaryRoute"> & {
  readonly status: VisionRouteVerificationStatus;
  readonly hostedConsent: "not-required" | "missing" | "granted";
  readonly fixtureSha256: string;
  readonly expectedEnglishDetected: boolean;
  readonly expectedArabicDetected: boolean;
  readonly latencyMs: number;
  readonly estimatedCostUsd?: number;
  readonly actualCostUsd?: number;
  readonly pricingComplete: boolean;
  readonly normalizedImage: {
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
  };
  readonly fallbackUsed: boolean;
  readonly attempts: readonly string[];
  readonly error?: string;
};

export type RunVisionRouteVerificationOptions = {
  readonly config: LoadedRuntimeConfig;
  readonly consentHosted?: boolean;
  readonly execute?: (input: {
    readonly plan: VisionRouteVerificationPlan & { readonly route: ResolvedModelRoute };
    readonly fixturePath: string;
  }) => Promise<ToolResult>;
};

export async function buildVisionRouteVerificationPlan(
  config: LoadedRuntimeConfig
): Promise<VisionRouteVerificationPlan> {
  const providerModels = await config.providerRegistry.listModels();
  const auxiliaryRoute = resolveAuxiliaryModelRoute("vision", config.auxiliaryModels, {
    mainRoute: config.primaryModelRoute,
    providerRegistry: config.providerRegistry,
    providerModels,
  });
  const route = auxiliaryRoute.route;
  const routeSource = auxiliaryRoute.source;
  const dispatch = route === undefined
    ? "unavailable"
    : routeSource === "main" || routeSource === "auto-main"
      ? "native"
      : "auxiliary";
  const inference = route === undefined ? "unavailable" : providerRouteDestination(route).inference;
  const possibleRoutes = route === undefined
    ? []
    : [
        route,
        ...(auxiliaryRoute.fallbackToMain && config.primaryModelRoute.profile.supportsVision
          ? [config.primaryModelRoute]
          : []),
        ...(dispatch === "native"
          ? config.modelFallbackRoutes.filter((fallback) => fallback.profile.supportsVision)
          : []),
      ];
  const hostedDestinations = [...new Set(possibleRoutes
    .map(providerRouteDestination)
    .filter((destination) => destination.inference === "hosted")
    .map((destination) => destination.key))].sort();
  const credential = route === undefined
    ? { diagnostic: { ok: false, message: "No executable vision route is configured." } }
    : await resolveRuntimeCredential({
        providerId: route.provider,
        route: { apiKeyEnv: route.apiKeyEnv, authMethod: route.authMethod },
        providerConfig: config.config.providers?.[route.provider],
        metadata: getProviderMetadata(route.provider),
        homeDir: config.homeDir,
        profileId: config.profileId,
        readOnly: true,
      });
  const fingerprintInput = {
    profileId: config.profileId,
    source: routeSource,
    dispatch,
    inference,
    hostedDestinations,
    route: route === undefined ? undefined : {
      provider: route.provider,
      model: route.id,
      baseUrl: route.baseUrl,
      apiMode: route.apiMode,
      authMethod: route.authMethod,
      apiKeyEnv: route.apiKeyEnv,
      supportsVision: route.profile.supportsVision,
    },
    fallbackToMain: auxiliaryRoute.fallbackToMain,
    timeoutMs: auxiliaryRoute.timeoutMs,
    maxConcurrency: auxiliaryRoute.maxConcurrency,
  };

  return {
    ...(route === undefined ? {} : { provider: route.provider, model: route.id, route }),
    routeSource,
    dispatch,
    inference,
    hostedDestinations,
    credentialReady: credential.diagnostic.ok,
    ...(credential.diagnostic.message === undefined ? {} : { credentialDiagnostic: credential.diagnostic.message }),
    visionCapable: route?.profile.supportsVision === true,
    configurationFingerprint: createHash("sha256")
      .update(JSON.stringify(fingerprintInput))
      .digest("hex"),
    diagnostics: auxiliaryRoute.diagnostics,
    auxiliaryRoute,
  };
}

export async function runVisionRouteVerification(
  options: RunVisionRouteVerificationOptions
): Promise<VisionRouteVerificationReport> {
  const fixture = await loadVisionAnalysisVerificationFixture();
  const plan = await buildVisionRouteVerificationPlan(options.config);
  const base = {
    provider: plan.provider,
    model: plan.model,
    routeSource: plan.routeSource,
    dispatch: plan.dispatch,
    inference: plan.inference,
    hostedDestinations: plan.hostedDestinations,
    credentialReady: plan.credentialReady,
    credentialDiagnostic: plan.credentialDiagnostic,
    visionCapable: plan.visionCapable,
    configurationFingerprint: plan.configurationFingerprint,
    diagnostics: plan.diagnostics,
    fixtureSha256: fixture.sha256,
    expectedEnglishDetected: false,
    expectedArabicDetected: false,
    latencyMs: 0,
    pricingComplete: false,
    normalizedImage: { width: fixture.width, height: fixture.height, bytes: fixture.bytes },
    fallbackUsed: false,
    attempts: [] as string[],
  };

  if (plan.route === undefined || !plan.visionCapable) {
    return {
      ...base,
      status: "configuration-blocked",
      hostedConsent: "not-required",
      error: plan.diagnostics.join("; ") || "No executable vision-capable route is configured.",
    };
  }
  if (!plan.credentialReady) {
    return {
      ...base,
      status: "credential-blocked",
      hostedConsent: plan.hostedDestinations.length > 0 ? "missing" : "not-required",
      error: plan.credentialDiagnostic ?? "The configured route credential is not ready.",
    };
  }
  if (plan.hostedDestinations.length > 0 && options.consentHosted !== true) {
    return {
      ...base,
      status: "consent-required",
      hostedConsent: "missing",
      error: "Hosted verification was not run. Re-run with explicit hosted-processing consent.",
    };
  }

  const startedAt = Date.now();
  const execute = options.execute ?? ((input) => executeVerification(options.config, input));
  const result = await execute({ plan: { ...plan, route: plan.route }, fixturePath: fixture.path });
  const latencyMs = numericMetadata(result.metadata?.latencyMs) ?? Math.max(0, Date.now() - startedAt);
  const usage = providerUsageFromMetadata(result.metadata?.usage);
  const actualProvider = typeof result.metadata?.provider === "string" ? result.metadata.provider : undefined;
  const actualModel = typeof result.metadata?.model === "string" ? result.metadata.model : undefined;
  const costRoute = [plan.route, options.config.primaryModelRoute].find((route) =>
    route.provider === actualProvider && route.id === actualModel
  ) ?? plan.route;
  const cost = estimateProviderUsage(usage, costRoute, 0);
  const normalization = recordValue(result.metadata?.normalization);
  const normalizedOutput = recordValue(normalization?.output);
  const content = result.content;
  const expectedEnglishDetected = normalizedIncludes(content, VISION_ANALYSIS_VERIFICATION_TEXT.en);
  const expectedArabicDetected = normalizedIncludes(content, VISION_ANALYSIS_VERIFICATION_TEXT.ar);
  const attempts = Array.isArray(result.metadata?.attempts)
    ? result.metadata.attempts.filter((value): value is string => typeof value === "string")
    : [];
  const fallback = recordValue(result.metadata?.fallback);

  return {
    ...base,
    status: result.ok && expectedEnglishDetected && expectedArabicDetected ? "passed" : "failed",
    hostedConsent: plan.hostedDestinations.length > 0 ? "granted" : "not-required",
    expectedEnglishDetected,
    expectedArabicDetected,
    latencyMs,
    ...(cost.usageComplete || cost.estimatedCostUsd > 0 ? { estimatedCostUsd: cost.estimatedCostUsd } : {}),
    pricingComplete: cost.pricingComplete,
    normalizedImage: {
      width: numericMetadata(normalizedOutput?.width) ?? numericMetadata(result.metadata?.width) ?? fixture.width,
      height: numericMetadata(normalizedOutput?.height) ?? numericMetadata(result.metadata?.height) ?? fixture.height,
      bytes: numericMetadata(normalizedOutput?.bytes) ?? numericMetadata(result.metadata?.bytes) ?? fixture.bytes,
    },
    fallbackUsed: fallback?.used === true,
    attempts,
    ...(result.ok && expectedEnglishDetected && expectedArabicDetected
      ? {}
      : {
          error: result.ok
            ? "The provider responded, but the expected English and Arabic verification text was not both detected."
            : result.content,
        }),
  };
}

async function executeVerification(
  config: LoadedRuntimeConfig,
  input: {
    readonly plan: VisionRouteVerificationPlan & { readonly route: ResolvedModelRoute };
    readonly fixturePath: string;
  }
): Promise<ToolResult> {
  const providerExecutor = new ProviderExecutor({
    registry: config.providerRegistry,
    homeDir: config.homeDir,
    profileId: config.profileId,
    allowUnenforcedAttributedSpend: true,
    readOnlyCredentials: true,
  });
  try {
    // A native route normally returns an ephemeral continuation for the main agent loop.
    // Verification has no continuation loop, so execute that same selected route directly.
    const directMainRoute = input.plan.dispatch === "native" ? undefined : config.primaryModelRoute;
    const directAuxiliaryRoute = input.plan.dispatch === "native"
      ? { ...input.plan.auxiliaryRoute, route: input.plan.route, fallbackToMain: false }
      : { ...input.plan.auxiliaryRoute, route: input.plan.route };
    return await analyzeImageWithVision({
      workspaceRoot: dirname(input.fixturePath),
      allowedRoots: [dirname(input.fixturePath)],
      profileId: config.profileId,
      visionAuxiliaryRoute: directAuxiliaryRoute,
      mainRoute: directMainRoute,
      mainFallbackRoutes: config.modelFallbackRoutes,
      providerExecutor,
    }, {
      path: input.fixturePath,
      mode: "ocr",
      detail: "high",
      output: "concise",
      prompt: "Transcribe all visible English and Arabic text exactly. Preserve the logical reading order and every LTR token.",
    });
  } finally {
    await providerExecutor.dispose();
  }
}

export function renderVisionRouteVerification(report: VisionRouteVerificationReport): string {
  const money = report.estimatedCostUsd === undefined
    ? "unavailable"
    : `$${report.estimatedCostUsd.toFixed(6)}${report.pricingComplete ? "" : " (partial estimate)"}`;
  return [
    "Vision Analysis verification",
    `Status: ${report.status}`,
    `Route: ${report.provider === undefined ? "unavailable" : `${report.provider}/${report.model}`}`,
    `Route selection: ${report.routeSource}`,
    `Dispatch: ${report.dispatch}`,
    `Processing: ${report.inference}`,
    `Possible hosted destinations: ${report.hostedDestinations.length === 0 ? "none" : report.hostedDestinations.join(", ")}`,
    `Hosted consent: ${report.hostedConsent}`,
    `Credential readiness: ${report.credentialReady ? "ready" : "blocked"}`,
    `Vision capability: ${report.visionCapable ? "yes" : "no"}`,
    `English text detected: ${report.expectedEnglishDetected ? "yes" : "no"}`,
    `Arabic text detected: ${report.expectedArabicDetected ? "yes" : "no"}`,
    `Normalized image: ${report.normalizedImage.width}x${report.normalizedImage.height}, ${report.normalizedImage.bytes} bytes`,
    `Latency: ${report.latencyMs} ms`,
    `Approximate cost: ${money}`,
    `Fallback used: ${report.fallbackUsed ? "yes" : "no"}`,
    `Configuration fingerprint: ${report.configurationFingerprint}`,
    `Fixture SHA-256: ${report.fixtureSha256}`,
    ...(report.error === undefined ? [] : [`Result: ${report.error}`]),
  ].join("\n");
}

function providerUsageFromMetadata(value: unknown): ProviderUsage | undefined {
  const record = recordValue(value);
  if (record === undefined) return undefined;
  const usage: ProviderUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    const metric = numericMetadata(record[key]);
    if (metric !== undefined) usage[key] = metric;
  }
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function numericMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedIncludes(content: string, expected: string): boolean {
  return content.normalize("NFKC").toLocaleLowerCase().includes(expected.normalize("NFKC").toLocaleLowerCase());
}
