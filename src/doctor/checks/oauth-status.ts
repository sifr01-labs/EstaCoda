import { loadOAuthStore } from "../../providers/oauth/oauth-store.js";
import type { ProviderAuthMethod } from "../../contracts/provider.js";

export type OAuthProviderStatus = {
  readonly providerId: string;
  readonly authMethod: ProviderAuthMethod;
  readonly status: "ready" | "expired";
};

export type OAuthStatusDiagnostic = {
  readonly status: "ready" | "warning";
  readonly providerStatuses: readonly OAuthProviderStatus[];
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
};

export async function diagnoseOAuthStatus(options: {
  readonly homeDir?: string;
  readonly profileId: string;
  readonly now?: Date;
}): Promise<OAuthStatusDiagnostic> {
  const now = options.now ?? new Date();
  const result = await loadOAuthStore({ homeDir: options.homeDir, profileId: options.profileId });
  const providerStatuses = Object.entries(result.store.providers)
    .map(([providerId, record]): OAuthProviderStatus => ({
      providerId,
      authMethod: record.authMethod,
      status: isExpired(record.expiresAt, now) ? "expired" : "ready"
    }))
    .sort((left, right) => left.providerId.localeCompare(right.providerId));
  const expiredProviders = providerStatuses.filter((provider) => provider.status === "expired");
  const warnings: string[] = [...result.diagnostics];
  const notes: string[] = [];

  if (expiredProviders.length > 0) {
    warnings.push(`OAuth credentials are expired for providers: ${expiredProviders.map((provider) => provider.providerId).join(", ")}`);
  }
  if (providerStatuses.length === 0 && result.diagnostics.length === 0) {
    notes.push("OAuth auth store has no provider records.");
  }

  return {
    status: warnings.length > 0 ? "warning" : "ready",
    providerStatuses,
    warnings,
    notes
  };
}

function isExpired(expiresAt: string | undefined, now: Date): boolean {
  if (expiresAt === undefined) return false;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}
