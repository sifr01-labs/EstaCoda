import type { ModelProfile, ProviderAdapter, ProviderId, ProviderRequest, ProviderResponse } from "../contracts/provider.js";

export type CatalogProviderOptions = {
  id: ProviderId;
  name?: string;
  models: ModelProfile[];
};

export function createCatalogProvider(options: CatalogProviderOptions): ProviderAdapter {
  return {
    id: options.id,
    name: options.name ?? `${options.id} catalog`,
    health() {
      return {
        available: true
      };
    },
    listModels() {
      return options.models;
    },
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      return {
        ok: false,
        content: `Provider ${options.id} is registered for model discovery, but its native inference adapter is not wired yet.`,
        model: request.model,
        provider: options.id,
        errorClass: "unsupported"
      };
    }
  };
}
