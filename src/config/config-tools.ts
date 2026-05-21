import type { RegisteredTool, SessionToolProvider } from "../contracts/tool.js";
import type { SessionDB } from "../contracts/session.js";
import { buildCompressionStatusReport, renderCompressionStatusReport } from "./compression-status.js";
import {
  loadRuntimeConfig,
  setupMcpConfig,
  setupBrowserConfig,
  setupImageGenerationConfig,
  setupProviderConfig,
  setupSecurityConfig,
  setupTelegramConfig,
  setupWebConfig,
  type BrowserSetupInput,
  type ImageGenerationSetupInput,
  type MCPSetupInput,
  type ProviderSetupInput,
  type SecuritySetupInput,
  type TelegramSetupInput,
  type WebSetupInput
} from "./runtime-config.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "./profile-home.js";
import { diagnoseProviderConfig, renderProviderDiagnostic } from "./provider-diagnostics.js";

export type ConfigToolsOptions = {
  workspaceRoot: string;
  homeDir?: string;
  profileId?: string;
  sessionId?: string | (() => string);
  sessionDb?: Pick<SessionDB, "listEvents">;
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
            "",
            renderProviderDiagnostic(diagnostic)
          ].join("\n"),
          metadata: {
            sources: loaded.sources,
            model: loaded.model,
            web: loaded.web,
            browser: loaded.browser,
            providerDiagnostic: diagnostic
          }
        };
      }
    },
    {
      name: "config.security.status",
      description: "Show configured EstaCoda approval mode and security config sources.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      riskClass: "read-only-local",
      toolsets: ["core"],
      progressLabel: "checking security config",
      maxResultSizeChars: 3000,
      isAvailable: () => true,
      run: async () => {
        const loaded = await loadRuntimeConfig(options);
        return {
          ok: true,
          content: [
            "EstaCoda security",
            `Approval mode: ${loaded.security.approvalMode}`,
            `Assessor: ${loaded.security.assessor.enabled ? "enabled" : "disabled"}`,
            loaded.security.assessor.provider === undefined ? undefined : `Assessor provider: ${loaded.security.assessor.provider}`,
            loaded.security.assessor.model === undefined ? undefined : `Assessor model: ${loaded.security.assessor.model}`,
            `Assessor timeout ms: ${loaded.security.assessor.timeoutMs}`,
            `Config sources: ${loaded.sources.join(", ") || "none"}`
          ].filter((line) => line !== undefined).join("\n"),
          metadata: {
            sources: loaded.sources,
            security: loaded.security
          }
        };
      }
    },
    {
      name: "config.compression.status",
      description: "Show read-only semantic compression config, auxiliary route, and current session compression diagnostics.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      riskClass: "read-only-local",
      toolsets: ["core"],
      progressLabel: "checking compression config",
      maxResultSizeChars: 5000,
      isAvailable: () => true,
      run: async () => {
        const loaded = await loadRuntimeConfig(options);
        const status = await buildCompressionStatusReport({
          loaded,
          sessionDb: options.sessionDb,
          sessionId: typeof options.sessionId === "function" ? options.sessionId() : options.sessionId
        });

        return {
          ok: true,
          content: renderCompressionStatusReport(status),
          metadata: {
            compressionStatus: status
          }
        };
      }
    },
    {
      name: "config.security.setup",
      description: "Configure EstaCoda approval mode.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["strict", "adaptive", "open", "manual", "smart", "off"] },
          assessorEnabled: { type: "boolean" },
          assessorProvider: { type: "string" },
          assessorModel: { type: "string" },
          assessorTimeoutMs: { type: "number" },
        }
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core"],
      progressLabel: "configuring security mode",
      maxResultSizeChars: 3000,
      isAvailable: () => true,
      run: async (input: SecuritySetupInput) => {
        const result = await setupSecurityConfig({
          ...options,
          input
        });
        const loaded = await loadRuntimeConfig(options);

        return {
          ok: true,
          content: [
            `Requested approval mode: ${input.mode ?? "unchanged"}.`,
            `Effective approval mode: ${loaded.security.approvalMode}.`,
            `Effective assessor: ${loaded.security.assessor.enabled ? "enabled" : "disabled"}.`,
            `Wrote ${result.path}.`
          ].join("\n"),
          metadata: {
            path: result.path,
            requested: redactConfigToolInput(input),
            security: loaded.security
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
      name: "config.mcp.status",
      description: "Show configured MCP servers and config sources.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      riskClass: "read-only-local",
      toolsets: ["core", "mcp"],
      progressLabel: "checking MCP config",
      maxResultSizeChars: 5000,
      isAvailable: () => true,
      run: async () => {
        const loaded = await loadRuntimeConfig(options);
        const servers = Object.entries(loaded.mcp.servers);
        return {
          ok: true,
          content: servers.length === 0
            ? [
                "MCP servers",
                "No MCP servers configured.",
                `Config sources: ${loaded.sources.join(", ") || "none"}`
              ].join("\n")
            : [
                "MCP servers",
                ...servers.map(([name, server]) =>
                  [
                    `${name}`,
                    `  enabled: ${server.enabled === false ? "no" : "yes"}`,
                    `  transport: ${server.transport ?? "stdio"}`,
                    `  trust: ${server.trust ?? "conservative"}`,
                    server.command === undefined ? undefined : `  command: ${server.command}`,
                    server.url === undefined ? undefined : `  url: ${server.url}`,
                    server.args === undefined ? undefined : `  args: ${server.args.join(" ") || "(none)"}`,
                    server.cwd === undefined ? undefined : `  cwd: ${server.cwd}`
                  ].filter((line) => line !== undefined).join("\n")
                ),
                `Config sources: ${loaded.sources.join(", ") || "none"}`
              ].join("\n"),
          metadata: {
            servers: loaded.mcp.servers,
            sources: loaded.sources
          }
        };
      }
    },
    {
      name: "config.mcp.setup",
      description: "Configure an MCP server entry for EstaCoda runtime discovery.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          transport: { type: "string", enum: ["stdio", "http"] },
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
          url: { type: "string" },
          includeTools: { type: "array", items: { type: "string" } },
          excludeTools: { type: "array", items: { type: "string" } },
          exposeResources: { type: "boolean" },
          exposePrompts: { type: "boolean" },
          toolPrefix: { anyOf: [{ type: "string" }, { type: "boolean" }] },
          timeoutMs: { type: "number" },
          connectTimeoutMs: { type: "number" },
          env: { type: "object", additionalProperties: { type: "string" } },
          headers: { type: "object", additionalProperties: { type: "string" } },
          trust: { type: "string", enum: ["conservative", "read-only-network", "read-only-local"] },
          toolRiskClass: {
            type: "string",
            enum: ["read-only-local", "read-only-network", "workspace-write", "external-side-effect", "credential-access", "destructive-local", "shared-state-mutation", "spend-money", "sandbox-escape"]
          },
          resourceReadRiskClass: {
            type: "string",
            enum: ["read-only-local", "read-only-network", "workspace-write", "external-side-effect", "credential-access", "destructive-local", "shared-state-mutation", "spend-money", "sandbox-escape"]
          },
          promptGetRiskClass: {
            type: "string",
            enum: ["read-only-local", "read-only-network", "workspace-write", "external-side-effect", "credential-access", "destructive-local", "shared-state-mutation", "spend-money", "sandbox-escape"]
          },
          enabled: { type: "boolean" },
        },
        required: ["name"]
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core", "mcp"],
      progressLabel: "configuring MCP",
      maxResultSizeChars: 5000,
      isAvailable: () => true,
      run: async (input: MCPSetupInput) => {
        const result = await setupMcpConfig({
          ...options,
          input
        });
        return {
          ok: true,
          content: [
            `Configured MCP server ${input.name}.`,
            `Wrote ${result.path}.`,
            `Transport: ${input.transport ?? "stdio"}`,
            `Trust: ${input.trust ?? "conservative"}`,
            input.command === undefined ? undefined : `Command: ${input.command}`,
            input.url === undefined ? undefined : `URL: ${input.url}`,
            input.args === undefined ? undefined : `Args: ${input.args.join(" ") || "(none)"}`
          ].filter((line) => line !== undefined).join("\n"),
          metadata: {
            path: result.path,
            servers: result.config.mcpServers
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
        const loaded = await loadRuntimeConfig(options);
        const telegram = loaded.channels.telegram;

        return {
          ok: true,
          content: [
            `Telegram channel ${input.enabled === false ? "disabled" : "configured"}.`,
            `Effective status: ${telegram.ready ? "ready" : telegram.enabled ? "configured, missing credentials" : "disabled"}.`,
            `Effective bot token env: ${telegram.botTokenEnv ?? "not set"}.`,
            `Wrote ${result.path}.`,
            result.secretPath === undefined ? undefined : `Secret store: ${result.secretPath}`,
            telegram.defaultChatId === undefined
              ? undefined
              : `Default chat: ${telegram.defaultChatId}`,
            result.secretPath === undefined ? "Bot token source: environment variable." : undefined
          ].filter((line) => line !== undefined).join("\n"),
          metadata: {
            path: result.path,
            requested: redactConfigToolInput(input),
            telegram,
            secretPath: result.secretPath
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
      name: "config.image.status",
      description: "Show configured EstaCoda image generation provider, model, cache, and key environment.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      riskClass: "read-only-local",
      toolsets: ["core", "media"],
      progressLabel: "checking image config",
      maxResultSizeChars: 3000,
      isAvailable: () => true,
      run: async () => {
        const loaded = await loadRuntimeConfig(options);
        const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
        const profilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId });
        const key = loaded.imageGen.apiKeyEnv;
        return {
          ok: true,
          content: [
            "EstaCoda image generation",
            `Provider: ${loaded.imageGen.provider}`,
            `Model: ${loaded.imageGen.model}`,
            `Gateway: ${loaded.imageGen.useGateway ? "yes" : "no"}`,
            `API key env: ${key}`,
            `Base URL: ${loaded.imageGen.baseUrl}`,
            `Cache: ${profilePaths.imageCachePath}`
          ].join("\n"),
          metadata: {
            imageGen: loaded.imageGen,
            apiKeyEnv: key
          }
        };
      }
    },
    {
      name: "config.provider.setup",
      description: "Configure EstaCoda's model provider, API key environment variable, and endpoint.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
          baseUrl: { type: "string" },
          apiKeyEnv: { type: "string" },
          apiKey: { type: "string" },
          enableNetwork: { type: "boolean" },
          primary: { type: "boolean" }
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
            `Requested: ${input.provider}/${input.model}`,
            `Effective: ${loaded.model.provider}/${loaded.model.id}`,
            `Wrote ${result.path}.`,
            result.secretPath === undefined ? "API key source: environment variable." : `Secret store: ${result.secretPath}`,
            "",
            renderProviderDiagnostic(diagnostic)
          ].filter((line) => line !== undefined).join("\n"),
          metadata: {
            path: result.path,
            requested: redactConfigToolInput(input),
            effective: loaded.model,
            secretPath: result.secretPath,
            providerDiagnostic: diagnostic
          }
        };
      }
    },
    {
      name: "config.image.setup",
      description: "Configure image generation provider/model and API key environment for EstaCoda runtime discovery.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["fal", "byteplus"] },
          model: { type: "string" },
          modelVersion: { type: "string", description: "Friendly model alias such as seedream-5, seedream-4.5, or seedream-4." },
          apiKeyEnv: { type: "string" },
          apiKey: { type: "string" },
          baseUrl: { type: "string" },
          useGateway: { type: "boolean" },
        }
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core", "media"],
      progressLabel: "configuring image generation",
      maxResultSizeChars: 5000,
      isAvailable: () => true,
      run: async (input: ImageGenerationSetupInput) => {
        const result = await setupImageGenerationConfig({
          ...options,
          input
        });
        const loaded = await loadRuntimeConfig(options);
        return {
          ok: true,
          content: [
            "Configured EstaCoda image generation.",
            `Requested provider: ${input.provider ?? "unchanged"}`,
            `Effective provider: ${loaded.imageGen.provider}`,
            `Effective model: ${loaded.imageGen.model}`,
            `Effective API key env: ${loaded.imageGen.apiKeyEnv}`,
            `Effective base URL: ${loaded.imageGen.baseUrl}`,
            `Wrote ${result.path}.`,
            result.secretPath === undefined ? undefined : `Secret store: ${result.secretPath}`,
            result.secretPath === undefined ? "API key source: environment variable." : undefined
          ].filter((line) => line !== undefined).join("\n"),
          metadata: {
            path: result.path,
            requested: redactConfigToolInput(input),
            imageGen: loaded.imageGen,
            secretPath: result.secretPath
          }
        };
      }
    }
  ];
}

export const configToolProvider: SessionToolProvider = {
  name: "config",
  kind: "session",
  createTools(ctx) {
    return createConfigTools({
      workspaceRoot: ctx.workspaceRoot,
      homeDir: ctx.homeDir,
      profileId: ctx.profileId,
      sessionId: ctx.currentSessionId,
      sessionDb: requireProviderDependency("config", "sessionDb", ctx.sessionDb)
    });
  }
};

function requireProviderDependency<T>(provider: string, dependency: string, value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError(`${provider}ToolProvider requires ${dependency}.`);
  }
  return value;
}

function redactConfigToolInput<T extends Record<string, unknown>>(input: T): T {
  const redacted: Record<string, unknown> = { ...input };
  for (const key of ["apiKey", "botToken", "ttsApiKey", "sttApiKey"]) {
    if (typeof redacted[key] === "string" && redacted[key].length > 0) {
      redacted[key] = "[redacted]";
    }
  }
  return redacted as T;
}
