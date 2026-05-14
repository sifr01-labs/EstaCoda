import type {
  ProviderEndpoint,
  ProviderRequest,
  ProviderResponse,
  ProviderRoutePreferences,
  ProviderStreamEvent,
  ProviderId,
  ResolvedModelRoute
} from "../contracts/provider.js";
import { CredentialPoolRegistry } from "./credential-pool.js";
import { ProviderRegistry } from "./provider-registry.js";
import { resolveRuntimeCredential } from "./runtime-credential-resolver.js";
import { getProviderMetadata } from "./provider-metadata.js";

export type ProviderAttempt = {
  provider: string;
  model: string;
  credentialId?: string;
  ok: boolean;
  errorClass?: string;
  content: string;
};

export type ProviderExecutionResult = {
  ok: boolean;
  response?: ProviderResponse;
  fallbackUsed: boolean;
  attempts: ProviderAttempt[];
  toolCalls: Array<{
    index?: number;
    id?: string;
    name?: string;
    argumentsText?: string;
    raw?: unknown;
  }>;
};

export type ProviderRuntimeEvent =
  | {
      kind: "provider-attempt-start";
      provider: string;
      model: string;
      credentialId?: string;
      fallback: boolean;
    }
  | {
      kind: "provider-token";
      provider: string;
      model: string;
      text: string;
    }
  | {
      kind: "provider-tool-call";
      provider: string;
      model: string;
      index?: number;
      id?: string;
      name?: string;
      argumentsText?: string;
      raw?: unknown;
    }
  | {
      kind: "provider-attempt-end";
      provider: string;
      model: string;
      credentialId?: string;
      ok: boolean;
      errorClass?: string;
      fallback: boolean;
      willFallback: boolean;
    };

export type ProviderExecutionOptions = {
  sessionId?: string;
  stream?: boolean;
  signal?: AbortSignal;
  primaryRoute?: ResolvedModelRoute;
  fallbackChain?: ResolvedModelRoute[];
  onEvent?: (event: ProviderRuntimeEvent) => void | Promise<void>;
};

export type ProviderExecutorOptions = {
  registry: ProviderRegistry;
  credentialPools?: CredentialPoolRegistry;
};

export class ProviderExecutor {
  readonly #registry: ProviderRegistry;
  readonly #credentialPools: CredentialPoolRegistry | undefined;

  constructor(options: ProviderExecutorOptions) {
    this.#registry = options.registry;
    this.#credentialPools = options.credentialPools;
  }

  async complete(
    request: Omit<ProviderRequest, "model"> & { model?: string },
    _preferences: ProviderRoutePreferences = {},
    options: ProviderExecutionOptions = {}
  ): Promise<ProviderExecutionResult> {
    const primaryRoute = options.primaryRoute;

    if (primaryRoute === undefined) {
      return {
        ok: false,
        fallbackUsed: false,
        attempts: [
          {
            provider: request.provider ?? "none",
            model: request.model ?? "none",
            ok: false,
            errorClass: "missing-route",
            content: "No explicit primary route is available. Production execution requires a resolved model route."
          }
        ],
        toolCalls: []
      };
    }

    return this.#executeRouteChain(request, options);
  }

