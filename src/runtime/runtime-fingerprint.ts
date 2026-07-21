import { join } from "node:path";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { ResolvedModelRoute } from "../contracts/provider.js";
import type { SecurityApprovalMode } from "../contracts/security.js";
import type { ToolsetName } from "../contracts/tool.js";
import type { ResolvedTokens } from "../contracts/ui-tokens.js";

export type RuntimeFingerprint = {
  // ── Identity / model ──
  modelProvider: string;
  modelId: string;
  modelContextWindowTokens: number;
  primaryModelRouteHash?: string;
  modelFallbackRoutesHash?: string;
  profileId: string;

  // ── Security (config-bound) ──
  securityMode: SecurityApprovalMode;
  securityAssessorEnabled: boolean;
  securityAssessorProvider?: string;
  securityAssessorModel?: string;
  securityAssessorTimeoutMs: number;
  securityUrlPolicyHash: string;
  approvalControllerPresent: boolean;
  explicitSecurityPolicyPresent: boolean;

  // ── Workspace / filesystem ──
  workspaceRoot: string;
  homeDir: string;
  localSkillsRoot: string;
  userMemoryRoot?: string;
  projectMemoryRoot?: string;
  trustStorePath: string;

  // ── Tools / capabilities ──
  disabledToolsets: string[];
  mcpServersHash: string;
  browserHash: string;
  enableWebNetwork: boolean;
  webMaxContentChars: number;
  webResearchHash: string;
  compressionConfigHash: string;
  memoryRetrievalConfigHash: string;
  externalMemoryConfigHash: string;
  delegationConfigHash: string;
  budgetsHash?: string;
  disableCronTools: boolean;

  // ── Skills ──
  skillAutonomy: string;
  skillConfigHash: string;
  externalSkillRoots: string[];

  // ── UI / profile ──
  uiLanguage: string;
  uiFlavor: string;
  activityLabels: string;
  runtimeUiIdentity?: string;
  agentProfileMode: string;
  agentResponseLanguage: string;

  // ── Media / auxiliary ──
  auxiliaryModelsHash?: string;
  imageGenHash: string;
  ttsHash: string;
  sttHash: string;
  telegramReady: boolean;
  currentPlatform: string;
};

export function computeRuntimeFingerprint(
  config: LoadedRuntimeConfig,
  options: {
    profileId: string;
    workspaceRoot: string;
    homeDir: string;
    localSkillsRoot: string;
    userMemoryRoot?: string;
    projectMemoryRoot?: string;
    trustStorePath?: string;
    disabledToolsets: ToolsetName[];
    disableCronTools: boolean;
    approvalControllerPresent: boolean;
    explicitSecurityPolicyPresent: boolean;
    currentPlatform: string;
    tokens?: ResolvedTokens;
  }
): RuntimeFingerprint {
  const runtimeUiIdentity = fingerprintRuntimeUiIdentity(options);
  return {
    modelProvider: config.model.provider,
    modelId: config.model.id,
    modelContextWindowTokens: config.model.contextWindowTokens,
    primaryModelRouteHash: config.primaryModelRoute
      ? stableJsonHash(fingerprintRoute(config.primaryModelRoute))
      : undefined,
    modelFallbackRoutesHash: config.modelFallbackRoutes
      ? stableJsonHash(config.modelFallbackRoutes.map(fingerprintRoute))
      : undefined,
    profileId: options.profileId,
    securityMode: config.security.approvalMode,
    securityAssessorEnabled: config.security.assessor.enabled,
    securityAssessorProvider: config.security.assessor.provider,
    securityAssessorModel: config.security.assessor.model,
    securityAssessorTimeoutMs: config.security.assessor.timeoutMs,
    securityUrlPolicyHash: stableJsonHash({
      allowPrivateUrls: config.security.allowPrivateUrls,
      websiteBlocklist: config.security.websiteBlocklist,
    }),
    approvalControllerPresent: options.approvalControllerPresent,
    explicitSecurityPolicyPresent: options.explicitSecurityPolicyPresent,
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir,
    localSkillsRoot: options.localSkillsRoot,
    userMemoryRoot: options.userMemoryRoot,
    projectMemoryRoot: options.projectMemoryRoot,
    trustStorePath: options.trustStorePath ?? join(options.homeDir, ".estacoda", "trust.json"),
    disabledToolsets: [...options.disabledToolsets].sort(),
    mcpServersHash: stableJsonHash(config.mcp.servers),
    browserHash: stableJsonHash(config.browser),
    enableWebNetwork: config.web.enableNetwork,
    webMaxContentChars: config.web.maxContentChars ?? 0,
    webResearchHash: stableJsonHash({
      backend: config.web.backend,
      searchBackend: config.web.searchBackend,
      extractBackend: config.web.extractBackend,
      crawlBackend: config.web.crawlBackend
    }),
    compressionConfigHash: stableJsonHash(config.compression),
    memoryRetrievalConfigHash: stableJsonHash(config.memory),
    externalMemoryConfigHash: stableJsonHash(config.externalMemory),
    delegationConfigHash: stableJsonHash(config.delegation),
    budgetsHash: stableJsonHash(config.budgets ?? {}),
    disableCronTools: options.disableCronTools,
    skillAutonomy: config.skills.autonomy,
    skillConfigHash: stableJsonHash(config.skills.config),
    externalSkillRoots: [...config.skills.externalDirs].sort(),
    uiLanguage: config.ui.language,
    uiFlavor: config.ui.flavor,
    activityLabels: config.ui.activityLabels,
    ...(runtimeUiIdentity !== undefined ? { runtimeUiIdentity } : {}),
    agentProfileMode: config.profile.mode,
    agentResponseLanguage: config.profile.responseLanguage,
    auxiliaryModelsHash: config.auxiliaryModels
      ? stableJsonHash(config.auxiliaryModels)
      : undefined,
    imageGenHash: stableJsonHash(config.imageGen),
    ttsHash: stableJsonHash(config.tts),
    sttHash: stableJsonHash(config.stt),
    telegramReady: config.channels.telegram.ready,
    currentPlatform: options.currentPlatform
  };
}

function fingerprintRuntimeUiIdentity(options: {
  tokens?: ResolvedTokens;
}): string | undefined {
  if (options.tokens !== undefined) {
    return `${options.tokens.skin}-${options.tokens.theme}`;
  }
  return undefined;
}

function fingerprintRoute(route: ResolvedModelRoute): Record<string, unknown> {
  return {
    provider: route.provider,
    id: route.id,
    baseUrl: route.baseUrl,
    apiKeyEnv: route.apiKeyEnv,
    apiMode: route.apiMode,
    contextWindowTokens: route.contextWindowTokens,
    maxTokens: route.maxTokens,
    timeoutMs: route.timeoutMs,
    staleTimeoutMs: route.staleTimeoutMs,
  };
}

export function stableJsonHash(value: unknown): string {
  const sorted = sortKeysRecursive(value);
  return cyrb53(JSON.stringify(sorted));
}

function sortKeysRecursive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysRecursive);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysRecursive((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function cyrb53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(16, "0");
}
