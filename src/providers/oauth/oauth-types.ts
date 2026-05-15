import type { ProviderAuthMethod } from "../../contracts/provider.js";

export type OAuthTokenRecord = {
  authMethod: ProviderAuthMethod;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes?: string[];
  source?: string;
};

export type OAuthAuthStore = {
  version: number;
  providers: Record<string, OAuthTokenRecord>;
};

export type OAuthStoreLoadResult = {
  store: OAuthAuthStore;
  diagnostics: string[];
};

export type OAuthStoreWriteResult = {
  path: string;
};

export const CURRENT_OAUTH_STORE_VERSION = 1;

export const OAUTH_AUTH_METHODS: ReadonlySet<ProviderAuthMethod> = new Set<ProviderAuthMethod>([
  "oauth_device",
  "oauth_device_pkce",
  "oauth_pkce_poll",
  "oauth_external"
]);

export function isOAuthAuthMethod(method: ProviderAuthMethod): boolean {
  return OAUTH_AUTH_METHODS.has(method);
}
