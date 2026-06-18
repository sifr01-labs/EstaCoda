import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedPythonCapabilityInstallStatus } from "../python-env/capability-manager.js";
import { DDGS_CAPABILITY_ID } from "../python-env/capability-registry.js";
import {
  getWebResearchProvider,
  listWebResearchProviders,
  registerDefaultWebResearchProviders,
  registerWebResearchProvider,
  resetWebResearchProvidersForTest,
  selectWebResearchProvider
} from "./web-research-registry.js";
import type { WebResearchProvider } from "./web-research-provider.js";

function provider(input: Partial<WebResearchProvider> & Pick<WebResearchProvider, "name">): WebResearchProvider {
  return {
    displayName: input.name,
    capabilities: { search: true },
    getAvailability: () => ({ available: true }),
    ...input
  };
}

describe("web research provider registry", () => {
  afterEach(() => {
    resetWebResearchProvidersForTest();
    vi.unstubAllEnvs();
  });

  it("registers, lists, gets, and resets providers", () => {
    const custom = provider({ name: "custom" });

    registerWebResearchProvider(custom);

    expect(listWebResearchProviders()).toEqual([custom]);
    expect(getWebResearchProvider("custom")).toBe(custom);

    resetWebResearchProvidersForTest();

    expect(listWebResearchProviders()).toEqual([]);
  });

  it("returns explicit unavailable providers with their reason", async () => {
    registerWebResearchProvider(provider({
      name: "offline",
      getAvailability: () => ({ available: false, reason: "offline for test" })
    }));

    await expect(selectWebResearchProvider("search", { searchBackend: "offline" })).resolves.toMatchObject({
      providerName: "offline",
      explicit: true,
      fallback: false,
      availability: {
        available: false,
        reason: "offline for test"
      }
    });
  });

  it("returns deterministic reasons for unknown providers and capability mismatches", async () => {
    registerWebResearchProvider(provider({
      name: "search-only",
      capabilities: { search: true }
    }));

    await expect(selectWebResearchProvider("search", { searchBackend: "missing" })).resolves.toMatchObject({
      providerName: "missing",
      explicit: true,
      availability: {
        available: false,
        reason: "Unknown web research provider: missing."
      }
    });
    await expect(selectWebResearchProvider("crawl", { crawlBackend: "search-only" })).resolves.toMatchObject({
      providerName: "search-only",
      explicit: true,
      availability: {
        available: false,
        reason: "Provider search-only does not support web crawl."
      }
    });
  });

  it("auto-detect skips unavailable providers and reports no backend for search", async () => {
    registerDefaultWebResearchProviders();

    const selection = await selectWebResearchProvider("search", {});

    expect(selection).toMatchObject({
      explicit: false,
      fallback: false,
      availability: {
        available: false,
        reason: "No available web search provider configured."
      }
    });
  });

  it("selects extract fallback only when extract is not explicit", async () => {
    registerDefaultWebResearchProviders();

    await expect(selectWebResearchProvider("extract", {})).resolves.toMatchObject({
      providerName: "fetch",
      explicit: false,
      fallback: true,
      availability: { available: true }
    });
    await expect(selectWebResearchProvider("extract", { extractBackend: "firecrawl" })).resolves.toMatchObject({
      providerName: "firecrawl",
      explicit: true,
      fallback: false,
      availability: {
        available: false,
        reason: "FIRECRAWL_API_KEY is missing."
      }
    });
  });

  it("hosted provider stubs remain unavailable with missing and present env", async () => {
    registerDefaultWebResearchProviders();

    expect(await getWebResearchProvider("firecrawl")?.getAvailability()).toEqual({
      available: false,
      reason: "FIRECRAWL_API_KEY is missing."
    });
    vi.stubEnv("FIRECRAWL_API_KEY", "test-key");
    expect(await getWebResearchProvider("firecrawl")?.getAvailability()).toEqual({
      available: false,
      reason: "Firecrawl provider is configured but not yet implemented."
    });
  });

  it("Brave is available when its credential resolves", async () => {
    registerDefaultWebResearchProviders();

    expect(await getWebResearchProvider("brave")?.getAvailability()).toEqual({
      available: false,
      reason: "Missing env var BRAVE_SEARCH_API_KEY"
    });
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "configured");
    expect(await getWebResearchProvider("brave")?.getAvailability()).toEqual({
      available: true
    });
  });

  it("auto-detect can select Brave when it is the only available live provider", async () => {
    registerDefaultWebResearchProviders();
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "configured");

    await expect(selectWebResearchProvider("search", {})).resolves.toMatchObject({
      providerName: "brave",
      explicit: false,
      fallback: false,
      availability: {
        available: true
      }
    });
  });

  it("auto-detect can select DDGS when installed and Brave is unavailable", async () => {
    registerDefaultWebResearchProviders();

    await expect(selectWebResearchProvider("search", {}, {
      pythonStateRoot: "/state",
      pythonCapabilityStatusChecker: vi.fn(async () => installedDdgsStatus("verified"))
    })).resolves.toMatchObject({
      providerName: "ddgs",
      explicit: false,
      fallback: false,
      availability: {
        available: true
      }
    });
  });

  it("explicit DDGS selection returns capability availability status", async () => {
    registerDefaultWebResearchProviders();

    await expect(selectWebResearchProvider("search", {
      searchBackend: "ddgs"
    }, {
      pythonStateRoot: "/state",
      pythonCapabilityStatusChecker: vi.fn(async () => installedDdgsStatus("verified"))
    })).resolves.toMatchObject({
      providerName: "ddgs",
      explicit: true,
      fallback: false,
      availability: {
        available: true
      }
    });
  });

  it("explicit unavailable DDGS returns a setup hint", async () => {
    registerDefaultWebResearchProviders();

    await expect(selectWebResearchProvider("search", {
      searchBackend: "ddgs"
    }, {
      pythonStateRoot: "/state",
      pythonCapabilityStatusChecker: vi.fn(async (): Promise<ManagedPythonCapabilityInstallStatus> => ({
        ok: false,
        capabilityId: DDGS_CAPABILITY_ID,
        reason: "install_required",
        message: "Managed Python capability environment has not been installed."
      }))
    })).resolves.toMatchObject({
      providerName: "ddgs",
      explicit: true,
      fallback: false,
      availability: {
        available: false,
        reason: "Managed Python capability environment has not been installed. Run estacoda python-env setup ddgs."
      }
    });
  });

  it("explicit Brave selection preserves credential config", async () => {
    registerDefaultWebResearchProviders();
    vi.stubEnv("CUSTOM_BRAVE_KEY", "configured");

    await expect(selectWebResearchProvider("search", {
      searchBackend: "brave",
      brave: {
        apiKeyEnv: "CUSTOM_BRAVE_KEY"
      }
    })).resolves.toMatchObject({
      providerName: "brave",
      explicit: true,
      fallback: false,
      availability: {
        available: true
      }
    });
  });

  it("all non-live provider stubs expose deterministic unavailable reasons", async () => {
    registerDefaultWebResearchProviders();

    const expectations = [
      ["parallel", "PARALLEL_API_KEY", "PARALLEL_API_KEY is missing.", "Parallel provider is configured but not yet implemented."],
      ["tavily", "TAVILY_API_KEY", "TAVILY_API_KEY is missing.", "Tavily provider is configured but not yet implemented."],
      ["exa", "EXA_API_KEY", "EXA_API_KEY is missing.", "Exa provider is configured but not yet implemented."],
      ["searxng", "SEARXNG_URL", "SEARXNG_URL is missing.", "SearXNG provider is configured but not yet implemented."]
    ] as const;

    for (const [name, envVar, missingReason, configuredReason] of expectations) {
      expect(await getWebResearchProvider(name)?.getAvailability()).toEqual({
        available: false,
        reason: missingReason
      });
      vi.stubEnv(envVar, "configured");
      expect(await getWebResearchProvider(name)?.getAvailability()).toEqual({
        available: false,
        reason: configuredReason
      });
      vi.unstubAllEnvs();
    }

    expect(await getWebResearchProvider("ddgs")?.getAvailability()).toEqual({
      available: false,
      reason: "Managed Python state is not available for DDGS search. Run estacoda python-env setup ddgs."
    });
  });
});

function installedDdgsStatus(status: "installed" | "verified"): ManagedPythonCapabilityInstallStatus {
  return {
    ok: true,
    status,
    capabilityId: DDGS_CAPABILITY_ID,
    version: "9.14.4",
    specHash: "hash",
    installedGroups: [],
    installedPackages: ["ddgs==9.14.4"],
    pythonPath: "/managed/python",
    envPath: "/managed/env",
    manifest: {
      id: DDGS_CAPABILITY_ID,
      version: "9.14.4",
      specHash: "hash",
      installedPackages: ["ddgs==9.14.4"],
      installedGroups: [],
      pythonPath: "/managed/python",
      envPath: "/managed/env",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      status
    }
  };
}
