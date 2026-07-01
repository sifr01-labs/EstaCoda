import { describe, expect, it } from "vitest";
import type { SelectPromptInput } from "../cli/interactive-select.js";
import type { Prompt } from "../cli/prompt-contract.js";
import type { ProviderId, ProviderApiMode, ProviderAuthMethod } from "../contracts/provider.js";
import type {
  FlowEngine,
  ModelCandidate,
  ProviderCandidate,
  ProviderModelSelectionResult,
} from "../providers/provider-model-selection-flow.js";
import {
  modelCandidateDescription,
  providerCandidateDescription,
  selectProviderModelRoute,
} from "./provider-model-route-prompt.js";

describe("selectProviderModelRoute", () => {
  it("returns selected route for a normal provider and model selection", async () => {
    const flow = fakeFlow();
    const prompt = fakePrompt();

    const result = await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      allowCancel: true,
    });

    expect(result).toEqual({
      kind: "selected",
      selection: selectionResult("openai", "alpha-model"),
    });
    expect(flow.resolved).toEqual([{ providerId: "openai", modelId: "alpha-model" }]);
    expect(prompt.calls).toHaveLength(2);
  });

  it("defers local model selection to the endpoint-first setup flow for configured modes", async () => {
    for (const mode of ["primary", "fallback", "auxiliary"] as const) {
      const flow = fakeFlow({
        providers: [providerCandidate("local", "Local", 2)],
        models: {
          local: [
            modelCandidate("local", "seed-model"),
            modelCandidate("local", "other-local-model"),
          ],
        },
      });
      const prompt = fakePrompt(["local"]);

      const result = await selectProviderModelRoute({
        prompt,
        flowEngine: flow.engine,
        locale: "en",
        mode,
        endpointFirstProviderIds: ["local"],
        allowCancel: true,
      });

      expect(result).toEqual({
        kind: "selected",
        selection: selectionResult("local", "seed-model"),
      });
      expect(flow.resolved).toEqual([{ providerId: "local", modelId: "seed-model" }]);
      expect(prompt.calls.map((call) => call.title)).toEqual([`${mode === "primary" ? "Primary" : mode === "fallback" ? "Fallback" : "Auxiliary"} provider`]);
    }
  });

  it("returns diagnostic when no providers are available", async () => {
    const flow = fakeFlow({ providers: [] });
    const prompt = fakePrompt();

    const result = await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
    });

    expect(result).toEqual({
      kind: "diagnostic",
      output: "No setup-visible provider candidates are available.",
    });
    expect(prompt.calls).toHaveLength(0);
    expect(flow.resolved).toHaveLength(0);
  });

  it("uses session-specific copy for session model switching", async () => {
    const flow = fakeFlow();
    const prompt = fakePrompt(["cancel"]);

    const result = await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "session",
      allowCancel: true,
    });

    expect(result).toEqual({ kind: "cancel" });
    expect(prompt.calls[0]).toMatchObject({
      title: "Session provider",
      body: "Choose the provider to use for this session only.\n",
    });
    expect(prompt.calls[0]?.options.find((option) => option.id === "cancel")).toMatchObject({
      cells: {
        name: "Cancel",
        details: "Keep the current session model.",
      },
    });
  });

  it("returns session-specific diagnostics when no ready providers are available", async () => {
    const flow = fakeFlow({ providers: [] });
    const prompt = fakePrompt();

    const result = await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "session",
    });

    expect(result).toEqual({
      kind: "diagnostic",
      output: "No configured runnable model providers are ready. Run estacoda model setup from a terminal.",
    });
    expect(prompt.calls).toHaveLength(0);
    expect(flow.resolved).toHaveLength(0);
  });

  it("returns diagnostic when selected provider has no models", async () => {
    const flow = fakeFlow({ models: { openai: [] } });
    const prompt = fakePrompt();

    const result = await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
    });

    expect(result).toEqual({
      kind: "diagnostic",
      output: "No setup-visible models are available for OpenAI.",
    });
    expect(prompt.calls).toHaveLength(1);
    expect(flow.resolved).toHaveLength(0);
  });

  it("returns diagnostic when final selection resolution fails", async () => {
    const flow = fakeFlow({ diagnostic: "Provider OpenAI is not runnable." });
    const prompt = fakePrompt();

    const result = await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
    });

    expect(result.kind).toBe("diagnostic");
    expect(result).toEqual({
      kind: "diagnostic",
      output: "Provider/model selection failed: Provider OpenAI is not runnable.",
    });
    expect(flow.resolved).toEqual([{ providerId: "openai", modelId: "alpha-model" }]);
  });

  it("returns cancel at the provider step when cancel is enabled", async () => {
    const flow = fakeFlow();
    const prompt = fakePrompt(["cancel"]);

    const result = await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      allowCancel: true,
    });

    expect(result).toEqual({ kind: "cancel" });
    expect(prompt.calls[0]?.options.map((option) => option.id)).toContain("cancel");
    expect(flow.resolved).toHaveLength(0);
  });

  it("returns cancel at the model step when cancel is enabled", async () => {
    const flow = fakeFlow();
    const prompt = fakePrompt(["openai", "cancel"]);

    const result = await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      allowCancel: true,
    });

    expect(result).toEqual({ kind: "cancel" });
    expect(prompt.calls[1]?.options.map((option) => option.id)).toContain("cancel");
    expect(flow.resolved).toHaveLength(0);
  });

  it("returns back at the provider step when back is enabled", async () => {
    const flow = fakeFlow();
    const prompt = fakePrompt(["back"]);

    const result = await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      allowBack: true,
    });

    expect(result).toEqual({ kind: "back" });
    expect(prompt.calls[0]?.options.map((option) => option.id)).toContain("back");
    expect(flow.resolved).toHaveLength(0);
  });

  it("returns to the provider card when Back is selected on the model card", async () => {
    const flow = fakeFlow({
      providers: [
        providerCandidate("openai", "OpenAI", 1),
        providerCandidate("local", "Local", 1),
      ],
      models: {
        openai: [modelCandidate("openai", "openai-model")],
        local: [modelCandidate("local", "local-model")],
      },
    });
    const prompt = fakePrompt(["openai", "back", "local", "local-model"]);

    const result = await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      allowBack: true,
      allowCancel: true,
    });

    expect(result).toEqual({
      kind: "selected",
      selection: selectionResult("local", "local-model"),
    });
    expect(prompt.calls.map((call) => call.title)).toEqual([
      "Primary provider",
      "Primary model",
      "Primary provider",
      "Primary model",
    ]);
    expect(flow.resolved).toEqual([{ providerId: "local", modelId: "local-model" }]);
  });

  it("shows Codex as an OpenAI sub-choice when the nested choice is enabled", async () => {
    const flow = fakeFlow({
      providers: [
        providerCandidate("openai", "OpenAI", 1),
        providerCandidate("local", "Local", 1),
      ],
    });
    const prompt = fakePrompt(["openai", "codex-oauth"]);

    const result = await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      allowBack: true,
      allowCancel: true,
      openAiCodexChoice: true,
    });

    expect(result).toEqual({
      kind: "selected",
      selection: selectionResult("codex", "gpt-5.5"),
    });
    expect(prompt.calls.map((call) => call.title)).toEqual([
      "Primary provider",
      "OpenAI setup",
    ]);
    expect(prompt.calls[0]?.options.map((option) => option.id)).toEqual([
      "openai",
      "local",
      "back",
      "cancel",
    ]);
    expect(prompt.calls[1]?.options.map((option) => option.id)).toEqual([
      "openai-api-key",
      "codex-oauth",
      "back",
      "cancel",
    ]);
    expect(flow.modelListCount).toBe(0);
    expect(flow.resolved).toEqual([{ providerId: "codex", modelId: "gpt-5.5" }]);
  });

  it("continues to normal OpenAI model selection from the OpenAI sub-choice", async () => {
    const flow = fakeFlow({
      providers: [
        providerCandidate("openai", "OpenAI", 1),
        providerCandidate("codex", "Codex", 1),
      ],
      models: {
        openai: [modelCandidate("openai", "gpt-5.5")],
      },
    });
    const prompt = fakePrompt(["openai", "openai-api-key", "gpt-5.5"]);

    const result = await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      allowBack: true,
      allowCancel: true,
      openAiCodexChoice: true,
    });

    expect(result).toEqual({
      kind: "selected",
      selection: selectionResult("openai", "gpt-5.5"),
    });
    expect(prompt.calls.map((call) => call.title)).toEqual([
      "Primary provider",
      "OpenAI setup",
      "Primary model",
    ]);
    expect(flow.resolved).toEqual([{ providerId: "openai", modelId: "gpt-5.5" }]);
  });

  it("leaves Codex as a top-level provider when the nested choice is disabled", async () => {
    const flow = fakeFlow({
      providers: [
        providerCandidate("openai", "OpenAI", 1),
        providerCandidate("codex", "Codex", 1),
      ],
      models: {
        codex: [modelCandidate("codex", "gpt-5.5")],
      },
    });
    const prompt = fakePrompt(["codex", "gpt-5.5"]);

    const result = await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      allowBack: true,
      allowCancel: true,
    });

    expect(result).toEqual({
      kind: "selected",
      selection: selectionResult("codex", "gpt-5.5"),
    });
    expect(prompt.calls[0]?.options.map((option) => option.id)).toEqual([
      "openai",
      "codex",
      "back",
      "cancel",
    ]);
    expect(flow.resolved).toEqual([{ providerId: "codex", modelId: "gpt-5.5" }]);
  });

  it("omits Back rows from provider and model cards when Back is disabled", async () => {
    const flow = fakeFlow();
    const prompt = fakePrompt();

    await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      allowBack: false,
      allowCancel: true,
    });

    expect(prompt.calls[0]?.options.map((option) => option.id)).not.toContain("back");
    expect(prompt.calls[1]?.options.map((option) => option.id)).not.toContain("back");
  });

  it("keeps model-card Cancel as cancel instead of returning to provider selection", async () => {
    const flow = fakeFlow();
    const prompt = fakePrompt(["openai", "cancel"]);

    const result = await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      allowBack: true,
      allowCancel: true,
    });

    expect(result).toEqual({ kind: "cancel" });
    expect(prompt.calls.map((call) => call.title)).toEqual(["Primary provider", "Primary model"]);
    expect(flow.resolved).toHaveLength(0);
  });

  it("uses structured prompt-card rows through the prompt contract", async () => {
    const flow = fakeFlow();
    const prompt = fakePrompt();

    await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      allowBack: true,
      allowCancel: true,
    });

    const providerPrompt = prompt.calls[0]!;
    const modelPrompt = prompt.calls[1]!;
    expect(providerPrompt.surface).toBe("promptCard");
    expect(providerPrompt.columns).toEqual([
      { key: "name", header: "Name" },
      { key: "details", header: "Details" },
    ]);
    expect(providerPrompt.tableDirection).toBeUndefined();
    expect(modelPrompt.tableDirection).toBeUndefined();
    expect(providerPrompt.tableWidth).toBeUndefined();
    expect(modelPrompt.tableWidth).toBeUndefined();
    expect(providerPrompt.tableMaxWidth).toBeUndefined();
    expect(modelPrompt.tableMaxWidth).toBeUndefined();
    expect(providerPrompt.tableAlign).toBeUndefined();
    expect(modelPrompt.tableAlign).toBeUndefined();
    expect(providerPrompt.showColumnHeaders).toBeUndefined();
    expect(providerPrompt.options[0]).toMatchObject({
      id: "openai",
      label: "OpenAI",
      cells: {
        name: "OpenAI",
        details: "Frontier models for high-quality primary reasoning. Direct API.",
      },
    });
    expect(modelPrompt.options[0]).toMatchObject({
      id: "alpha-model",
      label: "alpha-model",
      cells: {
        name: "alpha-model",
        details: "128K context | Tools | Vision",
      },
    });
    expect(providerPrompt.showCurrentBadge).toBe(false);
    expect(modelPrompt.showCurrentBadge).toBe(false);
    expect(providerPrompt.options.at(-2)).toMatchObject({
      id: "back",
      group: "navigation",
      cells: {
        details: "Return to the previous step.",
      },
    });
    expect(providerPrompt.options.at(-1)).toMatchObject({
      id: "cancel",
      group: "navigation",
    });
    expect(modelPrompt.options.at(-2)).toMatchObject({
      id: "back",
      group: "navigation",
      cells: {
        details: "Return to the previous step.",
      },
    });
    expect(modelPrompt.options.at(-1)).toMatchObject({
      id: "cancel",
      group: "navigation",
    });
    expect(providerPrompt.options[0]?.group).toBeUndefined();
    expect(modelPrompt.options[0]?.group).toBeUndefined();
  });

  it("paginates OpenRouter model choices for setup editor route modes", async () => {
    for (const mode of ["primary", "fallback", "auxiliary"] as const) {
      const openRouterModels = Array.from({ length: 30 }, (_, index) =>
        modelCandidate("openrouter", `openrouter-model-${String(index + 1).padStart(2, "0")}`));
      const flow = fakeFlow({
        providers: [providerCandidate("openrouter", "OpenRouter", openRouterModels.length)],
        models: { openrouter: openRouterModels },
      });
      const prompt = fakePrompt(["openrouter", "next-page", "openrouter-model-26"]);

      const result = await selectProviderModelRoute({
        prompt,
        flowEngine: flow.engine,
        locale: "en",
        mode,
        allowBack: true,
        allowCancel: true,
      });

      expect(result).toEqual({
        kind: "selected",
        selection: selectionResult("openrouter", "openrouter-model-26"),
      });
      expect(prompt.calls).toHaveLength(3);
      expect(prompt.calls[1]?.options.map((option) => option.id)).toEqual([
        ...openRouterModels.slice(0, 25).map((model) => model.id),
        "next-page",
        "back",
        "cancel",
      ]);
      expect(prompt.calls[1]?.options.map((option) => option.id)).not.toContain("openrouter-model-26");
      expect(prompt.calls[1]?.technicalLines).toEqual(["Models 1-25 of 30."]);
      expect(prompt.calls[2]?.options.map((option) => option.id)).toEqual([
        ...openRouterModels.slice(25).map((model) => model.id),
        "previous-page",
        "back",
        "cancel",
      ]);
      expect(prompt.calls[2]?.technicalLines).toEqual(["Models 26-30 of 30."]);
      expect(flow.resolved).toEqual([{ providerId: "openrouter", modelId: "openrouter-model-26" }]);
    }
  });

  it("starts OpenRouter pagination on the page that contains the current model", async () => {
    const openRouterModels = Array.from({ length: 30 }, (_, index) =>
      modelCandidate("openrouter", `openrouter-model-${String(index + 1).padStart(2, "0")}`));
    const flow = fakeFlow({
      providers: [providerCandidate("openrouter", "OpenRouter", openRouterModels.length)],
      models: { openrouter: openRouterModels },
    });
    const prompt = fakePrompt(["openrouter", "openrouter-model-30"]);

    await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      allowBack: true,
      allowCancel: true,
      currentProviderId: "openrouter",
      currentModelId: "openrouter-model-30",
    });

    expect(prompt.calls[1]?.defaultIndex).toBe(4);
    expect(prompt.calls[1]?.options.map((option) => option.id)).toEqual([
      ...openRouterModels.slice(25).map((model) => model.id),
      "previous-page",
      "back",
      "cancel",
    ]);
    expect(prompt.calls[1]?.options[4]).toMatchObject({
      id: "openrouter-model-30",
      current: true,
    });
    expect(prompt.calls[1]?.technicalLines).toEqual(["Models 26-30 of 30."]);
  });

  it("leaves long non-OpenRouter model lists unpaginated", async () => {
    const openAiModels = Array.from({ length: 30 }, (_, index) =>
      modelCandidate("openai", `openai-model-${String(index + 1).padStart(2, "0")}`));
    const flow = fakeFlow({
      providers: [providerCandidate("openai", "OpenAI", openAiModels.length)],
      models: { openai: openAiModels },
    });
    const prompt = fakePrompt(["openai", "openai-model-30"]);

    const result = await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      allowBack: true,
      allowCancel: true,
    });

    expect(result).toEqual({
      kind: "selected",
      selection: selectionResult("openai", "openai-model-30"),
    });
    expect(prompt.calls).toHaveLength(2);
    expect(prompt.calls[1]?.options.map((option) => option.id)).toEqual([
      ...openAiModels.map((model) => model.id),
      "back",
      "cancel",
    ]);
    expect(prompt.calls[1]?.options.map((option) => option.id)).not.toContain("next-page");
    expect(prompt.calls[1]?.technicalLines).toBeUndefined();
  });

  it("does not mark Back or Cancel rows as current", async () => {
    const flow = fakeFlow();
    const prompt = fakePrompt();

    await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      allowBack: true,
      allowCancel: true,
      currentProviderId: "openai",
      currentModelId: "alpha-model",
    });

    for (const call of prompt.calls) {
      for (const option of call.options.filter((item) => item.id === "back" || item.id === "cancel")) {
        expect(option.current).toBeUndefined();
        expect(option.badges).toBeUndefined();
        expect(option.group).toBe("navigation");
      }
    }
  });

  it("uses visible current provider as provider default selection and marks it current", async () => {
    const flow = fakeFlow({
      providers: [
        providerCandidate("openai", "OpenAI", 1),
        providerCandidate("local", "Local", 1),
      ],
    });
    const prompt = fakePrompt();

    await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      currentProviderId: "local",
      currentModelId: "local-model",
    });

    expect(prompt.calls[0]?.defaultIndex).toBe(1);
    expect(prompt.calls[0]?.technicalLines).toBeUndefined();
    expect(prompt.calls[0]?.statusLines).toEqual([
      { text: "Current: local/local-model", tone: "active", direction: "ltr" },
    ]);
    expect(prompt.calls[0]?.options[1]).toMatchObject({
      id: "local",
      current: true,
    });
    expect(prompt.calls[0]?.options[1]?.badges).toBeUndefined();
    expect(prompt.calls[0]?.showCurrentBadge).toBe(false);
    expect(flow.resolved).toEqual([{ providerId: "local", modelId: "alpha-model" }]);
  });

  it("builds Arabic current route status from localized label and isolated route token", async () => {
    const flow = fakeFlow({
      providers: [
        providerCandidate("openai", "OpenAI", 1),
        providerCandidate("local", "Local", 1),
      ],
    });
    const prompt = fakePrompt();

    await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "ar",
      mode: "primary",
      currentProviderId: "local",
      currentModelId: "local-model",
    });

    expect(prompt.calls[0]?.statusLines).toEqual([
      { text: "الحالي: \u2066local/local-model\u2069", tone: "active", direction: "rtl" },
    ]);
  });

  it("uses localized previous-step copy for Arabic Back rows", async () => {
    const flow = fakeFlow();
    const prompt = fakePrompt();

    await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "ar",
      mode: "primary",
      allowBack: true,
    });

    expect(prompt.calls[0]?.options.find((option) => option.id === "back")).toMatchObject({
      group: "navigation",
      cells: {
        details: "ارجع إلى الخطوة السابقة.",
      },
    });
  });

  it("uses visible current model as model default selection and marks it current", async () => {
    const flow = fakeFlow({
      models: {
        openai: [
          modelCandidate("openai", "alpha-model"),
          modelCandidate("openai", "beta-model"),
        ],
      },
    });
    const prompt = fakePrompt();

    await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      currentProviderId: "openai",
      currentModelId: "beta-model",
    });

    expect(prompt.calls[1]?.defaultIndex).toBe(1);
    expect(prompt.calls[1]?.options[1]).toMatchObject({
      id: "beta-model",
      current: true,
    });
    expect(prompt.calls[1]?.options[1]?.badges).toBeUndefined();
    expect(prompt.calls[1]?.showCurrentBadge).toBe(false);
    expect(flow.resolved).toEqual([{ providerId: "openai", modelId: "beta-model" }]);
  });

  it("does not mark current model when browsing a different provider", async () => {
    const flow = fakeFlow({
      providers: [
        providerCandidate("openai", "OpenAI", 1),
        providerCandidate("local", "Local", 1),
      ],
    });
    const prompt = fakePrompt();

    await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      currentProviderId: "local",
      currentModelId: "local-model",
    });

    expect(prompt.calls[1]?.options.some((option) => option.current === true)).toBe(false);
    expect(prompt.calls[1]?.options.some((option) => option.badges?.includes("Current") === true)).toBe(false);
  });

  it("shows a current-model-not-visible note for the current provider", async () => {
    const flow = fakeFlow({
      models: {
        openai: [modelCandidate("openai", "alpha-model")],
      },
    });
    const prompt = fakePrompt();

    await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      currentProviderId: "openai",
      currentModelId: "missing-model",
    });

    expect(prompt.calls[1]?.statusLines).toEqual([
      { text: "Current: openai/missing-model", tone: "active", direction: "ltr" },
    ]);
    expect(prompt.calls[1]?.technicalLines).toEqual([
      "Current model not shown: openai/missing-model",
    ]);
  });

  it("uses provider descriptions with custom fallback behavior", () => {
    expect(providerCandidateDescription("en", providerCandidate("deepseek", "DeepSeek", 1))).toBe("Cost-efficient models for primary or auxiliary use. Direct API.");
    expect(providerCandidateDescription("en", providerCandidate("google", "Google", 1))).toBe("Gemini models with strong utility and multimodal coverage. Direct API.");
    expect(providerCandidateDescription("en", providerCandidate("kimi", "Kimi", 1))).toBe("Moonshot Kimi models with strong quality/cost balance. Direct API.");
    expect(providerCandidateDescription("en", providerCandidate("local", "Local / Custom", 1))).toBe("OpenAI-compatible local or custom endpoint. API key optional.");
    expect(providerCandidateDescription("en", providerCandidate("openai", "OpenAI", 1))).toBe("Frontier models for high-quality primary reasoning. Direct API.");
    expect(providerCandidateDescription("en", providerCandidate("openrouter", "OpenRouter", 1))).toBe("Pay-per-use aggregator for routing across many model providers.");
    expect(providerCandidateDescription("en", providerCandidate("zai", "Z.AI", 1))).toBe("GLM models with strong quality/cost balance. Direct API.");
    expect(providerCandidateDescription("en", {
      ...providerCandidate("custom-provider" as ProviderId, "Custom", 1),
      baseUrl: "https://models.example/v1",
    })).toBe("Custom OpenAI-compatible provider at https://models.example/v1.");
    expect(providerCandidateDescription("en", providerCandidate("custom-provider" as ProviderId, "Custom", 1))).toBe("Custom OpenAI-compatible provider.");
  });

  it("generates conservative model descriptions from model metadata", () => {
    expect(modelCandidateDescription("en", modelCandidate("openai", "alpha-model"))).toBe(
      "128K context | Tools | Vision"
    );
    expect(modelCandidateDescription("en", {
      ...modelCandidate("openai", "beta-model"),
      profile: {
        ...modelCandidate("openai", "beta-model").profile,
        contextWindowTokens: 1_000_000,
        supportsTools: false,
        supportsVision: false,
        supportsStructuredOutput: false,
        supportsReasoning: true,
        status: "beta",
      },
      supportsVision: false,
      lifecycleNote: "Use with care.",
      warnings: ["Limited availability."],
    })).toBe("1M context | Reasoning | Beta | Use with care | Limited availability");
  });

  it("does not display structured output in model descriptions", () => {
    expect(modelCandidateDescription("en", {
      ...modelCandidate("openai", "structured-model"),
      profile: {
        ...modelCandidate("openai", "structured-model").profile,
        supportsTools: false,
        supportsVision: false,
        supportsStructuredOutput: true,
        supportsReasoning: false,
      },
      supportsVision: false,
    })).toBe("128K context");
  });

  it("does not invent model capabilities when metadata fields are absent", () => {
    expect(modelCandidateDescription("en", {
      ...modelCandidate("openai", "plain-model"),
      profile: {
        ...modelCandidate("openai", "plain-model").profile,
        contextWindowTokens: 0,
        supportsTools: false,
        supportsVision: false,
        supportsStructuredOutput: false,
        supportsReasoning: false,
      },
      supportsVision: false,
    })).toBe("");
  });

  it("preserves local and custom fallback descriptions when no metadata is available", () => {
    expect(modelCandidateDescription("en", {
      ...modelCandidate("local", "plain-local"),
      profile: {
        ...modelCandidate("local", "plain-local").profile,
        contextWindowTokens: 0,
        supportsTools: false,
        supportsVision: false,
        supportsStructuredOutput: false,
        supportsReasoning: false,
      },
      supportsVision: false,
    })).toBe("Local OpenAI-compatible model.");

    expect(modelCandidateDescription("en", {
      ...modelCandidate("openai-compatible", "plain-custom"),
      profile: {
        ...modelCandidate("openai-compatible", "plain-custom").profile,
        contextWindowTokens: 0,
        supportsTools: false,
        supportsVision: false,
        supportsStructuredOutput: false,
        supportsReasoning: false,
      },
      supportsVision: false,
    })).toBe("Custom OpenAI-compatible model.");
  });

  it("appends curated model notes after metadata", () => {
    expect(modelCandidateDescription("en", {
      ...modelCandidate("openai", "gpt-5-mini"),
      profile: {
        ...modelCandidate("openai", "gpt-5-mini").profile,
        contextWindowTokens: 400000,
        supportsTools: true,
        supportsVision: true,
        supportsReasoning: true,
        supportsStructuredOutput: true,
      },
    })).toBe("400K context | Tools | Vision | Reasoning | Recommended auxiliary model");
  });

  it("uses curated model notes without metadata and avoids provider/model key collisions", () => {
    expect(modelCandidateDescription("en", {
      ...modelCandidate("openai", "gpt-5-mini"),
      profile: {
        ...modelCandidate("openai", "gpt-5-mini").profile,
        contextWindowTokens: 0,
        supportsTools: false,
        supportsVision: false,
        supportsReasoning: false,
        supportsStructuredOutput: false,
      },
      supportsVision: false,
    })).toBe("Recommended auxiliary model");

    expect(modelCandidateDescription("en", {
      ...modelCandidate("deepseek", "deepseek-v4-flash"),
      profile: {
        ...modelCandidate("deepseek", "deepseek-v4-flash").profile,
        contextWindowTokens: 0,
        supportsTools: false,
        supportsVision: false,
        supportsReasoning: false,
        supportsStructuredOutput: false,
      },
      supportsVision: false,
    })).toBe("Recommended auxiliary model");

    expect(modelCandidateDescription("en", {
      ...modelCandidate("google", "gemini-3-flash-preview"),
      profile: {
        ...modelCandidate("google", "gemini-3-flash-preview").profile,
        contextWindowTokens: 0,
        supportsTools: false,
        supportsVision: false,
        supportsReasoning: false,
        supportsStructuredOutput: false,
      },
      supportsVision: false,
    })).toBe("Recommended auxiliary model");

    expect(modelCandidateDescription("ar", {
      ...modelCandidate("openai", "gpt-5-mini"),
      profile: {
        ...modelCandidate("openai", "gpt-5-mini").profile,
        contextWindowTokens: 0,
        supportsTools: false,
        supportsVision: false,
        supportsReasoning: false,
        supportsStructuredOutput: false,
      },
      supportsVision: false,
    })).toBe("نموذج مساعد موصى به");

    expect(modelCandidateDescription("en", {
      ...modelCandidate("google", "gpt-5-mini"),
      profile: {
        ...modelCandidate("google", "gpt-5-mini").profile,
        contextWindowTokens: 0,
        supportsTools: false,
        supportsVision: false,
        supportsReasoning: false,
        supportsStructuredOutput: false,
      },
      supportsVision: false,
    })).toBe("");
  });

  it("includes deprecated lifecycle when profile status is stable or absent", () => {
    expect(modelCandidateDescription("en", {
      ...modelCandidate("openai", "stable-deprecated-model"),
      lifecycle: "deprecated",
      profile: {
        ...modelCandidate("openai", "stable-deprecated-model").profile,
        status: "stable",
      },
    })).toContain("Deprecated");

    const withoutStatus = modelCandidate("openai", "statusless-deprecated-model");
    const { status: _status, ...profileWithoutStatus } = withoutStatus.profile;
    expect(modelCandidateDescription("en", {
      ...withoutStatus,
      lifecycle: "deprecated",
      profile: profileWithoutStatus,
    })).toContain("Deprecated");
  });

  it("does not duplicate deprecated when lifecycle and profile status both carry it", () => {
    const description = modelCandidateDescription("en", {
      ...modelCandidate("openai", "deprecated-model"),
      lifecycle: "deprecated",
      profile: {
        ...modelCandidate("openai", "deprecated-model").profile,
        status: "deprecated",
      },
    });

    expect(description.match(/Deprecated/gu)).toHaveLength(1);
  });

  it("generates Arabic-safe provider and model descriptions", () => {
    const providerDescription = providerCandidateDescription("ar", {
      ...providerCandidate("custom-provider" as ProviderId, "Custom", 1),
      baseUrl: "https://models.example/v1",
    });
    expect(providerDescription).toContain("https://models.example/v1");
    expect(providerDescription).toContain("\u2066https://models.example/v1\u2069");
    expect(modelCandidateDescription("ar", modelCandidate("local", "llama3"))).toContain("سياق \u2066128K\u2069 | أدوات | رؤية");
  });

  it("does not resolve or persist anything when navigation exits early", async () => {
    const flow = fakeFlow();
    const prompt = fakePrompt(["back"]);

    const result = await selectProviderModelRoute({
      prompt,
      flowEngine: flow.engine,
      locale: "en",
      mode: "primary",
      allowBack: true,
      allowCancel: true,
    });

    expect(result).toEqual({ kind: "back" });
    expect(flow.providerListCount).toBe(1);
    expect(flow.modelListCount).toBe(0);
    expect(flow.resolved).toHaveLength(0);
  });
});

