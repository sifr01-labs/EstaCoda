import type { ProviderId } from "../contracts/provider.js";
import type { FetchLike } from "../providers/openai-compatible-provider.js";
import {
  openAIChatCompletionNotTested,
  probeOpenAIModels,
  testOpenAICompatibleChatCompletion,
  type OpenAIChatCompletionTestResult,
  type OpenAICompatibleCheckStatus,
  type OpenAICompatibleProbeAuth,
  type OpenAIModelProbe,
} from "../providers/openai-compatible-model-probe.js";
import type { SetupDeferredSecretWrite } from "./setup-apply-plan.js";
import type { SetupCopyLocale } from "./setup-copy.js";
import { setupEditorAction, scopedPatch, type SetupEditorActionDraft } from "./setup-editor-actions.js";
import { formatSetupCopy, setupCopyText } from "./setup-prompts.js";

export type OpenAICompatibleModelSource = "discovered" | "manual";
export type OpenAICompatibleToolsCheckStatus = "unknown";

export type OpenAICompatibleEndpointCheck = {
  readonly status: OpenAICompatibleCheckStatus;
  readonly message: string;
};

export type OpenAICompatibleEndpointFlowChecks = {
  readonly modelList: OpenAICompatibleEndpointCheck;
  readonly chatCompletion: OpenAICompatibleEndpointCheck;
  readonly tools: {
    readonly status: OpenAICompatibleToolsCheckStatus;
    readonly message: string;
  };
};

export type OpenAICompatibleModelChoice = {
  readonly modelId: string;
  readonly badge: "discovered" | "reasoning" | "embedding";
  readonly label: string;
  readonly description: string;
};

export type OpenAICompatibleEndpointAction = "check" | "manual" | "auth" | "cancel";
export type OpenAICompatibleEndpointIntroAction = "continue" | "change-endpoint" | "cancel";
export type OpenAICompatibleModelSelection =
  | { readonly kind: "model"; readonly modelId: string }
  | { readonly kind: "manual" }
  | { readonly kind: "change-endpoint" }
  | { readonly kind: "configure-auth" }
  | { readonly kind: "cancel" };
export type OpenAICompatibleAuthSelection = "none" | "env" | "enter" | "cancel";
export type OpenAICompatibleChatTestSelection = "run" | "skip" | "not-tested";
export type OpenAICompatibleSummaryDecision = "review" | "back" | "cancel";

export type OpenAICompatibleEndpointFlowText = {
  readonly intro: {
    readonly title: string;
    readonly body: string;
    readonly current: string;
    readonly currentNone: string;
    readonly endpoint: string;
    readonly defaultEndpoint: string;
    readonly hasCurrentEndpoint: boolean;
    readonly process: string;
    readonly destination: string;
    readonly continue: string;
    readonly continueDescription: string;
    readonly changeEndpoint: string;
    readonly changeEndpointDescription: string;
  };
  readonly endpoint: {
    readonly title: string;
    readonly body: string;
    readonly baseUrlQuestion: string;
    readonly destination: string;
    readonly check: string;
    readonly manual: string;
    readonly auth: string;
    readonly invalid: string;
  };
  readonly checking: string;
  readonly models: {
    readonly title: string;
    readonly discovered: string;
    readonly failed: string;
    readonly failureReason?: string;
    readonly possibleCauses: string;
    readonly enterManual: string;
    readonly changeEndpoint: string;
  };
  readonly modelId: {
    readonly title: string;
    readonly question: string;
  };
  readonly contextWindow: {
    readonly question: string;
    readonly hint: string;
  };
  readonly auth: {
    readonly title: string;
    readonly body: string;
    readonly none: string;
    readonly env: string;
    readonly enter: string;
    readonly envQuestion: string;
    readonly secretQuestion: string;
    readonly secretStorage: string;
  };
  readonly test: {
    readonly title: string;
    readonly body: string;
    readonly run: string;
    readonly skip: string;
  };
  readonly summary: {
    readonly title: string;
    readonly lines: readonly string[];
    readonly review: string;
  };
};

