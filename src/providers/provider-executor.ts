import type {
  ProviderCompletionOptions,
  ProviderRequest,
  ProviderResponse,
  ProviderRoutePreferences,
  ProviderStreamEvent,
  ProviderId,
  ResolvedModelRoute,
  ProviderApiMode,
  ProviderFinishReason,
  ProviderLoopRuntimeMetadata,
  ProviderReasoningMetadata,
  ProviderAttemptState,
  ProviderRouteRole,
  ProviderStreamDiagnostics,
  ProviderStreamFinish,
  ProviderUsage
} from "../contracts/provider.js";
import type { ProviderUsageContext, ProviderUsageEntry } from "../contracts/provider-usage.js";
import type {
  ProviderSpendAttempt,
  ProviderSpendDenialReason,
  ProviderSpendRequest,
  ProviderSpendReservationResult
} from "../contracts/provider-spend.js";
import { stripThinkBlocks } from "./provider-reasoning.js";
import { ProviderRegistry } from "./provider-registry.js";
import { resolveRuntimeCredential } from "./runtime-credential-resolver.js";
import { getProviderMetadata } from "./provider-metadata.js";
import { isOAuthAuthMethod } from "./oauth/oauth-types.js";
import { loadOAuthStore } from "./oauth/oauth-store.js";
import { refreshOAuthToken } from "./oauth/oauth-refresh.js";
import { providerUsageEntryFromAttempt } from "./provider-usage-ledger.js";
import { prepareProviderSpend, providerSpendDenialMessage } from "./provider-spend-policy.js";

export type ProviderAttempt = ProviderAttemptState & {
  provider: string;
  model: string;
  /** Exact position and semantic role in the resolved route chain. */
  routeIndex?: number;
  routeRole?: ProviderRouteRole;
  credentialId?: string;
  ok: boolean;
  errorClass?: string;
  content: string;
  partialContent?: string;
  finishReason?: ProviderFinishReason;
  incompleteReason?: string;
  usage?: ProviderUsage;
  reasoningMetadata?: ProviderReasoningMetadata;
  streamDiagnostics?: ProviderStreamDiagnostics;
};

/** Runtime guard for injected executors and persisted/untyped boundaries. */
export function assertProviderAttemptState(attempt: ProviderAttempt): void {
  const candidate = attempt as ProviderAttempt & { state?: unknown; dispatchedAt?: unknown };
  if (candidate.state === "preflight") {
    if ("dispatchedAt" in candidate) {
      throw new Error("A preflight provider Attempt cannot have a dispatch timestamp.");
    }
    return;
  }
  if (candidate.state === "dispatched" &&
      typeof candidate.dispatchedAt === "string" &&
      Number.isFinite(Date.parse(candidate.dispatchedAt))) {
    return;
  }
  throw new Error("Provider Attempt dispatch state is missing or invalid.");
}

export type ProviderExecutionResult = {
  ok: boolean;
  response?: ProviderResponse;
  partialContent?: string;
  fallbackUsed: boolean;
  attempts: ProviderAttempt[];
  route?: ResolvedModelRoute;
  attemptedRouteIndex?: number;
  routeRole?: ProviderRouteRole;
  runtimeMetadata?: ProviderLoopRuntimeMetadata;
  spendDenialReason?: ProviderSpendDenialReason;
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
      finishReason?: ProviderFinishReason;
      incompleteReason?: string;
      usage?: ProviderUsage;
      reasoningMetadata?: ProviderReasoningMetadata;
    };

export type ProviderExecutionOptions = {
  sessionId?: string;
  stream?: boolean;
  signal?: AbortSignal;
  primaryRoute?: ResolvedModelRoute;
  fallbackChain?: ResolvedModelRoute[];
  onEvent?: (event: ProviderRuntimeEvent) => void | Promise<void>;
  now?: () => number;
  usage?: ProviderUsageContext;
};

