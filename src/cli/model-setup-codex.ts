import { readConfig, saveRuntimeConfig } from "../config/runtime-config.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";
import {
  loadOAuthStore,
  writeOAuthStore
} from "../providers/oauth/oauth-store.js";
import { runCodexOAuthFlow, type FetchLike } from "../providers/oauth/codex-oauth.js";
import { isCodexTokenExpired } from "../providers/oauth/codex-oauth.js";
import type { Prompt } from "./readline-prompt.js";
import type { CliOptions, CliCommandResult } from "./cli.js";

const CODEX_DEFAULT_MODEL = "o3";
const CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";

type OutputSink = {
  write(chunk: string): void;
};

export type ModelSetupCodexOptions = {
  homeDir?: string;
  profileId?: string;
  workspaceRoot: string;
  prompt?: Prompt;
  fetchLike?: FetchLike;
  signal?: AbortSignal;
  output?: OutputSink;
};

export async function runModelSetupCodex(
  options: ModelSetupCodexOptions
): Promise<CliCommandResult> {
  const prompt = options.prompt;
  const homeDir = options.homeDir;

  // Read existing auth state
  const oauthResult = await loadOAuthStore({ homeDir });
  const existingRecord = oauthResult.store.providers.codex;
  const hasValidCreds =
    existingRecord !== undefined &&
    existingRecord.accessToken.length > 0 &&
    !isCodexTokenExpired(existingRecord);

  if (hasValidCreds) {
    return await handleExistingCredentials(options, oauthResult.store);
  }

  return await handleNewAuthentication(options);
}

async function handleExistingCredentials(
  options: ModelSetupCodexOptions,
  existingStore: Awaited<ReturnType<typeof loadOAuthStore>>["store"]
): Promise<CliCommandResult> {
  const prompt = options.prompt;

  // Prompt: [1] Use existing [2] Reauthenticate [3] Cancel
  const choice = await askChoice(prompt, [
    { label: "Use existing credentials", value: "use" },
    { label: "Reauthenticate (creates a new OAuth session)", value: "reauth" },
    { label: "Cancel", value: "cancel" }
  ], "Codex credentials found in ~/.estacoda/auth.json.\n");

  if (choice === "cancel" || choice === null) {
    return cancelResult();
  }

  if (choice === "use") {
    const configResult = await configureCodexRoute(options);
    if (!configResult.ok) {
      return {
        handled: true,
        exitCode: 1,
        output: configResult.message
      };
    }
    return {
      handled: true,
      exitCode: 0,
      output: [
        "Using existing Codex credentials.",
        "Codex route configured.",
        `  Provider: codex`,
        `  Model: ${CODEX_DEFAULT_MODEL}`
      ].join("\n")
    };
  }

  // Reauthenticate
  const { flowResult, deviceCodeShown } = await runCodexOAuthFlowWithDeviceCodeNotice(options);

  if (flowResult.kind === "cancelled") {
    return cancelResult();
  }

  if (flowResult.kind === "timeout") {
    return {
      handled: true,
      exitCode: 1,
      output: formatOAuthFailure("timeout", flowResult.reason, deviceCodeShown)
    };
  }

  if (flowResult.kind === "error") {
    return {
      handled: true,
      exitCode: 1,
      output: formatOAuthFailure("error", flowResult.reason, deviceCodeShown)
    };
  }

  // Write tokens to auth.json
  const updatedStore = {
    ...existingStore,
    providers: {
      ...existingStore.providers,
      codex: {
        authMethod: "oauth_device_pkce" as const,
        accessToken: flowResult.tokens.accessToken,
        ...(flowResult.tokens.refreshToken !== undefined
          ? { refreshToken: flowResult.tokens.refreshToken }
          : {}),
        ...(flowResult.tokens.expiresAt !== undefined
          ? { expiresAt: flowResult.tokens.expiresAt }
          : {}),
        scopes: flowResult.tokens.scopes,
        source: "estacoda"
      }
    }
  };

  const writeResult = await writeOAuthStore(updatedStore, { homeDir: options.homeDir });

  // Configure route
  const configResult = await configureCodexRoute(options);
  if (!configResult.ok) {
    return {
      handled: true,
      exitCode: 1,
      output: "Codex authentication succeeded, but route configuration failed."
    };
  }

  return {
    handled: true,
    exitCode: 0,
    output: [
      "Reauthenticating Codex...",
      "(This replaces your existing Codex OAuth session)",
      "",
      "Codex route configured.",
      `  Provider: codex`,
      `  Model: ${CODEX_DEFAULT_MODEL}`
    ].join("\n")
  };
}

