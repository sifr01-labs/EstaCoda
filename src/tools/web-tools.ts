import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RegisteredTool } from "../contracts/tool.js";
import type { SessionToolProvider } from "../contracts/tool.js";
import type { BrowserActionInput, BrowserBackend, BrowserSnapshot, WebExtractionResult } from "../contracts/browser.js";
import { createUnconfiguredBrowserBackend } from "../browser/browser-backend.js";
import { isAlwaysBlockedUrl, isSafeUrl, redactUrlForMetadata, scanUrlForSecrets, type ResolveHostnameFn } from "../browser/url-safety.js";
import { checkWebsiteAccess, loadWebsiteBlocklist } from "../browser/website-policy.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { analyzeImageWithVision } from "./vision-tools.js";

export type WebToolOptions = {
  fetch?: FetchLike;
  browserBackend?: BrowserBackend;
  enableNetwork?: boolean;
  maxContentChars?: number;
  workspaceRoot?: string;
  securityConfig?: Pick<import("../config/runtime-config.js").LoadedRuntimeConfig["security"], "allowPrivateUrls" | "websiteBlocklist">;
  resolveHostname?: ResolveHostnameFn;
  visionAnalyzer?: (input: { path: string; prompt?: string }, signal?: AbortSignal) => Promise<{
    ok: boolean;
    content: string;
    metadata?: Record<string, unknown>;
  }>;
};

export type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  redirect?: "manual" | "follow" | "error";
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}>;

