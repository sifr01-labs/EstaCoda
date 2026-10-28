import type { ProviderAuthMethod } from "../../contracts/provider.js";
import { codexDeviceVerificationUrl, runCodexOAuthFlow, type CodexTokenBundle, type FetchLike } from "./codex-oauth.js";
import { isCodexTokenExpired } from "./codex-oauth.js";
import { loadOAuthStore } from "./oauth-store.js";
import type { OAuthAuthStore, OAuthTokenRecord } from "./oauth-types.js";

export const CODEX_DEFAULT_MODEL = "gpt-6.1-sol";
export const CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_OAUTH_AUTH_METHOD = "oauth_device_pkce" as const satisfies ProviderAuthMethod;

export type CodexOAuthStatusValue = "ready" | "required" | "expired";

export type CodexOAuthStatus = {
  readonly providerId: "codex";
  readonly authMethod: typeof CODEX_OAUTH_AUTH_METHOD;
  readonly status: CodexOAuthStatusValue;
};

export type OutputSink = {
  write(chunk: string): void;
};

export function codexOAuthStatusFromStore(store: OAuthAuthStore): CodexOAuthStatus {
  const existingRecord = store.providers.codex;
  if (existingRecord === undefined || existingRecord.accessToken.length === 0) {
    return codexOAuthStatus("required");
  }
  if (isCodexTokenExpired(existingRecord)) {
    return codexOAuthStatus("expired");
  }
  return codexOAuthStatus("ready");
}

export async function readCodexOAuthStatus(options?: {
  readonly homeDir?: string;
  readonly profileId?: string;
}): Promise<CodexOAuthStatus> {
  const oauthResult = await loadOAuthStore({
    homeDir: options?.homeDir,
    profileId: options?.profileId,
  });
  return codexOAuthStatusFromStore(oauthResult.store);
}

export function buildCodexOAuthTokenRecord(tokens: CodexTokenBundle): OAuthTokenRecord {
  return {
    authMethod: CODEX_OAUTH_AUTH_METHOD,
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    scopes: tokens.scopes,
    source: "estacoda",
  };
}

export async function runCodexOAuthFlowWithDeviceCodeNotice(options: {
  readonly fetchLike?: FetchLike;
  readonly signal?: AbortSignal;
  readonly output?: OutputSink;
  readonly onDeviceCodeNotice?: (notice: {
    readonly userCode: string;
    readonly rendered: string;
  }) => void;
}): Promise<{
  readonly flowResult: Awaited<ReturnType<typeof runCodexOAuthFlow>>;
  readonly deviceCodeShown: boolean;
}> {
  let deviceCodeShown = false;
  const flowResult = await runCodexOAuthFlow({
    fetchLike: options.fetchLike,
    signal: options.signal,
    onDeviceCode: (info) => {
      deviceCodeShown = true;
      const rendered = renderCodexDeviceCodeNotice(info);
      options.output?.write(rendered);
      options.onDeviceCodeNotice?.({
        userCode: info.userCode,
        rendered,
      });
    },
  });
  return { flowResult, deviceCodeShown };
}

export function renderCodexDeviceCodeNotice(info: {
  readonly userCode: string;
}): string {
  return [
    "Codex OAuth device authorization",
    `Open: ${codexDeviceVerificationUrl()}`,
    `Code: ${info.userCode}`,
    "Waiting for authorization. This may take up to 15 minutes.",
    "",
  ].join("\n");
}

export function formatCodexOAuthFailure(kind: "timeout" | "error", reason: string, deviceCodeShown: boolean): string {
  if (!deviceCodeShown) {
    return kind === "timeout"
      ? `Authentication timed out: ${reason}`
      : `Authentication failed: ${reason}`;
  }

  return kind === "timeout"
    ? `Authentication timed out while waiting for authorization: ${reason}`
    : `Authentication failed while waiting for authorization: ${reason}`;
}

function codexOAuthStatus(status: CodexOAuthStatusValue): CodexOAuthStatus {
  return {
    providerId: "codex",
    authMethod: CODEX_OAUTH_AUTH_METHOD,
    status,
  };
}
