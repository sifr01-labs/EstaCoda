import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelProfile, ProviderExecutionSummary } from "../contracts/provider.js";
import type { SessionEvent, SessionModelOverride } from "../contracts/session.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { resolveProfileStateHome } from "./profile-home.js";
import { createConfigTools } from "../tools/config-tools.js";

type CompressionStatusMetadata = {
  compressionStatus: {
    config: {
      enabled: boolean;
      effectiveEnabled: boolean;
      experimental: boolean;
      active: boolean;
      threshold: number;
      targetRatio: number;
      protectFirstN: number;
      protectLastN: number;
      summaryModelContextLength?: number;
    };
    auxiliaryRoute: {
      configured: boolean;
      resolved: boolean;
      provider?: string;
      model?: string;
      timeoutMs?: number;
      fallbackToMain: boolean;
      diagnostics: string[];
    };
    session?: {
      available: boolean;
      state?: {
        compressionCount: number;
        lastCompressedAt?: string;
        lastCompressedThroughMessageId?: string;
        lastPromptTokensEstimated?: number;
        lastActualPromptTokens?: number;
        lastCompressionSavingsPct?: number;
        ineffectiveCompressionCount: number;
        recentSavingsRatios?: number[];
        summaryFailureCooldownUntil?: string;
        latestFallbackReason?: string;
        warningCount: number;
      };
      latestEvent?: {
        trigger?: string;
        mode: string;
        fallbackUsed?: boolean;
        fallbackReason?: string;
        modelUsed?: string;
        summaryLengthTokens?: number;
        sourceMessageCount?: number;
        protectedMessageCount?: number;
        droppedMessageCount?: number;
        warningCount: number;
        failure?: { code: string; message: string };
      };
    };
  };
};

type ProviderStatusMetadata = {
  model: ModelProfile;
  profileModel: ModelProfile;
  effectiveModel: {
    provider: string;
    id: string;
    sessionOverride: boolean;
  };
  sessionModelOverride?: {
    provider: string;
    id: string;
    setAt: string;
    source: string;
  };
  sessionModelOverrideStatus: "none" | "active" | "ignored";
  sessionModelOverrideMessage?: string;
  providerExecution?: ProviderExecutionSummary;
};