const DEFAULT_MAX_CONTENT_CHARS = 24_000;
const MAX_WEB_EXTRACT_REDIRECTS = 10;
const CDP_URL_PARAMETER_METHODS = new Map<string, string>([
  ["Page.navigate", "url"],
  ["Target.createTarget", "url"]
]);
const CDP_RUNTIME_METHODS = new Set(["Runtime.evaluate", "Runtime.callFunctionOn"]);
const CDP_NETWORK_EXPRESSION_PATTERN = /\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource)\b/u;
const CDP_NAVIGATION_EXPRESSION_PATTERN = /\b(?:location\.(?:href|assign|replace)|(?:window|document|self|top|parent)\.location|window\.open|open\s*\()/u;
const CDP_URL_LITERAL_PATTERN = /https?:\/\/[^\s"'<>\\)]+/giu;

export function createWebTools(options: WebToolOptions = {}): readonly RegisteredTool[] {
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const browserBackend = options.browserBackend ?? createUnconfiguredBrowserBackend();
  const urlGuard = createUrlGuard(options);

  return [
    {
      name: "web.extract",
      description: "Fetch and extract readable text from a URL for research workflows.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          text: { type: "string" },
          maxContentChars: { type: "number" }
        }
      },
      riskClass: "read-only-network",
      toolsets: ["web", "research"],
      progressLabel: "extracting web content",
      maxResultSizeChars: maxContentChars,
      isAvailable: () => true,
      run: async (input: { url?: string; text?: string; maxContentChars?: number }, context) => {
        const url = normalizeUrl(input.url ?? extractFirstUrl(input.text ?? ""));

        if (url === undefined) {
          return {
            ok: false,
            content: "No URL found for web.extract.",
            metadata: {
              reason: "missing-url"
            }
          };
        }

        const secretFailure = blockSecretUrl(url, "secret-in-url");
        if (secretFailure !== undefined) {
          return secretFailure;
        }

        if (options.enableNetwork !== true) {
          return {
            ok: false,
            content: `web.extract is ready for ${redactUrlForMetadata(url)}, but network fetching is not enabled for this runtime.`,
            metadata: {
              url: redactUrlForMetadata(url),
              reason: "network-disabled"
            }
          };
        }

        const guardFailure = await urlGuard(url, {
          unsafeReason: "unsafe-url",
          policyReason: "website-policy"
        });
        if (guardFailure !== undefined) {
          return guardFailure;
        }

        return extractWithFetch({
          url,
          fetch: options.fetch ?? globalThis.fetch,
          maxContentChars: Math.min(input.maxContentChars ?? maxContentChars, maxContentChars),
          guardUrl: urlGuard,
          signal: context?.signal
        });
      }
    },
    {
      name: "browser.status",
      description: "Check configured browser backend availability and endpoint details.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      riskClass: "read-only-network",
      toolsets: ["browser", "core"],
      progressLabel: "checking browser backend",
      maxResultSizeChars: 3000,
      isAvailable: () => true,
      run: async () => {
        const status = await browserBackend.status();

        return {
          ok: true,
          content: [
            `Browser backend: ${status.backend}`,
            `Available: ${status.available ? "yes" : "no"}`,
            status.endpoint === undefined ? undefined : `Endpoint: ${status.endpoint}`,
            status.browser === undefined ? undefined : `Browser: ${status.browser}`,
            status.version === undefined ? undefined : `Protocol: ${status.version}`,
            status.reason === undefined ? undefined : `Reason: ${status.reason}`
          ].filter((line) => line !== undefined).join("\n"),
          metadata: status
        };
      }
    },
    createBrowserSnapshotTool(browserBackend),
    createBrowserActionTool({
      name: "browser.click",
      description: "Click an interactive browser element by ref from browser.snapshot.",
      progressLabel: "clicking browser element",
      browserBackend,
      method: "click",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string" },
          sessionId: { type: "string" }
        },
        required: ["ref"]
      }
    }),
    createBrowserActionTool({
      name: "browser.type",
      description: "Type text into an input element by ref from browser.snapshot.",
      progressLabel: "typing in browser",
      browserBackend,
      method: "type",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string" },
          text: { type: "string" },
          sessionId: { type: "string" }
        },
        required: ["ref", "text"]
      }
    }),
    createBrowserActionTool({
      name: "browser.scroll",
      description: "Scroll the current browser page up or down.",
      progressLabel: "scrolling browser",
      browserBackend,
      method: "scroll",
      inputSchema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down"] },
          amount: { type: "number" },
          sessionId: { type: "string" }
        }
      }
    }),
    createBrowserActionTool({
      name: "browser.press",
      description: "Press a keyboard key in the current browser page.",
      progressLabel: "pressing browser key",
      browserBackend,
      method: "press",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string" },
          sessionId: { type: "string" }
        }
      }
    }),
    createBrowserActionTool({
      name: "browser.back",
      description: "Navigate the current browser page back in history.",
      progressLabel: "going back in browser",
      browserBackend,
      method: "back",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" }
        }
      }
    }),
    {
      name: "browser.get_images",
      description: "List images on the current browser page with source URLs and alt text.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" }
        }
      },
      riskClass: "read-only-network",
      toolsets: ["browser", "web", "research"],
      progressLabel: "listing browser images",
      maxResultSizeChars: 5000,
      isAvailable: () => browserBackend.isAvailable(),
      run: async (input: BrowserActionInput) => {
        if (browserBackend.getImages === undefined) {
          return unsupportedBrowserTool(browserBackend, "browser.get_images");
        }
        const images = await browserBackend.getImages(input).catch((error: unknown) => ({ error }));
        if ("error" in images) {
          return {
            ok: false,
            content: images.error instanceof Error ? images.error.message : "Browser image listing failed.",
            metadata: { backend: browserBackend.kind }
          };
        }
        return {
          ok: true,
          content: images.length === 0
            ? "No images found on the current browser page."
            : images.map((image, index) => `${index + 1}. ${image.src}${image.alt === undefined ? "" : ` — ${image.alt}`}`).join("\n"),
          metadata: { backend: browserBackend.kind, images }
        };
      }
    },
    {
      name: "browser.console",
      description: "Get captured browser console output for the current page. Use clear=true to clear after reading.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          clear: { type: "boolean" }
        }
      },
      riskClass: "read-only-network",
      toolsets: ["browser", "web", "research"],
      progressLabel: "reading browser console",
      maxResultSizeChars: 8000,
      isAvailable: () => browserBackend.isAvailable(),
      run: async (input: BrowserActionInput) => {
        if (browserBackend.console === undefined) {
          return unsupportedBrowserTool(browserBackend, "browser.console");
        }
        const entries = await browserBackend.console(input).catch((error: unknown) => ({ error }));
        if ("error" in entries) {
          return {
            ok: false,
            content: entries.error instanceof Error ? entries.error.message : "Browser console read failed.",
            metadata: { backend: browserBackend.kind }
          };
        }
        return {
          ok: true,
          content: entries.length === 0
            ? "No captured browser console entries."
            : entries.map((entry) => `${entry.timestamp ?? ""} [${entry.level}] ${entry.text}`.trim()).join("\n"),
          metadata: { backend: browserBackend.kind, entries }
        };
      }
    },
    {
      name: "browser.cdp",
      description: "Run a raw Chrome DevTools Protocol method against the active local-CDP browser session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          method: { type: "string" },
          params: { type: "object" }
        },
        required: ["method"]
      },
      riskClass: "external-side-effect",
      toolsets: ["browser", "web", "research"],
      progressLabel: "running browser CDP command",
      maxResultSizeChars: 8000,
      isAvailable: () => browserBackend.isAvailable(),
      run: async (input: BrowserActionInput) => {
        if (browserBackend.cdp === undefined) {
          return unsupportedBrowserTool(browserBackend, "browser.cdp");
        }
        const guardFailure = await guardBrowserCdpInput(input, urlGuard, browserBackend.kind);
        if (guardFailure !== undefined) {
          return guardFailure;
        }
        const result = await browserBackend.cdp(input).catch((error: unknown) => ({ error }));
        if (typeof result === "object" && result !== null && "error" in result) {
          return {
            ok: false,
            content: result.error instanceof Error ? result.error.message : "Browser CDP command failed.",
            metadata: { backend: browserBackend.kind }
          };
        }
        return {
          ok: true,
          content: JSON.stringify(result, null, 2),
          metadata: { backend: browserBackend.kind, result: result as Record<string, unknown> }
        };
      }
    },
    {
      name: "browser.screenshot",
      description: "Capture a screenshot of the active browser page and save it under .estacoda/browser/screenshots.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" }
        }
      },
      riskClass: "read-only-network",
      toolsets: ["browser", "web", "research"],
      progressLabel: "capturing browser screenshot",
      maxResultSizeChars: 3000,
      isAvailable: () => browserBackend.isAvailable(),
      run: async (input: BrowserActionInput) => {
        if (browserBackend.screenshot === undefined) {
          return unsupportedBrowserTool(browserBackend, "browser.screenshot");
        }
        const screenshot = await browserBackend.screenshot(input).catch((error: unknown) => ({ error }));
        if ("error" in screenshot) {
          return {
            ok: false,
            content: screenshot.error instanceof Error ? screenshot.error.message : "Browser screenshot failed.",
            metadata: { backend: browserBackend.kind }
          };
        }
        const saved = await saveBrowserScreenshot(options.workspaceRoot, screenshot.base64);
        return {
          ok: true,
          content: [
            `Screenshot: ${saved.path}`,
            `MIME: ${screenshot.mimeType}`,
            `Bytes: ${saved.bytes}`
          ].join("\n"),
          metadata: { backend: browserBackend.kind, path: saved.path, mimeType: screenshot.mimeType, bytes: saved.bytes }
        };
      }
    },
    {
      name: "browser.vision",
      description: "Capture a browser screenshot and analyze it with the configured vision route.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          prompt: { type: "string" }
        }
      },
      riskClass: "read-only-network",
      toolsets: ["browser", "web", "research", "media"],
      progressLabel: "analyzing browser screenshot",
      maxResultSizeChars: 8_000,
      isAvailable: () => browserBackend.isAvailable(),
      run: async (input: BrowserActionInput & { prompt?: string }, context) => {
        if (browserBackend.screenshot === undefined) {
          return unsupportedBrowserTool(browserBackend, "browser.vision");
        }
        if (options.visionAnalyzer === undefined) {
          return {
            ok: false,
            content: "browser.vision requires a configured vision analyzer route.",
            metadata: { backend: browserBackend.kind, reason: "vision-unavailable" }
          };
        }
        const screenshot = await browserBackend.screenshot(input).catch((error: unknown) => ({ error }));
        if ("error" in screenshot) {
          return {
            ok: false,
            content: screenshot.error instanceof Error ? screenshot.error.message : "Browser screenshot failed.",
            metadata: { backend: browserBackend.kind }
          };
        }
        const saved = await saveBrowserScreenshot(options.workspaceRoot, screenshot.base64);
        const analysis = await options.visionAnalyzer({
          path: saved.path,
          prompt: input.prompt
        }, context?.signal);
        return {
          ...analysis,
          content: [
            `Browser screenshot: ${saved.path}`,
            analysis.content
          ].join("\n\n"),
          metadata: {
            ...(analysis.metadata ?? {}),
            backend: browserBackend.kind,
            screenshotPath: saved.path,
            screenshotBytes: saved.bytes
          }
        };
      }
    },
    createBrowserActionTool({
      name: "browser.dialog",
      description: "Accept or dismiss a native JavaScript dialog in the active local-CDP browser session.",
      progressLabel: "responding to browser dialog",
      browserBackend,
      method: "dialog",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          action: { type: "string", enum: ["accept", "dismiss"] },
          promptText: { type: "string" }
        }
      }
    }),
    {
      name: "browser.navigate",
      description: "Navigate a browser backend to a URL and return a first snapshot when a backend is configured.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          text: { type: "string" }
        }
      },
      riskClass: "read-only-network",
      toolsets: ["browser", "web", "research"],
      progressLabel: "navigating browser",
      maxResultSizeChars: 4000,
      isAvailable: () => browserBackend.isAvailable(),
      run: async (input: { url?: string; text?: string }, context) => {
        const url = normalizeUrl(input.url ?? extractFirstUrl(input.text ?? ""));

        if (url === undefined) {
          return {
            ok: false,
            content: "No URL found for browser.navigate.",
            metadata: {
              reason: "missing-url",
              backend: "unconfigured"
            }
          };
        }

        const secretFailure = blockSecretUrl(url, "secret-in-url", { backend: browserBackend.kind });
        if (secretFailure !== undefined) {
          return secretFailure;
        }

        const guardFailure = await urlGuard(url, {
          unsafeReason: "unsafe-url",
          policyReason: "website-policy",
          metadata: { backend: browserBackend.kind }
        });
        if (guardFailure !== undefined) {
          return guardFailure;
        }

        if (!(await browserBackend.isAvailable())) {
          return {
            ok: false,
            content: [
              `Browser navigation requested for ${redactUrlForMetadata(url)}.`,
              "No browser backend is configured yet. Next backends to wire: local CDP, Firecrawl, Browserbase/Camofox."
            ].join("\n"),
            metadata: {
              url: redactUrlForMetadata(url),
              backend: browserBackend.kind
            }
          };
        }

        if (context?.signal?.aborted === true) {
          return {
            ok: false,
            content: "Browser navigation cancelled.",
            metadata: {
              url: redactUrlForMetadata(url),
              backend: browserBackend.kind,
              reason: "cancelled"
            }
          };
        }

        const result = await browserBackend.navigate({ url, signal: context?.signal }).catch((error: unknown) => ({
          error
        }));

        if ("error" in result) {
          return {
            ok: false,
            content: result.error instanceof Error ? result.error.message : "Browser navigation failed.",
            metadata: {
              url: redactUrlForMetadata(url),
              backend: browserBackend.kind,
              reason: "navigation-failed"
            }
          };
        }

        const postNavigationFailure = await checkPostNavigationUrl({
          requestedUrl: url,
          result,
          browserBackend,
          guardUrl: urlGuard,
          signal: context?.signal
        });
        if (postNavigationFailure !== undefined) {
          return postNavigationFailure;
        }

        return {
          ok: true,
          content: [
            `Browser: ${result.session.backend}`,
            `Session: ${result.session.id}`,
            `URL: ${result.snapshot.url}`,
            result.snapshot.title === undefined ? undefined : `Title: ${result.snapshot.title}`,
            "",
            renderBrowserSnapshot(result.snapshot)
          ].filter((line) => line !== undefined).join("\n"),
          metadata: {
            url: redactUrlForMetadata(url),
            backend: result.session.backend,
            session: result.session,
            snapshot: result.snapshot
          }
        };
      }
    }
  ];
}

