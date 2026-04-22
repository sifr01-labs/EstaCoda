import type { ModelProfile, ProviderAdapter, ProviderId } from "../contracts/provider.js";

export class ProviderRegistry {
  readonly #providers = new Map<ProviderId, ProviderAdapter>();

  register(provider: ProviderAdapter): void {
    this.#providers.set(provider.id, provider);
  }

  get(id: ProviderId): ProviderAdapter | undefined {
    return this.#providers.get(id);
  }

  list(): ProviderAdapter[] {
    return [...this.#providers.values()];
  }

  async listModels(): Promise<ModelProfile[]> {
    const models: ModelProfile[] = [];

    for (const provider of this.#providers.values()) {
      models.push(...await provider.listModels());
    }

    return models;
  }

  async getAvailableProviders(): Promise<ProviderAdapter[]> {
    const available: ProviderAdapter[] = [];

    for (const provider of this.#providers.values()) {
      const health = await provider.health();

      if (health.available) {
        available.push(provider);
      }
    }

    return available;
  }
}
