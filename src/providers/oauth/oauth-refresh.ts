import { loadOAuthStore, writeOAuthStore } from "./oauth-store.js";
import type { OAuthTokenRecord } from "./oauth-types.js";
import { isOAuthAuthMethod } from "./oauth-types.js";
import type { ProviderAuthMethod } from "../../contracts/provider.js";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";

export type OAuthRefreshResult =
  | {
      kind: "success";
      accessToken: string;
      refreshToken?: string;
      expiresAt?: string;
    }
  | {
      kind: "error";
      reason: string;
      needsReauthentication: boolean;
    };

export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}>;

function defaultFetch(): FetchLike {
  return async (url, init) => {
    const response = await globalThis.fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body
    });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      json: async () => response.json()
    };
  };
}

/**
 * Refresh an OAuth access token using the refresh token flow.
 *
 * On success, updates auth.json with the new tokens.
 * On failure, leaves auth.json untouched.
 */
export async function refreshOAuthToken(options: {
  providerId: string;
  record: OAuthTokenRecord;
  fetchLike?: FetchLike;
  homeDir?: string;
  profileId?: string;
}): Promise<OAuthRefreshResult> {
  if (typeof options.record.refreshToken !== "string" || options.record.refreshToken.length === 0) {
    return {
      kind: "error",
      reason: `OAuth token for ${options.providerId} is missing a refresh token.`,
      needsReauthentication: true
    };
  }

  const fetchFn = options.fetchLike ?? defaultFetch();

  const body = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: options.record.refreshToken
  });

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchFn(REFRESH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Network error during token refresh.";
    return {
      kind: "error",
      reason: `Token refresh failed: ${reason}`,
      needsReauthentication: false
    };
  }

  const data = await response.json();

  if (!response.ok) {
    const errorDesc = extractErrorDescription(data) || response.statusText;
    const lowerDesc = errorDesc.toLowerCase();
    const isInvalidGrant = lowerDesc.includes("invalid_grant") || (typeof (data as Record<string, unknown>)?.error === "string" && (data as Record<string, unknown>).error === "invalid_grant");
    return {
      kind: "error",
      reason: `Token refresh failed: ${response.status} ${errorDesc}`,
      needsReauthentication: isInvalidGrant
    };
  }

  const parsed = parseRefreshResponse(data);
  if (!parsed) {
    return {
      kind: "error",
      reason: "Token refresh response missing access_token.",
      needsReauthentication: false
    };
  }

  // Preserve existing refresh token if server did not return a new one
  const newRefreshToken = parsed.refreshToken ?? options.record.refreshToken;

  // Update auth.json atomically
  const loadResult = await loadOAuthStore({ homeDir: options.homeDir, profileId: options.profileId });
  const currentRecord = loadResult.store.providers[options.providerId];
  if (currentRecord && (currentRecord.accessToken !== options.record.accessToken || currentRecord.refreshToken !== options.record.refreshToken)) {
    return {kind:'error',reason:'Authorization changed while refreshing; reacquire the route.',needsReauthentication:false};
  }
  const updatedStore = {
    ...loadResult.store,
    providers: {
      ...loadResult.store.providers,
      [options.providerId]: {
        authMethod: options.record.authMethod,
        accessToken: parsed.accessToken,
        refreshToken: newRefreshToken,
        ...(parsed.expiresAt !== undefined ? { expiresAt: parsed.expiresAt } : {}),
        scopes: options.record.scopes ?? [],
        source: options.record.source ?? "estacoda"
      }
    }
  };

  await writeOAuthStore(updatedStore, { homeDir: options.homeDir, profileId: options.profileId, expectedStore: loadResult.store });

  return {
    kind: "success",
    accessToken: parsed.accessToken,
    refreshToken: newRefreshToken,
    expiresAt: parsed.expiresAt
  };
}

/**
 * Check whether a token should be refreshed.
 * Returns true if expired or expiring within the given skew (default 120s).
 */
export function shouldRefreshToken(record: { expiresAt?: string }, skewSeconds = 120): boolean {
  if (!record.expiresAt) return false;
  const expiry = new Date(record.expiresAt).getTime();
  return expiry <= Date.now() + skewSeconds * 1000;
}

function parseRefreshResponse(data: unknown): {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
} | null {
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;

  if (typeof obj.access_token !== "string") return null;

  const result: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
  } = {
    accessToken: obj.access_token
  };

  if (typeof obj.refresh_token === "string") {
    result.refreshToken = obj.refresh_token;
  }

  if (typeof obj.expires_in === "number") {
    result.expiresAt = new Date(Date.now() + obj.expires_in * 1000).toISOString();
  }

  return result;
}

function extractErrorDescription(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const obj = data as Record<string, unknown>;
  if (typeof obj.error_description === "string") return obj.error_description;
  if (typeof obj.error === "string") return obj.error;
  return undefined;
}