export const webToolProvider: SessionToolProvider = {
  name: "web",
  kind: "session",
  createTools(ctx) {
    const providerRegistry = requireProviderDependency("web", "providerRegistry", ctx.providerRegistry);
    const channelMediaRoot = requireProviderDependency("web", "channelMediaRoot", ctx.channelMediaRoot);
    return createWebTools({
      fetch: ctx.webFetch,
      browserBackend: requireProviderDependency("web", "browserBackend", ctx.browserBackend),
      enableNetwork: ctx.enableWebNetwork,
      maxContentChars: ctx.webMaxContentChars,
      workspaceRoot: ctx.workspaceRoot,
      securityConfig: ctx.securityConfig,
      visionAnalyzer: (input, signal) => analyzeImageWithVision({
        workspaceRoot: ctx.workspaceRoot,
        allowedRoots: [channelMediaRoot],
        visionAuxiliaryRoute: ctx.visionRoute,
        mainRoute: ctx.mainRoute,
        providerExecutor: new ProviderExecutor({
          registry: providerRegistry
        })
      }, input, signal)
    });
  }
};

function requireProviderDependency<T>(provider: string, dependency: string, value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError(`${provider}ToolProvider requires ${dependency}.`);
  }
  return value;
}

function createBrowserSnapshotTool(browserBackend: BrowserBackend): RegisteredTool {
  return {
    name: "browser.snapshot",
    description: "Get a text snapshot of the current browser page with interactive element refs like @e1.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" }
      }
    },
    riskClass: "read-only-network",
    toolsets: ["browser", "web", "research"],
    progressLabel: "snapshotting browser",
    maxResultSizeChars: 8000,
    isAvailable: () => browserBackend.isAvailable(),
    run: async (input: BrowserActionInput) => {
      if (browserBackend.snapshot === undefined) {
        return unsupportedBrowserTool(browserBackend, "browser.snapshot");
      }
      const snapshot = await browserBackend.snapshot(input).catch((error: unknown) => ({ error }));
      if ("error" in snapshot) {
        return {
          ok: false,
          content: snapshot.error instanceof Error ? snapshot.error.message : "Browser snapshot failed.",
          metadata: { backend: browserBackend.kind }
        };
      }
      return {
        ok: true,
        content: renderBrowserSnapshot(snapshot),
        metadata: { backend: browserBackend.kind, snapshot }
      };
    }
  };
}

