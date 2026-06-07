import { describe, expect, it, vi } from "vitest";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { ProviderExecutor, ProviderExecutionResult } from "../providers/provider-executor.js";
import { maybeSummarizeSnapshot, redactSnapshotSecrets } from "./snapshot-summarizer.js";

const modelProfile = {
  id: "summary-model",
  provider: "openai" as const,
  contextWindowTokens: 128_000,
  supportsTools: false,
  supportsVision: false,
  supportsStructuredOutput: true
};

const route: ResolvedModelRoute = {
  provider: "openai",
  id: "summary-model",
  profile: modelProfile
};

const auxiliaryRoute: ResolvedAuxiliaryRoute = {
  task: "compression",
  route,
  source: "explicit",
  fallbackToMain: false,
  diagnostics: []
};

function okProviderResult(content: string): ProviderExecutionResult {
  return {
    ok: true,
    response: {
      ok: true,
      content,
      provider: "openai",
      model: "summary-model"
    },
    fallbackUsed: false,
    attempts: [{ provider: "openai", model: "summary-model", ok: true, content }],
    toolCalls: []
  };
}

function failingProviderResult(): ProviderExecutionResult {
  return {
    ok: false,
    fallbackUsed: false,
    attempts: [{ provider: "openai", model: "summary-model", ok: false, content: "nope", errorClass: "rate_limit" }],
    toolCalls: []
  };
}

function createExecutor(content: string): Pick<ProviderExecutor, "complete"> {
  return {
    complete: vi.fn(async () => okProviderResult(content))
  };
}