export type OpenAICompatibleEndpointFlowUi = {
  readonly selectEndpointIntro: (input: {
    readonly defaultBaseUrl: string;
    readonly currentRoute?: OpenAICompatibleEndpointCurrentRoute;
    readonly text: OpenAICompatibleEndpointFlowText["intro"];
  }) => Promise<OpenAICompatibleEndpointIntroAction>;
  readonly promptBaseUrl: (input: {
    readonly defaultBaseUrl: string;
    readonly text: OpenAICompatibleEndpointFlowText["endpoint"];
    readonly error?: string;
  }) => Promise<string | undefined>;
  readonly selectEndpointAction: (input: {
    readonly baseUrl: string;
    readonly authConfigured: boolean;
    readonly text: OpenAICompatibleEndpointFlowText["endpoint"];
  }) => Promise<OpenAICompatibleEndpointAction>;
  readonly showChecking?: (input: {
    readonly baseUrl: string;
    readonly message: string;
  }) => void;
  readonly selectModel: (input: {
    readonly baseUrl: string;
    readonly probe: OpenAIModelProbe;
    readonly choices: readonly OpenAICompatibleModelChoice[];
    readonly text: OpenAICompatibleEndpointFlowText["models"];
  }) => Promise<OpenAICompatibleModelSelection>;
  readonly promptManualModelId: (input: {
    readonly baseUrl: string;
    readonly text: OpenAICompatibleEndpointFlowText["modelId"];
  }) => Promise<string>;
  readonly promptContextWindowTokens: (input: {
    readonly modelId: string;
    readonly text: OpenAICompatibleEndpointFlowText["contextWindow"];
  }) => Promise<number | undefined>;
  readonly selectAuth: (input: {
    readonly baseUrl: string;
    readonly modelId: string;
    readonly defaultEnvVar: string;
    readonly text: OpenAICompatibleEndpointFlowText["auth"];
  }) => Promise<OpenAICompatibleAuthSelection>;
  readonly promptAuthEnvVar: (input: {
    readonly defaultEnvVar: string;
    readonly text: OpenAICompatibleEndpointFlowText["auth"];
  }) => Promise<string>;
  readonly promptSecret: (input: {
    readonly envVarName: string;
    readonly text: OpenAICompatibleEndpointFlowText["auth"];
  }) => Promise<string | undefined>;
  readonly selectChatCompletionTest: (input: {
    readonly baseUrl: string;
    readonly modelId: string;
    readonly authConfigured: boolean;
    readonly text: OpenAICompatibleEndpointFlowText["test"];
  }) => Promise<OpenAICompatibleChatTestSelection>;
  readonly confirmSummary: (input: {
    readonly providerId: ProviderId;
    readonly baseUrl: string;
    readonly modelId: string;
    readonly modelSource: OpenAICompatibleModelSource;
    readonly apiKeyEnv?: string;
    readonly checks: OpenAICompatibleEndpointFlowChecks;
    readonly text: OpenAICompatibleEndpointFlowText["summary"];
  }) => Promise<OpenAICompatibleSummaryDecision>;
};

export type OpenAICompatibleEndpointCurrentRoute = {
  readonly providerId: string;
  readonly modelId: string;
  readonly baseUrl?: string;
};

export type OpenAICompatibleEndpointFlowOptions = {
  readonly providerId: ProviderId;
  readonly defaultBaseUrl: string;
  readonly defaultApiKeyEnv?: string;
  readonly currentRoute?: OpenAICompatibleEndpointCurrentRoute;
  readonly locale: SetupCopyLocale;
  readonly ui: OpenAICompatibleEndpointFlowUi;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly initialEnv?: Record<string, string | undefined>;
  readonly visionVerificationImageDataUrl?: string;
};

export type OpenAICompatibleEndpointFlowResult =
  | {
      readonly kind: "ready";
      readonly providerId: ProviderId;
      readonly baseUrl: string;
      readonly modelId: string;
      readonly modelSource: OpenAICompatibleModelSource;
      readonly contextWindowTokens?: number;
      readonly apiKeyEnv?: string;
      readonly checks: OpenAICompatibleEndpointFlowChecks;
      readonly routeAction: SetupEditorActionDraft;
      readonly credentialAction?: SetupEditorActionDraft;
      readonly pendingCredentialWrite?: SetupDeferredSecretWrite;
    }
  | {
      readonly kind: "back" | "cancelled";
    };