function createBrowserActionTool(input: {
  name: string;
  description: string;
  progressLabel: string;
  browserBackend: BrowserBackend;
  method: "click" | "type" | "scroll" | "press" | "back" | "dialog";
  inputSchema: RegisteredTool["inputSchema"];
}): RegisteredTool {
  return {
    name: input.name,
    description: input.description,
    inputSchema: input.inputSchema,
    riskClass: "read-only-network",
    toolsets: ["browser", "web", "research"],
    progressLabel: input.progressLabel,
    maxResultSizeChars: 8000,
    isAvailable: () => input.browserBackend.isAvailable(),
    run: async (toolInput: BrowserActionInput) => {
      const method = input.browserBackend[input.method];
      if (method === undefined) {
        return unsupportedBrowserTool(input.browserBackend, input.name);
      }
      const snapshot = await method(toolInput).catch((error: unknown) => ({ error }));
      if ("error" in snapshot) {
        return {
          ok: false,
          content: snapshot.error instanceof Error ? snapshot.error.message : `${input.name} failed.`,
          metadata: { backend: input.browserBackend.kind }
        };
      }
      return {
        ok: true,
        content: renderBrowserSnapshot(snapshot),
        metadata: { backend: input.browserBackend.kind, snapshot }
      };
    }
  };
}

