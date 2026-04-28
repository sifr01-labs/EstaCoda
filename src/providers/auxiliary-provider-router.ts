import type {
  AuxiliaryProviderConfig,
  AuxiliaryProviderRoute,
  AuxiliaryProviderTask,
  ModelProfile,
  ProviderRoutePreferences
} from "../contracts/provider.js";
import { routeProvider } from "./provider-router.js";

export const auxiliaryProviderTasks: readonly AuxiliaryProviderTask[] = [
  "main",
  "vision",
  "compression",
  "approval",
  "web_extract",
  "session_search",
  "skills_hub",
  "mcp",
  "memory_flush",
  "delegation"
];

export const defaultAuxiliaryProviderPreferences: Record<AuxiliaryProviderTask, ProviderRoutePreferences> = {
  main: {
    requireTools: true,
    preferFreeOrOpenWeights: true
  },
  vision: {
    requireVision: true,
    preferFreeOrOpenWeights: true
  },
  compression: {
    requireStructuredOutput: true,
    preferFreeOrOpenWeights: true
  },
  approval: {
    requireStructuredOutput: true,
    preferFreeOrOpenWeights: true
  },
  web_extract: {
    requireStructuredOutput: true,
    preferFreeOrOpenWeights: true
  },
  session_search: {
    requireStructuredOutput: true,
    preferFreeOrOpenWeights: true
  },
  skills_hub: {
    requireTools: true,
    requireStructuredOutput: true,
    preferFreeOrOpenWeights: true
  },
  mcp: {
    requireTools: true,
    requireStructuredOutput: true,
    preferFreeOrOpenWeights: true
  },
  memory_flush: {
    requireStructuredOutput: true,
    preferFreeOrOpenWeights: true
  },
  delegation: {
    requireTools: true,
    preferFreeOrOpenWeights: true
  }
};

export class AuxiliaryProviderRouter {
  readonly #models: ModelProfile[];
  readonly #config: AuxiliaryProviderConfig;

  constructor(options: {
    models: ModelProfile[];
    config?: AuxiliaryProviderConfig;
  }) {
    this.#models = options.models;
    this.#config = options.config ?? {};
  }

  resolve(task: AuxiliaryProviderTask): AuxiliaryProviderRoute {
    const preferences = mergePreferences(defaultAuxiliaryProviderPreferences[task], this.#config[task]);

    return {
      task,
      preferences,
      route: routeProvider(this.#models, preferences)
    };
  }

  resolveAll(): AuxiliaryProviderRoute[] {
    return auxiliaryProviderTasks.map((task) => this.resolve(task));
  }
}

export function summarizeAuxiliaryRoutes(routes: AuxiliaryProviderRoute[]): string {
  return routes
    .map((route) =>
      `${route.task}:${route.route === undefined ? "unavailable" : `${route.route.primary.provider}/${route.route.primary.id}`}`
    )
    .join(", ");
}

function mergePreferences(
  defaults: ProviderRoutePreferences,
  override: ProviderRoutePreferences | undefined
): ProviderRoutePreferences {
  return {
    ...defaults,
    ...(override ?? {}),
    providerOrder: override?.providerOrder ?? defaults.providerOrder,
    providerAllowlist: override?.providerAllowlist ?? defaults.providerAllowlist,
    providerBlocklist: override?.providerBlocklist ?? defaults.providerBlocklist
  };
}