describe("maybeSummarizeSnapshot", () => {
  it("skips the provider and truncates when summarizeSnapshots is false", async () => {
    const executor = createExecutor("summary");
    const result = await maybeSummarizeSnapshot({
      renderedSnapshot: "x".repeat(120)
    }, {
      providerExecutor: executor,
      auxiliaryRoute,
      mainRoute: route,
      maxResultSizeChars: 50,
      threshold: 10,
      mode: false
    });

    expect(executor.complete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ summarized: false, reason: "disabled" });
    expect(result.content.length).toBeLessThanOrEqual(50);
    expect(result.content).toMatch(/\n\.\.\. \[truncated\]$/u);
  });

  it("calls the provider when enabled and rendered snapshot exceeds the threshold", async () => {
    const executor = createExecutor("Summary with @e1 preserved.");
    const result = await maybeSummarizeSnapshot({
      renderedSnapshot: "[Full page snapshot]\n\n@e1 button Save\n".repeat(5)
    }, {
      providerExecutor: executor,
      auxiliaryRoute,
      mainRoute: route,
      maxResultSizeChars: 8_000,
      threshold: 20,
      mode: true
    });

    expect(executor.complete).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      content: "Summary with @e1 preserved.",
      summarized: true
    });
  });

  it("does not call the provider below threshold", async () => {
    const executor = createExecutor("summary");
    const result = await maybeSummarizeSnapshot({
      renderedSnapshot: "short @e1 snapshot"
    }, {
      providerExecutor: executor,
      auxiliaryRoute,
      mainRoute: route,
      maxResultSizeChars: 8_000,
      threshold: 100,
      mode: true
    });

    expect(executor.complete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ summarized: false, reason: "below-threshold" });
    expect(result.content).toBe("short @e1 snapshot");
  });

  it("auto mode calls the provider only when an auxiliary route and executor are available", async () => {
    const executor = createExecutor("auto summary");
    const available = await maybeSummarizeSnapshot({
      renderedSnapshot: "x".repeat(120)
    }, {
      providerExecutor: executor,
      auxiliaryRoute,
      mainRoute: route,
      maxResultSizeChars: 8_000,
      threshold: 10,
      mode: "auto"
    });

    const unavailable = await maybeSummarizeSnapshot({
      renderedSnapshot: "x".repeat(120)
    }, {
      maxResultSizeChars: 50,
      threshold: 10,
      mode: "auto"
    });

    expect(available.summarized).toBe(true);
    expect(executor.complete).toHaveBeenCalledTimes(1);
    expect(unavailable).toMatchObject({ summarized: false, reason: "missing-provider-executor" });
    expect(unavailable.content).toMatch(/\n\.\.\. \[truncated\]$/u);
  });

  it("falls back to truncation when provider execution fails", async () => {
    const executor = {
      complete: vi.fn(async () => failingProviderResult())
    } satisfies Pick<ProviderExecutor, "complete">;

    const result = await maybeSummarizeSnapshot({
      renderedSnapshot: "x".repeat(120)
    }, {
      providerExecutor: executor,
      auxiliaryRoute,
      mainRoute: route,
      maxResultSizeChars: 40,
      threshold: 10,
      mode: true
    });

    expect(result).toMatchObject({ summarized: false, reason: "failed" });
    expect(result.content.length).toBeLessThanOrEqual(40);
    expect(result.content).toMatch(/\n\.\.\. \[truncated\]$/u);
  });

  it("falls back to truncation when the provider returns an empty summary", async () => {
    const executor = createExecutor("   ");
    const result = await maybeSummarizeSnapshot({
      renderedSnapshot: "x".repeat(120)
    }, {
      providerExecutor: executor,
      auxiliaryRoute,
      mainRoute: route,
      maxResultSizeChars: 40,
      threshold: 10,
      mode: true
    });

    expect(executor.complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ summarized: false, reason: "empty-summary" });
    expect(result.content.length).toBeLessThanOrEqual(40);
    expect(result.content).toMatch(/\n\.\.\. \[truncated\]$/u);
  });

  it("truncates successful summaries to maxResultSizeChars", async () => {
    const executor = createExecutor("s".repeat(120));
    const result = await maybeSummarizeSnapshot({
      renderedSnapshot: "x".repeat(120)
    }, {
      providerExecutor: executor,
      auxiliaryRoute,
      mainRoute: route,
      maxResultSizeChars: 40,
      threshold: 10,
      mode: true
    });

    expect(result.summarized).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(40);
    expect(result.content).toMatch(/\n\.\.\. \[truncated\]$/u);
  });

  it("prompts the provider to preserve interactive refs", async () => {
    const executor = createExecutor("summary");
    await maybeSummarizeSnapshot({
      renderedSnapshot: "[Compact viewport snapshot]\n\nInteractive elements:\n@e1 button Save",
      userTask: "Click save"
    }, {
      providerExecutor: executor,
      auxiliaryRoute,
      mainRoute: route,
      maxResultSizeChars: 8_000,
      threshold: 10,
      mode: true
    });

    const request = vi.mocked(executor.complete).mock.calls[0]?.[0];
    const prompt = JSON.stringify(request?.messages);
    expect(prompt).toContain("Preserve all useful interactive elements and their exact @eN refs");
    expect(prompt).toContain("@e1 button Save");
    expect(prompt).toContain("Click save");
  });

  it("redacts raw secrets before provider calls and from provider responses", async () => {
    const executor = createExecutor("Summary mentions sk-ant-response-secret and token=response-secret");
    await maybeSummarizeSnapshot({
      renderedSnapshot: [
        "token=raw-token",
        "api_key=raw-api-key",
        "password=raw-password",
        "Bearer raw-bearer",
        "sk-ant-rawsecret",
        "sk-rawsecret",
        "ghp_rawsecret",
        "http://user:pass@example.com/"
      ].join("\n")
    }, {
      providerExecutor: executor,
      auxiliaryRoute,
      mainRoute: route,
      maxResultSizeChars: 8_000,
      threshold: 10,
      mode: true
    });

    const request = vi.mocked(executor.complete).mock.calls[0]?.[0];
    const prompt = JSON.stringify(request?.messages);
    expect(prompt).not.toContain("raw-token");
    expect(prompt).not.toContain("raw-api-key");
    expect(prompt).not.toContain("raw-password");
    expect(prompt).not.toContain("raw-bearer");
    expect(prompt).not.toContain("sk-ant-rawsecret");
    expect(prompt).not.toContain("sk-rawsecret");
    expect(prompt).not.toContain("ghp_rawsecret");
    expect(prompt).not.toContain("user:pass");

    const result = await maybeSummarizeSnapshot({
      renderedSnapshot: "x".repeat(120)
    }, {
      providerExecutor: executor,
      auxiliaryRoute,
      mainRoute: route,
      maxResultSizeChars: 8_000,
      threshold: 10,
      mode: true
    });
    expect(result.content).not.toContain("sk-ant-response-secret");
    expect(result.content).not.toContain("response-secret");
  });

  it("redacts supported secret shapes deterministically", () => {
    const redacted = redactSnapshotSecrets("sk-ant-a sk-b ghp_c Bearer d token=e api_key=f password=g https://u:p@example.com/");
    expect(redacted).toContain("[REDACTED_SECRET]");
    expect(redacted).toContain("Bearer [REDACTED]");
    expect(redacted).toContain("token=[REDACTED]");
    expect(redacted).toContain("api_key=[REDACTED]");
    expect(redacted).toContain("password=[REDACTED]");
    expect(redacted).not.toContain("u:p");
  });
});