async function saveBrowserScreenshot(workspaceRoot: string | undefined, base64: string): Promise<{ path: string; bytes: number }> {
  const root = workspaceRoot ?? process.cwd();
  const path = join(root, ".estacoda", "browser", "screenshots", `browser-${Date.now()}.png`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(base64, "base64"));
  const file = await stat(path);
  return { path, bytes: file.size };
}

function renderBrowserSnapshot(snapshot: BrowserSnapshot): string {
  const elements = snapshot.elements ?? [];
  return [
    snapshot.text,
    elements.length === 0 ? undefined : "",
    elements.length === 0 ? undefined : "Interactive elements:",
    ...elements.map((element) => `${element.ref} ${element.role ?? "element"} ${element.name ?? ""}`.trim())
  ].filter((line) => line !== undefined).join("\n");
}

function unsupportedBrowserTool(browserBackend: BrowserBackend, tool: string) {
  return {
    ok: false,
    content: `${tool} is not supported by the ${browserBackend.kind} browser backend yet.`,
    metadata: {
      backend: browserBackend.kind,
      reason: "unsupported-browser-tool"
    }
  };
}

type UrlGuardFailure = {
  ok: false;
  content: string;
  metadata: Record<string, unknown>;
};

type UrlGuard = (
  url: string,
  reasons: {
    unsafeReason: string;
    policyReason: string;
    metadata?: Record<string, unknown>;
  }
) => Promise<UrlGuardFailure | undefined>;