type AuthState = {
  readonly apiKeyEnv?: string;
  readonly pendingCredentialWrite?: SetupDeferredSecretWrite;
  readonly probeAuth: OpenAICompatibleProbeAuth;
};

const DEFAULT_API_KEY_ENV = "OPENAI_COMPATIBLE_API_KEY";

export async function collectOpenAICompatibleEndpointFlow(
  options: OpenAICompatibleEndpointFlowOptions
): Promise<OpenAICompatibleEndpointFlowResult> {
  const defaultApiKeyEnv = options.defaultApiKeyEnv ?? DEFAULT_API_KEY_ENV;
  let baseUrl = await collectInitialBaseUrl(options);
  if (baseUrl === undefined) return { kind: "cancelled" };
  let authState: AuthState = { probeAuth: { kind: "none" } };
  let modelListCheck: OpenAICompatibleEndpointCheck = {
    status: "notTested",
    message: setupCopyText(options.locale, "setupEditor.prompt.openaiCompatible.summary.modelListNotTested"),
  };

  for (;;) {
    const endpointAction = await options.ui.selectEndpointAction({
      baseUrl,
      authConfigured: authState.apiKeyEnv !== undefined,
      text: endpointText(options.locale, baseUrl),
    });
    if (endpointAction === "cancel") return { kind: "cancelled" };
    if (endpointAction === "auth") {
      const nextAuth = await collectAuth(options, baseUrl, "", defaultApiKeyEnv);
      if (nextAuth === undefined) return { kind: "cancelled" };
      authState = nextAuth;
      continue;
    }

    if (endpointAction === "manual") {
      const manual = await collectManualModel(options, baseUrl);
      if (manual === undefined) return { kind: "cancelled" };
      return finalizeOpenAICompatibleEndpointFlow({
        options,
        defaultApiKeyEnv,
        baseUrl,
        modelId: manual,
        modelSource: "manual",
        modelListCheck,
        authState,
      });
    }

    options.ui.showChecking?.({
      baseUrl,
      message: formatSetupCopy(options.locale, "setupEditor.prompt.openaiCompatible.checking", { baseUrl }),
    });
    const probe = await probeOpenAIModels(baseUrl, {
      fetch: options.fetch,
      auth: authState.probeAuth,
      timeoutMs: options.timeoutMs,
    });
    modelListCheck = modelListCheckFromProbe(probe, options.locale);

    for (;;) {
      const modelSelection = await options.ui.selectModel({
        baseUrl,
        probe,
        choices: modelChoices(probe.models, options.locale),
        text: modelsText(options.locale, probe),
      });
      if (modelSelection.kind === "cancel") return { kind: "cancelled" };
      if (modelSelection.kind === "change-endpoint") {
        const nextBaseUrl = await promptValidBaseUrl(options);
        if (nextBaseUrl === undefined) return { kind: "cancelled" };
        baseUrl = nextBaseUrl;
        break;
      }
      if (modelSelection.kind === "configure-auth") {
        const nextAuth = await collectAuth(options, baseUrl, "", defaultApiKeyEnv);
        if (nextAuth === undefined) return { kind: "cancelled" };
        authState = nextAuth;
        break;
      }
      if (modelSelection.kind === "manual") {
        const manual = await collectManualModel(options, baseUrl);
        if (manual === undefined) return { kind: "cancelled" };
        return finalizeOpenAICompatibleEndpointFlow({
          options,
          defaultApiKeyEnv,
          baseUrl,
          modelId: manual,
          modelSource: "manual",
          modelListCheck,
          authState,
        });
      }
      return finalizeOpenAICompatibleEndpointFlow({
        options,
        defaultApiKeyEnv,
        baseUrl,
        modelId: modelSelection.modelId,
        modelSource: "discovered",
        modelListCheck,
        authState,
      });
    }
  }
}