async function handleNewAuthentication(
  options: ModelSetupCodexOptions
): Promise<CliCommandResult> {
  const prompt = options.prompt;

  const choice = await askChoice(prompt, [
    { label: "Sign in with device code", value: "signin" },
    { label: "Cancel", value: "cancel" }
  ], "Codex requires OAuth authentication.\n");

  if (choice === "cancel" || choice === null) {
    return cancelResult();
  }

  const { flowResult, deviceCodeShown } = await runCodexOAuthFlowWithDeviceCodeNotice(options);

  if (flowResult.kind === "cancelled") {
    return cancelResult();
  }

  if (flowResult.kind === "timeout") {
    return {
      handled: true,
      exitCode: 1,
      output: formatOAuthFailure("timeout", flowResult.reason, deviceCodeShown)
    };
  }

  if (flowResult.kind === "error") {
    return {
      handled: true,
      exitCode: 1,
      output: formatOAuthFailure("error", flowResult.reason, deviceCodeShown)
    };
  }

  // Load existing store (may be empty) and merge
  const oauthResult = await loadOAuthStore({ homeDir: options.homeDir });
  const updatedStore = {
    ...oauthResult.store,
    providers: {
      ...oauthResult.store.providers,
      codex: {
        authMethod: "oauth_device_pkce" as const,
        accessToken: flowResult.tokens.accessToken,
        ...(flowResult.tokens.refreshToken !== undefined
          ? { refreshToken: flowResult.tokens.refreshToken }
          : {}),
        ...(flowResult.tokens.expiresAt !== undefined
          ? { expiresAt: flowResult.tokens.expiresAt }
          : {}),
        scopes: flowResult.tokens.scopes,
        source: "estacoda"
      }
    }
  };

  const writeResult = await writeOAuthStore(updatedStore, { homeDir: options.homeDir });

  // Configure route
  const configResult = await configureCodexRoute(options);
  if (!configResult.ok) {
    return {
      handled: true,
      exitCode: 1,
      output: "Codex authentication succeeded, but route configuration failed."
    };
  }

  return {
    handled: true,
    exitCode: 0,
    output: [
      "Codex route configured.",
      `  Provider: codex`,
      `  Model: ${CODEX_DEFAULT_MODEL}`
    ].join("\n")
  };
}

async function runCodexOAuthFlowWithDeviceCodeNotice(
  options: ModelSetupCodexOptions
): Promise<{
  flowResult: Awaited<ReturnType<typeof runCodexOAuthFlow>>;
  deviceCodeShown: boolean;
}> {
  let deviceCodeShown = false;
  const flowResult = await runCodexOAuthFlow({
    fetchLike: options.fetchLike,
    signal: options.signal,
    onDeviceCode: (info) => {
      deviceCodeShown = true;
      options.output?.write(renderDeviceCodeNotice(info));
    }
  });
  return { flowResult, deviceCodeShown };
}

function renderDeviceCodeNotice(info: {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
}): string {
  return [
    "Codex OAuth device authorization",
    `Open: ${info.verificationUriComplete ?? info.verificationUri}`,
    `Code: ${info.userCode}`,
    "Waiting for authorization. This may take up to 15 minutes.",
    ""
  ].join("\n");
}

function formatOAuthFailure(kind: "timeout" | "error", reason: string, deviceCodeShown: boolean): string {
  if (!deviceCodeShown) {
    return kind === "timeout"
      ? `Authentication timed out: ${reason}`
      : `Authentication failed: ${reason}`;
  }

  return kind === "timeout"
    ? `Authentication timed out while waiting for authorization: ${reason}`
    : `Authentication failed while waiting for authorization: ${reason}`;
}

async function configureCodexRoute(
  options: ModelSetupCodexOptions
): Promise<{ ok: true } | { ok: false; message: string }> {
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  const targetPath = resolveProfileStateHome({ homeDir: options.homeDir, profileId }).configPath;

  try {
    const existing = await readConfig(targetPath);

    const config = {
      ...existing.config,
      model: {
        provider: "codex" as const,
        id: CODEX_DEFAULT_MODEL
      },
      providers: {
        ...(existing.config.providers ?? {}),
        codex: {
          ...(existing.config.providers?.codex ?? {}),
          baseUrl: CODEX_DEFAULT_BASE_URL,
          authMethod: "oauth_device_pkce" as const
        }
      }
    };

    await saveRuntimeConfig(targetPath, config);
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Codex authentication succeeded, but route configuration failed.\n${reason}`
    };
  }
}

function cancelResult(): CliCommandResult {
  return {
    handled: true,
    exitCode: 0,
    output: "Cancelled. No changes were made."
  };
}

async function askChoice(
  prompt: Prompt | undefined,
  choices: Array<{ label: string; value: string }>,
  preamble: string
): Promise<string | null> {
  if (prompt === undefined) {
    return null;
  }

  const lines: string[] = [preamble];
  for (let i = 0; i < choices.length; i++) {
    lines.push(`[${i + 1}] ${choices[i].label}`);
  }
  lines.push("");

  const raw = await prompt(lines.join("\n") + "Choice: ");
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return null;
  }

  const index = Number.parseInt(trimmed, 10) - 1;
  if (index >= 0 && index < choices.length) {
    return choices[index].value;
  }

  return null;
}