describe("config.provider.status", () => {
  it("reports profile config when no session override exists", async () => {
    const homeDir = await configHome(localModelConfig({
      primaryModel: "qwen2.5:3b",
      models: ["qwen2.5:3b", "phi4:latest"]
    }));

    const result = await runProviderStatusTool({ homeDir });
    const status = providerMetadata(result);

    expect(result.content).toContain("Model: local/qwen2.5:3b");
    expect(result.content).toContain("Selected route: local/qwen2.5:3b");
    expect(result.content).not.toContain("session override");
    expect(result.content).not.toContain("Profile config:");
    expect(status.effectiveModel).toEqual({
      provider: "local",
      id: "qwen2.5:3b",
      sessionOverride: false
    });
    expect(status.profileModel.id).toBe("qwen2.5:3b");
    expect(status.sessionModelOverrideStatus).toBe("none");
  });

  it("reports valid session model override as the effective model", async () => {
    const homeDir = await configHome(localModelConfig({
      primaryModel: "qwen2.5:3b",
      models: ["qwen2.5:3b", "phi4:latest"]
    }));
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "session-1", profileId: "default" });
    await sessionDb.setSessionModelOverride("session-1", sessionOverride("phi4:latest"));

    const result = await runProviderStatusTool({
      homeDir,
      sessionId: "session-1",
      sessionDb
    });
    const status = providerMetadata(result);

    expect(result.content).toContain("Model: local/phi4:latest (session override)");
    expect(result.content).toContain("Profile config: local/qwen2.5:3b");
    expect(result.content).toContain("Selected route: local/phi4:latest");
    expect(result.content).not.toContain("Selected route: local/qwen2.5:3b");
    expect(status.effectiveModel).toEqual({
      provider: "local",
      id: "phi4:latest",
      sessionOverride: true
    });
    expect(status.model.id).toBe("phi4:latest");
    expect(status.profileModel.id).toBe("qwen2.5:3b");
    expect(status.sessionModelOverride).toEqual({
      provider: "local",
      id: "phi4:latest",
      setAt: "2026-06-15T00:00:00.000Z",
      source: "cli"
    });
    expect(status.sessionModelOverrideStatus).toBe("active");
  });

  it("reports ignored stale session model override", async () => {
    const homeDir = await configHome(localModelConfig({
      primaryModel: "qwen2.5:3b",
      models: ["qwen2.5:3b"]
    }));
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "session-1", profileId: "default" });
    await sessionDb.setSessionModelOverride("session-1", sessionOverride("missing-model"));

    const result = await runProviderStatusTool({
      homeDir,
      sessionId: "session-1",
      sessionDb
    });
    const status = providerMetadata(result);

    expect(result.content).toContain("Model: local/qwen2.5:3b");
    expect(result.content).toContain("Session override ignored:");
    expect(result.content).toContain("Stored session override: local/missing-model");
    expect(result.content).toContain("Selected route: local/qwen2.5:3b");
    expect(status.effectiveModel).toEqual({
      provider: "local",
      id: "qwen2.5:3b",
      sessionOverride: false
    });
    expect(status.sessionModelOverride).toEqual({
      provider: "local",
      id: "missing-model",
      setAt: "2026-06-15T00:00:00.000Z",
      source: "cli"
    });
    expect(status.sessionModelOverrideStatus).toBe("ignored");
    expect(status.sessionModelOverrideMessage).toContain("Stored model override is no longer present");
  });

  it("includes sanitized latest provider execution truth when available", async () => {
    const homeDir = await configHome(localModelConfig({
      primaryModel: "kimi-k2.7-code",
      models: ["kimi-k2.7-code", "deepseek-v4-pro"]
    }));
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "session-1", profileId: "default" });
    await sessionDb.appendMessage({
      sessionId: "session-1",
      role: "agent",
      content: "fallback response",
      metadata: {
        providerExecution: providerExecutionMetadataWithCredentialLeak()
      }
    });

    const result = await runProviderStatusTool({
      homeDir,
      sessionId: "session-1",
      sessionDb
    });
    const status = providerMetadata(result);
    const serialized = JSON.stringify(status.providerExecution);

    expect(result.content).toContain("Health check: env/config only, not a live inference check.");
    expect(result.content).toContain("provider: deepseek/deepseek-v4-pro");
    expect(result.content).toContain("provider fallback used: local/kimi-k2.7-code failed with rate-limit");
    expect(status.providerExecution).toMatchObject({
      status: "fallback-success",
      fallbackUsed: true,
      primaryFailureClass: "rate-limit",
      actual: {
        provider: "deepseek",
        model: "deepseek-v4-pro"
      },
      attempts: [
        {
          provider: "local",
          model: "kimi-k2.7-code",
          ok: false,
          errorClass: "rate-limit"
        },
        {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          ok: true
        }
      ]
    });
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("SECRET");
    expect(result.content).not.toContain("credential");
    expect(result.content).not.toContain("SECRET");
  });

  it("does not print malicious latest execution tokens in provider status", async () => {
    const homeDir = await configHome(localModelConfig({
      primaryModel: "kimi-k2.7-code",
      models: ["kimi-k2.7-code", "deepseek-v4-pro"]
    }));
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "session-1", profileId: "default" });
    await sessionDb.appendMessage({
      sessionId: "session-1",
      role: "agent",
      content: "fallback response",
      metadata: {
        providerExecution: maliciousProviderExecutionMetadata()
      }
    });

    const result = await runProviderStatusTool({
      homeDir,
      sessionId: "session-1",
      sessionDb
    });
    const serialized = JSON.stringify(providerMetadata(result).providerExecution);

    expect(result.content).toContain("provider: deepseek/deepseek-v4-pro");
    expect(result.content).toContain("provider fallback used: unknown/unknown failed with unknown");
    for (const unsafe of ["ignore previous", "[deepseek]", "${", "rate-limit leak", "SECRET_RAW_ERROR_BODY"]) {
      expect(result.content).not.toContain(unsafe);
      expect(serialized).not.toContain(unsafe);
    }
  });
});