async function collectInitialBaseUrl(options: OpenAICompatibleEndpointFlowOptions): Promise<string | undefined> {
  const introAction = await options.ui.selectEndpointIntro({
    defaultBaseUrl: options.defaultBaseUrl,
    currentRoute: options.currentRoute,
    text: introText(options.locale, {
      providerId: options.providerId,
      defaultBaseUrl: options.defaultBaseUrl,
      currentRoute: options.currentRoute,
    }),
  });
  if (introAction === "cancel") return undefined;
  if (introAction === "change-endpoint" || !isValidOpenAICompatibleEndpointBaseUrl(options.defaultBaseUrl)) {
    return promptValidBaseUrl(options);
  }
  return options.defaultBaseUrl.replace(/\/$/, "");
}

export function isValidOpenAICompatibleEndpointBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function promptValidBaseUrl(options: OpenAICompatibleEndpointFlowOptions): Promise<string | undefined> {
  let error: string | undefined;
  for (;;) {
    const submitted = await options.ui.promptBaseUrl({
      defaultBaseUrl: options.defaultBaseUrl,
      text: endpointText(options.locale, options.defaultBaseUrl),
      error,
    });
    if (submitted === undefined || isPromptInterrupt(submitted)) {
      return undefined;
    }
    const raw = submitted.trim();
    const candidate = raw.length > 0 ? raw : options.defaultBaseUrl;
    if (isValidOpenAICompatibleEndpointBaseUrl(candidate)) {
      return candidate.replace(/\/$/, "");
    }
    error = formatSetupCopy(options.locale, "setupEditor.prompt.openaiCompatible.endpoint.invalid", {
      baseUrl: options.defaultBaseUrl,
    });
  }
}

function isPromptInterrupt(value: string): boolean {
  return value.includes("\u0003");
}

async function finalizeOpenAICompatibleEndpointFlow(input: {
  readonly options: OpenAICompatibleEndpointFlowOptions;
  readonly defaultApiKeyEnv: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly modelSource: OpenAICompatibleModelSource;
  readonly modelListCheck: OpenAICompatibleEndpointCheck;
  readonly authState: AuthState;
}): Promise<OpenAICompatibleEndpointFlowResult> {
  const contextWindowTokens = await input.options.ui.promptContextWindowTokens({
    modelId: input.modelId,
    text: contextWindowText(input.options.locale),
  });
  const authState = input.authState.apiKeyEnv === undefined
    ? await collectAuth(input.options, input.baseUrl, input.modelId, input.defaultApiKeyEnv)
    : input.authState;
  if (authState === undefined) return { kind: "cancelled" };

  const chatCompletion = await collectChatCompletionCheck(input.options, {
    baseUrl: input.baseUrl,
    modelId: input.modelId,
    authState,
  });
  const checks: OpenAICompatibleEndpointFlowChecks = {
    modelList: input.modelListCheck,
    chatCompletion: {
      status: chatCompletion.status,
      message: chatCompletion.message,
    },
    tools: {
      status: "unknown",
      message: setupCopyText(input.options.locale, "setupEditor.prompt.openaiCompatible.summary.toolsUnknown"),
    },
  };

  const decision = await input.options.ui.confirmSummary({
    providerId: input.options.providerId,
    baseUrl: input.baseUrl,
    modelId: input.modelId,
    modelSource: input.modelSource,
    apiKeyEnv: authState.apiKeyEnv,
    checks,
    text: summaryText(input.options.locale, {
      providerId: input.options.providerId,
      baseUrl: input.baseUrl,
      modelId: input.modelId,
      modelSource: input.modelSource,
      apiKeyEnv: authState.apiKeyEnv,
      checks,
    }),
  });
  if (decision === "cancel") return { kind: "cancelled" };
  if (decision === "back") return { kind: "back" };

  return {
    kind: "ready",
    providerId: input.options.providerId,
    baseUrl: input.baseUrl,
    modelId: input.modelId,
    modelSource: input.modelSource,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(authState.apiKeyEnv === undefined ? {} : { apiKeyEnv: authState.apiKeyEnv }),
    checks,
    routeAction: routeAction({
      providerId: input.options.providerId,
      baseUrl: input.baseUrl,
      modelId: input.modelId,
      modelSource: input.modelSource,
      contextWindowTokens,
      checks,
      authMethod: authState.apiKeyEnv === undefined ? "none" : "api_key",
    }),
    ...(authState.apiKeyEnv === undefined
      ? {}
      : { credentialAction: credentialAction(input.options.providerId, input.modelId, authState.apiKeyEnv) }),
    ...(authState.pendingCredentialWrite === undefined
      ? {}
      : { pendingCredentialWrite: authState.pendingCredentialWrite }),
  };
}

