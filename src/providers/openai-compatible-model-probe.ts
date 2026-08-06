import type { FetchLike } from "./openai-compatible-provider.js";

export type OpenAICompatibleProbeAuth =
  | { readonly kind: "none" }
  | { readonly kind: "bearer"; readonly token: string }
  | { readonly kind: "env"; readonly name: string; readonly env?: Record<string, string | undefined> };

export type OpenAIModelProbe = {
  ok: boolean;
  baseUrl: string;
  models: string[];
  message: string;
};

export type OpenAIModelProbeOptions = {
  readonly fetch?: FetchLike;
  readonly auth?: OpenAICompatibleProbeAuth;
  readonly timeoutMs?: number;
};

export type OpenAICompatibleCheckStatus = "passed" | "failed" | "skipped" | "notTested";

export type OpenAIChatCompletionTestResult = {
  readonly status: OpenAICompatibleCheckStatus;
  readonly ok: boolean;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly message: string;
};

export type OpenAIChatCompletionTestOptions = {
  readonly fetch?: FetchLike;
  readonly auth?: OpenAICompatibleProbeAuth;
  readonly timeoutMs?: number;
  readonly skip?: boolean;
  readonly visionImageDataUrl?: string;
};

const DEFAULT_TIMEOUT_MS = 3_000;

export async function probeOpenAIModels(baseUrl: string, options: OpenAIModelProbeOptions = {}): Promise<OpenAIModelProbe> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const url = `${normalizedBaseUrl}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const authToken = resolveAuthToken(options.auth);

  try {
    const response = await fetchWithFallback(options.fetch, url, {
      method: "GET",
      headers: authHeaders(authToken),
      body: "",
      signal: controller.signal
    });
    const json = await safeJson(response);
    const models = extractOpenAIModelIds(json);

    if (!response.ok) {
      return {
        ok: false,
        baseUrl: normalizedBaseUrl,
        models,
        message: redactSensitive(response.statusText || `HTTP ${response.status}`, authToken)
      };
    }

    return {
      ok: true,
      baseUrl: normalizedBaseUrl,
      models,
      message: models.length === 0
        ? "endpoint responded, but no models were listed"
        : `endpoint ready; ${models.length} model(s) visible`
    };
  } catch (error) {
    return {
      ok: false,
      baseUrl: normalizedBaseUrl,
      models: [],
      message: redactSensitive(error instanceof Error ? error.message : "endpoint did not respond", authToken)
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function testOpenAICompatibleChatCompletion(
  baseUrl: string,
  modelId: string,
  options: OpenAIChatCompletionTestOptions = {}
): Promise<OpenAIChatCompletionTestResult> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (options.skip === true) {
    return {
      status: "skipped",
      ok: false,
      baseUrl: normalizedBaseUrl,
      modelId,
      message: "Chat completion test skipped."
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const authToken = resolveAuthToken(options.auth);
  const url = `${normalizedBaseUrl}/chat/completions`;

  try {
    const response = await fetchWithFallback(options.fetch, url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(authToken)
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{
          role: "user",
          content: options.visionImageDataUrl === undefined
            ? "Respond with OK."
            : [
                { type: "text", text: "Read the benign verification image and identify its English and Arabic text." },
                { type: "image_url", image_url: { url: options.visionImageDataUrl, detail: "low" } },
              ],
        }],
        stream: false,
        max_tokens: options.visionImageDataUrl === undefined ? 8 : 64
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        status: "failed",
        ok: false,
        baseUrl: normalizedBaseUrl,
        modelId,
        message: redactSensitive(response.statusText || `HTTP ${response.status}`, authToken)
      };
    }

    return {
      status: "passed",
      ok: true,
      baseUrl: normalizedBaseUrl,
      modelId,
      message: options.visionImageDataUrl === undefined
        ? "Chat completion passed."
        : "Vision completion passed."
    };
  } catch (error) {
    return {
      status: "failed",
      ok: false,
      baseUrl: normalizedBaseUrl,
      modelId,
      message: redactSensitive(error instanceof Error ? error.message : "chat completion test failed", authToken)
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function openAIChatCompletionNotTested(baseUrl: string, modelId: string): OpenAIChatCompletionTestResult {
  return {
    status: "notTested",
    ok: false,
    baseUrl: normalizeBaseUrl(baseUrl),
    modelId,
    message: "Chat completion not tested."
  };
}

export function extractOpenAIModelIds(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as {
    data?: Array<{ id?: unknown }>;
    models?: Array<{ name?: unknown; model?: unknown; id?: unknown }>;
  };

  if (Array.isArray(record.data)) {
    return uniqueStrings(record.data.map((entry) => typeof entry.id === "string" ? entry.id : ""));
  }

  if (Array.isArray(record.models)) {
    return uniqueStrings(record.models.map((entry) => {
      if (typeof entry.id === "string") return entry.id;
      if (typeof entry.model === "string") return entry.model;
      if (typeof entry.name === "string") return entry.name;
      return "";
    }));
  }

  return [];
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function resolveAuthToken(auth: OpenAICompatibleProbeAuth | undefined): string | undefined {
  if (auth === undefined || auth.kind === "none") return undefined;
  if (auth.kind === "bearer") return auth.token;
  return auth.env?.[auth.name] ?? process.env[auth.name];
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

async function fetchWithFallback(
  fetchLike: FetchLike | undefined,
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
): ReturnType<FetchLike> {
  if (fetchLike !== undefined) {
    return fetchLike(url, init);
  }
  return globalThis.fetch(url, init) as ReturnType<FetchLike>;
}

async function safeJson(response: Awaited<ReturnType<FetchLike>>): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

function redactSensitive(value: string, token: string | undefined): string {
  if (token === undefined || token.length === 0) return value;
  return value.split(token).join("[redacted]");
}
