import type { RegisteredTool } from "../contracts/tool.js";
import {
  loadRuntimeConfig,
  setupBrowserConfig,
  setupProviderConfig,
  setupTelegramConfig,
  setupWebConfig,
  type BrowserSetupInput,
  type ProviderSetupInput,
  type TelegramSetupInput,
  type WebSetupInput
} from "./runtime-config.js";
import { diagnoseProviderConfig, renderProviderDiagnostic } from "./provider-diagnostics.js";

export type ConfigToolsOptions = {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
};

export function createConfigTools(options: ConfigToolsOptions): RegisteredTool[] {
  return [
    {
      name: "config.provider.status",
      description: "Show configured EstaCoda provider/model settings and config sources.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      riskClass: "read-only-local",
      toolsets: ["core"],
      progressLabel: "checking provider config",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async () => {
        const loaded = await loadRuntimeConfig(options);
        const diagnostic = await diagnoseProviderConfig(loaded);

        return {
          ok: true,
          content: [
            `Model: ${loaded.model.provider}/${loaded.model.id}`,
            `Web extraction: ${loaded.web.enableNetwork ? "enabled" : "disabled"}`,
            `Browser backend: ${loaded.browser.backend}`,
            `Config sources: ${loaded.sources.join(", ") || "none"}`,
            `Credential pools: ${loaded.credentialPools.snapshots().map((snapshot) => `${snapshot.provider}:${snapshot.entries.length}`).join(", ") || "none"}`,
            "",
            renderProviderDiagnostic(diagnostic)
          ].join("\n"),
          metadata: {
            sources: loaded.sources,
            model: loaded.model,
            web: loaded.web,
            browser: loaded.browser,
            credentialPools: loaded.credentialPools.snapshots(),
            providerDiagnostic: diagnostic
          }
        };
      }
    },
    {
      name: "config.web.setup",
      description: "Configure EstaCoda web extraction network access and extraction limits.",
      inputSchema: {
        type: "object",
        properties: {
          enableNetwork: { type: "boolean" },
          maxContentChars: { type: "number" },
          scope: { type: "string", enum: ["user", "project"] }
        }
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core", "web"],
      progressLabel: "configuring web extraction",
      maxResultSizeChars: 3000,
      isAvailable: () => true,
      run: async (input: WebSetupInput) => {
        const result = await setupWebConfig({
          ...options,
          input
        });

        return {
          ok: true,
          content: [
            `Web extraction ${input.enableNetwork === false ? "disabled" : "enabled"}.`,
            `Wrote ${result.path}.`,
            result.config.web?.maxContentChars === undefined
              ? undefined
              : `Max content chars: ${result.config.web.maxContentChars}`
          ].filter((line) => line !== undefined).join("\n"),
          metadata: {
            path: result.path,
            web: result.config.web
          }
        };
      }
    },
    {
      name: "config.browser.setup",
      description: "Configure EstaCoda browser backend selection and local CDP settings.",
      inputSchema: {
        type: "object",
        properties: {
          backend: { type: "string" },
          cdpUrl: { type: "string" },
          launchCommand: { type: "string" },
          autoLaunch: { type: "boolean" },
          scope: { type: "string", enum: ["user", "project"] }
        }
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core", "browser"],
      progressLabel: "configuring browser backend",
      maxResultSizeChars: 3000,
      isAvailable: () => true,
      run: async (input: BrowserSetupInput) => {
        const result = await setupBrowserConfig({
          ...options,
          input
        });

        return {
          ok: true,
          content: [
            `Browser backend: ${result.config.browser?.backend ?? "unconfigured"}.`,
            result.config.browser?.cdpUrl === undefined ? undefined : `CDP URL: ${result.config.browser.cdpUrl}`,
            result.config.browser?.launchCommand === undefined ? undefined : `Launch command: ${result.config.browser.launchCommand}`,
            `Auto-launch: ${result.config.browser?.autoLaunch === true ? "enabled" : "disabled"}`,
            `Wrote ${result.path}.`
          ].filter((line) => line !== undefined).join("\n"),
          metadata: {
            path: result.path,
            browser: result.config.browser
          }
        };
      }
    },
    {
      name: "config.telegram.setup",
      description: "Configure EstaCoda Telegram channel access through a bot token environment variable.",
      inputSchema: {
        type: "object",
        properties: {
          botTokenEnv: { type: "string" },
          botToken: { type: "string" },
          defaultChatId: { type: "string" },
          allowedUserIds: { type: "array", items: { type: "string" } },
          allowedChatIds: { type: "array", items: { type: "string" } },
          pollTimeoutSeconds: { type: "number" },
          enabled: { type: "boolean" },
          scope: { type: "string", enum: ["user", "project"] }
        }
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core"],
      progressLabel: "configuring Telegram",
      maxResultSizeChars: 5000,
      isAvailable: () => true,
      run: async (input: TelegramSetupInput) => {
        const result = await setupTelegramConfig({
          ...options,
          input
        });

        return {
          ok: true,
          content: [
            `Telegram channel ${input.enabled === false ? "disabled" : "configured"}.`,
            `Wrote ${result.path}.`,
            `Bot token env: ${result.config.channels?.telegram?.botTokenEnv ?? "not set"}`,
            result.config.channels?.telegram?.defaultChatId === undefined
              ? undefined
              : `Default chat: ${result.config.channels.telegram.defaultChatId}`,
            result.envExport === undefined
              ? "API key source: environment variable."
              : `Add this to your shell config:\n${result.envExport}`
          ].filter((line) => line !== undefined).join("\n"),
          metadata: {
            path: result.path,
            telegram: result.config.channels?.telegram,
            envExport: result.envExport
          }
        };
      }
    },
    {
      name: "config.telegram.status",
      description: "Show EstaCoda Telegram channel configuration and readiness.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      riskClass: "read-only-local",
      toolsets: ["core"],
      progressLabel: "checking Telegram config",
      maxResultSizeChars: 3000,
      isAvailable: () => true,
      run: async () => {
        const loaded = await loadRuntimeConfig(options);
        const telegram = loaded.channels.telegram;

        return {
          ok: true,
          content: [
            "Telegram channel",
            `Status: ${telegram.ready ? "ready" : telegram.enabled ? "configured, missing credentials" : "disabled"}`,
            `Enabled: ${telegram.enabled === true ? "yes" : "no"}`,
            telegram.botTokenEnv === undefined ? undefined : `Bot token env: ${telegram.botTokenEnv}`,
            telegram.defaultChatId === undefined ? undefined : `Default chat: ${telegram.defaultChatId}`,
            `Allowed users: ${(telegram.allowedUserIds ?? []).join(", ") || "none"}`,
            `Allowed chats: ${(telegram.allowedChatIds ?? []).join(", ") || "none"}`,
            telegram.missing === undefined ? undefined : `Missing: ${telegram.missing.join(", ")}`
          ].filter((line) => line !== undefined).join("\n"),
          metadata: {
            telegram
          }
        };
      }
    },
    {
      name: "config.provider.setup",
      description: "Configure EstaCoda's model provider, API key environment variable, credential pool, and endpoint.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
          baseUrl: { type: "string" },
          apiKeyEnv: { type: "string" },
          apiKey: { type: "string" },
          enableNetwork: { type: "boolean" },
          scope: { type: "string", enum: ["user", "project"] },
          credentialPoolStrategy: { type: "string" }
        },
        required: ["provider", "model"]
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core"],
      progressLabel: "configuring provider",
      maxResultSizeChars: 6000,
      isAvailable: () => true,
      run: async (input: ProviderSetupInput) => {
        const result = await setupProviderConfig({
          ...options,
          input
        });
        const loaded = await loadRuntimeConfig(options);
        const diagnostic = await diagnoseProviderConfig(loaded);

        return {
          ok: true,
          content: [
            `Configured ${input.provider}/${input.model}.`,
            `Wrote ${result.path}.`,
            result.envExport === undefined
              ? "API key source: environment variable."
              : `Add this to your shell config:\n${result.envExport}`,
            "",
            renderProviderDiagnostic(diagnostic)
          ].filter((line) => line !== undefined).join("\n"),
          metadata: {
            path: result.path,
            provider: input.provider,
            model: input.model,
            envExport: result.envExport,
            providerDiagnostic: diagnostic
          }
        };
      }
    }
  ];
}