  async #executeRouteChain(
    request: Omit<ProviderRequest, "model"> & { model?: string },
    options: ProviderExecutionOptions
  ): Promise<ProviderExecutionResult> {
    const primaryRoute = options.primaryRoute!;
    const fallbackChain = options.fallbackChain ?? [];
    const attempts: ProviderAttempt[] = [];
    const toolCalls: ProviderExecutionResult["toolCalls"] = [];
    const chain = [primaryRoute, ...fallbackChain];

    for (let index = 0; index < chain.length; index++) {
      if (options.signal?.aborted === true) {
        return {
          ok: false,
          fallbackUsed: attempts.length > 1,
          attempts,
          toolCalls
        };
      }

      const route = chain[index];
      const provider = this.#registry.get(route.provider);

      if (provider === undefined || provider.executable === false) {
        const reason = provider === undefined
          ? `No provider adapter is registered for ${route.provider}.`
          : `Provider ${route.provider} is registered for model discovery only and is not yet executable.`;
        attempts.push({
          provider: route.provider,
          model: route.id,
          ok: false,
          errorClass: provider === undefined ? undefined : "unsupported",
          content: reason
        });
        await options.onEvent?.({
          kind: "provider-attempt-end",
          provider: route.provider,
          model: route.id,
          ok: false,
          errorClass: provider === undefined ? undefined : "unsupported",
          fallback: index > 0,
          willFallback: index < chain.length - 1
        });
        continue;
      }

      // Credential resolution: route.apiKeyEnv takes precedence over pool
      const resolution = resolveRuntimeCredential({
        providerId: route.provider,
        route: { apiKeyEnv: route.apiKeyEnv },
        credentialPools: this.#credentialPools,
        metadata: getProviderMetadata(route.provider),
      });

      if (!resolution.diagnostic.ok) {
        const errorContent = resolution.diagnostic.message ?? `Missing credential for ${route.provider}`;
        attempts.push({
          provider: route.provider,
          model: route.id,
          ok: false,
          errorClass: "auth",
          content: errorContent
        });
        await options.onEvent?.({
          kind: "provider-attempt-end",
          provider: route.provider,
          model: route.id,
          ok: false,
          errorClass: "auth",
          fallback: index > 0,
          willFallback: index < chain.length - 1
        });
        continue;
      }

      const credential = resolution.credential?.kind === "bearer"
        ? { id: resolution.credential.id, value: resolution.credential.value }
        : undefined;

      await options.onEvent?.({
        kind: "provider-attempt-start",
        provider: route.provider,
        model: route.id,
        credentialId: credential?.id,
        fallback: index > 0
      });

      const completionOptions: {
        credential?: { id: string; value?: string };
        endpoint?: ProviderEndpoint;
        signal?: AbortSignal;
      } = {
        credential,
        signal: options.signal
      };

      if (route.baseUrl !== undefined) {
        completionOptions.endpoint = {
          baseUrl: route.baseUrl,
          apiKey: route.apiKeyEnv !== undefined ? { kind: "env", name: route.apiKeyEnv } : undefined
        };
      }

      const response = options.stream === true && provider.stream !== undefined
        ? await collectProviderStream({
            provider: route.provider,
            model: route.id,
            stream: provider.stream({
              ...request,
              provider: route.provider,
              model: route.id,
              stream: true
            }, completionOptions),
            onEvent: options.onEvent,
            toolCalls,
            signal: options.signal
          })
        : await provider.complete({
            ...request,
            provider: route.provider,
            model: route.id
          }, completionOptions);

      attempts.push({
        provider: route.provider,
        model: route.id,
        credentialId: credential?.id,
        ok: response.ok,
        errorClass: response.errorClass,
        content: response.content
      });

      const nextRoute = chain[index + 1];
      const willFallback = !response.ok && shouldFallback(response, route, nextRoute);

      await options.onEvent?.({
        kind: "provider-attempt-end",
        provider: route.provider,
        model: route.id,
        credentialId: credential?.id,
        ok: response.ok,
        errorClass: response.errorClass,
        fallback: index > 0,
        willFallback
      });

      if (response.ok) {
        if (credential !== undefined && this.#credentialPools !== undefined && route.apiKeyEnv === undefined) {
          this.#credentialPools.reportSuccess(route.provider, credential.id);
        }

        for (const toolCall of extractToolCallsFromProviderResponse(response.raw)) {
          toolCalls.push(toolCall);
          await options.onEvent?.({
            kind: "provider-tool-call",
            provider: route.provider,
            model: route.id,
            index: toolCall.index,
            id: toolCall.id,
            name: toolCall.name,
            argumentsText: toolCall.argumentsText,
            raw: toolCall.raw
          });
        }

        return {
          ok: true,
          response,
          fallbackUsed: index > 0,
          attempts,
          toolCalls
        };
      }

      if (credential !== undefined && this.#credentialPools !== undefined && route.apiKeyEnv === undefined) {
        this.#credentialPools.reportFailure(route.provider, credential.id, response.errorClass ?? "unknown");
      }

      if (!willFallback) {
        break;
      }
    }

    return {
      ok: false,
      fallbackUsed: attempts.length > 1,
      attempts,
      toolCalls
    };
  }
}