describe("config.provider.execution_status", () => {
  it("reports no latest execution without making a live check", async () => {
    const homeDir = await configHome(localModelConfig({
      primaryModel: "qwen2.5:3b",
      models: ["qwen2.5:3b"]
    }));

    const result = await runProviderExecutionStatusTool({ homeDir });

    expect(result.content).toContain("Health check: env/config only, not a live inference check.");
    expect(result.content).toContain("Last execution:\nnone recorded for this session");
    expect(result.metadata?.providerExecution).toBeUndefined();
  });

  it("reads the latest agent provider execution metadata and strips credential-like fields", async () => {
    const homeDir = await configHome(localModelConfig({
      primaryModel: "kimi-k2.7-code",
      models: ["kimi-k2.7-code", "deepseek-v4-pro"]
    }));
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "session-1", profileId: "default" });
    await sessionDb.appendMessage({
      sessionId: "session-1",
      role: "agent",
      content: "older primary response",
      metadata: {
        providerExecution: {
          configuredPrimary: { provider: "local", model: "kimi-k2.7-code" },
          actual: { provider: "local", model: "kimi-k2.7-code" },
          fallbackUsed: false,
          attempts: [{ provider: "local", model: "kimi-k2.7-code", ok: true }],
          status: "primary-success"
        }
      }
    });
    await sessionDb.appendMessage({
      sessionId: "session-1",
      role: "agent",
      content: "latest fallback response",
      metadata: {
        providerExecution: providerExecutionMetadataWithCredentialLeak()
      }
    });

    const result = await runProviderExecutionStatusTool({
      homeDir,
      sessionId: "session-1",
      sessionDb
    });
    const execution = result.metadata?.providerExecution as ProviderExecutionSummary | undefined;
    const serialized = JSON.stringify(result.metadata?.providerExecution);

    expect(result.content).toContain("Configured provider route:");
    expect(result.content).toContain("Fallback routes: none");
    expect(result.content).toContain("provider: deepseek/deepseek-v4-pro");
    expect(result.content).toContain("provider fallback used: local/kimi-k2.7-code failed with rate-limit");
    expect(execution?.status).toBe("fallback-success");
    expect(execution?.actual?.provider).toBe("deepseek");
    expect(execution?.attempts[0]).toMatchObject({
      provider: "local",
      model: "kimi-k2.7-code",
      ok: false,
      errorClass: "rate-limit"
    });
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("SECRET");
    expect(result.content).not.toContain("credential");
    expect(result.content).not.toContain("SECRET");
  });

  it("sanitizes malicious persisted provider execution tokens before rendering", async () => {
    const homeDir = await configHome(localModelConfig({
      primaryModel: "kimi-k2.7-code",
      models: ["kimi-k2.7-code", "deepseek-v4-pro"]
    }));
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "session-1", profileId: "default" });
    await sessionDb.appendMessage({
      sessionId: "session-1",
      role: "agent",
      content: "latest fallback response",
      metadata: {
        providerExecution: maliciousProviderExecutionMetadata()
      }
    });

    const result = await runProviderExecutionStatusTool({
      homeDir,
      sessionId: "session-1",
      sessionDb
    });
    const execution = result.metadata?.providerExecution as ProviderExecutionSummary | undefined;
    const serialized = JSON.stringify(execution);

    expect(result.content).toContain("provider: deepseek/deepseek-v4-pro");
    expect(result.content).toContain("provider fallback used: unknown/unknown failed with unknown");
    expect(execution?.actual).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
    expect(execution?.attempts[0]).toMatchObject({ provider: "unknown", model: "unknown", ok: false });
    expect(execution?.attempts).toContainEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      ok: true,
      routeRole: "fallback",
      attemptedRouteIndex: 1
    });
    for (const unsafe of ["ignore previous", "[deepseek]", "${", "rate-limit leak", "SECRET_RAW_ERROR_BODY", "SECRET_PRIMARY_CREDENTIAL"]) {
      expect(result.content).not.toContain(unsafe);
      expect(serialized).not.toContain(unsafe);
    }
  });
});

