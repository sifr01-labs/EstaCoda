import type {
  AuxiliaryModelConfig,
  AuxiliaryModelSlotConfig,
  AuxiliaryModelSlotInput,
  AuxiliaryModelTask,
  ModelProfile,
  ProviderId,
  ProviderRoutePreferences,
  ResolvedAuxiliaryRoute,
  ResolvedModelRoute
} from "../contracts/provider.js";
import { ProviderRegistry } from "./provider-registry.js";
import { matchesPreferences, routeProvider } from "./provider-router.js";
import { inferModelProfile, resolveModelProfileFromCatalog } from "./model-catalog.js";

const taskCapabilityRequirements: Record<AuxiliaryModelTask, ProviderRoutePreferences> = {
  vision: { requireVision: true },
  compression: { requireStructuredOutput: true },
  assessor: { requireStructuredOutput: true },
  web_extract: { requireStructuredOutput: true },
  session_search: { requireStructuredOutput: true },
  mcp: { requireTools: true, requireStructuredOutput: true },
  memory_flush: { requireStructuredOutput: true },
  delegation: { requireTools: true },
  skills_library: { requireTools: true, requireStructuredOutput: true },
  title_generation: { requireStructuredOutput: true },
  curator: { requireStructuredOutput: true },
  memory_compaction: { requireStructuredOutput: true },
  profile_context: { requireStructuredOutput: true }
};

