import type { LoadedRuntimeConfig } from "./runtime-config.js";
import { ProviderExecutor } from "../providers/provider-executor.js";

export type ProviderDiagnostic = {
  status: "ready" | "warning" | "blocked";
  lines: string[];
  warnings: string[];
};

export type ProviderLiveDiagnostic = {
  status: "ready" | "blocked";
  lines: string[];
  warnings: string[];
};

export async function diagnoseProviderConfig(config: LoadedRuntimeConfig): Promise<ProviderDiagnostic> {
  const models = await config.providerRegistry.listModels();
  const selectedProvider = config.model.provider;
  const selectedModel = config.model.id;
  const provider = config.providerRegistry.get(selectedProvider);
  const registeredSelectedModel = models.find((model) => model.provider === selectedProvider && model.id === selectedModel);
  const selectedProfile = registeredSelectedModel ?? config.model;
  const warnings: string[] = [];
  const lines: string[] = [
    `Selected route: ${selectedProvider}/${selectedModel}`,
    `Context window: ${formatCount(selectedProfile.contextWindowTokens)} tokens`,
    `Tools: ${selectedProfile.supportsTools ? "yes" : "no"}`,
    `Vision: ${selectedProfile.supportsVision ? "yes" : "no"}`,
    `Structured output: ${selectedProfile.supportsStructuredOutput ? "yes" : "no"}`
  ];

  const route = config.primaryModelRoute;
  if (route?.baseUrl !== undefined) {
    lines.push(`Route baseUrl: ${route.baseUrl}`);
  }
  if (route?.apiKeyEnv !== undefined) {
    lines.push(`Route apiKeyEnv: ${route.apiKeyEnv}`);
    if (process.env[route.apiKeyEnv] === undefined) {
      warnings.push(`Missing env var ${route.apiKeyEnv} for route.`);
    }
  }

  if (selectedProvider === "unconfigured" || selectedModel === "unconfigured") {
    warnings.push("Provider setup is incomplete.");
    lines.push("Provider health: not configured");
  } else if (provider === undefined) {
    warnings.push(`No provider adapter is registered for ${selectedProvider}.`);
    lines.push("Provider health: adapter missing");
  } else if (provider.executable === false) {
    warnings.push(`Provider ${selectedProvider} is registered for model discovery only and is not yet executable.`);
    lines.push("Provider health: not executable");
  } else {
    const health = await provider.health();
    lines.push(`Provider health: ${health.available ? "available" : `blocked (${health.reason ?? "unknown reason"})`}`);

    if (!health.available) {
      warnings.push(humanProviderHealthIssue(health.reason));
    }

    if (!models.some((model) => model.provider === selectedProvider && model.id === selectedModel)) {
      warnings.push(`Configured model ${selectedProvider}/${selectedModel} is not registered in the provider model list.`);
    }
  }

  if (selectedProfile.contextWindowTokens > 0 && selectedProfile.contextWindowTokens < 64_000) {
    warnings.push("Configured model context window is below 64K tokens.");
  }

  const selectedProviderConfig = config.config.providers?.[selectedProvider];
  if (selectedProvider !== "local" && selectedProvider !== "unconfigured") {
    lines.push(`Network inference: ${selectedProviderConfig?.enableNetwork === true ? "enabled" : "disabled"}`);

    if (selectedProviderConfig?.enableNetwork !== true) {
      warnings.push("Network inference is disabled for the selected hosted provider.");
    }
  } else if (selectedProvider === "local") {
    lines.push("Network inference: local OpenAI-compatible route");
  }

  if (selectedProvider !== "local" && selectedProvider !== "unconfigured" && route?.apiKeyEnv === undefined) {
    warnings.push(`No apiKeyEnv is configured for ${selectedProvider}.`);
  }

  const fallbackRoutes = config.modelFallbackRoutes;
  lines.push(`Fallback routes: ${fallbackRoutes.length === 0 ? "none" : fallbackRoutes.map((r) => `${r.provider}/${r.id}`).join(", ")}`);

  const status = warnings.length === 0
    ? "ready"
    : warnings.some((warning) => /incomplete|missing|blocked|disabled|No provider|No credential|No available credential/iu.test(warning))
      ? "blocked"
      : "warning";

  return {
    status,
    lines,
    warnings
  };
}

export function renderProviderDiagnostic(diagnostic: ProviderDiagnostic): string {
  return [
    ...diagnostic.lines,
    diagnostic.warnings.length === 0
      ? "Provider status: ready"
      : `Provider warnings:\n${diagnostic.warnings.map((warning) => `- ${warning}`).join("\n")}`
  ].join("\n");
}

export async function diagnoseProviderLive(config: LoadedRuntimeConfig): Promise<ProviderLiveDiagnostic> {
  if (config.model.provider === "unconfigured" || config.model.id === "unconfigured") {
    return {
      status: "blocked",
      lines: ["Live provider check: skipped"],
      warnings: ["Provider setup is incomplete."]
    };
  }

  const executor = new ProviderExecutor({
    registry: config.providerRegistry
  });
  const execution = await executor.complete({
    provider: config.model.provider,
    model: config.model.id,
    messages: [
      {
        role: "system",
        content: "You are EstaCoda. This is a provider connectivity check."
      },
      {
        role: "user",
        content: "Reply with exactly: OK"
      }
    ],
    temperature: 0.2,
    maxTokens: 8
  }, {
    providerOrder: [config.model.provider]
  }, {
    primaryRoute: config.primaryModelRoute
  });
  const attemptSummary = execution.attempts.map((attempt) =>
    `${attempt.provider}/${attempt.model}:${attempt.ok ? "ok" : attempt.errorClass ?? "failed"}`
  );

  if (execution.ok && execution.response !== undefined) {
    return {
      status: "ready",
      lines: [
        "Live provider check: ready",
        `Response provider: ${execution.response.provider}/${execution.response.model}`,
        `Response text: ${execution.response.content.trim() || "[empty]"}`,
        `Attempts: ${attemptSummary.join(", ") || "none"}`
      ],
      warnings: []
    };
  }

  return {
    status: "blocked",
    lines: [
      "Live provider check: blocked",
      `Attempts: ${attemptSummary.join(", ") || "none"}`
    ],
    warnings: [
      execution.attempts.at(-1)?.content ?? "Provider live check failed before receiving a response."
    ]
  };
}

export function renderProviderLiveDiagnostic(diagnostic: ProviderLiveDiagnostic): string {
  return [
    ...diagnostic.lines,
    diagnostic.warnings.length === 0
      ? "Live provider status: ready"
      : `Live provider warnings:\n${diagnostic.warnings.map((warning) => `- ${warning}`).join("\n")}`
  ].join("\n");
}

function humanProviderHealthIssue(reason: string | undefined): string {
  if (reason === undefined) {
    return "Provider health check failed.";
  }

  const missingEnv = /Missing\s+([A-Z0-9_]+)/u.exec(reason)?.[1];
  if (missingEnv !== undefined) {
    return `Missing API key environment variable ${missingEnv}.`;
  }

  return reason;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }

  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  return String(value);
}
