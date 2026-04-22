import type {
  CredentialPoolEntry,
  CredentialPoolSnapshot,
  CredentialRotationStrategy,
  ProviderCredentialSource,
  ProviderErrorClass,
  ProviderId
} from "../contracts/provider.js";

export type CredentialResolution = {
  id: string;
  source: ProviderCredentialSource;
  value?: string;
};

export type CredentialPoolOptions = {
  provider: ProviderId;
  entries?: CredentialPoolEntry[];
  strategy?: CredentialRotationStrategy;
  now?: () => Date;
};

export class CredentialPool {
  readonly provider: ProviderId;
  readonly #entries: CredentialPoolEntry[];
  readonly #strategy: CredentialRotationStrategy;
  readonly #now: () => Date;
  #cursor = 0;

  constructor(options: CredentialPoolOptions) {
    this.provider = options.provider;
    this.#entries = [...(options.entries ?? [])].sort(compareEntries);
    this.#strategy = options.strategy ?? "fill_first";
    this.#now = options.now ?? (() => new Date());
  }

  add(entry: CredentialPoolEntry): void {
    this.#entries.push(entry);
    this.#entries.sort(compareEntries);
  }

  resolveNext(): CredentialResolution | undefined {
    const available = this.#entries.filter((entry) => this.#isAvailable(entry));

    if (available.length === 0) {
      return undefined;
    }

    const entry = this.#selectEntry(available);
    entry.usageCount = (entry.usageCount ?? 0) + 1;

    return {
      id: entry.id,
      source: entry.source,
      value: resolveCredential(entry.source)
    };
  }

  reportFailure(id: string, errorClass: ProviderErrorClass): void {
    const entry = this.#entries.find((candidate) => candidate.id === id);

    if (entry === undefined) {
      return;
    }

    entry.failureCount = (entry.failureCount ?? 0) + 1;

    if (shouldCooldown(errorClass, entry.failureCount)) {
      const cooldownMs = cooldownMsFor(errorClass);
      entry.cooldownUntil = new Date(this.#now().getTime() + cooldownMs).toISOString();
    }
  }

  reportSuccess(id: string): void {
    const entry = this.#entries.find((candidate) => candidate.id === id);

    if (entry === undefined) {
      return;
    }

    entry.failureCount = 0;
    entry.cooldownUntil = undefined;
  }

  snapshot(): CredentialPoolSnapshot {
    return {
      provider: this.provider,
      strategy: this.#strategy,
      entries: this.#entries.map((entry) => ({
        id: entry.id,
        priority: entry.priority ?? 100,
        available: this.#isAvailable(entry),
        cooldownUntil: entry.cooldownUntil,
        failureCount: entry.failureCount ?? 0,
        usageCount: entry.usageCount ?? 0
      }))
    };
  }

  #selectEntry(available: CredentialPoolEntry[]): CredentialPoolEntry {
    switch (this.#strategy) {
      case "round_robin": {
        const entry = available[this.#cursor % available.length];
        this.#cursor += 1;
        return entry;
      }
      case "least_used":
        return [...available].sort((left, right) =>
          (left.usageCount ?? 0) - (right.usageCount ?? 0) ||
          compareEntries(left, right)
        )[0];
      case "random":
        return available[Math.floor(Math.random() * available.length)];
      case "fill_first":
      default:
        return available[0];
    }
  }

  #isAvailable(entry: CredentialPoolEntry): boolean {
    if (entry.cooldownUntil !== undefined && Date.parse(entry.cooldownUntil) > this.#now().getTime()) {
      return false;
    }

    return resolveCredential(entry.source) !== undefined || entry.source.kind === "none";
  }
}

export class CredentialPoolRegistry {
  readonly #pools = new Map<ProviderId, CredentialPool>();

  register(pool: CredentialPool): void {
    this.#pools.set(pool.provider, pool);
  }

  get(provider: ProviderId): CredentialPool | undefined {
    return this.#pools.get(provider);
  }

  resolve(provider: ProviderId): CredentialResolution | undefined {
    return this.#pools.get(provider)?.resolveNext();
  }

  reportFailure(provider: ProviderId, credentialId: string, errorClass: ProviderErrorClass): void {
    this.#pools.get(provider)?.reportFailure(credentialId, errorClass);
  }

  reportSuccess(provider: ProviderId, credentialId: string): void {
    this.#pools.get(provider)?.reportSuccess(credentialId);
  }

  snapshots(): CredentialPoolSnapshot[] {
    return [...this.#pools.values()].map((pool) => pool.snapshot());
  }
}

export function resolveCredential(source: ProviderCredentialSource): string | undefined {
  switch (source.kind) {
    case "literal":
      return source.value;
    case "env":
      return process.env[source.name];
    case "none":
      return undefined;
  }
}

function compareEntries(left: CredentialPoolEntry, right: CredentialPoolEntry): number {
  return (left.priority ?? 100) - (right.priority ?? 100);
}

function shouldCooldown(errorClass: ProviderErrorClass, failureCount: number): boolean {
  if (errorClass === "rate-limit") return failureCount >= 2;
  return errorClass === "quota" || errorClass === "auth";
}

function cooldownMsFor(errorClass: ProviderErrorClass): number {
  if (errorClass === "quota") return 24 * 60 * 60_000;
  if (errorClass === "auth") return 30 * 60_000;
  if (errorClass === "rate-limit") return 60 * 60_000;
  return 60_000;
}
