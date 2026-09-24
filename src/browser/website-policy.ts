import { readFileSync } from "node:fs";

export type WebsiteBlocklistPolicy = {
  enabled: boolean;
  exactDomains: Set<string>;
  wildcardDomains: Set<string>;
  warnings: string[];
};

export type WebsiteAccessResult = {
  allowed: boolean;
  host?: string;
  matchedRule?: string;
  reason?: "website-blocklist";
} | null;

export type WebsitePolicyConfig = {
  domains?: string[];
  sharedFiles?: string[];
};

const WEBSITE_BLOCKLIST_CACHE_TTL_MS = 30_000;
const policyCache = new Map<string, {
  loadedAt: number;
  policy: WebsiteBlocklistPolicy;
}>();

export function loadWebsiteBlocklist(config: WebsitePolicyConfig, options: { refresh?: boolean } = {}): WebsiteBlocklistPolicy {
  const domains = Array.isArray(config?.domains) ? config.domains : [];
  const sharedFiles = Array.isArray(config?.sharedFiles) ? config.sharedFiles : [];
  const cacheKey = JSON.stringify({
    domains,
    sharedFiles
  });
  const cached = policyCache.get(cacheKey);
  if (!options.refresh && cached !== undefined && Date.now() - cached.loadedAt < WEBSITE_BLOCKLIST_CACHE_TTL_MS) {
    return cached.policy;
  }

  const warnings: string[] = [];
  const exactDomains = new Set<string>();
  const wildcardDomains = new Set<string>();

  for (const rule of domains) {
    addRule(rule, exactDomains, wildcardDomains);
  }

  for (const filePath of sharedFiles) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      continue;
    }
    try {
      const content = readFileSync(filePath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) {
          continue;
        }
        addRule(trimmed, exactDomains, wildcardDomains);
      }
    } catch {
      warnings.push(`Missing website blocklist file: ${filePath}`);
    }
  }

  const policy = {
    enabled: exactDomains.size > 0 || wildcardDomains.size > 0,
    exactDomains,
    wildcardDomains,
    warnings
  };
  policyCache.set(cacheKey, {
    loadedAt: Date.now(),
    policy
  });
  return policy;
}

export function checkWebsiteAccess(url: string, policy: WebsiteBlocklistPolicy): WebsiteAccessResult {
  try {
    if (!policy.enabled) {
      return { allowed: true };
    }

    const host = normalizeHostInput(url);
    if (host === undefined) {
      return null;
    }

    if (policy.exactDomains.has(host)) {
      return {
        allowed: false,
        host,
        matchedRule: host,
        reason: "website-blocklist"
      };
    }

    for (const domain of policy.wildcardDomains) {
      if (host !== domain && host.endsWith(`.${domain}`)) {
        return {
          allowed: false,
          host,
          matchedRule: `*.${domain}`,
          reason: "website-blocklist"
        };
      }
    }

    return { allowed: true, host };
  } catch {
    return null;
  }
}

export function resetWebsiteBlocklistCache(): void {
  policyCache.clear();
}

function addRule(rule: string, exactDomains: Set<string>, wildcardDomains: Set<string>): void {
  if (typeof rule !== "string") {
    return;
  }
  const normalizedRule = normalizeHostInput(rule);
  if (normalizedRule === undefined) {
    return;
  }

  if (rule.trim().startsWith("*.")) {
    wildcardDomains.add(normalizedRule);
    return;
  }

  exactDomains.add(normalizedRule);
}

function normalizeHostInput(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const withoutWildcard = trimmed.startsWith("*.") ? trimmed.slice(2) : trimmed;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(withoutWildcard)
    ? withoutWildcard
    : `https://${withoutWildcard}`;

  let host: string;
  try {
    host = new URL(withScheme).hostname;
  } catch {
    return undefined;
  }

  const normalized = host.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
  return normalized.length === 0 ? undefined : normalized;
}
