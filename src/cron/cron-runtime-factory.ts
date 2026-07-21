import type { SessionDB } from "../contracts/session.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { createRuntime, type Runtime, type RuntimeOptions } from "../runtime/create-runtime.js";
import { resolveTokens } from "../theme/token-resolver.js";
import type { CronRunContext } from "./cron-runner.js";
import type { CronJob } from "./cron-store.js";
import { CRON_FORCED_DISABLED_TOOLSETS, resolveCronModelRoute } from "./cron-runtime-validation.js";

export type CronRuntimeFactory = (options: RuntimeOptions) => Promise<Runtime>;

export async function createIsolatedCronRuntime(input: {
  job: CronJob;
  context: CronRunContext;
  workspaceRoot: string;
  homeDir?: string;
  profileId: string;
  sessionDb?: SessionDB;
  createRuntime?: CronRuntimeFactory;
}): Promise<Runtime> {
  const effectiveWorkspaceRoot = input.context.workspaceRoot ?? input.workspaceRoot;
  const latestConfig = await loadRuntimeConfig({
    workspaceRoot: effectiveWorkspaceRoot,
    homeDir: input.homeDir,
    profileId: input.profileId
  });
  const factory = input.createRuntime ?? createRuntime;
  const primaryModelRoute = await resolveCronModelRoute({ job: input.job, latestConfig });

  return factory({
    tokens: resolveTokens("standard", "dark", "kemetBlue"),
    model: primaryModelRoute?.profile ?? latestConfig.model,
    primaryModelRoute,
    modelFallbackRoutes: latestConfig.modelFallbackRoutes,
    workspaceRoot: effectiveWorkspaceRoot,
    homeDir: input.homeDir,
    profileId: input.profileId,
    sessionId: input.context.sessionId,
    sessionDb: input.sessionDb,
    externalSkillRoots: latestConfig.skills.externalDirs,
    skillAutonomy: latestConfig.skills.autonomy,
    skillConfig: latestConfig.skills.config,
    ui: latestConfig.ui,
    agentProfile: latestConfig.profile,
    providerRegistry: latestConfig.providerRegistry,
    providerConfigs: latestConfig.config.providers,
    auxiliaryModels: latestConfig.auxiliaryModels,
    compression: latestConfig.compression,
    budgets: latestConfig.budgets,
    memory: latestConfig.memory,
    externalMemory: latestConfig.externalMemory,
    mcpServers: latestConfig.mcp.servers,
    browser: latestConfig.browser,
    imageGen: latestConfig.imageGen,
    tts: latestConfig.tts,
    stt: latestConfig.stt,
    telegramReady: latestConfig.channels.telegram.ready,
    enableWebNetwork: latestConfig.web.enableNetwork,
    webMaxContentChars: latestConfig.web.maxContentChars,
    webConfig: {
      backend: latestConfig.web.backend,
      searchBackend: latestConfig.web.searchBackend,
      extractBackend: latestConfig.web.extractBackend,
      crawlBackend: latestConfig.web.crawlBackend,
      brave: latestConfig.web.brave
    },
    securityConfig: {
      allowPrivateUrls: latestConfig.security.allowPrivateUrls,
      websiteBlocklist: latestConfig.security.websiteBlocklist
    },
    securityMode: latestConfig.security.approvalMode,
    securityAssessor: latestConfig.security.assessor,
    workspaceTrusted: input.context.trustedWorkspace ?? false,
    disableCronTools: true,
    disabledToolsets: [...CRON_FORCED_DISABLED_TOOLSETS],
    enabledToolsets: input.job.enabledToolsets,
  });
}
