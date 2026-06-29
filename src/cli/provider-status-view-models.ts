import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { ProviderId } from "../contracts/provider.js";
import type { ViewModel, ViewModelSeverity } from "../contracts/view-model.js";
import { createModelSelectionCatalog } from "../providers/model-selection-catalog.js";
import { getProviderMetadata } from "../providers/provider-metadata.js";
import { chromeCopy, type UiLocale } from "../ui/cli-ui-copy.js";
import {
  buildCommandResultViewModel,
  buildKeyValueBlockViewModel,
  buildListViewModel,
  kv,
  listItem,
} from "../ui/view-models/builders.js";

type ProviderReadinessStatus = "ready" | "missingCredential" | "endpointFailed" | "notConfigured";

export async function buildProvidersStatusViewModel(
  config: LoadedRuntimeConfig,
  locale: UiLocale = "en"
): Promise<ViewModel> {
  const copy = chromeCopy(locale);
  const catalog = await createModelSelectionCatalog({
    config: config.config,
    providerRegistry: config.providerRegistry,
    homeDir: config.homeDir,
    allowNetwork: false,
  });
  const providers = await catalog.listProviders({ includeCatalogOnly: true });
  const configuredProviders = providers.filter((provider) => provider.configured);
  const primary = config.primaryModelRoute;

  return buildCommandResultViewModel({
    ok: primary.provider !== "unconfigured" && primary.id !== "unconfigured",
    title: copy.providersTitle,
    blocks: [
      buildKeyValueBlockViewModel({
        entries: [
          kv(copy.providersActiveRoute, `${primary.provider}/${primary.id}`),
          ...(primary.baseUrl === undefined ? [] : [kv(copy.providersEndpoint, primary.baseUrl)]),
          ...(primary.apiKeyEnv === undefined ? [] : [kv(copy.providersCredential, primary.apiKeyEnv)]),
        ],
      }),
      buildListViewModel({
        title: copy.providersConfiguredProviders,
        items: configuredProviders.map((provider) => {
          const status = providerReadinessStatus(config, provider.id, {
            configured: provider.configured,
            credentialReady: provider.credentialReady,
            endpointReady: provider.endpointReady,
          });
          return listItem(
            provider.id,
            [
              readinessLabel(copy, status),
              copy.providersModelCount(provider.modelsCount),
            ].join(" | "),
            readinessSeverity(status)
          );
        }),
        emptyMessage: copy.providersStatusNotConfigured,
      }),
      buildKeyValueBlockViewModel({
        title: copy.providersDiagnosticsTitle,
        entries: [
          kv(copy.providersEndpointCheck, copy.providersEndpointCheckConfigOnly),
          kv(copy.providersCredentialCheck, copy.providersCredentialCheckConfigOnly),
          kv(copy.providersSetup, copy.providersLocalSetupHint),
        ],
      }),
    ],
  });
}

function providerReadinessStatus(
  config: LoadedRuntimeConfig,
  providerId: ProviderId,
  provider: {
    readonly configured: boolean;
    readonly credentialReady: boolean;
    readonly endpointReady: boolean;
  }
): ProviderReadinessStatus {
  if (!provider.configured) {
    return "notConfigured";
  }

  const providerConfig = config.config.providers?.[providerId];
  const endpointUrl = providerConfig?.baseUrl ?? getProviderMetadata(providerId).defaultBaseUrl;
  const endpointRequired = endpointUrl !== undefined || providerId === "local";
  if (endpointRequired && !isValidEndpointUrl(endpointUrl)) {
    return "endpointFailed";
  }

  if (!provider.credentialReady) {
    return "missingCredential";
  }

  return "ready";
}

function isValidEndpointUrl(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) {
    return false;
  }
  try {
    new URL(baseUrl);
    return true;
  } catch {
    return false;
  }
}

function readinessLabel(copy: ReturnType<typeof chromeCopy>, status: ProviderReadinessStatus): string {
  switch (status) {
    case "ready":
      return copy.providersStatusReady;
    case "missingCredential":
      return copy.providersStatusMissingCredential;
    case "endpointFailed":
      return copy.providersStatusEndpointFailed;
    case "notConfigured":
      return copy.providersStatusNotConfigured;
  }
}

function readinessSeverity(status: ProviderReadinessStatus): ViewModelSeverity {
  switch (status) {
    case "ready":
      return "ok";
    case "missingCredential":
    case "endpointFailed":
      return "warn";
    case "notConfigured":
      return "info";
  }
}