export type ProviderExecutorOptions = {
  registry: ProviderRegistry;
  homeDir?: string;
  profileId?: string;
  usageRecorder?: (input: {
    execution: ProviderExecutionResult;
    context: ProviderUsageContext;
    routes: readonly ResolvedModelRoute[];
  }) => Promise<void>;
  spendController?: ProviderSpendController;
  /** Test-only compatibility for non-durable in-memory runtimes. Never enable for production SQLite execution. */
  allowUnenforcedAttributedSpend?: boolean;
};

export type ProviderSpendController = {
  reserve(
    request: ProviderSpendRequest,
    reservedAt: string
  ): ProviderSpendReservationResult | Promise<ProviderSpendReservationResult>;
  markDispatching(
    requestKey: string,
    dispatchingAt: string
  ): ProviderSpendAttempt | Promise<ProviderSpendAttempt>;
  releaseBeforeDispatch(
    requestKey: string,
    releasedAt: string
  ): ProviderSpendAttempt | Promise<ProviderSpendAttempt>;
  settle(
    requestKey: string,
    usage: ProviderUsageEntry,
    settledAt: string
  ): ProviderSpendAttempt | Promise<ProviderSpendAttempt>;
};

export class ProviderExecutor {
  readonly #registry: ProviderRegistry;
  readonly #homeDir: string | undefined;
  readonly #profileId: string | undefined;
  readonly #usageRecorder: ProviderExecutorOptions["usageRecorder"];
  readonly #spendController: ProviderSpendController | undefined;
  readonly #allowUnenforcedAttributedSpend: boolean;

  constructor(options: ProviderExecutorOptions) {
    this.#registry = options.registry;
    this.#homeDir = options.homeDir;
    this.#profileId = options.profileId;
    this.#usageRecorder = options.usageRecorder;
    this.#spendController = options.spendController;
    this.#allowUnenforcedAttributedSpend = options.allowUnenforcedAttributedSpend === true;
  }

