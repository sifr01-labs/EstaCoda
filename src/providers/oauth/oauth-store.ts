import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveStateHome } from "../../config/state-home.js";
import type { ProviderAuthMethod } from "../../contracts/provider.js";
import {
  CURRENT_OAUTH_STORE_VERSION,
  isOAuthAuthMethod,
  OAUTH_AUTH_METHODS
} from "./oauth-types.js";
import type {
  OAuthAuthStore,
  OAuthStoreLoadResult,
  OAuthStoreWriteResult,
  OAuthTokenRecord
} from "./oauth-types.js";

export function defaultOAuthStorePath(homeDir?: string): string {
  return resolveStateHome({ homeDir }).authJsonPath;
}

export async function loadOAuthStore(options?: {
  homeDir?: string;
  path?: string;
}): Promise<OAuthStoreLoadResult> {
  const path = options?.path ?? defaultOAuthStorePath(options?.homeDir);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        store: { version: CURRENT_OAUTH_STORE_VERSION, providers: {} },
        diagnostics: []
      };
    }
    throw error;
  }

  if (content.trim().length === 0) {
    return {
      store: { version: CURRENT_OAUTH_STORE_VERSION, providers: {} },
      diagnostics: []
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      store: { version: CURRENT_OAUTH_STORE_VERSION, providers: {} },
      diagnostics: ["auth.json contains invalid JSON; treating as empty store."]
    };
  }

  return validateOAuthStore(parsed);
}

export function validateOAuthStore(data: unknown): OAuthStoreLoadResult {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {
      store: { version: CURRENT_OAUTH_STORE_VERSION, providers: {} },
      diagnostics: ["auth.json top-level value is not an object; treating as empty store."]
    };
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.version !== "number") {
    return {
      store: { version: CURRENT_OAUTH_STORE_VERSION, providers: {} },
      diagnostics: ["auth.json is missing version field; treating as empty store."]
    };
  }

  if (obj.version !== CURRENT_OAUTH_STORE_VERSION) {
    return {
      store: { version: CURRENT_OAUTH_STORE_VERSION, providers: {} },
      diagnostics: [`Unsupported auth store version ${obj.version}; treating as empty store.`]
    };
  }

  if (typeof obj.providers !== "object" || obj.providers === null || Array.isArray(obj.providers)) {
    return {
      store: { version: CURRENT_OAUTH_STORE_VERSION, providers: {} },
      diagnostics: ["auth.json providers field is missing or not an object; treating as empty store."]
    };
  }

  const providers = obj.providers as Record<string, unknown>;
  const sanitizedProviders: Record<string, OAuthTokenRecord> = {};
  const diagnostics: string[] = [];

  for (const [providerId, record] of Object.entries(providers)) {
    if (typeof record !== "object" || record === null) {
      diagnostics.push(`Malformed auth record for provider ${providerId}: not an object.`);
      continue;
    }

    const rec = record as Record<string, unknown>;

    if (typeof rec.authMethod !== "string") {
      diagnostics.push(`Malformed auth record for provider ${providerId}: missing authMethod.`);
      continue;
    }

    if (!isOAuthAuthMethod(rec.authMethod as ProviderAuthMethod)) {
      diagnostics.push(
        `Malformed auth record for provider ${providerId}: authMethod "${rec.authMethod}" is not an OAuth method.`
      );
      continue;
    }

    if (typeof rec.accessToken !== "string") {
      diagnostics.push(`Malformed auth record for provider ${providerId}: missing accessToken.`);
      continue;
    }

    const sanitizedRecord: OAuthTokenRecord = {
      authMethod: rec.authMethod as ProviderAuthMethod,
      accessToken: rec.accessToken
    };

    if (typeof rec.refreshToken === "string") {
      sanitizedRecord.refreshToken = rec.refreshToken;
    }

    if (typeof rec.expiresAt === "string") {
      sanitizedRecord.expiresAt = rec.expiresAt;
    }

    if (Array.isArray(rec.scopes)) {
      sanitizedRecord.scopes = rec.scopes.filter((s): s is string => typeof s === "string");
    }

    if (typeof rec.source === "string") {
      sanitizedRecord.source = rec.source;
    }

    sanitizedProviders[providerId] = sanitizedRecord;
  }

  return {
    store: { version: CURRENT_OAUTH_STORE_VERSION, providers: sanitizedProviders },
    diagnostics
  };
}

export async function writeOAuthStore(
  store: OAuthAuthStore,
  options?: { homeDir?: string; path?: string }
): Promise<OAuthStoreWriteResult> {
  const path = options?.path ?? defaultOAuthStorePath(options?.homeDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");

  try {
    await chmod(path, 0o600);
  } catch {
    // Non-fatal: chmod may be unavailable or restricted on some platforms.
  }

  return { path };
}