export function resolveAuxiliaryModelRoute(
  task: AuxiliaryModelTask,
  slotOrConfig: AuxiliaryModelSlotInput | AuxiliaryModelConfig | undefined,
  context: {
    mainRoute: ResolvedModelRoute;
    providerRegistry: ProviderRegistry;
    providerModels?: ModelProfile[];
  }
): ResolvedAuxiliaryRoute {
  const diagnostics: string[] = [];
  const requirements = taskCapabilityRequirements[task];
  if (requirements === undefined) {
    throw new Error(`Unsupported auxiliary model task '${String(task)}'`);
  }
  const slot = resolveEffectiveSlot(task, slotOrConfig);
  const executionFields = resolvedExecutionFields(slot);

  // 1. Disabled
  if (slot.enabled === false) {
    return {
      task,
      route: undefined,
      source: "disabled",
      fallbackToMain: false,
      ...executionFields,
      diagnostics: ["Slot is explicitly disabled"]
    };
  }

  // 2. Custom baseUrl
  if (slot.baseUrl !== undefined) {
    if (slot.id === undefined || slot.id.length === 0) {
      diagnostics.push("slot.baseUrl is set but slot.id is missing; custom routes require both baseUrl and id");
      return {
        task,
        route: undefined,
        source: "custom",
        fallbackToMain: false,
        ...executionFields,
        diagnostics
      };
    }

    const effectiveProvider = customRouteProvider(slot);
    const profile = inferModelProfile({ provider: effectiveProvider, model: slot.id });
    const route: ResolvedModelRoute = {
      provider: effectiveProvider,
      id: slot.id,
      profile,
      baseUrl: slot.baseUrl,
      apiKeyEnv: slot.apiKeyEnv,
      contextWindowTokens: slot.contextWindowTokens
    };

    const requirementFailure = visionRequirementFailure(task, route);
    if (requirementFailure !== undefined) {
      return {
        task,
        route: undefined,
        source: "custom",
        fallbackToMain: false,
        ...executionFields,
        diagnostics: [customRouteDiagnostic(effectiveProvider, slot.baseUrl), requirementFailure]
      };
    }

    return {
      task,
      route,
      source: "custom",
      fallbackToMain: computeFallbackToMain({ task, slot, mainRoute: context.mainRoute, source: "custom" }),
      ...executionFields,
      diagnostics: [customRouteDiagnostic(effectiveProvider, slot.baseUrl)]
    };
  }

  // 3. Main provider
  if (slot.provider === "main") {
    const requirementFailure = visionRequirementFailure(task, context.mainRoute);
    if (requirementFailure !== undefined) {
      return {
        task,
        route: undefined,
        source: "main",
        fallbackToMain: false,
        ...executionFields,
        diagnostics: [requirementFailure]
      };
    }

    return {
      task,
      route: context.mainRoute,
      source: "main",
      fallbackToMain: false,
      ...executionFields,
      diagnostics: ["Using main model route"]
    };
  }

  // 4-5. Explicit provider
  if (slot.provider !== undefined && slot.provider !== "auto") {
    const explicitProvider = slot.provider as ProviderId;
    const models = context.providerModels ?? [];

    if (slot.id !== undefined && slot.id.length > 0) {
      // Exact provider+id
      const profile = models.find((m) => m.provider === explicitProvider && m.id === slot.id)
        ?? inferModelProfile({ provider: explicitProvider, model: slot.id });

      const route: ResolvedModelRoute = {
        provider: explicitProvider,
        id: slot.id,
        profile,
        apiKeyEnv: slot.apiKeyEnv,
        contextWindowTokens: slot.contextWindowTokens
      };

      const requirementFailure = visionRequirementFailure(task, route);
      if (requirementFailure !== undefined) {
        return {
          task,
          route: undefined,
          source: "explicit",
          fallbackToMain: false,
          ...executionFields,
          diagnostics: [requirementFailure]
        };
      }

      return {
        task,
        route,
        source: "explicit",
        fallbackToMain: computeFallbackToMain({ task, slot, mainRoute: context.mainRoute, source: "explicit" }),
        ...executionFields,
        diagnostics: [`Explicit route ${explicitProvider}/${slot.id}`]
      };
    }

    // Best model on explicit provider
    const providerModels = models.filter((m) => m.provider === explicitProvider);
    const chosen = routeProvider(providerModels, requirements);

    if (chosen === undefined) {
      diagnostics.push(`No model on provider ${explicitProvider} matches task requirements`);
      return {
        task,
        route: undefined,
        source: "explicit",
        fallbackToMain: computeFallbackToMain({ task, slot, mainRoute: context.mainRoute, source: "explicit" }),
        ...executionFields,
        diagnostics
      };
    }

    const route: ResolvedModelRoute = {
      provider: explicitProvider,
      id: chosen.primary.id,
      profile: chosen.primary,
      apiKeyEnv: slot.apiKeyEnv,
      contextWindowTokens: slot.contextWindowTokens
    };

    return {
      task,
      route,
      source: "explicit",
      fallbackToMain: computeFallbackToMain({ task, slot, mainRoute: context.mainRoute, source: "explicit" }),
      ...executionFields,
      diagnostics: [`Best model on ${explicitProvider}: ${chosen.primary.id}`]
    };
  }

  // 6. Auto (slot.provider is "auto" or undefined)
  const mainSatisfies = matchesPreferences(context.mainRoute.profile, requirements);
  if (mainSatisfies) {
    return {
      task,
      route: context.mainRoute,
      source: "auto-main",
      fallbackToMain: computeFallbackToMain({ task, slot, mainRoute: context.mainRoute, source: "auto-main" }),
      ...executionFields,
      diagnostics: ["Main model satisfies task requirements"]
    };
  }

  const models = context.providerModels ?? [];
  const chosen = routeProvider(models, requirements);

  if (chosen === undefined) {
    diagnostics.push("No configured model matches task requirements; main model also unsuitable");
    return {
      task,
      route: undefined,
      source: "auto-configured",
      fallbackToMain: computeFallbackToMain({ task, slot, mainRoute: context.mainRoute, source: "auto-configured" }),
      ...executionFields,
      diagnostics
    };
  }

  const route: ResolvedModelRoute = {
    provider: chosen.primary.provider,
    id: chosen.primary.id,
    profile: chosen.primary,
    apiKeyEnv: slot.apiKeyEnv,
    contextWindowTokens: slot.contextWindowTokens
  };

  return {
    task,
    route,
    source: "auto-configured",
    fallbackToMain: computeFallbackToMain({ task, slot, mainRoute: context.mainRoute, source: "auto-configured" }),
    ...executionFields,
    diagnostics: [`Auto-selected ${chosen.primary.provider}/${chosen.primary.id}`]
  };
}

function customRouteProvider(slot: AuxiliaryModelSlotConfig): ProviderId {
  if (slot.provider !== undefined && slot.provider !== "auto" && slot.provider !== "main") {
    return slot.provider;
  }
  return "openai-compatible";
}

function customRouteDiagnostic(provider: ProviderId, baseUrl: string): string {
  if (provider === "openai-compatible") {
    return `Custom OpenAI-compatible route at ${baseUrl}`;
  }
  return `Custom route for ${provider} at ${baseUrl}`;
}