async function collectProviderStream(input: {
  provider: ProviderId;
  model: string;
  stream: AsyncIterable<ProviderStreamEvent>;
  onEvent?: (event: ProviderRuntimeEvent) => void | Promise<void>;
  toolCalls: ProviderExecutionResult["toolCalls"];
  signal?: AbortSignal;
}): Promise<ProviderResponse> {
  let content = "";
  let finalResponse: ProviderResponse | undefined;
  let errorResponse: ProviderResponse | undefined;
  const toolCallFragments = new Map<string, ProviderExecutionResult["toolCalls"][number]>();

  for await (const event of input.stream) {
    if (input.signal?.aborted === true) {
      return {
        ok: false,
        content: "Provider stream cancelled.",
        model: input.model,
        provider: input.provider,
        errorClass: "timeout"
      };
    }

    switch (event.kind) {
      case "start":
        break;
      case "token":
        content += event.text;
        await input.onEvent?.({
          kind: "provider-token",
          provider: event.provider,
          model: event.model,
          text: event.text
        });
        break;
      case "tool-call":
        mergeToolCallFragment(toolCallFragments, event);
        break;
      case "done":
        finalResponse = event.response.content.length === 0 && content.length > 0
          ? {
              ...event.response,
              content
            }
          : event.response;
        break;
      case "error":
        errorResponse = event.response;
        break;
    }
  }

  for (const toolCall of toolCallFragments.values()) {
    input.toolCalls.push(toolCall);
    await input.onEvent?.({
      kind: "provider-tool-call",
      provider: input.provider,
      model: input.model,
      index: toolCall.index,
      id: toolCall.id,
      name: toolCall.name,
      argumentsText: toolCall.argumentsText,
      raw: toolCall.raw
    });
  }

  if (errorResponse !== undefined) {
    return errorResponse;
  }

  if (finalResponse !== undefined) {
    return finalResponse;
  }

  return {
    ok: false,
    content: content.length === 0
      ? "Provider stream ended before a done or error event."
      : `Provider stream ended before completion after partial output:\n${content}`,
    model: input.model,
    provider: input.provider,
    errorClass: "incomplete-stream"
  };
}

function mergeToolCallFragment(
  fragments: Map<string, ProviderExecutionResult["toolCalls"][number]>,
  event: Extract<ProviderStreamEvent, { kind: "tool-call" }>
): void {
  const key = stableToolCallFragmentKey(fragments, event);
  const current = fragments.get(key);

  if (current === undefined) {
    fragments.set(key, {
      index: event.index,
      id: event.id,
      name: event.name,
      argumentsText: event.argumentsText ?? "",
      raw: event.raw
    });
    return;
  }

  fragments.set(key, {
    index: current.index ?? event.index,
    id: current.id ?? event.id,
    name: current.name ?? event.name,
    argumentsText: `${current.argumentsText ?? ""}${event.argumentsText ?? ""}`,
    raw: event.raw ?? current.raw
  });
}

function stableToolCallFragmentKey(
  fragments: Map<string, ProviderExecutionResult["toolCalls"][number]>,
  event: Extract<ProviderStreamEvent, { kind: "tool-call" }>
): string {
  if (event.index !== undefined) {
    return `index:${event.index}`;
  }

  if (event.id !== undefined) {
    return `id:${event.id}`;
  }

  if (event.name !== undefined) {
    return `name:${event.name}`;
  }

  if (fragments.size === 1) {
    const [existingKey] = fragments.keys();
    return existingKey;
  }

  return `anonymous:${fragments.size}`;
}

function shouldFallback(
  response: ProviderResponse,
  currentRoute: ResolvedModelRoute,
  nextRoute: ResolvedModelRoute | undefined
): boolean {
  if (response.errorClass === undefined ||
      response.errorClass === "unknown" ||
      response.errorClass === "rate-limit" ||
      response.errorClass === "quota" ||
      response.errorClass === "network" ||
      response.errorClass === "server" ||
      response.errorClass === "model-unavailable" ||
      response.errorClass === "timeout") {
    return true;
  }

  if (response.errorClass === "auth") {
    if (nextRoute === undefined) {
      return false;
    }
    return isCredentialIndependent(currentRoute, nextRoute);
  }

  return false;
}

function isCredentialIndependent(a: ResolvedModelRoute, b: ResolvedModelRoute): boolean {
  if (a.provider !== b.provider) {
    return true;
  }
  if (a.apiKeyEnv !== undefined && a.apiKeyEnv === b.apiKeyEnv) {
    return false;
  }
  if (a.apiKeyEnv === undefined && b.apiKeyEnv === undefined) {
    return false;
  }
  return true;
}

function extractToolCallsFromProviderResponse(raw: unknown): ProviderExecutionResult["toolCalls"] {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return [];
  }

  const payload = raw as {
    choices?: Array<{
      message?: {
        tool_calls?: Array<{
          id?: string;
          function?: {
            name?: string;
            arguments?: string;
          };
        }>;
      };
    }>;
  };

  return (payload.choices?.[0]?.message?.tool_calls ?? []).map((toolCall, index) => ({
    index,
    id: toolCall.id,
    name: toolCall.function?.name,
    argumentsText: toolCall.function?.arguments,
    raw: toolCall
  }));
}