async function collectManualModel(
  options: OpenAICompatibleEndpointFlowOptions,
  baseUrl: string
): Promise<string | undefined> {
  for (;;) {
    const modelId = (await options.ui.promptManualModelId({
      baseUrl,
      text: modelIdText(options.locale),
    })).trim();
    if (modelId.length > 0) return modelId;
  }
}

async function collectAuth(
  options: OpenAICompatibleEndpointFlowOptions,
  baseUrl: string,
  modelId: string,
  defaultApiKeyEnv: string
): Promise<AuthState | undefined> {
  const selection = await options.ui.selectAuth({
    baseUrl,
    modelId,
    defaultEnvVar: defaultApiKeyEnv,
    text: authText(options.locale, defaultApiKeyEnv),
  });
  if (selection === "cancel") return undefined;
  if (selection === "none") return { probeAuth: { kind: "none" } };

  const envVarName = ((await options.ui.promptAuthEnvVar({
    defaultEnvVar: defaultApiKeyEnv,
    text: authText(options.locale, defaultApiKeyEnv),
  })).trim()) || defaultApiKeyEnv;

  if (selection === "env") {
    return {
      apiKeyEnv: envVarName,
      probeAuth: { kind: "env", name: envVarName, env: options.initialEnv },
    };
  }

  const secret = (await options.ui.promptSecret({
    envVarName,
    text: authText(options.locale, envVarName),
  }))?.trim();
  if (secret === undefined || secret.length === 0) {
    return {
      apiKeyEnv: envVarName,
      probeAuth: { kind: "env", name: envVarName, env: options.initialEnv },
    };
  }
  return {
    apiKeyEnv: envVarName,
    pendingCredentialWrite: { envVarName, value: secret },
    probeAuth: { kind: "bearer", token: secret },
  };
}

async function collectChatCompletionCheck(
  options: OpenAICompatibleEndpointFlowOptions,
  input: {
    readonly baseUrl: string;
    readonly modelId: string;
    readonly authState: AuthState;
  }
): Promise<OpenAIChatCompletionTestResult> {
  const selection = await options.ui.selectChatCompletionTest({
    baseUrl: input.baseUrl,
    modelId: input.modelId,
    authConfigured: input.authState.apiKeyEnv !== undefined,
    text: testText(options.locale, input.modelId),
  });
  if (selection === "not-tested") {
    return openAIChatCompletionNotTested(input.baseUrl, input.modelId);
  }
  return testOpenAICompatibleChatCompletion(input.baseUrl, input.modelId, {
    fetch: options.fetch,
    auth: input.authState.probeAuth,
    timeoutMs: options.timeoutMs,
    skip: selection === "skip",
    visionImageDataUrl: options.visionVerificationImageDataUrl,
  });
}

function routeAction(input: {
  readonly providerId: ProviderId;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly modelSource: OpenAICompatibleModelSource;
  readonly contextWindowTokens?: number;
  readonly checks: OpenAICompatibleEndpointFlowChecks;
  readonly authMethod: "none" | "api_key";
}): SetupEditorActionDraft {
  return setupEditorAction({
    id: "edit-primary-model-route",
    copyKey: "setupEditor.actions.editPrimaryModelRoute",
    sectionId: "model-route",
    effect: "draft-config-patch",
    readOnly: false,
    requiresExplicitApply: true,
    patch: scopedPatch(["model.provider", "model.id", "provider.route"]),
    reviewValues: {
      provider: input.providerId,
      model: input.modelId,
      baseUrl: input.baseUrl,
      ...(input.contextWindowTokens === undefined ? {} : { contextWindowTokens: input.contextWindowTokens }),
      authMethod: input.authMethod,
      modelSource: input.modelSource,
      modelListStatus: input.checks.modelList.status,
      chatCompletionStatus: input.checks.chatCompletion.status,
      toolsStatus: input.checks.tools.status,
    },
  });
}