function resolvedExecutionFields(slot: AuxiliaryModelSlotConfig): Pick<ResolvedAuxiliaryRoute, "timeoutMs" | "maxConcurrency"> {
  return {
    ...(slot.timeoutMs !== undefined ? { timeoutMs: slot.timeoutMs } : {}),
    ...(slot.maxConcurrency !== undefined ? { maxConcurrency: slot.maxConcurrency } : {})
  };
}

function visionRequirementFailure(
  task: AuxiliaryModelTask,
  route: ResolvedModelRoute
): string | undefined {
  if (task !== "vision" || route.profile.supportsVision) {
    return undefined;
  }

  return `Route ${route.provider}/${route.id} does not satisfy vision task requirements: vision`;
}

function computeFallbackToMain(options: {
  task: AuxiliaryModelTask;
  slot: AuxiliaryModelSlotConfig;
  mainRoute: ResolvedModelRoute;
  source: ResolvedAuxiliaryRoute["source"];
}): boolean {
  if (options.task === "vision" && !options.mainRoute.profile.supportsVision) {
    return false;
  }

  if (options.slot.fallbackToMain !== undefined) {
    return options.slot.fallbackToMain;
  }

  if (options.source === "explicit" || options.source === "custom") {
    return false;
  }

  return options.task === "vision";
}

export async function resolveAllAuxiliaryRoutes(
  config: AuxiliaryModelConfig,
  context: {
    mainRoute: ResolvedModelRoute;
    providerRegistry: ProviderRegistry;
  }
): Promise<ResolvedAuxiliaryRoute[]> {
  const providerModels = await context.providerRegistry.listModels();
  const tasks = Object.keys(config).filter((task) => task !== "default") as AuxiliaryModelTask[];
  return tasks.map((task) =>
    resolveAuxiliaryModelRoute(task, config, {
      mainRoute: context.mainRoute,
      providerRegistry: context.providerRegistry,
      providerModels
    })
  );
}

function resolveEffectiveSlot(
  task: AuxiliaryModelTask,
  slotOrConfig: AuxiliaryModelSlotInput | AuxiliaryModelConfig | undefined
): AuxiliaryModelSlotConfig {
  if (isAuxiliaryModelConfigInput(slotOrConfig)) {
    const defaultSlot = normalizeAuxiliarySlotInput(slotOrConfig.default, "auxiliaryModels.default");
    const taskSlot = normalizeAuxiliarySlotInput(slotOrConfig[task], `auxiliaryModels.${task}`);
    return {
      ...(defaultSlot ?? {}),
      ...(taskSlot ?? {}),
      provider: taskSlot?.provider ?? defaultSlot?.provider ?? "auto",
      enabled: taskSlot?.enabled ?? defaultSlot?.enabled ?? true
    };
  }

  const slot = normalizeAuxiliarySlotInput(slotOrConfig, "auxiliaryModels.slot");
  return {
    ...(slot ?? {}),
    provider: slot?.provider ?? "auto",
    enabled: slot?.enabled ?? true
  };
}

function isAuxiliaryModelConfigInput(
  value: AuxiliaryModelSlotInput | AuxiliaryModelConfig | undefined
): value is AuxiliaryModelConfig {
  if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return "default" in value || Object.keys(value).some((key) => key in taskCapabilityRequirements);
}

function normalizeAuxiliarySlotInput(
  slot: AuxiliaryModelSlotInput | undefined,
  path: string
): AuxiliaryModelSlotConfig | undefined {
  if (slot === undefined) return undefined;
  if (typeof slot === "string") {
    return parseAuxiliaryModelShorthand(slot, path);
  }
  return slot;
}

function parseAuxiliaryModelShorthand(value: string, path: string): AuxiliaryModelSlotConfig {
  const slashIndex = value.indexOf("/");
  if (slashIndex < 0) {
    throw new Error(`${path} shorthand must be provider/model`);
  }
  const provider = value.slice(0, slashIndex);
  const id = value.slice(slashIndex + 1);
  if (provider.length === 0) {
    throw new Error(`${path} shorthand is missing provider before /`);
  }
  if (id.length === 0) {
    throw new Error(`${path} shorthand is missing model id after /`);
  }
  return { provider: provider as ProviderId, id };
}