describe("config.compression.status", () => {
  it("reports default disabled compression without session state", async () => {
    const homeDir = await configHome({ model: { provider: "openai", id: "gpt-4o" } });
    const result = await runCompressionStatusTool({ homeDir });

    const status = metadata(result).compressionStatus;
    expect(status.config).toMatchObject({
      enabled: false,
      effectiveEnabled: false,
      experimental: false,
      active: false,
      threshold: 0.5,
      targetRatio: 0.2,
      protectFirstN: 3,
      protectLastN: 20
    });
    expect(status.auxiliaryRoute.configured).toBe(false);
    expect(status.session).toBeUndefined();
    expect(result.content).toContain("Active: no");
  });

  it("shows active false when config requests enabled but experimental is false", async () => {
    const homeDir = await configHome({
      model: { provider: "openai", id: "gpt-4o" },
      compression: {
        enabled: true,
        experimental: false
      }
    });

    const result = await runCompressionStatusTool({ homeDir });

    expect(metadata(result).compressionStatus.config).toMatchObject({
      enabled: true,
      effectiveEnabled: false,
      experimental: false,
      active: false
    });
  });

  it("reports active normalized compression values and auxiliary route without secrets", async () => {
    const homeDir = await configHome({
      model: { provider: "openai", id: "gpt-4o", contextWindowTokens: 128_000 },
      compression: {
        enabled: true,
        experimental: true,
        threshold: 0.99,
        targetRatio: "0.05",
        protectFirstN: "2",
        protectLastN: 0,
        summaryModelContextLength: "64000"
      },
      auxiliaryModels: {
        compression: {
          provider: "openai",
          id: "gpt-4o-mini",
          timeoutMs: 4321,
          fallbackToMain: true,
          apiKeyEnv: "SECRET_COMPRESSION_KEY"
        }
      }
    });

    const result = await runCompressionStatusTool({ homeDir });
    const status = metadata(result).compressionStatus;

    expect(status.config).toMatchObject({
      enabled: true,
      effectiveEnabled: true,
      experimental: true,
      active: true,
      threshold: 0.95,
      targetRatio: 0.1,
      protectFirstN: 2,
      protectLastN: 1,
      summaryModelContextLength: 64_000
    });
    expect(status.auxiliaryRoute).toMatchObject({
      configured: true,
      resolved: true,
      provider: "openai",
      model: "gpt-4o-mini",
      timeoutMs: 4321,
      fallbackToMain: true
    });
    expect(JSON.stringify(status)).not.toContain("SECRET_COMPRESSION_KEY");
    expect(result.content).not.toContain("SECRET_COMPRESSION_KEY");
  });

  it("works when the auxiliary compression route is explicitly missing", async () => {
    const homeDir = await configHome({
      model: { provider: "openai", id: "gpt-4o" },
      auxiliaryModels: {
        compression: {
          enabled: false,
          provider: "openai",
          id: "gpt-4o-mini"
        }
      }
    });

    const result = await runCompressionStatusTool({ homeDir });
    const status = metadata(result).compressionStatus;

    expect(status.auxiliaryRoute).toMatchObject({
      configured: true,
      resolved: false,
      fallbackToMain: false
    });
    expect(status.auxiliaryRoute.diagnostics.join("\n")).toContain("Slot is explicitly disabled");
  });

  it("reads latest session compression state and event without exposing previous summary", async () => {
    const homeDir = await configHome({
      model: { provider: "openai", id: "gpt-4o" },
      compression: { enabled: true, experimental: true }
    });
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "session-1", profileId: "default" });
    await sessionDb.appendEvent("session-1", {
      kind: "session-history-compressed",
      trigger: "manual",
      source: { startMessageId: "m1", endMessageId: "m10", messageCount: 8, estimatedTokens: 12_000 },
      sourceMessageCount: 10,
      protectedFirstN: 1,
      protectedLastN: 2,
      protectedMessageCount: 3,
      summaryFormatVersion: "v1",
      summaryChars: 1200,
      summaryLengthTokens: 300,
      droppedMessageCount: 6,
      fallbackUsed: true,
      fallbackReason: "deterministic fallback",
      modelUsed: "gpt-4o-mini",
      warnings: ["bounded warning"]
    });
    await sessionDb.appendEvent("session-1", {
      kind: "session-compression-state",
      state: {
        compressionCount: 7,
        lastCompressedAt: "2026-05-20T00:00:00.000Z",
        previousSummary: "previous summary with TOKEN=secretsecretsecretsecretsecret",
        lastCompressedThroughMessageId: "m10",
        lastPromptTokensEstimated: 111,
        lastActualPromptTokens: 99,
        lastCompressionSavingsPct: 42,
        ineffectiveCompressionCount: 1,
        recentSavingsRatios: [0.4, 0.42],
        summaryFailureCooldownUntil: "2026-05-20T00:01:00.000Z",
        fallbackReason: "deterministic fallback",
        warnings: ["raw warning should not be listed"]
      }
    });

    const before = await sessionDb.listEvents("session-1");
    const result = await runCompressionStatusTool({ homeDir, sessionDb, sessionId: "session-1" });
    const after = await sessionDb.listEvents("session-1");
    const status = metadata(result).compressionStatus;

    expect(after).toEqual(before);
    expect(status.session?.state).toMatchObject({
      compressionCount: 7,
      lastCompressedAt: "2026-05-20T00:00:00.000Z",
      lastCompressedThroughMessageId: "m10",
      lastPromptTokensEstimated: 111,
      lastActualPromptTokens: 99,
      lastCompressionSavingsPct: 42,
      ineffectiveCompressionCount: 1,
      recentSavingsRatios: [0.4, 0.42],
      summaryFailureCooldownUntil: "2026-05-20T00:01:00.000Z",
      latestFallbackReason: "deterministic fallback",
      warningCount: 1
    });
    expect(status.session?.latestEvent).toMatchObject({
      trigger: "manual",
      mode: "deterministic",
      fallbackUsed: true,
      fallbackReason: "deterministic fallback",
      modelUsed: "gpt-4o-mini",
      summaryLengthTokens: 300,
      sourceMessageCount: 10,
      protectedMessageCount: 3,
      droppedMessageCount: 6,
      warningCount: 1
    });
    expect(JSON.stringify(status)).not.toContain("previous summary");
    expect(JSON.stringify(status)).not.toContain("secretsecret");
  });

  it("handles malformed state and redacts bounded latest event failures", async () => {
    const homeDir = await configHome({ model: { provider: "openai", id: "gpt-4o" } });
    const listEvents = vi.fn(async () => [
      {
        kind: "session-compression-state",
        state: {
          compressionCount: "bad",
          previousSummary: "TOKEN=secretsecretsecretsecretsecret",
          warnings: ["warning TOKEN=secretsecretsecretsecretsecret"]
        }
      },
      {
        kind: "session-history-compressed",
        trigger: "auto",
        fallbackReason: "api_key=secretsecretsecretsecretsecret " + "x".repeat(500),
        warnings: ["raw warning TOKEN=secretsecretsecretsecretsecret"],
        failure: {
          code: "provider",
          message: "TOKEN=secretsecretsecretsecretsecret " + "x".repeat(500)
        }
      }
    ] as unknown as SessionEvent[]);

    const result = await runCompressionStatusTool({
      homeDir,
      sessionId: "session-1",
      sessionDb: { listEvents }
    });
    const status = metadata(result).compressionStatus;
    const statusJson = JSON.stringify(status);

    expect(status.session?.state?.compressionCount).toBe(0);
    expect(status.session?.latestEvent?.failure?.message).toContain("TOKEN=[REDACTED]");
    expect(status.session?.latestEvent?.failure?.message.length).toBeLessThan(320);
    expect(status.session?.latestEvent?.fallbackReason).toContain("api_key=[REDACTED]");
    expect(statusJson).not.toContain("secretsecret");
    expect(statusJson).not.toContain("raw warning TOKEN");
  });

  it("does not expose a compression setup tool", () => {
    const tools = createConfigTools({ workspaceRoot: "/tmp/workspace", homeDir: "/tmp/home" });
    expect(tools.map((tool) => tool.name)).toContain("config.compression.status");
    expect(tools.map((tool) => tool.name)).not.toContain("config.compression.setup");
  });
});