function credentialAction(
  providerId: ProviderId,
  modelId: string,
  envVarName: string
): SetupEditorActionDraft {
  return setupEditorAction({
    id: "store-provider-credential-reference",
    copyKey: "setupEditor.actions.storeProviderCredentialReference",
    sectionId: "credentials",
    effect: "draft-config-patch",
    readOnly: false,
    requiresExplicitApply: true,
    patch: scopedPatch(["provider.credentialReference"]),
    credentialRefs: [{ kind: "env", name: envVarName, value: "not-included" }],
    reviewValues: {
      provider: providerId,
      model: modelId,
      apiKeyEnv: envVarName,
    },
  });
}

function modelListCheckFromProbe(
  probe: OpenAIModelProbe,
  locale: SetupCopyLocale
): OpenAICompatibleEndpointCheck {
  if (!probe.ok) {
    return {
      status: "failed",
      message: formatSetupCopy(locale, "setupEditor.prompt.openaiCompatible.models.failureReason", {
        reason: probe.message,
      }),
    };
  }
  return {
    status: "passed",
    message: formatSetupCopy(locale, "setupEditor.prompt.openaiCompatible.models.discovered", {
      count: String(probe.models.length),
    }),
  };
}

function modelChoices(
  models: readonly string[],
  locale: SetupCopyLocale
): readonly OpenAICompatibleModelChoice[] {
  return models.map((modelId) => {
    const badge = modelBadge(modelId);
    return {
      modelId,
      badge,
      label: modelId,
      description: setupCopyText(locale, `setupEditor.prompt.openaiCompatible.models.${badge}Badge`),
    };
  });
}

function modelBadge(modelId: string): OpenAICompatibleModelChoice["badge"] {
  const normalized = modelId.toLowerCase();
  if (/embed|embedding|nomic/u.test(normalized)) return "embedding";
  if (/reason|r1|think/u.test(normalized)) return "reasoning";
  return "discovered";
}

function endpointText(
  locale: SetupCopyLocale,
  baseUrl: string
): OpenAICompatibleEndpointFlowText["endpoint"] {
  return {
    title: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.endpoint.title"),
    body: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.endpoint.body"),
    baseUrlQuestion: formatSetupCopy(locale, "setupEditor.prompt.openaiCompatible.endpoint.baseUrl", { baseUrl }),
    destination: formatSetupCopy(locale, "setupEditor.prompt.openaiCompatible.endpoint.destination", { baseUrl }),
    check: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.endpoint.check"),
    manual: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.endpoint.manual"),
    auth: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.endpoint.auth"),
    invalid: formatSetupCopy(locale, "setupEditor.prompt.openaiCompatible.endpoint.invalid", { baseUrl }),
  };
}

function introText(
  locale: SetupCopyLocale,
  input: {
    readonly providerId: ProviderId;
    readonly defaultBaseUrl: string;
    readonly currentRoute?: OpenAICompatibleEndpointCurrentRoute;
  }
): OpenAICompatibleEndpointFlowText["intro"] {
  const endpointBaseUrl = input.currentRoute?.providerId === input.providerId
    ? input.currentRoute.baseUrl
    : undefined;
  return {
    title: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.intro.title"),
    body: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.intro.body"),
    current: input.currentRoute === undefined
      ? setupCopyText(locale, "setupEditor.prompt.openaiCompatible.intro.currentNone")
      : formatSetupCopy(locale, "setupEditor.prompt.openaiCompatible.intro.current", {
        providerId: input.currentRoute.providerId,
        modelId: input.currentRoute.modelId,
      }),
    currentNone: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.intro.currentNone"),
    endpoint: formatSetupCopy(locale, "setupEditor.prompt.openaiCompatible.intro.endpoint", {
      baseUrl: endpointBaseUrl ?? input.defaultBaseUrl,
    }),
    defaultEndpoint: formatSetupCopy(locale, "setupEditor.prompt.openaiCompatible.intro.defaultEndpoint", {
      baseUrl: input.defaultBaseUrl,
    }),
    hasCurrentEndpoint: endpointBaseUrl !== undefined,
    process: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.intro.process"),
    destination: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.intro.destination"),
    continue: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.intro.continue"),
    continueDescription: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.intro.continue.description"),
    changeEndpoint: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.intro.changeEndpoint"),
    changeEndpointDescription: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.intro.changeEndpoint.description"),
  };
}

