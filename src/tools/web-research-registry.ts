import { braveProvider } from "./web-research-providers/brave-provider.js";
import { ddgsProvider } from "./web-research-providers/ddgs-provider.js";
import { exaProvider } from "./web-research-providers/exa-provider.js";
import { fetchExtractProvider } from "./web-research-providers/fetch-extract-provider.js";
import { firecrawlProvider } from "./web-research-providers/firecrawl-provider.js";
import { parallelProvider } from "./web-research-providers/parallel-provider.js";
import { searxngProvider } from "./web-research-providers/searxng-provider.js";
import { tavilyProvider } from "./web-research-providers/tavily-provider.js";
import type { ProviderAvailability, WebResearchCapability, WebResearchConfig, WebResearchProvider } from "./web-research-provider.js";

const providers = new Map<string, WebResearchProvider>();
const AUTO_DETECT_ORDER = ["firecrawl", "parallel", "tavily", "exa", "searxng", "brave", "ddgs"] as const;

export type WebResearchProviderSelection = {
  provider?: WebResearchProvider;
  providerName?: string;
  availability: ProviderAvailability;
  explicit: boolean;
  fallback: boolean;
};

export function registerWebResearchProvider(provider: WebResearchProvider): void {
  providers.set(provider.name, provider);
}

export function listWebResearchProviders(): WebResearchProvider[] {
  return Array.from(providers.values());
}

export function getWebResearchProvider(name: string): WebResearchProvider | undefined {
  return providers.get(name);
}

export function resetWebResearchProvidersForTest(): void {
  providers.clear();
}

export function registerDefaultWebResearchProviders(): void {
  for (const provider of [
    firecrawlProvider,
    parallelProvider,
    tavilyProvider,
    exaProvider,
    searxngProvider,
    braveProvider,
    ddgsProvider,
    fetchExtractProvider
  ]) {
    registerWebResearchProvider(provider);
  }
}

export async function selectWebResearchProvider(
  capability: WebResearchCapability,
  config: WebResearchConfig = {}
): Promise<WebResearchProviderSelection> {
  const explicitName = explicitProviderName(capability, config);
  if (explicitName !== undefined) {
    return selectExplicitProvider(capability, explicitName, config);
  }

  for (const name of AUTO_DETECT_ORDER) {
    const provider = providers.get(name);
    if (provider === undefined || provider.capabilities[capability] !== true) {
      continue;
    }

    const configuredProvider = configureProvider(provider, config);
    const availability = await configuredProvider.getAvailability();
    if (availability.available) {
      return { provider: configuredProvider, providerName: configuredProvider.name, availability, explicit: false, fallback: false };
    }
  }

  if (capability === "extract") {
    const provider = providers.get(fetchExtractProvider.name);
    return {
      provider,
      providerName: provider?.name ?? fetchExtractProvider.name,
      availability: { available: true },
      explicit: false,
      fallback: true
    };
  }

  return {
    availability: { available: false, reason: `No available web ${capability} provider configured.` },
    explicit: false,
    fallback: false
  };
}

function explicitProviderName(capability: WebResearchCapability, config: WebResearchConfig): string | undefined {
  if (capability === "search" && config.searchBackend !== undefined) return config.searchBackend;
  if (capability === "extract" && config.extractBackend !== undefined) return config.extractBackend;
  if (capability === "crawl" && config.crawlBackend !== undefined) return config.crawlBackend;
  return config.backend;
}

async function selectExplicitProvider(
  capability: WebResearchCapability,
  name: string,
  config: WebResearchConfig
): Promise<WebResearchProviderSelection> {
  const provider = providers.get(name);
  if (provider === undefined) {
    return {
      providerName: name,
      availability: { available: false, reason: `Unknown web research provider: ${name}.` },
      explicit: true,
      fallback: false
    };
  }

  const configuredProvider = configureProvider(provider, config);
  if (configuredProvider.capabilities[capability] !== true) {
    return {
      provider: configuredProvider,
      providerName: configuredProvider.name,
      availability: { available: false, reason: `Provider ${configuredProvider.name} does not support web ${capability}.` },
      explicit: true,
      fallback: false
    };
  }

  return {
    provider: configuredProvider,
    providerName: configuredProvider.name,
    availability: await configuredProvider.getAvailability(),
    explicit: true,
    fallback: false
  };
}

function configureProvider(provider: WebResearchProvider, config: WebResearchConfig): WebResearchProvider {
  return provider.configure?.({ config }) ?? provider;
}