  async complete(
    request: Omit<ProviderRequest, "model"> & { model?: string },
    preferences: ProviderRoutePreferences = {},
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
            state: "preflight",
            ok: false,
            errorClass: "missing-route",
            content: "No explicit primary route is available. Production execution requires a resolved model route."
          }
        ],
        toolCalls: []
      };
    }
    if (options.usage !== undefined && this.#usageRecorder === undefined && this.#spendController === undefined &&
        !this.#allowUnenforcedAttributedSpend) {
      throw new Error("Attributed provider execution requires an immutable usage recorder before dispatch.");
    }

    const execution = await this.#executeRouteChain(request, preferences, options);
    if (options.usage !== undefined && this.#usageRecorder !== undefined && this.#spendController === undefined) {
      await this.#usageRecorder({
        execution,
        context: options.usage,
        routes: [primaryRoute, ...(options.fallbackChain ?? [])]
      });
    }
    return execution;
  }

  async #executeRouteChain(
    request: Omit<ProviderRequest, "model"> & { model?: string },
    preferences: ProviderRoutePreferences,
    options: ProviderExecutionOptions
  ): Promise<ProviderExecutionResult> {
    const primaryRoute = options.primaryRoute!;
    const fallbackChain = options.fallbackChain ?? [];
    const attempts: ProviderAttempt[] = [];
    const toolCalls: ProviderExecutionResult["toolCalls"] = [];
    const chain = [primaryRoute, ...fallbackChain];

    for (let index = 0; index < chain.length; index++) {
      if (options.signal?.aborted === true) {
        const partialContent = lastPartialContent(attempts);
        return {
          ok: false,
          fallbackUsed: attempts.length > 1,
          attempts,
          ...(partialContent === undefined ? {} : { partialContent }),
          toolCalls
        };
      }

      const route = chain[index];
      const preferenceFailure = routePreferenceFailure(route, preferences);
      if (preferenceFailure !== undefined) {
        attempts.push({
          provider: route.provider,
          model: route.id,
          state: "preflight",
          ok: false,
          errorClass: "unsupported",
          content: preferenceFailure
        });
        await options.onEvent?.({
          kind: "provider-attempt-end",
          provider: route.provider,
          model: route.id,
          ok: false,
          errorClass: "unsupported",
          fallback: index > 0,
          willFallback: index < chain.length - 1
        });
        continue;
      }

      const provider = this.#registry.get(route.provider);

      if (provider === undefined || provider.executable === false) {
        const reason = provider === undefined
          ? `No provider adapter is registered for ${route.provider}.`
          : `Provider ${route.provider} is registered for model discovery only and is not yet executable.`;
        attempts.push({
          provider: route.provider,
          model: route.id,
          state: "preflight",
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

      const metadata = getProviderMetadata(route.provider);

      // Metadata runnable gate: non-runnable providers must not execute
      if (!metadata.runnable) {
        const reason = `Provider ${route.provider} is not runnable.`;
        attempts.push({
          provider: route.provider,
          model: route.id,
          state: "preflight",
          ok: false,
          errorClass: "unsupported",
          content: reason
        });
        await options.onEvent?.({
          kind: "provider-attempt-end",
          provider: route.provider,
          model: route.id,
          ok: false,
          errorClass: "unsupported",
          fallback: index > 0,
          willFallback: index < chain.length - 1
        });
        continue;
      }

      // Effective API mode gate: only executable modes are allowed
      const apiMode = route.apiMode ?? metadata.apiMode;
      const executableModes: ProviderApiMode[] = [
        "openai_chat_completions",
        "custom_openai_compatible",
        "openai_responses"
      ];
      if (!executableModes.includes(apiMode)) {
        const reason = `Provider ${route.provider} uses unsupported API mode ${apiMode}.`;
        attempts.push({
          provider: route.provider,
          model: route.id,
          state: "preflight",
          ok: false,
          errorClass: "unsupported",
          content: reason
        });
        await options.onEvent?.({
          kind: "provider-attempt-end",
          provider: route.provider,
          model: route.id,
          ok: false,
          errorClass: "unsupported",
          fallback: index > 0,
          willFallback: index < chain.length - 1
        });
        continue;
      }

      // Credential resolution: route.apiKeyEnv takes precedence over pool
      const resolution = await resolveRuntimeCredential({
        providerId: route.provider,
        route: { apiKeyEnv: route.apiKeyEnv, authMethod: route.authMethod },
        metadata: getProviderMetadata(route.provider),
        homeDir: this.#homeDir,
        profileId: this.#profileId
      });

      if (!resolution.diagnostic.ok) {
        const errorContent = resolution.diagnostic.message ?? `Missing credential for ${route.provider}`;
        attempts.push({
          provider: route.provider,
          model: route.id,
          state: "preflight",
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

      let credential = resolution.credential?.kind === "bearer"
        ? { id: resolution.credential.id, value: resolution.credential.value }
        : undefined;
      const credentialSource = resolution.credential?.kind === "bearer"
        ? resolution.credential.source
        : undefined;

      let response: ProviderResponse | undefined;
      let finalizedStreamToolCalls: ProviderExecutionResult["toolCalls"] = [];
      let routeAttemptCount = 0;
      const maxRouteAttempts = 2;
      const effectiveAuthMethod = route.authMethod ?? metadata.defaultAuthMethod;

      while (routeAttemptCount < maxRouteAttempts) {
        routeAttemptCount++;
        const dispatchedAt = new Date().toISOString();
        const routeRequest = buildRouteProviderRequest(request, route, { stream: options.stream === true });
        const providerAttemptIndex = attempts.length;
        const authorization = await this.#authorizeProviderSpend({
          request: routeRequest,
          route,
          routeIndex: index,
          providerAttemptIndex,
          usage: options.usage,
          reservedAt: dispatchedAt
        });
        if (authorization.ok === false) {
          const content = providerSpendDenialMessage(authorization.reason);
          attempts.push({
            provider: route.provider,
            model: route.id,
            routeIndex: index,
            routeRole: routeRoleForIndex(index),
            state: "preflight",
            ok: false,
            errorClass: "spend-denied",
            content
          });
          await options.onEvent?.({
            kind: "provider-attempt-end",
            provider: route.provider,
            model: route.id,
            ok: false,
            errorClass: "spend-denied",
            fallback: index > 0,
            willFallback: false
          });
          return {
            ok: false,
            fallbackUsed: index > 0,
            attempts,
            spendDenialReason: authorization.reason,
            toolCalls
          };
        }

        await options.onEvent?.({
          kind: "provider-attempt-start",
          provider: route.provider,
          model: route.id,
          credentialId: credential?.id,
          fallback: index > 0
        });

        const completionOptions: ProviderCompletionOptions = {
          credential,
          signal: options.signal,
          timeoutMs: route.timeoutMs,
          staleTimeoutMs: route.staleTimeoutMs
        };

        if (route.baseUrl !== undefined) {
          completionOptions.endpoint = {
            baseUrl: route.baseUrl,
            apiKey: route.apiKeyEnv !== undefined ? { kind: "env", name: route.apiKeyEnv } : undefined
          };
        }

        const callResult = options.stream === true && provider.stream !== undefined
          ? await collectProviderStream({
              provider: route.provider,
              model: route.id,
              stream: provider.stream(routeRequest, completionOptions),
              onEvent: options.onEvent,
              signal: options.signal,
              now: options.now
            })
          : {
              response: await provider.complete(routeRequest, completionOptions),
              toolCalls: [],
              streamDiagnostics: undefined
            };
        const callResponse = callResult.response;

        const nextRoute = chain[index + 1];
        const callWillFallback = !callResponse.ok && shouldFallback(callResponse, route, nextRoute);

        const dispatchedAttempt: ProviderAttempt & { state: "dispatched"; dispatchedAt: string } = {
          provider: route.provider,
          model: route.id,
          routeIndex: index,
          routeRole: routeRoleForIndex(index),
          state: "dispatched",
          dispatchedAt,
          credentialId: credential?.id,
          ok: callResponse.ok,
          errorClass: callResponse.errorClass,
          content: callResponse.content,
          ...(callResponse.partialContent === undefined ? {} : { partialContent: callResponse.partialContent }),
          ...(callResult.streamDiagnostics === undefined ? {} : { streamDiagnostics: callResult.streamDiagnostics }),
          ...attemptMetadataFromResponse(callResponse)
        };
        attempts.push(dispatchedAttempt);
        if (authorization.reservation !== undefined && this.#spendController !== undefined) {
          const { sessionBudgetScopeId: _unverifiedScopeId, ...usageWithoutScope } = options.usage!;
          const normalizedUsageContext: ProviderUsageContext =
            authorization.reservation.request.sessionBudgetScopeId === undefined
              ? usageWithoutScope
              : {
                  ...usageWithoutScope,
                  sessionBudgetScopeId: authorization.reservation.request.sessionBudgetScopeId
                };
          const usageEntry = providerUsageEntryFromAttempt({
            attempt: dispatchedAttempt,
            providerAttemptIndex,
            profileId: authorization.reservation.request.profileId,
            context: normalizedUsageContext,
            routes: chain
          });
          await this.#spendController.settle(
            authorization.reservation.request.requestKey,
            usageEntry,
            new Date().toISOString()
          );
        }

        if (!callResponse.ok) {
          await options.onEvent?.({
            kind: "provider-attempt-end",
            provider: route.provider,
            model: route.id,
            credentialId: credential?.id,
            ok: callResponse.ok,
            errorClass: callResponse.errorClass,
            fallback: index > 0,
            willFallback: callWillFallback,
            ...attemptMetadataFromResponse(callResponse)
          });
        }

        if (callResponse.ok) {
          response = callResponse;
          finalizedStreamToolCalls = callResult.toolCalls;
          break;
        }

        const canRetry =
          callResponse.errorClass === "auth" &&
          routeAttemptCount < maxRouteAttempts &&
          effectiveAuthMethod !== undefined &&
          isOAuthAuthMethod(effectiveAuthMethod) &&
          credentialSource === "oauth";

        if (!canRetry) {
          response = callResponse;
          break;
        }

        const refreshResult = await this.#tryRefreshOAuthToken(route.provider);
        if (refreshResult.kind === "error") {
          const diagnostic = this.#buildAuthDiagnostic(route.provider, maxRouteAttempts);
          response = {
            ok: false,
            content: diagnostic,
            model: route.id,
            provider: route.provider,
            errorClass: "auth"
          };
          attempts[attempts.length - 1] = {
            ...attempts[attempts.length - 1],
            ok: false,
            content: diagnostic,
            errorClass: "auth"
          };
          break;
        }

        credential = { id: `${route.provider}:oauth`, value: refreshResult.accessToken };
      }

      if (response === undefined) {
        throw new Error("Invariant violated: route response was never assigned");
      }

      if (!response.ok && response.errorClass === "auth" && routeAttemptCount >= maxRouteAttempts) {
        const diagnostic = this.#buildAuthDiagnostic(route.provider, routeAttemptCount);
        response = {
          ...response,
          content: diagnostic
        };
        attempts[attempts.length - 1] = {
          ...attempts[attempts.length - 1],
          content: diagnostic
        };
      }

      const nextRoute = chain[index + 1];
      const willFallback = !response.ok && shouldFallback(response, route, nextRoute);

      if (response.ok) {
        const extractedToolCalls = extractToolCallsFromProviderResponse(response.raw);
        const reasoningPresent = hasReasoning(response);
        const terminalEmptyWithoutTools =
          response.content.trim().length === 0 &&
          finalizedStreamToolCalls.length === 0 &&
          extractedToolCalls.length === 0 &&
          !reasoningPresent;

        if (terminalEmptyWithoutTools && nextRoute !== undefined) {
          attempts[attempts.length - 1] = {
            ...attempts[attempts.length - 1],
            ok: false,
            errorClass: "empty-response",
            content: "Provider returned empty content with no tool calls.",
            streamDiagnostics: reclassifyStreamDiagnostics(
              attempts[attempts.length - 1]?.streamDiagnostics,
              "empty-response",
              { errorClass: "empty-response" }
            )
          };

          await options.onEvent?.({
            kind: "provider-attempt-end",
            provider: route.provider,
            model: route.id,
            credentialId: credential?.id,
            ok: false,
            errorClass: "empty-response",
            fallback: index > 0,
            willFallback: true,
            ...attemptMetadataFromResponse(response)
          });

          continue;
        }

        await options.onEvent?.({
          kind: "provider-attempt-end",
          provider: route.provider,
          model: route.id,
          credentialId: credential?.id,
          ok: true,
          fallback: index > 0,
          willFallback: false,
          ...attemptMetadataFromResponse(response)
        });

        for (const toolCall of finalizedStreamToolCalls) {
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

        for (const toolCall of extractedToolCalls) {
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
          route,
          attemptedRouteIndex: index,
          routeRole: routeRoleForIndex(index),
          runtimeMetadata: runtimeMetadataFromResponse(response),
          toolCalls
        };
      }

      if (!willFallback) {
        break;
      }
    }

    const partialContent = lastPartialContent(attempts);
    return {
      ok: false,
      fallbackUsed: attempts.length > 1,
      attempts,
      ...(partialContent === undefined ? {} : { partialContent }),
      toolCalls
    };
  }

  async #authorizeProviderSpend(input: {
    request: ProviderRequest;
    route: ResolvedModelRoute;
    routeIndex: number;
    providerAttemptIndex: number;
    usage?: ProviderUsageContext;
    reservedAt: string;
  }): Promise<
    | { ok: true; reservation?: ProviderSpendAttempt }
    | { ok: false; reason: ProviderSpendDenialReason }
  > {
    if (input.usage === undefined) return { ok: true };
    if (this.#spendController === undefined || this.#profileId === undefined) {
      return this.#allowUnenforcedAttributedSpend
        ? { ok: true }
        : { ok: false, reason: "SPEND_CONTROLLER_UNAVAILABLE" };
    }

    const prepared = prepareProviderSpend({
      profileId: this.#profileId,
      request: input.request,
      route: input.route,
      routeIndex: input.routeIndex,
      routeRole: routeRoleForIndex(input.routeIndex),
      providerAttemptIndex: input.providerAttemptIndex,
      usage: input.usage
    });
    let reserved: ProviderSpendReservationResult;
    try {
      reserved = await this.#spendController.reserve(prepared.request, input.reservedAt);
    } catch {
      return { ok: false, reason: "SPEND_CONTROLLER_UNAVAILABLE" };
    }
    if (!reserved.ok) return { ok: false, reason: reserved.reason };

    const hasApplicableLimit = reserved.attempt.allocations.length > 0;
    const policyDenial = hasApplicableLimit && !prepared.pricingAvailable
      ? "PRICING_UNAVAILABLE" as const
      : hasApplicableLimit && !prepared.safelyBounded
      ? "REQUEST_CANNOT_BE_SAFELY_BOUNDED" as const
      : undefined;
    if (policyDenial !== undefined) {
      if (reserved.attempt.state === "reserved") {
        try {
          await this.#spendController.releaseBeforeDispatch(prepared.request.requestKey, input.reservedAt);
        } catch {
          return { ok: false, reason: "SPEND_CONTROLLER_UNAVAILABLE" };
        }
      }
      return { ok: false, reason: policyDenial };
    }
    if (reserved.attempt.state !== "reserved") {
      return { ok: false, reason: "SPEND_CONTROLLER_UNAVAILABLE" };
    }
    try {
      const reservation = await this.#spendController.markDispatching(
        prepared.request.requestKey,
        input.reservedAt
      );
      return { ok: true, reservation };
    } catch {
      return { ok: false, reason: "SPEND_CONTROLLER_UNAVAILABLE" };
    }
  }

  async #tryRefreshOAuthToken(providerId: string): Promise<
    | { kind: "success"; accessToken: string }
    | { kind: "error"; reason: string }
  > {
    const oauthResult = await loadOAuthStore({ homeDir: this.#homeDir, profileId: this.#profileId });
    const record = oauthResult.store.providers[providerId];
    if (record === undefined) {
      return {
        kind: "error",
        reason: `OAuth token for ${providerId} is missing.`
      };
    }
    const refreshResult = await refreshOAuthToken({
      providerId,
      record,
      homeDir: this.#homeDir,
      profileId: this.#profileId
    });
    if (refreshResult.kind === "error") {
      return {
        kind: "error",
        reason: refreshResult.reason
      };
    }
    return {
      kind: "success",
      accessToken: refreshResult.accessToken
    };
  }

  #buildAuthDiagnostic(providerId: string, attempts: number): string {
    const providerLabel = providerId === "codex" ? "Codex" : providerId;
    return `${providerLabel} authentication failed after ${attempts} attempt(s). Token may be expired or revoked. Run "estacoda model setup ${providerId}" to re-authenticate.`;
  }
}

function attemptMetadataFromResponse(response: ProviderResponse): Pick<
  ProviderAttempt,
  "finishReason" | "incompleteReason" | "usage" | "reasoningMetadata"
> {
  const reasoningMetadata = safeReasoningMetadataFromResponse(response);
  return {
    ...(response.finishReason === undefined ? {} : { finishReason: response.finishReason }),
    ...(response.incompleteReason === undefined ? {} : { incompleteReason: response.incompleteReason }),
    ...(response.usage === undefined ? {} : { usage: response.usage }),
    ...(reasoningMetadata === undefined ? {} : { reasoningMetadata })
  };
}

function runtimeMetadataFromResponse(response: ProviderResponse): ProviderLoopRuntimeMetadata | undefined {
  const reasoning = safeReasoningMetadataFromResponse(response);
  return reasoning === undefined ? undefined : { reasoning };
}

function hasReasoning(response: ProviderResponse): boolean {
  return (response.reasoning !== undefined && response.reasoning.length > 0) ||
    response.reasoningMetadata?.present === true;
}

function safeReasoningMetadataFromResponse(response: ProviderResponse): ProviderReasoningMetadata | undefined {
  if (response.reasoningMetadata !== undefined) {
    return response.reasoningMetadata;
  }

  if (response.reasoning !== undefined && response.reasoning.length > 0) {
    return {
      present: true,
      chars: response.reasoning.length,
      format: "unknown"
    };
  }

  return undefined;
}

function routeRoleForIndex(index: number): ProviderRouteRole {
  return index === 0 ? "primary" : "fallback";
}

function buildRouteProviderRequest(
  request: Omit<ProviderRequest, "model"> & { model?: string },
  route: ResolvedModelRoute,
  overrides: Partial<ProviderRequest> = {}
): ProviderRequest {
  const {
    provider: _provider,
    model: _model,
    maxTokens: requestMaxTokens,
    ...rest
  } = request;
  const effectiveMaxTokens = requestMaxTokens ?? route.maxTokens;

  return {
    ...rest,
    ...overrides,
    provider: route.provider,
    model: route.id,
    ...(effectiveMaxTokens === undefined ? {} : { maxTokens: effectiveMaxTokens })
  };
}

type CollectedProviderStream = {
  response: ProviderResponse;
  toolCalls: ProviderExecutionResult["toolCalls"];
  streamDiagnostics: ProviderStreamDiagnostics;
};

async function collectProviderStream(input: {
  provider: ProviderId;
  model: string;
  stream: AsyncIterable<ProviderStreamEvent>;
  onEvent?: (event: ProviderRuntimeEvent) => void | Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<CollectedProviderStream> {
  const now = input.now ?? Date.now;
  const startedAtMs = now();
  let content = "";
  let finalResponse: ProviderResponse | undefined;
  let errorResponse: ProviderResponse | undefined;
  let sawTransportDone = false;
  let firstEventMs: number | undefined;
  let firstTokenMs: number | undefined;
  let eventCount = 0;
  let tokenChunks = 0;
  let visibleChars = 0;
  let toolCallChunks = 0;
  const toolCallFragments = new Map<string, ProviderExecutionResult["toolCalls"][number]>();

  const markEvent = (event: ProviderStreamEvent) => {
    eventCount += 1;
    if (event.kind !== "start" && firstEventMs === undefined) {
      firstEventMs = Math.max(0, now() - startedAtMs);
    }
  };

  const finishDiagnostics = (
    finish: ProviderStreamFinish,
    response?: ProviderResponse
  ): ProviderStreamDiagnostics => {
    const endedAtMs = now();
    const reasoningMetadata = response === undefined ? undefined : safeReasoningMetadataFromResponse(response);
    return {
      stream: true,
      startedAtMs,
      endedAtMs,
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      ...(firstEventMs === undefined ? {} : { firstEventMs }),
      ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
      eventCount,
      tokenChunks,
      visibleChars,
      toolCallChunks,
      transportDone: sawTransportDone,
      finish,
      ...(response?.errorClass === undefined ? {} : { errorClass: response.errorClass }),
      ...(response?.finishReason === undefined ? {} : { finishReason: response.finishReason }),
      ...(response?.incompleteReason === undefined ? {} : { incompleteReason: response.incompleteReason }),
      ...(reasoningMetadata === undefined ? {} : { reasoningMetadata })
    };
  };

  for await (const event of input.stream) {
    markEvent(event);
    if (input.signal?.aborted === true) {
      const response: ProviderResponse = {
        ok: false,
        content: "Provider stream cancelled.",
        model: input.model,
        provider: input.provider,
        errorClass: "timeout"
      };
      return {
        response,
        toolCalls: [],
        streamDiagnostics: finishDiagnostics("cancelled", response)
      };
    }

    switch (event.kind) {
      case "start":
        break;
      case "token":
        tokenChunks += 1;
        visibleChars += event.text.length;
        if (firstTokenMs === undefined) {
          firstTokenMs = Math.max(0, now() - startedAtMs);
        }
        content += event.text;
        await input.onEvent?.({
          kind: "provider-token",
          provider: event.provider,
          model: event.model,
          text: event.text
        });
        break;
      case "tool-call":
        toolCallChunks += 1;
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
      case "transport-done":
        sawTransportDone = true;
        break;
    }
  }

  if (errorResponse !== undefined) {
    return {
      response: errorResponse,
      toolCalls: [],
      streamDiagnostics: finishDiagnostics("error", errorResponse)
    };
  }

  if (finalResponse !== undefined) {
    return {
      response: finalResponse,
      toolCalls: [...toolCallFragments.values()],
      streamDiagnostics: finishDiagnostics("done", finalResponse)
    };
  }

  if (sawTransportDone && toolCallFragments.size === 0 && content.length > 0) {
    const response: ProviderResponse = {
      ok: true,
      content,
      model: input.model,
      provider: input.provider,
      finishReason: "unknown"
    };
    return {
      response,
      toolCalls: [],
      streamDiagnostics: finishDiagnostics("done", response)
    };
  }

  const partialContent = partialContentFromIncompleteStream(content);
  const response: ProviderResponse = {
    ok: false,
    content: content.length === 0
      ? "Provider stream ended before a done or error event."
      : `Provider stream ended before completion after partial output:\n${content}`,
    ...(partialContent === undefined ? {} : { partialContent }),
    model: input.model,
    provider: input.provider,
    errorClass: "incomplete-stream"
  };
  return {
    response,
    toolCalls: [],
    streamDiagnostics: finishDiagnostics("incomplete-stream", response)
  };
}

function reclassifyStreamDiagnostics(
  diagnostics: ProviderStreamDiagnostics | undefined,
  finish: ProviderStreamFinish,
  metadata: Pick<ProviderStreamDiagnostics, "errorClass"> = {}
): ProviderStreamDiagnostics | undefined {
  if (diagnostics === undefined) return undefined;
  return {
    ...diagnostics,
    finish,
    ...metadata
  };
}

function partialContentFromIncompleteStream(content: string): string | undefined {
  const stripped = stripThinkBlocks(content);
  return stripped.length === 0 ? undefined : stripped;
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
      response.errorClass === "incomplete-stream" ||
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

function routePreferenceFailure(
  route: ResolvedModelRoute,
  preferences: ProviderRoutePreferences
): string | undefined {
  if (preferences.providerAllowlist !== undefined && !preferences.providerAllowlist.includes(route.provider)) {
    return `Provider route ${route.provider}/${route.id} is not in the allowed provider set for this request.`;
  }

  if (preferences.providerBlocklist?.includes(route.provider)) {
    return `Provider route ${route.provider}/${route.id} is blocked for this request.`;
  }

  if (preferences.requireTools === true && !route.profile.supportsTools) {
    return `Provider route ${route.provider}/${route.id} does not support tools required for this request.`;
  }

  if (preferences.requireVision === true && !route.profile.supportsVision) {
    return `Provider route ${route.provider}/${route.id} does not support vision required for this request.`;
  }

  if (preferences.requireStructuredOutput === true && !route.profile.supportsStructuredOutput) {
    return `Provider route ${route.provider}/${route.id} does not support structured output required for this request.`;
  }

  if (preferences.requireReasoning === true && route.profile.supportsReasoning !== true) {
    return `Provider route ${route.provider}/${route.id} does not support reasoning required for this request.`;
  }

  return undefined;
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

function lastPartialContent(attempts: readonly ProviderAttempt[]): string | undefined {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const partialContent = attempts[index].partialContent;
    if (partialContent !== undefined && partialContent.trim().length > 0) {
      return partialContent;
    }
  }
  return undefined;
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
    output?: Array<{
      type?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    }>;
  };

  const chatToolCalls = (payload.choices?.[0]?.message?.tool_calls ?? []).map((toolCall, index) => ({
    index,
    id: toolCall.id,
    name: toolCall.function?.name,
    argumentsText: toolCall.function?.arguments,
    raw: toolCall
  }));

  const responsesToolCalls = (payload.output ?? [])
    .filter((item) => item.type === "function_call")
    .map((item, index) => ({
      index,
      id: item.call_id,
      name: item.name,
      argumentsText: item.arguments,
      raw: item
    }));

  return [...chatToolCalls, ...responsesToolCalls];
}