function modelsText(
  locale: SetupCopyLocale,
  probe: OpenAIModelProbe
): OpenAICompatibleEndpointFlowText["models"] {
  return {
    title: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.models.title"),
    discovered: formatSetupCopy(locale, "setupEditor.prompt.openaiCompatible.models.discovered", {
      count: String(probe.models.length),
    }),
    failed: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.models.failed"),
    ...(probe.ok
      ? {}
      : {
          failureReason: formatSetupCopy(locale, "setupEditor.prompt.openaiCompatible.models.failureReason", {
            reason: probe.message,
          }),
        }),
    possibleCauses: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.models.possibleCauses"),
    enterManual: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.models.enterManual"),
    changeEndpoint: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.models.changeEndpoint"),
  };
}

function modelIdText(locale: SetupCopyLocale): OpenAICompatibleEndpointFlowText["modelId"] {
  return {
    title: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.modelId.title"),
    question: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.modelId.question"),
  };
}

function contextWindowText(locale: SetupCopyLocale): OpenAICompatibleEndpointFlowText["contextWindow"] {
  return {
    question: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.contextWindow.question"),
    hint: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.contextWindow.hint"),
  };
}

function authText(
  locale: SetupCopyLocale,
  envVar: string
): OpenAICompatibleEndpointFlowText["auth"] {
  return {
    title: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.auth.title"),
    body: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.auth.body"),
    none: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.auth.none"),
    env: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.auth.env"),
    enter: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.auth.enter"),
    envQuestion: formatSetupCopy(locale, "setupEditor.prompt.openaiCompatible.auth.envQuestion", { envVar }),
    secretQuestion: formatSetupCopy(locale, "setupEditor.prompt.openaiCompatible.auth.secretQuestion", { envVar }),
    secretStorage: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.auth.secretStorage"),
  };
}

function testText(
  locale: SetupCopyLocale,
  modelId: string
): OpenAICompatibleEndpointFlowText["test"] {
  return {
    title: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.test.title"),
    body: formatSetupCopy(locale, "setupEditor.prompt.openaiCompatible.test.body", { modelId }),
    run: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.test.run"),
    skip: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.test.skip"),
  };
}

function summaryText(
  locale: SetupCopyLocale,
  input: {
    readonly providerId: ProviderId;
    readonly baseUrl: string;
    readonly modelId: string;
    readonly modelSource: OpenAICompatibleModelSource;
    readonly apiKeyEnv?: string;
    readonly checks: OpenAICompatibleEndpointFlowChecks;
  }
): OpenAICompatibleEndpointFlowText["summary"] {
  const source = input.modelSource === "discovered"
    ? setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.sourceDiscovered")
    : setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.sourceManual");
  const auth = input.apiKeyEnv === undefined
    ? setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.authNone")
    : formatSetupCopy(locale, "setupEditor.prompt.openaiCompatible.summary.authEnv", { envVar: input.apiKeyEnv });
  return {
    title: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.title"),
    lines: [
      `${setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.provider")}: ${input.providerId}`,
      `${setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.endpoint")}: ${input.baseUrl}`,
      `${setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.model")}: ${input.modelId}`,
      source,
      auth,
      summaryModelListStatus(locale, input.checks.modelList.status),
      summaryChatStatus(locale, input.checks.chatCompletion.status),
      setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.toolsUnknown"),
    ],
    review: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.review"),
  };
}

function summaryModelListStatus(locale: SetupCopyLocale, status: OpenAICompatibleCheckStatus): string {
  if (status === "passed") return setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.modelListPassed");
  if (status === "failed") return setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.modelListFailed");
  return setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.modelListNotTested");
}

function summaryChatStatus(locale: SetupCopyLocale, status: OpenAICompatibleCheckStatus): string {
  if (status === "passed") return setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.chatPassed");
  if (status === "failed") return setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.chatFailed");
  return setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.chatNotTested");
}
