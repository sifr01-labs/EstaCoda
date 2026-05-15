import type { OAuthAuthStore, OAuthTokenRecord } from "./oauth-types.js";

export function redactOAuthTokenRecord(record: OAuthTokenRecord): OAuthTokenRecord {
  const redacted: OAuthTokenRecord = {
    ...record,
    accessToken: "[REDACTED]"
  };

  if (record.refreshToken !== undefined) {
    redacted.refreshToken = "[REDACTED]";
  }

  return redacted;
}

export function redactOAuthStore(store: OAuthAuthStore): OAuthAuthStore {
  const redactedProviders: Record<string, OAuthTokenRecord> = {};

  for (const [providerId, record] of Object.entries(store.providers)) {
    redactedProviders[providerId] = redactOAuthTokenRecord(record);
  }

  return {
    version: store.version,
    providers: redactedProviders
  };
}
