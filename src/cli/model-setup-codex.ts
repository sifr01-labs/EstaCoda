import {withProfileWriteLock} from '../config/profile-write-lock.js';
import {dirname} from 'node:path';
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
  CODEX_OAUTH_AUTH_METHOD,
  codexOAuthStatusFromStore,
  formatCodexOAuthFailure,
  runCodexOAuthFlowWithDeviceCodeNotice,
  type OutputSink,
} from "../providers/oauth/codex-setup.js";
import { fallbackKnownModelProfiles } from "../providers/model-catalog.js";
import { selectModelForProvider } from "../setup/provider-model-route-prompt.js";
import { getProviderMetadata } from "../providers/provider-metadata.js";
import type { Prompt } from "./prompt-contract.js";
import type { CliOptions, CliCommandResult } from "./cli.js";

const CODEX_API_MODE = getProviderMetadata("codex").apiMode;

export type ModelSetupCodexOptions = {
  homeDir?: string;
  profileId?: string;
  /** Model already chosen by the shared route picker. Direct setup prompts when omitted. */
  modelId?: string;
  workspaceRoot: string;
  prompt?: Prompt;
  fetchLike?: FetchLike;
  signal?: AbortSignal;
  output?: OutputSink;
};

export async function runModelSetupCodex(
  options: ModelSetupCodexOptions
): Promise<CliCommandResult> {
  if (options.prompt === undefined) return cancelResult();
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  // Reading the current selection is advisory; the existing save path reports configuration failures.
  const existing = await readConfig(resolveProfileStateHome({ homeDir: options.homeDir, profileId }).configPath).catch(() => undefined);
  const models = fallbackKnownModelProfiles.filter((model) => model.provider === "codex" && model.status !== "deprecated");
  const selection = options.modelId === undefined ? await selectModelForProvider({
    prompt: options.prompt,
    locale: options.prompt.uiContext?.locale === "ar" ? "ar" : "en",
    mode: "primary",
    allowCancel: true,
    currentProviderId: existing?.config.model?.provider,
    currentModelId: existing?.config.model?.id,
  }, {
    id: "codex", displayName: getProviderMetadata("codex").displayName,
    configurable: true, runnable: true, catalogOnly: false, credentialReady: false,
    modelsCount: models.length,
  }, models.map((profile) => ({
    id: profile.id, provider: profile.provider, profile, configured: false,
    executable: true, catalogOnly: false, supportsVision: profile.supportsVision,
    lifecycle: "available", usageClass: "primary-chat",
  }))) : undefined;
  const modelId = options.modelId ?? (selection?.kind === "model" ? selection.model.id : undefined);
  if (modelId === undefined) return cancelResult();
  const selectedOptions = { ...options, profileId, modelId };
  const homeDir = options.homeDir;

  // Read existing auth state
  const oauthResult = await loadOAuthStore({ homeDir, profileId });
  const oauthStatus = codexOAuthStatusFromStore(oauthResult.store);

  if (oauthStatus.status === "ready") {
    return await handleExistingCredentials(selectedOptions, oauthResult.store);
  }

  return await handleNewAuthentication(selectedOptions);
}

async function handleExistingCredentials(
  options: ModelSetupCodexOptions & { modelId: string },
  existingStore: Awaited<ReturnType<typeof loadOAuthStore>>["store"]
): Promise<CliCommandResult> {
  const prompt = options.prompt;

  // Prompt: [1] Use existing [2] Reauthenticate [3] Cancel
  const choice = await askChoice(prompt, [
    { label: "Use existing credentials", value: "use" },
    { label: "Reauthenticate (creates a new OAuth session)", value: "reauth" },
    { label: "Cancel", value: "cancel" }
  ], "Codex credentials found in the selected profile.\n");

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
        `  Model: ${options.modelId}`
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

  await writeOAuthStore(updatedStore, { homeDir: options.homeDir, profileId: options.profileId, expectedStore: existingStore });

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
      `  Model: ${options.modelId}`
    ].join("\n")
  };
}

async function handleNewAuthentication(
  options: ModelSetupCodexOptions & { modelId: string }
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

  await writeOAuthStore(updatedStore, { homeDir: options.homeDir, profileId: options.profileId, expectedStore: oauthResult.store });

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
      `  Model: ${options.modelId}`
    ].join("\n")
  };
}

async function configureCodexRoute(
  options: ModelSetupCodexOptions & { modelId: string }
): Promise<{ ok: true } | { ok: false; message: string }> {
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  const targetPath = resolveProfileStateHome({ homeDir: options.homeDir, profileId }).configPath;

  try {
    return await withProfileWriteLock(dirname(targetPath), async () => {
    const existing = await readConfig(targetPath);

    const config = {
      ...existing.config,
      model: {
        ...existing.config.model,
        provider: "codex" as const,
        id: options.modelId
      },
      providers: {
        ...(existing.config.providers ?? {}),
        codex: {
          ...(existing.config.providers?.codex ?? {}),
          baseUrl: CODEX_DEFAULT_BASE_URL,
          apiMode: CODEX_API_MODE,
          authMethod: CODEX_OAUTH_AUTH_METHOD,
          enableNetwork: true
        }
      }
    };

    await saveRuntimeConfig(targetPath, config);
    return { ok: true as const };
    });
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
