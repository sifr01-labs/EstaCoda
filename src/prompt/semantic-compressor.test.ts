import { describe, expect, it, vi } from "vitest";
import { normalizeSessionCompressionConfig } from "../config/runtime-config.js";
import type { ProviderResponse, ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { SessionMessage } from "../contracts/session.js";
import {
  CONTENT_HEAD,
  CONTENT_MAX,
  CONTENT_TAIL,
  computeSummaryBudget,
  computeSummaryRequestMaxTokens,
  deterministicFallbackSummary,
  SemanticCompressor,
  SUMMARY_FORMAT_VERSION,
  SUMMARY_PREFIX,
  SUMMARY_REQUEST_HEADROOM_RATIO,
  normalizeSummaryPrefix,
  serializeMessagesForSummary,
  TOOL_ARGS_MAX,
  TOOL_ARGS_HEAD
} from "./semantic-compressor.js";

describe("SemanticCompressor", () => {
  it("bypasses compression when disabled and respects threshold when enabled", async () => {
    const disabled = new SemanticCompressor({
      config: normalizeSessionCompressionConfig({ enabled: true })
    });
    const messages = fixtureMessages(10);

    expect(disabled.shouldCompress({ messages, profileId: "p", sessionId: "s" })).toMatchObject({
      shouldCompress: false,
      reason: "disabled"
    });

    const enabled = new SemanticCompressor({
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 100,
        threshold: 0.50
      })
    });

    expect(enabled.shouldCompress({ messages: fixtureMessages(1), profileId: "p", sessionId: "s" }).shouldCompress).toBe(false);
    expect(enabled.shouldCompress({ messages, profileId: "p", sessionId: "s" }).shouldCompress).toBe(true);
  });

  it("preserves protected head, tail, active tool pairs, explicit constraints, and latest user message", async () => {
    const compressor = new SemanticCompressor({
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 2,
        protectLastN: 2,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness("Key Decisions\n- summarized safely")
    });
    const messages = [
      message("head-user", "user", "first head"),
      message("head-agent", "agent", "second head"),
      message("old-1", "user", "old body one"),
      message("constraint", "user", "must keep this explicit constraint", { explicitConstraint: true }),
      message("tool-call", "agent", "calling tool", { tool_call_id: "call-1", tool_call_name: "file.read", activeToolCall: true }),
      message("tool-result", "tool", "tool result", { tool_call_id: "call-1", tool_call_name: "file.read", activeToolResult: true }),
      message("old-2", "agent", "old body two"),
      message("tail-agent", "agent", "recent answer"),
      message("latest-user", "user", "latest user request")
    ];

    const result = await compressor.compress({ messages, profileId: "profile", sessionId: "session" });

    expect(result.didCompress).toBe(true);
    expect(result.messages.map((entry) => entry.id)).toContain("head-user");
    expect(result.messages.map((entry) => entry.id)).toContain("head-agent");
    expect(result.messages.map((entry) => entry.id)).toContain("constraint");
    expect(result.messages.map((entry) => entry.id)).toContain("tool-call");
    expect(result.messages.map((entry) => entry.id)).toContain("tool-result");
    expect(result.messages.at(-1)?.id).toBe("latest-user");
    expect(result.messages.some((entry) => entry.metadata?.semanticCompression === true)).toBe(true);
    expect(result.diagnostics.protectedSpans.length).toBeGreaterThan(0);
    expect(result.diagnostics.protectedCategories).toEqual(expect.arrayContaining([
      "current_user_request",
      "active_tool_call",
      "active_tool_result",
      "explicit_constraint",
      "recent_turn"
    ]));
  });

  it("uses Hermes-style per-message and tool-argument truncation before summarization", () => {
    const longContent = "a".repeat(CONTENT_MAX + 200);
    const longToolArgs = { payload: "b".repeat(TOOL_ARGS_MAX + 200) };
    const serialized = serializeMessagesForSummary([
      message("tool-1", "tool", longContent, {
        provider_native_tool_call: longToolArgs
      })
    ]);

    expect(serialized.text).toContain("a".repeat(CONTENT_HEAD));
    expect(serialized.text).toContain("a".repeat(CONTENT_TAIL));
    expect(serialized.text).toContain(`[truncated ${longContent.length - CONTENT_HEAD - CONTENT_TAIL} chars]`);
    expect(serialized.text).toContain("b".repeat(1_000));
    expect(serialized.text).toContain(`[truncated ${JSON.stringify(longToolArgs).length - TOOL_ARGS_HEAD} chars]`);
    expect(serialized.text).toContain("provider_native_tool_call");
    expect(serialized.prunedToolResults).toBe(1);
  });

  it("summarizes old tool results instead of preserving them as live history", async () => {
    const compressor = new SemanticCompressor({
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness("old tool work summarized")
    });
    const messages = [
      message("old-tool-call", "agent", "calling tool", { tool_call_id: "call-old", tool_call_name: "shell.run" }),
      message("old-tool-result", "tool", "x".repeat(CONTENT_MAX + 20), { tool_call_id: "call-old", tool_call_name: "shell.run" }),
      ...fixtureMessages(5)
    ];

    const result = await compressor.compress({ messages, profileId: "profile", sessionId: "session" });

    expect(result.didCompress).toBe(true);
    expect(result.messages.map((entry) => entry.id)).not.toContain("old-tool-call");
    expect(result.messages.map((entry) => entry.id)).not.toContain("old-tool-result");
    expect(result.diagnostics.prunedToolResults).toBe(1);
    expect(result.diagnostics.warnings).toEqual(expect.arrayContaining([
      "tool result old-tool-result was truncated before summarization"
    ]));
  });

  it("redacts summarizer input and generated summary output", async () => {
    let observedTranscript = "";
    const outputSecret = "sk-live-secret1234567890abcdef";
    const harness = auxiliaryHarness(`Use token ${outputSecret} in output`);
    harness.providerExecutor.complete = vi.fn(async (request?: unknown): Promise<any> => {
      observedTranscript = String((request as { messages?: Array<{ content?: unknown }> }).messages?.[1]?.content ?? "");
      return providerResult(`Use token ${outputSecret} in output`);
    });
    const compressor = new SemanticCompressor({
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...harness
    });

    const result = await compressor.compress({
      messages: fixtureMessages(6, "OPENAI_API_KEY=sk-input-secret"),
      profileId: "profile",
      sessionId: "session"
    });

    expect(observedTranscript).not.toContain("sk-input-secret");
    expect(observedTranscript).toContain("[REDACTED]");
    expect(result.messages.find((entry) => entry.metadata?.semanticCompression === true)?.content).not.toContain(outputSecret);
    expect(result.messages.find((entry) => entry.metadata?.semanticCompression === true)?.content).toContain("[REDACTED]");
  });

  it("normalizes summary prefixes without duplicating current or legacy prefixes", () => {
    const current = normalizeSummaryPrefix(`${SUMMARY_PREFIX}\n\nBody`);
    const legacy = normalizeSummaryPrefix("[CONTEXT SUMMARY]\nlegacy body");

    expect(current.match(/\[CONTEXT COMPACTION/g)).toHaveLength(1);
    expect(legacy.match(/\[CONTEXT COMPACTION/g)).toHaveLength(1);
    expect(current).toContain("Body");
    expect(legacy).toContain("legacy body");
  });

  it("includes previous summary for iterative summary updates", async () => {
    let observedPrompt = "";
    const harness = auxiliaryHarness("updated summary");
    harness.providerExecutor.complete = vi.fn(async (request?: unknown): Promise<any> => {
      observedPrompt = String((request as { messages?: Array<{ content?: unknown }> }).messages?.[1]?.content ?? "");
      return providerResult("updated summary");
    });
    const compressor = new SemanticCompressor({
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...harness
    });
    const messages = [
      message("summary-prev", "system", normalizeSummaryPrefix("previous important summary"), {
        semanticCompression: true,
        summaryFormatVersion: SUMMARY_FORMAT_VERSION
      }),
      ...fixtureMessages(8)
    ];

    await compressor.compress({
      messages,
      profileId: "profile",
      sessionId: "session",
      previousState: {
        status: "compressed",
        compressionCount: 1,
        protectedFirstN: 0,
        protectedLastN: 0,
        protectedSpans: [],
        summaryMessageId: "summary-prev",
        ineffectiveCompressionCount: 0,
        fallbackUsed: false,
        warnings: []
      }
    });

    expect(observedPrompt).toContain("Previous summary:");
    expect(observedPrompt).toContain("previous important summary");
  });

  it("uses auxiliary summarization success and records fallback/main route diagnostics", async () => {
    const harness = auxiliaryHarness("provider summary");
    const compressor = new SemanticCompressor({
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...harness
    });

    const result = await compressor.compress({ messages: fixtureMessages(6), profileId: "profile", sessionId: "session" });

    expect(result.diagnostics.fallbackUsed).toBe(false);
    expect(result.diagnostics.model).toBe("compression-model");
    expect(result.diagnostics.scopeKey).toBe("profile:session");
    expect(harness.providerExecutor.complete).toHaveBeenCalled();
  });

  it("passes computed summary budget with provider generation headroom", async () => {
    let observedMaxTokens: number | undefined;
    const harness = auxiliaryHarness("provider summary");
    harness.providerExecutor.complete = vi.fn(async (request?: unknown): Promise<any> => {
      observedMaxTokens = (request as { maxTokens?: number }).maxTokens;
      return providerResult("provider summary");
    });
    const compressor = new SemanticCompressor({
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        targetRatio: 0.20,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...harness
    });

    await compressor.compress({ messages: fixtureMessages(6), profileId: "profile", sessionId: "session" });

    const targetSummaryBudget = computeSummaryBudget({
      sourceMessages: fixtureMessages(5),
      targetRatio: 0.20,
      contextLength: 50
    });
    expect(targetSummaryBudget).toBe(2_000);
    expect(SUMMARY_REQUEST_HEADROOM_RATIO).toBe(1.3);
    expect(observedMaxTokens).toBe(computeSummaryRequestMaxTokens(targetSummaryBudget));
    expect(observedMaxTokens).toBe(2_600);
    expect(observedMaxTokens).not.toBe(1_200);
  });

  it("computes Hermes-style summary budgets from source tokens, ratio, context cap, and ceiling", () => {
    const small = computeSummaryBudget({
      sourceMessages: [message("small", "user", "small transcript")],
      targetRatio: 0.20,
      contextLength: 128_000
    });
    const normalMessages = [message("normal", "user", "x".repeat(79_960))];
    const normal = computeSummaryBudget({
      sourceMessages: normalMessages,
      targetRatio: 0.20,
      contextLength: 128_000
    });
    const lowerRatio = computeSummaryBudget({
      sourceMessages: normalMessages,
      targetRatio: 0.10,
      contextLength: 128_000
    });
    const contextCapped = computeSummaryBudget({
      sourceMessages: [message("huge", "user", "x".repeat(399_960))],
      targetRatio: 0.20,
      contextLength: 128_000
    });
    const ceilingCapped = computeSummaryBudget({
      sourceMessages: [message("ceiling", "user", "x".repeat(999_960))],
      targetRatio: 0.20,
      contextLength: 400_000
    });

    expect(small).toBe(2_000);
    expect(normal).toBe(4_000);
    expect(lowerRatio).toBe(2_000);
    expect(contextCapped).toBe(6_400);
    expect(ceilingCapped).toBe(12_000);
  });

  it("uses context length and image-aware metadata when computing summary budgets", () => {
    const sourceMessages = [message("images", "user", "", { imageCount: 10 })];
    const imageBudget = computeSummaryBudget({
      sourceMessages,
      targetRatio: 0.20,
      contextLength: 128_000
    });
    const textOnlyBudget = computeSummaryBudget({
      sourceMessages: [message("text", "user", "")],
      targetRatio: 0.20,
      contextLength: 128_000
    });
    const lowerContextBudget = computeSummaryBudget({
      sourceMessages: [message("large", "user", "x".repeat(79_960))],
      targetRatio: 0.20,
      contextLength: 50_000
    });

    expect(imageBudget).toBeGreaterThan(textOnlyBudget);
    expect(imageBudget).toBe(3_202);
    expect(lowerContextBudget).toBe(2_500);
  });

  it("passes manual focus topics into the summarizer prompt", async () => {
    let observedPrompt = "";
    const harness = auxiliaryHarness("provider summary");
    harness.providerExecutor.complete = vi.fn(async (request?: unknown): Promise<any> => {
      observedPrompt = String((request as { messages?: Array<{ content?: unknown }> }).messages?.[1]?.content ?? "");
      return providerResult("provider summary");
    });
    const compressor = new SemanticCompressor({
      config: normalizeSessionCompressionConfig({
        enabled: false,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...harness
    });

    await compressor.compress({
      messages: fixtureMessages(6),
      profileId: "profile",
      sessionId: "session",
      force: true,
      focusTopic: "deployment handoff"
    });

    expect(observedPrompt).toContain("## Active Task\ndeployment handoff");
    expect(observedPrompt).toContain("Manual focus topic: deployment handoff");
  });

  it("falls back deterministically when auxiliary and explicit main retry fail", async () => {
    const failing = auxiliaryHarness("provider failed", false);
    const compressor = new SemanticCompressor({
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...failing
    });

    const result = await compressor.compress({ messages: fixtureMessages(6), profileId: "profile", sessionId: "session" });

    expect(result.diagnostics.fallbackUsed).toBe(true);
    expect(result.diagnostics.fallbackReason).toBe("deterministic-fallback");
    expect(result.diagnostics.auxModelFailure).toEqual(expect.objectContaining({
      code: "failed"
    }));
    expect(result.diagnostics.mainRetryFailure).toEqual(expect.objectContaining({
      code: "failed"
    }));
    expect(result.messages.find((entry) => entry.metadata?.semanticCompression === true)?.content).toContain(SUMMARY_PREFIX);
  });

  it("records main retry success after auxiliary compression failure", async () => {
    const providerExecutor = {
      complete: vi.fn(async (_request?: unknown, _preferences?: unknown, options?: { primaryRoute?: ResolvedModelRoute }): Promise<any> => {
        if (options?.primaryRoute?.id === "compression-model") {
          return providerResult("aux failed OPENAI_API_KEY=aux-secret", false, "compression-model", "network");
        }
        return providerResult("main retry summary", true, "main-model");
      })
    };
    const compressor = new SemanticCompressor({
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      route: auxiliaryRoute(),
      mainRoute: mainRoute(),
      providerExecutor
    });

    const result = await compressor.compress({ messages: fixtureMessages(6), profileId: "profile", sessionId: "session" });

    expect(providerExecutor.complete).toHaveBeenCalledTimes(2);
    expect(result.diagnostics.fallbackUsed).toBe(true);
    expect(result.diagnostics.fallbackReason).toBeUndefined();
    expect(result.diagnostics.model).toBe("main-model");
    expect(result.diagnostics.auxModelFailure).toEqual({
      code: "network",
      message: "aux failed OPENAI_API_KEY=[REDACTED]",
      recoverable: true
    });
    expect(result.diagnostics.mainRetryFailure).toBeUndefined();
    expect(result.messages.find((entry) => entry.metadata?.semanticCompression === true)?.content).toContain("main retry summary");
  });

  it("uses a static emergency marker only when deterministic fallback cannot fit", () => {
    const deterministic = deterministicFallbackSummary("old context ".repeat(100), 2_000);
    const staticFallback = deterministicFallbackSummary("old context ".repeat(100), 1);

    expect(deterministic.reason).toBe("deterministic-fallback");
    expect(staticFallback.reason).toBe("static-emergency-marker");
    expect(staticFallback.summary).toContain("could not be summarized within the fallback budget");
  });

  it("skips after ineffective recent compression to avoid thrashing", async () => {
    const compressor = new SemanticCompressor({
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      })
    });

    const result = await compressor.compress({
      messages: fixtureMessages(8),
      profileId: "profile",
      sessionId: "session",
      previousState: {
        status: "compressed",
        compressionCount: 2,
        protectedFirstN: 0,
        protectedLastN: 0,
        protectedSpans: [],
        ineffectiveCompressionCount: 2,
        fallbackUsed: false,
        warnings: []
      }
    });

    expect(result.didCompress).toBe(false);
    expect(result.diagnostics.reason).toBe("anti-thrashing");
    expect(result.diagnostics.ineffectiveCompressionCount).toBe(2);
    expect(result.diagnostics.warnings).toContain("last 2 compressions saved <10% each; skipped to avoid thrashing");
  });

  it("uses image-aware token estimates", () => {
    const compressor = new SemanticCompressor({
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 2_000,
        threshold: 0.50
      })
    });
    const withoutImage = compressor.shouldCompress({
      messages: [
        message("m1", "user", "short"),
        message("m2", "agent", "short"),
        message("m3", "user", "latest")
      ],
      profileId: "profile",
      sessionId: "session"
    });
    const withImage = compressor.shouldCompress({
      messages: [
        message("m1", "user", "short", { imageCount: 1 }),
        message("m2", "agent", "short"),
        message("m3", "user", "latest")
      ],
      profileId: "profile",
      sessionId: "session"
    });

    expect(withImage.preTokens).toBeGreaterThan(withoutImage.preTokens);
    expect(withImage.shouldCompress).toBe(true);
  });
});

