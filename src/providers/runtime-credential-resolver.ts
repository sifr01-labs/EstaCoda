import type { ProviderId } from "../contracts/provider.js";
import type { ProviderMetadata } from "./provider-metadata.js";
import type { CredentialPoolRegistry } from "./credential-pool.js";

export type RuntimeCredential =
  | { kind: "none"; id: string }
  | { kind: "bearer"; id: string; value: string; source: "env" | "pool" };

export type RuntimeCredentialResolverOptions = {
  providerId: ProviderId;
  route?: {
    apiKeyEnv?: string;
  };
  providerConfig?: {
    apiKeyEnv?: string;
  };
  credentialPools?: CredentialPoolRegistry;
  metadata?: ProviderMetadata;
};

export type RuntimeCredentialDiagnostic = {
  ok: boolean;
  message?: string;
};

export type RuntimeCredentialResolution = {
  credential?: RuntimeCredential;
  diagnostic: RuntimeCredentialDiagnostic;
};

export function resolveRuntimeCredential(
  options: RuntimeCredentialResolverOptions
): RuntimeCredentialResolution {
  // 1. route explicit credential reference
  if (options.route?.apiKeyEnv !== undefined) {
    const value = process.env[options.route.apiKeyEnv];
    if (value === undefined || value.length === 0) {
      return {
        diagnostic: {
          ok: false,
          message: `Missing env var ${options.route.apiKeyEnv}`,
        },
      };
    }
    return {
      credential: {
        kind: "bearer",
        id: options.route.apiKeyEnv,
        value,
        source: "env",
      },
      diagnostic: { ok: true },
    };
  }

  // 2. provider configured credential reference
  if (options.providerConfig?.apiKeyEnv !== undefined) {
    const value = process.env[options.providerConfig.apiKeyEnv];
    if (value === undefined || value.length === 0) {
      return {
        diagnostic: {
          ok: false,
          message: `Missing env var ${options.providerConfig.apiKeyEnv}`,
        },
      };
    }
    return {
      credential: {
        kind: "bearer",
        id: options.providerConfig.apiKeyEnv,
        value,
        source: "env",
      },
      diagnostic: { ok: true },
    };
  }

  // 3. credential pool, if provider explicitly opts into rotation
  if (options.credentialPools !== undefined) {
    const poolCredential = options.credentialPools.resolve(options.providerId);
    if (poolCredential !== undefined && poolCredential.value !== undefined) {
      return {
        credential: {
          kind: "bearer",
          id: poolCredential.id,
          value: poolCredential.value,
          source: "pool",
        },
        diagnostic: { ok: true },
      };
    }
  }

  // 4. none if provider auth method is none
  if (options.metadata?.authMethods.includes("none")) {
    return {
      credential: { kind: "none", id: `${options.providerId}:none` },
      diagnostic: { ok: true },
    };
  }

  return {
    credential: { kind: "none", id: `${options.providerId}:none` },
    diagnostic: { ok: true },
  };
}