async function configHome(config: Record<string, unknown>): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), "estacoda-compression-status-"));
  const configPath = resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config), "utf8");
  return homeDir;
}

function localModelConfig(input: { primaryModel: string; models: string[] }): Record<string, unknown> {
  return {
    model: {
      provider: "local",
      id: input.primaryModel
    },
    providers: {
      local: {
        models: input.models
      }
    }
  };
}

function sessionOverride(modelId: string): SessionModelOverride {
  const profile = modelProfile(modelId);
  return {
    route: {
      provider: "local",
      id: modelId,
      contextWindowTokens: profile.contextWindowTokens,
      authMethod: "none"
    },
    modelProfile: profile,
    setAt: "2026-06-15T00:00:00.000Z",
    source: "cli"
  };
}

function modelProfile(modelId: string): ModelProfile {
  return {
    provider: "local",
    id: modelId,
    contextWindowTokens: 8192,
    supportsTools: false,
    supportsVision: false,
    supportsStructuredOutput: false
  };
}

async function runProviderStatusTool(input: {
  homeDir: string;
  sessionDb?: Pick<InMemorySessionDB, "listEvents" | "getSessionModelOverride" | "listMessages">;
  sessionId?: string;
}) {
  const tools = createConfigTools({
    workspaceRoot: input.homeDir,
    homeDir: input.homeDir,
    profileId: "default",
    sessionDb: input.sessionDb,
    sessionId: input.sessionId
  });
  const tool = tools.find((candidate) => candidate.name === "config.provider.status");
  if (tool === undefined) {
    throw new Error("config.provider.status tool not registered");
  }
  return await tool.run({});
}