function fixtureMessages(count: number, extra = ""): SessionMessage[] {
  return Array.from({ length: count }, (_value, index) =>
    message(`m${index}`, index % 2 === 0 ? "user" : "agent", `message ${index} ${"x".repeat(120)} ${extra}`));
}

function message(
  id: string,
  role: SessionMessage["role"],
  content: string,
  metadata?: Record<string, unknown>
): SessionMessage {
  return {
    id,
    sessionId: "session",
    role,
    content,
    createdAt: `2030-01-01T00:00:${id.replace(/\D/gu, "").padStart(2, "0") || "00"}.000Z`,
    metadata
  };
}

function auxiliaryHarness(content: string, ok = true) {
  return {
    route: auxiliaryRoute(),
    mainRoute: mainRoute(),
    providerExecutor: {
      complete: vi.fn(async (_request?: unknown): Promise<any> => providerResult(content, ok))
    }
  };
}

function providerResult(content: string, ok = true, model = "compression-model", errorClass?: ProviderResponse["errorClass"]) {
  const response: ProviderResponse = {
    ok,
    content,
    model,
    provider: "test-provider",
    errorClass
  };
  return {
    ok,
    response,
    fallbackUsed: false,
    attempts: [{ provider: "test-provider", model, ok, content, errorClass }],
    toolCalls: []
  };
}

function auxiliaryRoute(): ResolvedAuxiliaryRoute {
  return {
    task: "compression",
    route: mainRoute("compression-model"),
    source: "explicit",
    fallbackToMain: true,
    diagnostics: []
  };
}

function mainRoute(id = "main-model"): ResolvedModelRoute {
  return {
    provider: "test-provider",
    id,
    profile: {
      id,
      provider: "test-provider",
      contextWindowTokens: 128_000,
      supportsTools: false,
      supportsVision: false,
      supportsStructuredOutput: true
    }
  };
}
