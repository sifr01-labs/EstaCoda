import { readConfig, saveRuntimeConfig } from "../config/runtime-config.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";
import {
  loadOAuthStore,
  writeOAuthStore
} from "../providers/oauth/oauth-store.js";
import type { FetchLike } from "../providers/oauth/codex-oauth.js";
import {
  buildCodexOAuthTokenRecord,
  CODEX_DEFAULT_BASE_URL,
  CODEX_DEFAULT_MODEL,
  CODEX_OAUTH_AUTH_METHOD,
  codexOAuthStatusFromStore,
  formatCodexOAuthFailure,
  runCodexOAuthFlowWithDeviceCodeNotice,
  type OutputSink,
} from "../providers/oauth/codex-setup.js";
import { getProviderMetadata } from "../providers/provider-metadata.js";
import type { Prompt } from "./prompt-contract.js";
import type { CliOptions, CliCommandResult } from "./cli.js";

const CODEX_API_MODE = getProviderMetadata("codex").apiMode;

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
  const oauthResult = await loadOAuthStore({ homeDir, profileId: options.profileId });
  const oauthStatus = codexOAuthStatusFromStore(oauthResult.store);

  if (oauthStatus.status === "ready") {
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
      output: formatCodexOAuthFailure("timeout", flowResult.reason, deviceCodeShown)
    };
  }

  if (flowResult.kind === "error") {
    return {
      handled: true,
      exitCode: 1,
      output: formatCodexOAuthFailure("error", flowResult.reason, deviceCodeShown)
    };
  }

  // Write tokens to auth.json
  const updatedStore = {
    ...existingStore,
    providers: {
      ...existingStore.providers,
      codex: buildCodexOAuthTokenRecord(flowResult.tokens)
    }
  };

  await writeOAuthStore(updatedStore, { homeDir: options.homeDir, profileId: options.profileId });

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
      output: formatCodexOAuthFailure("timeout", flowResult.reason, deviceCodeShown)
    };
  }

  if (flowResult.kind === "error") {
    return {
      handled: true,
      exitCode: 1,
      output: formatCodexOAuthFailure("error", flowResult.reason, deviceCodeShown)
    };
  }

  // Load existing store (may be empty) and merge
  const oauthResult = await loadOAuthStore({ homeDir: options.homeDir, profileId: options.profileId });
  const updatedStore = {
    ...oauthResult.store,
    providers: {
      ...oauthResult.store.providers,
      codex: buildCodexOAuthTokenRecord(flowResult.tokens)
    }
  };

  await writeOAuthStore(updatedStore, { homeDir: options.homeDir, profileId: options.profileId });

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
          apiMode: CODEX_API_MODE,
          authMethod: CODEX_OAUTH_AUTH_METHOD
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