function createUrlGuard(options: WebToolOptions): UrlGuard {
  const websitePolicy = loadWebsiteBlocklist(options.securityConfig?.websiteBlocklist ?? {});
  const allowPrivateUrls = options.securityConfig?.allowPrivateUrls === true;
  return async (url, reasons) => {
    if (!await isSafeUrl(url, {
      allowPrivateUrls,
      resolveHostname: options.resolveHostname
    })) {
      return {
        ok: false,
        content: "Blocked unsafe URL.",
        metadata: {
          url: redactUrlForMetadata(url),
          ...(reasons.metadata ?? {}),
          reason: reasons.unsafeReason
        }
      };
    }

    const websiteAccess = checkWebsiteAccess(url, websitePolicy);
    if (websiteAccess?.allowed === false) {
      return {
        ok: false,
        content: "Blocked by website policy.",
        metadata: {
          url: redactUrlForMetadata(url),
          ...(reasons.metadata ?? {}),
          reason: reasons.policyReason,
          host: websiteAccess.host,
          matchedRule: websiteAccess.matchedRule
        }
      };
    }

    return undefined;
  };
}

function blockSecretUrl(
  url: string,
  reason: string,
  metadata: Record<string, unknown> = {}
): UrlGuardFailure | undefined {
  if (scanUrlForSecrets(url) === undefined) {
    return undefined;
  }

  return {
    ok: false,
    content: "Blocked URL containing a secret.",
    metadata: {
      ...metadata,
      url: redactUrlForMetadata(url),
      reason
    }
  };
}

async function guardBrowserCdpInput(
  input: BrowserActionInput,
  guardUrl: UrlGuard,
  backend: BrowserBackend["kind"]
): Promise<UrlGuardFailure | undefined> {
  const method = input.method ?? "";
  const metadata = { backend, method };
  const urlParamName = CDP_URL_PARAMETER_METHODS.get(method);
  const explicitUrl = urlParamName === undefined ? undefined : input.params?.[urlParamName];
  if (typeof explicitUrl === "string") {
    return guardCdpUrl(explicitUrl, guardUrl, metadata);
  }

  if (!CDP_RUNTIME_METHODS.has(method)) {
    return undefined;
  }

  return guardCdpRuntimeExpression(input.params, guardUrl, metadata);
}

async function guardCdpUrl(
  url: string,
  guardUrl: UrlGuard,
  metadata: Record<string, unknown>
): Promise<UrlGuardFailure | undefined> {
  const secretFailure = blockSecretUrl(url, "secret-in-url", metadata);
  if (secretFailure !== undefined) {
    return secretFailure;
  }

  return guardUrl(url, {
    unsafeReason: "unsafe-url",
    policyReason: "website-policy",
    metadata
  });
}

