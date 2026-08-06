import { describe, expect, it } from "vitest";
import type { FetchLike } from "./openai-compatible-provider.js";
import {
  extractOpenAIModelIds,
  openAIChatCompletionNotTested,
  probeOpenAIModels,
  testOpenAICompatibleChatCompletion,
} from "./openai-compatible-model-probe.js";

function response(input: {
  readonly ok: boolean;
  readonly status?: number;
  readonly statusText?: string;
  readonly json?: () => Promise<unknown>;
  readonly text?: () => Promise<string>;
}): Awaited<ReturnType<FetchLike>> {
  return {
    ok: input.ok,
    status: input.status ?? (input.ok ? 200 : 500),
    statusText: input.statusText ?? (input.ok ? "OK" : "Error"),
    json: input.json ?? (async () => ({})),
    text: input.text ?? (async () => ""),
    body: null
  };
}

describe("openai-compatible model probe", () => {
  it("extracts OpenAI data ids with duplicates filtered", () => {
    expect(extractOpenAIModelIds({
      data: [
        { id: "qwen2.5:7b" },
        { id: "qwen2.5:7b" },
        { id: "" },
        { id: 123 },
        { id: "llama3.1:8b" }
      ]
    })).toEqual(["qwen2.5:7b", "llama3.1:8b"]);
  });

  it("extracts Ollama-style model entries by id, model, or name", () => {
    expect(extractOpenAIModelIds({
      models: [
        { name: "llama3.1:8b" },
        { model: "qwen2.5-coder:14b" },
        { id: "deepseek-r1:8b" },
        { name: 123 }
      ]
    })).toEqual(["llama3.1:8b", "qwen2.5-coder:14b", "deepseek-r1:8b"]);
  });

  it("checks /models with normalized base URL and optional bearer auth", async () => {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const fetchLike: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return response({
        ok: true,
        json: async () => ({ data: [{ id: "local-chat" }] })
      });
    };

    const result = await probeOpenAIModels("http://localhost:11434/v1/", {
      fetch: fetchLike,
      auth: { kind: "bearer", token: "sk-local-secret" }
    });

    expect(result).toEqual({
      ok: true,
      baseUrl: "http://localhost:11434/v1",
      models: ["local-chat"],
      message: "endpoint ready; 1 model(s) visible"
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://localhost:11434/v1/models");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.headers.authorization).toBe("Bearer sk-local-secret");
  });

  it("reports HTTP model-list failures even when the body is not JSON", async () => {
    const result = await probeOpenAIModels("https://private.example/v1", {
      fetch: async () => response({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: async () => {
          throw new Error("not json");
        }
      })
    });

    expect(result.ok).toBe(false);
    expect(result.baseUrl).toBe("https://private.example/v1");
    expect(result.models).toEqual([]);
    expect(result.message).toBe("Service Unavailable");
  });

  it("redacts bearer tokens from timeout and abort errors", async () => {
    const fetchLike: FetchLike = async (_url, init) => new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(new Error("request aborted for sk-redact-me"));
      }, { once: true });
    });

    const result = await probeOpenAIModels("https://private.example/v1", {
      fetch: fetchLike,
      auth: { kind: "bearer", token: "sk-redact-me" },
      timeoutMs: 1
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("[redacted]");
    expect(result.message).not.toContain("sk-redact-me");
  });

  it("tests chat completion through /chat/completions", async () => {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const fetchLike: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return response({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "OK" } }] })
      });
    };

    const result = await testOpenAICompatibleChatCompletion("http://localhost:11434/v1/", "qwen2.5:7b", {
      fetch: fetchLike,
      auth: { kind: "env", name: "LOCAL_KEY", env: { LOCAL_KEY: "sk-chat-secret" } }
    });

    expect(result.status).toBe("passed");
    expect(result.ok).toBe(true);
    expect(result.baseUrl).toBe("http://localhost:11434/v1");
    expect(calls[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers.authorization).toBe("Bearer sk-chat-secret");
    expect(JSON.parse(calls[0]?.init.body ?? "{}")).toEqual(expect.objectContaining({
      model: "qwen2.5:7b",
      stream: false
    }));
  });

  it("redacts bearer tokens from chat completion failures", async () => {
    const result = await testOpenAICompatibleChatCompletion("https://private.example/v1", "private-model", {
      fetch: async () => response({
        ok: false,
        status: 401,
        statusText: "Unauthorized sk-chat-secret"
      }),
      auth: { kind: "bearer", token: "sk-chat-secret" }
    });

    expect(result.status).toBe("failed");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Unauthorized [redacted]");
  });

  it("uses a multimodal request for the benign Vision Analysis route check", async () => {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const result = await testOpenAICompatibleChatCompletion("http://localhost:11434/v1", "vision-local", {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ ok: true });
      },
      visionImageDataUrl: imageDataUrl,
    });
    const body = JSON.parse(calls[0]?.init.body ?? "{}") as {
      messages?: Array<{ content?: Array<{ type?: string; image_url?: { url?: string } }> }>;
      max_tokens?: number;
    };

    expect(result).toEqual(expect.objectContaining({ status: "passed", message: "Vision completion passed." }));
    expect(body.messages?.[0]?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text" }),
      expect.objectContaining({ type: "image_url", image_url: { url: imageDataUrl, detail: "low" } }),
    ]));
    expect(body.max_tokens).toBe(64);
  });

  it("represents skipped and not-tested chat checks explicitly", async () => {
    await expect(testOpenAICompatibleChatCompletion("http://localhost:11434/v1", "local-model", {
      skip: true
    })).resolves.toEqual({
      status: "skipped",
      ok: false,
      baseUrl: "http://localhost:11434/v1",
      modelId: "local-model",
      message: "Chat completion test skipped."
    });

    expect(openAIChatCompletionNotTested("http://localhost:11434/v1/", "local-model")).toEqual({
      status: "notTested",
      ok: false,
      baseUrl: "http://localhost:11434/v1",
      modelId: "local-model",
      message: "Chat completion not tested."
    });
  });
});