async function runProviderExecutionStatusTool(input: {
  homeDir: string;
  sessionDb?: Pick<InMemorySessionDB, "listEvents" | "getSessionModelOverride" | "listMessages">;
  sessionId?: string;
}) {
  const tools = createConfigTools({
    workspaceRoot: input.homeDir,
    homeDir: input.homeDir,
    profileId: "default",
    sessionDb: input.sessionDb,
    sessionId: input.sessionId
  });
  const tool = tools.find((candidate) => candidate.name === "config.provider.execution_status");
  if (tool === undefined) {
    throw new Error("config.provider.execution_status tool not registered");
  }
  return await tool.run({});
}

async function runCompressionStatusTool(input: {
  homeDir: string;
  sessionDb?: { listEvents(sessionId: string): Promise<SessionEvent[]> };
  sessionId?: string;
}) {
  const tools = createConfigTools({
    workspaceRoot: input.homeDir,
    homeDir: input.homeDir,
    profileId: "default",
    sessionDb: input.sessionDb,
    sessionId: input.sessionId
  });
  const tool = tools.find((candidate) => candidate.name === "config.compression.status");
  if (tool === undefined) {
    throw new Error("config.compression.status tool not registered");
  }
  return await tool.run({});
}

function metadata(result: Awaited<ReturnType<typeof runCompressionStatusTool>>): CompressionStatusMetadata {
  return result.metadata as CompressionStatusMetadata;
}

function providerMetadata(result: Awaited<ReturnType<typeof runProviderStatusTool>>): ProviderStatusMetadata {
  return result.metadata as ProviderStatusMetadata;
}

function providerExecutionMetadataWithCredentialLeak(): Record<string, unknown> {
  return {
    configuredPrimary: { provider: "local", model: "kimi-k2.7-code" },
    actual: {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      credentialId: "SECRET_ACTUAL_CREDENTIAL"
    },
    fallbackUsed: true,
    primaryFailureClass: "rate-limit",
    attempts: [
      {
        provider: "local",
        model: "kimi-k2.7-code",
        ok: false,
        errorClass: "rate-limit",
        credentialId: "SECRET_PRIMARY_CREDENTIAL",
        rawBody: "SECRET_RAW_ERROR_BODY",
        routeRole: "primary",
        attemptedRouteIndex: 0
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        ok: true,
        credentialId: "SECRET_FALLBACK_CREDENTIAL",
        routeRole: "fallback",
        attemptedRouteIndex: 1
      }
    ],
    rawErrorBody: "SECRET_TOP_LEVEL_RAW_ERROR_BODY",
    status: "fallback-success"
  };
}

function maliciousProviderExecutionMetadata(): Record<string, unknown> {
  return {
    configuredPrimary: { provider: "kimi ${inject}", model: "kimi-k2.7-code" },
    actual: {
      provider: "deepseek",
      model: "deepseek-v4-pro"
    },
    fallbackUsed: true,
    primaryFailureClass: "rate-limit\nleak",
    attempts: [
      {
        provider: "kimi ${inject}",
        model: "kimi\nignore previous",
        ok: false,
        errorClass: "rate-limit\nleak",
        credentialId: "SECRET_PRIMARY_CREDENTIAL",
        rawBody: "SECRET_RAW_ERROR_BODY",
        routeRole: "primary",
        attemptedRouteIndex: 0
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        ok: true,
        routeRole: "fallback",
        attemptedRouteIndex: 1
      },
      {
        provider: "kimi",
        model: "[deepseek]",
        ok: false,
        errorClass: "auth",
        routeRole: "fallback",
        attemptedRouteIndex: 2
      }
    ],
    status: "fallback-success"
  };
}