async function guardCdpRuntimeExpression(
  params: Record<string, unknown> | undefined,
  guardUrl: UrlGuard,
  metadata: Record<string, unknown>
): Promise<UrlGuardFailure | undefined> {
  const texts = collectStrings(params ?? {});
  const literalUrls = unique(texts.flatMap(extractUrlLiterals));
  for (const url of literalUrls) {
    const secretFailure = blockSecretUrl(url, "secret-in-url", metadata);
    if (secretFailure !== undefined) {
      return secretFailure;
    }
  }

  if (!texts.some(isGuardableCdpRuntimeExpression)) {
    return undefined;
  }

  if (literalUrls.length === 0) {
    return {
      ok: false,
      content: "Blocked network-capable CDP expression.",
      metadata: {
        ...metadata,
        reason: "cdp-network-expression-unchecked"
      }
    };
  }

  for (const url of literalUrls) {
    const guardFailure = await guardUrl(url, {
      unsafeReason: "unsafe-url",
      policyReason: "website-policy",
      metadata
    });
    if (guardFailure !== undefined) {
      return guardFailure;
    }
  }

  return undefined;
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 6) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStrings(entry, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap((entry) => collectStrings(entry, depth + 1));
  }
  return [];
}

function isGuardableCdpRuntimeExpression(text: string): boolean {
  return CDP_NETWORK_EXPRESSION_PATTERN.test(text) || CDP_NAVIGATION_EXPRESSION_PATTERN.test(text);
}

function extractUrlLiterals(text: string): string[] {
  CDP_URL_LITERAL_PATTERN.lastIndex = 0;
  return Array.from(text.matchAll(CDP_URL_LITERAL_PATTERN), (match) => trimUrlLiteral(match[0]));
}