function fakePrompt(selectionIds: readonly string[] = []): Prompt & {
  readonly calls: SelectPromptInput<unknown>[];
} {
  const selections = [...selectionIds];
  const calls: SelectPromptInput<unknown>[] = [];
  const prompt = (async () => {
    throw new Error("Plain prompt fallback was not expected in provider-model route prompt tests.");
  }) as unknown as Prompt & { readonly calls: SelectPromptInput<unknown>[] };
  prompt.select = async <T>(input: SelectPromptInput<T>): Promise<T> => {
    calls.push(input as SelectPromptInput<unknown>);
    const requested = selections.shift();
    const selected = requested === undefined
      ? input.options[input.defaultIndex ?? 0]
      : input.options.find((option) => option.id === requested || option.label === requested);
    return (selected ?? input.options[input.defaultIndex ?? 0] ?? input.options[0])!.value;
  };
  prompt.onboardingCard = () => undefined;
  prompt.close = () => undefined;
  Object.defineProperty(prompt, "calls", { value: calls });
  return prompt;
}

function fakeFlow(options: {
  readonly providers?: readonly ProviderCandidate[];
  readonly models?: Readonly<Record<string, readonly ModelCandidate[]>>;
  readonly diagnostic?: string;
} = {}): {
  readonly engine: FlowEngine;
  readonly resolved: Array<{ readonly providerId: ProviderId; readonly modelId: string }>;
  providerListCount: number;
  modelListCount: number;
} {
  const resolved: Array<{ readonly providerId: ProviderId; readonly modelId: string }> = [];
  const state = {
    providerListCount: 0,
    modelListCount: 0,
    resolved,
    engine: {
      listProviderCandidates: async () => {
        state.providerListCount += 1;
        return [...(options.providers ?? [providerCandidate("openai", "OpenAI", 2)])];
      },
      listModelCandidates: async (providerId: ProviderId) => {
        state.modelListCount += 1;
        const models = options.models?.[providerId] ?? [modelCandidate(providerId, "alpha-model")];
        return [...models];
      },
      resolveSelection: async (providerId: ProviderId, modelId: string) => {
        resolved.push({ providerId, modelId });
        if (options.diagnostic !== undefined) {
          return {
            kind: "diagnostic" as const,
            provider: providerId,
            model: modelId,
            reason: options.diagnostic,
          };
        }
        return selectionResult(providerId, modelId);
      },
    },
  };
  return state;
}

function providerCandidate(id: ProviderId, displayName: string, modelsCount: number): ProviderCandidate {
  return {
    id,
    displayName,
    catalogOnly: false,
    configurable: true,
    runnable: true,
    modelsCount,
    credentialReady: true,
  };
}

function modelCandidate(provider: ProviderId, id: string): ModelCandidate {
  return {
    id,
    provider,
    profile: {
      id,
      provider,
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: false,
      supportsStructuredOutput: true,
      status: "stable",
    },
    configured: true,
    executable: true,
    catalogOnly: false,
    supportsVision: true,
    lifecycle: "available",
    usageClass: "primary-chat",
  };
}

function selectionResult(provider: ProviderId, model: string): ProviderModelSelectionResult {
  return {
    kind: "selected",
    provider,
    model,
    apiMode: "custom_openai_compatible" as ProviderApiMode,
    authMethod: "api_key" as ProviderAuthMethod,
    credentialAction: { kind: "reuse", reference: "env:OPENAI_API_KEY" },
    profile: {
      id: model,
      provider,
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: false,
      supportsStructuredOutput: true,
      status: "stable",
    },
  };
}
