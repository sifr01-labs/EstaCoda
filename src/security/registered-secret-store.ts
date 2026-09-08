import type { SecureInputRequest } from "../contracts/secure-input.js";
import { writeEnvSecret } from "../config/env-secret-store.js";
import type { SecureInputTransport } from "./secure-input-transport-registry.js";

export type RegisteredSecretStore = {
  id: string;
  verifyEntryName(entryName: string): boolean;
  write(entryName: string, value: Uint8Array): Promise<void>;
};

export class RegisteredSecretStoreRegistry {
  readonly #stores = new Map<string, RegisteredSecretStore>();

  register(store: RegisteredSecretStore): void {
    if (store.id.trim().length === 0) throw new Error("Registered secret store id is required.");
    if (this.#stores.has(store.id)) throw new Error(`Secret store already registered: ${store.id}`);
    this.#stores.set(store.id, store);
  }

  get(id: string): RegisteredSecretStore | undefined {
    return this.#stores.get(id);
  }
}

export function createProfileEnvSecretStore(options: {
  profileId: string;
  homeDir?: string;
}): RegisteredSecretStore {
  return {
    id: "profile-env",
    verifyEntryName: isEnvironmentVariableName,
    write: async (entryName, value) => {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
      await writeEnvSecret({
        homeDir: options.homeDir,
        profileId: options.profileId,
        key: entryName,
        value: decoded
      });
    }
  };
}

export function createRegisteredSecretStoreTransport(
  stores: RegisteredSecretStoreRegistry
): SecureInputTransport {
  const resolve = (request: SecureInputRequest): RegisteredSecretStore | undefined => {
    if (request.destination.type !== "registered-store") return undefined;
    const store = stores.get(request.destination.storeId);
    return store?.verifyEntryName(request.destination.entryName) === true ? store : undefined;
  };
  return {
    id: "registered-secret-store",
    destinationTypes: ["registered-store"],
    priority: 200,
    verificationStrength: "declared-target",
    persistence: "profile-secret-store",
    disclosureBoundary: "local-runtime",
    requiresApproval: true,
    isAvailable: (request) => resolve(request) !== undefined,
    verify: ({ request }) => resolve(request) === undefined
      ? { status: "rejected", code: "destination-not-verifiable" }
      : { status: "verified", destination: structuredClone(request.destination) },
    deliver: async ({ value, context, consume }) => {
      const destination = context.request.destination;
      if (destination.type !== "registered-store") throw new Error("Registered store destination changed.");
      const store = resolve(context.request);
      if (store === undefined) throw new Error("Registered store destination is unavailable.");
      await store.write(destination.entryName, value);
      await consume(value, context);
    }
  };
}

function isEnvironmentVariableName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}