function trimUrlLiteral(url: string): string {
  return url.replace(/[.,;]+$/u, "");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

async function extractWithFetch(input: {
  url: string;
  fetch: FetchLike;
  maxContentChars: number;
  guardUrl: UrlGuard;
  signal?: AbortSignal;
}) {
  const { signal, cleanup } = createTimeoutSignal(30_000, input.signal);

  try {
    const { response, url } = await fetchWithGuardedRedirects(input.url, {
      fetch: input.fetch,
      guardUrl: input.guardUrl,
      signal
    });
    const raw = await response.text();
    const contentType = response.headers.get("content-type") ?? undefined;
    const extracted = extractReadableText(raw, contentType);
    const result: WebExtractionResult = {
      url,
      title: extractTitle(raw),
      content: truncate(extracted, input.maxContentChars),
      contentType,
      status: response.status,
      source: "fetch"
    };

    return {
      ok: response.ok,
      content: [
        `URL: ${result.url}`,
        result.title === undefined ? undefined : `Title: ${result.title}`,
        `Status: ${response.status} ${response.statusText}`,
        "",
        result.content
      ].filter((line) => line !== undefined).join("\n"),
      metadata: result
    };
  } catch (error) {
    if (isUrlGuardFailure(error)) {
      return error;
    }
    return {
      ok: false,
      content: error instanceof Error ? error.message : "web.extract failed.",
      metadata: {
        url: redactUrlForMetadata(input.url),
        reason: "fetch-failed"
      }
    };
  } finally {
    cleanup();
  }
}

async function fetchWithGuardedRedirects(
  startUrl: string,
  input: {
    fetch: FetchLike;
    guardUrl: UrlGuard;
    signal: AbortSignal;
  }
): Promise<{
  response: Awaited<ReturnType<FetchLike>>;
  url: string;
}> {
  let currentUrl = startUrl;
  for (let redirectCount = 0; redirectCount <= MAX_WEB_EXTRACT_REDIRECTS; redirectCount++) {
    const response = await input.fetch(currentUrl, {
      method: "GET",
      headers: {
        "user-agent": "EstaCoda/2 web.extract"
      },
      redirect: "manual",
      signal: input.signal
    });

    const location = response.headers.get("location");
    if (!isRedirectStatus(response.status) || location === null) {
      return { response, url: currentUrl };
    }

    if (redirectCount >= MAX_WEB_EXTRACT_REDIRECTS) {
      throw createRedirectFailure(currentUrl, "too-many-redirects");
    }

    const nextUrl = resolveRedirectUrl(location, currentUrl);
    if (nextUrl === undefined) {
      throw createRedirectFailure(currentUrl, "redirect-unsafe-url");
    }

    const secretFailure = blockSecretUrl(nextUrl, "redirect-secret-in-url");
    if (secretFailure !== undefined) {
      throw secretFailure;
    }

    const guardFailure = await input.guardUrl(nextUrl, {
      unsafeReason: "redirect-unsafe-url",
      policyReason: "redirect-website-policy"
    });
    if (guardFailure !== undefined) {
      throw guardFailure;
    }

    currentUrl = nextUrl;
  }

  throw createRedirectFailure(currentUrl, "too-many-redirects");
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function resolveRedirectUrl(location: string, currentUrl: string): string | undefined {
  try {
    return normalizeUrl(new URL(location, currentUrl).toString());
  } catch {
    return undefined;
  }
}

function createRedirectFailure(url: string, reason: string): UrlGuardFailure {
  return {
    ok: false,
    content: "Blocked web.extract redirect.",
    metadata: {
      url: redactUrlForMetadata(url),
      reason
    }
  };
}

function isUrlGuardFailure(value: unknown): value is UrlGuardFailure {
  return typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { metadata?: unknown }).metadata === "object";
}

async function checkPostNavigationUrl(input: {
  requestedUrl: string;
  result: import("../contracts/browser.js").BrowserNavigateResult;
  browserBackend: BrowserBackend;
  guardUrl: UrlGuard;
  signal?: AbortSignal;
}): Promise<UrlGuardFailure | undefined> {
  const finalUrl = normalizeUrl(input.result.snapshot.url);
  if (finalUrl === undefined || finalUrl === input.requestedUrl) {
    return undefined;
  }

  const baseMetadata = {
    backend: input.result.session.backend,
    url: redactUrlForMetadata(input.requestedUrl),
    finalUrl: redactUrlForMetadata(input.result.snapshot.url)
  };

  const secretFailure = blockSecretUrl(finalUrl, "post-redirect-secret-in-url", baseMetadata);
  if (secretFailure !== undefined) {
    await blankBrowserSession(input.browserBackend, input.result.session.id, input.signal);
    return secretFailure;
  }

  if (isAlwaysBlockedUrl(finalUrl)) {
    await blankBrowserSession(input.browserBackend, input.result.session.id, input.signal);
    return {
      ok: false,
      content: "Blocked browser navigation to an always-blocked redirect target.",
      metadata: {
        ...baseMetadata,
        reason: "post-redirect-always-blocked"
      }
    };
  }

  const guardFailure = await input.guardUrl(finalUrl, {
    unsafeReason: "post-redirect-unsafe",
    policyReason: "post-redirect-website-policy",
    metadata: baseMetadata
  });
  if (guardFailure !== undefined) {
    await blankBrowserSession(input.browserBackend, input.result.session.id, input.signal);
    return guardFailure;
  }

  return undefined;
}

async function blankBrowserSession(browserBackend: BrowserBackend, sessionId: string, signal: AbortSignal | undefined): Promise<void> {
  await browserBackend.navigate({
    url: "about:blank",
    sessionId,
    signal
  }).catch(() => undefined);
}

export function extractFirstUrl(text: string): string | undefined {
  return /https?:\/\/[^\s<>"')]+/iu.exec(text)?.[0];
}

function normalizeUrl(url: string | undefined): string | undefined {
  if (url === undefined || url.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = new URL(url.trim());

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }

    return parsed.toString();
  } catch {
    return undefined;
  }
}

function createTimeoutSignal(timeoutMs: number, parentSignal: AbortSignal | undefined): {
  signal: AbortSignal;
  cleanup(): void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal?.reason);
  const timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);

  if (parentSignal?.aborted === true) {
    abort();
  } else {
    parentSignal?.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
    }
  };
}

function extractReadableText(raw: string, contentType: string | undefined): string {
  if (contentType !== undefined && !/html|text|json|xml/i.test(contentType)) {
    return truncate(raw, DEFAULT_MAX_CONTENT_CHARS);
  }

  return raw
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractTitle(raw: string): string | undefined {
  const title = /<title[^>]*>(?<title>[\s\S]*?)<\/title>/iu.exec(raw)?.groups?.title
    ?.replace(/\s+/gu, " ")
    .trim();

  return title === undefined || title.length === 0 ? undefined : title;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}
