import type { ProviderId, ProviderAuthMethod } from "../contracts/provider.js";
import type { ProviderMetadata } from "./provider-metadata.js";
import { loadOAuthStore, writeOAuthStore } from "./oauth/oauth-store.js";
import { refreshOAuthToken, shouldRefreshToken } from "./oauth/oauth-refresh.js";
import { isOAuthAuthMethod } from "./oauth/oauth-types.js";

export type RuntimeCredential =
  | { kind: "none"; id: string }
  | { kind: "bearer"; id: string; value: string; source: "env" | "oauth" };

export type RuntimeCredentialResolverOptions = {
  providerId: ProviderId;
  route?: {
    apiKeyEnv?: string;
    authMethod?: ProviderAuthMethod;
  };
  providerConfig?: {
    apiKeyEnv?: string;
    authMethod?: ProviderAuthMethod;
  };
  metadata?: ProviderMetadata;
  homeDir?: string;
};

export type RuntimeCredentialDiagnostic = {
  ok: boolean;
  message?: string;
};

export type RuntimeCredentialResolution = {
  credential?: RuntimeCredential;
  diagnostic: RuntimeCredentialDiagnostic;
};

export async function resolveRuntimeCredential(
  options: RuntimeCredentialResolverOptions
): Promise<RuntimeCredentialResolution> {
  // 0. OAuth credential resolution
  const oauthAuthMethod = options.route?.authMethod ?? options.providerConfig?.authMethod ?? options.metadata?.defaultAuthMethod;
  if (oauthAuthMethod !== undefined && isOAuthAuthMethod(oauthAuthMethod)) {
    return await resolveOAuthCredential(options.providerId, oauthAuthMethod, options.homeDir);
  }

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

  // 3. none if provider auth method is none
  if (options.metadata?.authMethods.includes("none")) {
    return {
      credential: { kind: "none", id: `${options.providerId}:none` },
      diagnostic: { ok: true },
    };
  }

  return {
    diagnostic: {
      ok: false,
      message: `Provider ${options.providerId} requires api_key credentials but no credential reference is configured.`,
    },
  };
}

async function resolveOAuthCredential(
  providerId: string,
  authMethod: ProviderAuthMethod,
  homeDir?: string
): Promise<RuntimeCredentialResolution> {
  const oauthResult = await loadOAuthStore({ homeDir });
  const record = oauthResult.store.providers[providerId];

  if (record === undefined) {
    return {
      diagnostic: {
        ok: false,
        message: `Provider ${providerId} requires OAuth authentication. Run "estacoda model setup ${providerId}" to authenticate.`
      }
    };
  }

  // Refresh if expired or expiring soon
  if (shouldRefreshToken(record)) {
    const refreshResult = await refreshOAuthToken({
      providerId,
      record,
      homeDir
    });

    if (refreshResult.kind === "error") {
      return {
        diagnostic: {
          ok: false,
          message: refreshResult.needsReauthentication
            ? `OAuth token for ${providerId} has expired. Run "estacoda model setup ${providerId}" to re-authenticate.`
            : refreshResult.reason
        }
      };
    }

    // Reload the store after successful refresh
    const refreshed = await loadOAuthStore({ homeDir });
    const refreshedRecord = refreshed.store.providers[providerId];
    if (refreshedRecord === undefined) {
      return {
        diagnostic: {
          ok: false,
          message: `OAuth token refresh succeeded but token record disappeared for ${providerId}.`
        }
      };
    }

    return {
      credential: {
        kind: "bearer",
        id: `${providerId}:oauth`,
        value: refreshedRecord.accessToken,
        source: "oauth"
      },
      diagnostic: { ok: true }
    };
  }

  return {
    credential: {
      kind: "bearer",
      id: `${providerId}:oauth`,
      value: record.accessToken,
      source: "oauth"
    },
    diagnostic: { ok: true }
  };
}
