import type {
  ModelProfile,
  ProviderRequest,
  ProviderResponse,
  ProviderRoute,
  ProviderRoutePreferences,
  ProviderStreamEvent,
  ProviderId
} from "../contracts/provider.js";
import { CredentialPoolRegistry } from "./credential-pool.js";
import { ProviderRegistry } from "./provider-registry.js";
import { routeProvider } from "./provider-router.js";

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
  route?: ProviderRoute;
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
  onEvent?: (event: ProviderRuntimeEvent) => void | Promise<void>;
};

export type ProviderExecutorOptions = {
  registry: ProviderRegistry;
  credentialPools?: CredentialPoolRegistry;
  oneShotFallbackPerSession?: boolean;
};

export class ProviderExecutor {
  readonly #registry: ProviderRegistry;
  readonly #credentialPools: CredentialPoolRegistry | undefined;
  readonly #oneShotFallbackPerSession: boolean;
  readonly #sessionsWithFallback = new Set<string>();

  constructor(options: ProviderExecutorOptions) {
    this.#registry = options.registry;
    this.#credentialPools = options.credentialPools;
    this.#oneShotFallbackPerSession = options.oneShotFallbackPerSession ?? true;
  }

  async complete(
    request: Omit<ProviderRequest, "model"> & { model?: string },
    preferences: ProviderRoutePreferences = {},
    options: ProviderExecutionOptions = {}
  ): Promise<ProviderExecutionResult> {
    const models = await this.#registry.listModels();
    const explicitModel = request.model === undefined
      ? undefined
      : models.find((model) => model.id === request.model);
    const route = explicitModel === undefined
      ? routeProvider(models, preferences)
      : {
        primary: explicitModel,
        fallbacks: routeProvider(models, preferences)?.fallbacks.filter((model) =>
          model.provider !== explicitModel.provider || model.id !== explicitModel.id
        ) ?? [],
        reason: `explicit model ${explicitModel.provider}/${explicitModel.id}`
      };

    if (route === undefined) {
      return {
        ok: false,
        fallbackUsed: false,
        attempts: [],
        toolCalls: []
      };
    }

    const attempts: ProviderAttempt[] = [];
    const toolCalls: ProviderExecutionResult["toolCalls"] = [];
    const canUseFallback = options.sessionId === undefined ||
      !this.#oneShotFallbackPerSession ||
      !this.#sessionsWithFallback.has(options.sessionId);
    const chain = [route.primary, ...(canUseFallback ? route.fallbacks : [])];

    for (let index = 0; index < chain.length; index++) {
      if (options.signal?.aborted === true) {
        return {
          ok: false,
          route,
          fallbackUsed: attempts.length > 1,
          attempts,
          toolCalls
        };
      }
      const model = chain[index];
      const provider = this.#registry.get(model.provider);

      if (provider === undefined) {
        continue;
      }

      const credential = this.#credentialPools?.resolve(model.provider);
      await options.onEvent?.({
        kind: "provider-attempt-start",
        provider: model.provider,
        model: model.id,
        credentialId: credential?.id,
        fallback: index > 0
      });
      const response = options.stream === true && provider.stream !== undefined
        ? await collectProviderStream({
            provider: model.provider,
            model: model.id,
            stream: provider.stream({
              ...request,
              model: model.id,
              stream: true
            }, {
              credential: credential === undefined
                ? undefined
                : {
                  id: credential.id,
                  value: credential.value
                },
              signal: options.signal
            }),
            onEvent: options.onEvent,
            toolCalls,
            signal: options.signal
          })
        : await provider.complete({
            ...request,
            model: model.id
          }, {
            credential: credential === undefined
              ? undefined
              : {
                id: credential.id,
                value: credential.value
              },
            signal: options.signal
          });

      attempts.push({
        provider: model.provider,
        model: model.id,
        credentialId: credential?.id,
        ok: response.ok,
        errorClass: response.errorClass,
        content: response.content
      });
      const willFallback = !response.ok && shouldFallback(response, model) && index < chain.length - 1;

      await options.onEvent?.({
        kind: "provider-attempt-end",
        provider: model.provider,
        model: model.id,
        credentialId: credential?.id,
        ok: response.ok,
        errorClass: response.errorClass,
        fallback: index > 0,
        willFallback
      });

      if (response.ok) {
        if (credential !== undefined) {
          this.#credentialPools?.reportSuccess(model.provider, credential.id);
        }

        return {
          ok: true,
          response,
          route,
          fallbackUsed: index > 0,
          attempts,
          toolCalls
        };
      }

      if (credential !== undefined) {
        this.#credentialPools?.reportFailure(model.provider, credential.id, response.errorClass ?? "unknown");
      }

      if (!willFallback) {
        break;
      }

      if (index === 0 && options.sessionId !== undefined && canUseFallback) {
        this.#sessionsWithFallback.add(options.sessionId);
      }
    }

    return {
      ok: false,
      route,
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

  return errorResponse ?? finalResponse ?? {
    ok: true,
    content,
    model: input.model,
    provider: input.provider
  };
}

function mergeToolCallFragment(
  fragments: Map<string, ProviderExecutionResult["toolCalls"][number]>,
  event: Extract<ProviderStreamEvent, { kind: "tool-call" }>
): void {
  const key = (event.index === undefined ? undefined : `index:${event.index}`) ?? event.id ?? event.name ?? `anonymous:${fragments.size}`;
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

function shouldFallback(response: ProviderResponse, _model: ModelProfile): boolean {
  return response.errorClass === undefined ||
    response.errorClass === "auth" ||
    response.errorClass === "rate-limit" ||
    response.errorClass === "quota" ||
    response.errorClass === "network" ||
    response.errorClass === "server" ||
    response.errorClass === "model-unavailable";
}
