import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RegisteredTool } from "../contracts/tool.js";
import type { SessionToolProvider } from "../contracts/tool.js";
import type { BrowserActionInput, BrowserBackend, BrowserNavigateInput, BrowserSnapshot, WebExtractionResult } from "../contracts/browser.js";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import { createBrowserDebugSession, type BrowserDebugSession } from "../browser/browser-debug.js";
import { createUnconfiguredBrowserBackend } from "../browser/browser-backend.js";
import { deriveBrowserSessionKey } from "../browser/session-key.js";
import { maybeSummarizeSnapshot, truncateSnapshotText } from "../browser/snapshot-summarizer.js";
import { isAlwaysBlockedUrl, isSafeUrl, redactUrlForMetadata, scanUrlForSecrets, type ResolveHostnameFn } from "../browser/url-safety.js";
import { checkWebsiteAccess, loadWebsiteBlocklist } from "../browser/website-policy.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { analyzeImageWithVision } from "./vision-tools.js";
import { createTimeoutSignal } from "../utils/timeout-signal.js";
import {
  registerDefaultWebResearchProviders,
  selectWebResearchProvider
} from "./web-research-registry.js";
import type { WebResearchConfig, WebResearchProvider, WebSearchResult } from "./web-research-provider.js";

export type WebToolOptions = {
  fetch?: FetchLike;
  browserBackend?: BrowserBackend;
  enableNetwork?: boolean;
  maxContentChars?: number;
  webConfig?: WebResearchConfig;
  browserConfig?: Pick<import("../config/runtime-config.js").LoadedRuntimeConfig["browser"], "summarizeSnapshots" | "snapshotSummarizeThreshold">;
  workspaceRoot?: string;
  currentSessionId?: () => string;
  mainRoute?: ResolvedModelRoute;
  snapshotAuxiliaryRoute?: ResolvedAuxiliaryRoute;
  providerExecutor?: Pick<ProviderExecutor, "complete">;
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
const CDP_READ_ONLY_METHODS = new Set([
  "Accessibility.getFullAXTree",
  "Browser.getVersion",
  "DOM.describeNode",
  "DOM.getDocument",
  "DOM.getOuterHTML",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "Network.getResponseBody",
  "Page.captureScreenshot",
  "Page.getFrameTree",
  "Page.getNavigationHistory",
  "Performance.getMetrics",
  "Runtime.getProperties",
  "Target.getTargets"
]);
const CDP_NETWORK_EXPRESSION_PATTERN = /\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource)\b/u;
const CDP_NAVIGATION_EXPRESSION_PATTERN = /\b(?:location\.(?:href|assign|replace)|(?:window|document|self|top|parent)\.location|window\.open|open\s*\()/u;
const CDP_URL_LITERAL_PATTERN = /https?:\/\/[^\s"'<>\\)]+/giu;

export function createWebTools(options: WebToolOptions = {}): readonly RegisteredTool[] {
  registerDefaultWebResearchProviders();
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const browserBackend = options.browserBackend ?? createUnconfiguredBrowserBackend();
  const urlGuard = createUrlGuard(options);
  const deriveBrowserInput = <TInput extends { sessionId?: string }>(input: TInput): TInput & { sessionId: string } =>
    withDerivedBrowserSessionId(input, options.currentSessionId);

  return [
    createWebSearchTool(options.webConfig),
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
        const debug = createBrowserDebugSession();
        const url = normalizeUrl(input.url ?? extractFirstUrl(input.text ?? ""));

        if (url === undefined) {
          debug.log("web.extract.blocked", { reason: "missing-url" });
          return withDebug({
            ok: false,
            content: "No URL found for web.extract.",
            metadata: {
              reason: "missing-url"
            }
          }, debug);
        }
        debug.log("web.extract.start", { url });

        const secretFailure = blockSecretUrl(url, "secret-in-url");
        if (secretFailure !== undefined) {
          debug.log("web.extract.blocked", { reason: "secret-in-url", url });
          return withDebug(secretFailure, debug);
        }

        if (options.enableNetwork !== true) {
          debug.log("web.extract.blocked", { reason: "network-disabled", url });
          return withDebug({
            ok: false,
            content: `web.extract is ready for ${redactUrlForMetadata(url)}, but network fetching is not enabled for this runtime.`,
            metadata: {
              url: redactUrlForMetadata(url),
              reason: "network-disabled"
            }
          }, debug);
        }

        const guardFailure = await urlGuard(url, {
          unsafeReason: "unsafe-url",
          policyReason: "website-policy"
        });
        if (guardFailure !== undefined) {
          debug.log("web.extract.blocked", { reason: guardFailure.metadata.reason, url });
          return withDebug(guardFailure, debug);
        }

        const providerSelection = await selectWebResearchProvider("extract", options.webConfig);
        debug.log("web.extract.provider", {
          provider: providerSelection.providerName,
          fallback: providerSelection.fallback,
          available: providerSelection.availability.available,
          reason: providerSelection.availability.reason
        });
        if (!providerSelection.availability.available) {
          return withDebug(unavailableWebResearchResult("web.extract", "extract", providerSelection), debug);
        }

        if (!providerSelection.fallback && providerSelection.providerName !== "fetch") {
          if (providerSelection.provider?.extract === undefined) {
            return withDebug(unavailableWebResearchResult("web.extract", "extract", {
              ...providerSelection,
              availability: {
                available: false,
                reason: `Provider ${providerSelection.providerName ?? "unknown"} does not support web extract.`
              }
            }), debug);
          }

          const providerResult = await providerSelection.provider.extract(url, {
            maxContentChars: Math.min(input.maxContentChars ?? maxContentChars, maxContentChars),
            signal: context?.signal
          }).catch((error: unknown) => ({ error }));
          if ("error" in providerResult) {
            debug.log("web.extract.provider_failed", { provider: providerSelection.providerName, url });
            return withDebug({
              ok: false,
              content: providerResult.error instanceof Error ? providerResult.error.message : "web.extract provider failed.",
              metadata: {
                url: redactUrlForMetadata(url),
                provider: providerSelection.providerName,
                reason: "provider-failed"
              }
            }, debug);
          }

          debug.log("web.extract.complete", {
            provider: providerSelection.providerName,
            url: providerResult.url,
            status: providerResult.status,
            contentLength: providerResult.content.length
          });
          return withDebug(formatWebExtractProviderResult(providerSelection.provider, providerResult), debug);
        }

        return extractWithFetch({
          url,
          fetch: options.fetch ?? globalThis.fetch,
          maxContentChars: Math.min(input.maxContentChars ?? maxContentChars, maxContentChars),
          guardUrl: urlGuard,
          debug,
          signal: context?.signal
        });
      }
    },
    createWebCrawlTool(options.webConfig, urlGuard),
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
            status.hybridRouting === undefined ? undefined : `Hybrid routing: ${status.hybridRouting ? "enabled" : "disabled"}`,
            status.lastNavigationBackend === undefined ? undefined : `Last served backend: ${status.lastNavigationBackend}`,
            status.reason === undefined ? undefined : `Reason: ${status.reason}`
          ].filter((line) => line !== undefined).join("\n"),
          metadata: status
        };
      }
    },
    createBrowserSnapshotTool(browserBackend, deriveBrowserInput, {
      browserConfig: options.browserConfig,
      mainRoute: options.mainRoute,
      snapshotAuxiliaryRoute: options.snapshotAuxiliaryRoute,
      providerExecutor: options.providerExecutor
    }),
    createBrowserActionTool({
      name: "browser.click",
      description: "Click an interactive browser element by ref from browser.snapshot.",
      progressLabel: "clicking browser element",
      browserBackend,
      deriveBrowserInput,
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
      deriveBrowserInput,
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
      deriveBrowserInput,
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
      deriveBrowserInput,
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
      deriveBrowserInput,
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
        const browserInput = deriveBrowserInput(input);
        const images = await browserBackend.getImages(browserInput).catch((error: unknown) => ({ error }));
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
        const browserInput = deriveBrowserInput(input);
        const entries = await browserBackend.console(browserInput).catch((error: unknown) => ({ error }));
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
      toolsets: ["dangerous"],
      progressLabel: "running browser CDP command",
      maxResultSizeChars: 8000,
      isAvailable: () => browserBackend.isAvailable(),
      run: async (input: BrowserActionInput) => {
        const debug = createBrowserDebugSession();
        if (browserBackend.cdp === undefined) {
          return withDebug(unsupportedBrowserTool(browserBackend, "browser.cdp"), debug);
        }
        const browserInput = deriveBrowserInput(input);
        debug.log("browser.cdp.start", {
          backend: browserBackend.kind,
          method: browserInput.method,
          params: browserInput.params
        });
        const guardFailure = await guardBrowserCdpInput(browserInput, urlGuard, browserBackend.kind);
        if (guardFailure !== undefined) {
          debug.log("browser.cdp.blocked", {
            backend: browserBackend.kind,
            method: browserInput.method,
            reason: guardFailure.metadata.reason,
            url: guardFailure.metadata.url
          });
          return withDebug(guardFailure, debug);
        }
        const result = await browserBackend.cdp(browserInput).catch((error: unknown) => ({ error }));
        if (typeof result === "object" && result !== null && "error" in result) {
          debug.log("browser.cdp.error", {
            backend: browserBackend.kind,
            method: browserInput.method,
            error: result.error instanceof Error ? result.error.message : "Browser CDP command failed."
          });
          return withDebug({
            ok: false,
            content: result.error instanceof Error ? result.error.message : "Browser CDP command failed.",
            metadata: { backend: browserBackend.kind }
          }, debug);
        }
        debug.log("browser.cdp.complete", {
          backend: browserBackend.kind,
          method: browserInput.method,
          responseShape: describeValueShape(result)
        });
        return {
          ok: true,
          content: JSON.stringify(result, null, 2),
          metadata: withDebugMetadata({ backend: browserBackend.kind, result: result as Record<string, unknown> }, debug)
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
        const browserInput = deriveBrowserInput(input);
        const screenshot = await browserBackend.screenshot(browserInput).catch((error: unknown) => ({ error }));
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
        const browserInput = deriveBrowserInput(input);
        const screenshot = await browserBackend.screenshot(browserInput).catch((error: unknown) => ({ error }));
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
      deriveBrowserInput,
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
      run: async (input: { url?: string; text?: string; sessionId?: string }, context) => {
        const debug = createBrowserDebugSession();
        const url = normalizeUrl(input.url ?? extractFirstUrl(input.text ?? ""));

        if (url === undefined) {
          debug.log("browser.navigate.blocked", { backend: browserBackend.kind, reason: "missing-url" });
          return withDebug({
            ok: false,
            content: "No URL found for browser.navigate.",
            metadata: {
              reason: "missing-url",
              backend: "unconfigured"
            }
          }, debug);
        }
        debug.log("browser.navigate.start", { backend: browserBackend.kind, requestedUrl: url });

        const secretFailure = blockSecretUrl(url, "secret-in-url", { backend: browserBackend.kind });
        if (secretFailure !== undefined) {
          debug.log("browser.navigate.blocked", { backend: browserBackend.kind, reason: "secret-in-url", requestedUrl: url });
          return withDebug(secretFailure, debug);
        }

        const guardFailure = await urlGuard(url, {
          unsafeReason: "unsafe-url",
          policyReason: "website-policy",
          metadata: { backend: browserBackend.kind }
        });
        if (guardFailure !== undefined) {
          debug.log("browser.navigate.blocked", { backend: browserBackend.kind, reason: guardFailure.metadata.reason, requestedUrl: url });
          return withDebug(guardFailure, debug);
        }

        if (!(await browserBackend.isAvailable())) {
          debug.log("browser.navigate.unavailable", { backend: browserBackend.kind, requestedUrl: url });
          return withDebug({
            ok: false,
            content: [
              `Browser navigation requested for ${redactUrlForMetadata(url)}.`,
              "No browser backend is configured yet. Configure local CDP with `estacoda browser setup --backend local-cdp` or Browserbase with `estacoda browser setup --backend browserbase --cloud-provider browserbase` and `estacoda browser approve-cloud`. Firecrawl, Camofox, and Browser Use remain deferred."
            ].join("\n"),
            metadata: {
              url: redactUrlForMetadata(url),
              backend: browserBackend.kind
            }
          }, debug);
        }

        if (context?.signal?.aborted === true) {
          debug.log("browser.navigate.blocked", { backend: browserBackend.kind, reason: "cancelled", requestedUrl: url });
          return withDebug({
            ok: false,
            content: "Browser navigation cancelled.",
            metadata: {
              url: redactUrlForMetadata(url),
              backend: browserBackend.kind,
              reason: "cancelled"
            }
          }, debug);
        }

        const browserInput = deriveBrowserInput({ url, sessionId: input.sessionId, signal: context?.signal });
        const result = await browserBackend.navigate(browserInput).catch((error: unknown) => ({
          error
        }));

        if ("error" in result) {
          debug.log("browser.navigate.error", {
            backend: browserBackend.kind,
            requestedUrl: url,
            error: result.error instanceof Error ? result.error.message : "Browser navigation failed."
          });
          return withDebug({
            ok: false,
            content: result.error instanceof Error ? result.error.message : "Browser navigation failed.",
            metadata: {
              url: redactUrlForMetadata(url),
              backend: browserBackend.kind,
              reason: "navigation-failed"
            }
          }, debug);
        }

        const postNavigationFailure = await checkPostNavigationUrl({
          requestedUrl: url,
          result,
          browserBackend,
          guardUrl: urlGuard,
          signal: context?.signal
        });
        if (postNavigationFailure !== undefined) {
          debug.log("browser.navigate.blocked", {
            backend: browserBackend.kind,
            sessionId: result.session.id,
            requestedUrl: url,
            finalUrl: result.snapshot.url,
            reason: postNavigationFailure.metadata.reason
          });
          return withDebug(postNavigationFailure, debug);
        }

        debug.log("browser.navigate.complete", {
          backend: result.session.backend,
          sessionId: result.session.id,
          requestedUrl: url,
          finalUrl: result.snapshot.url
        });
        const botDetectionWarning = browserBotDetectionWarning(result.snapshot);
        return {
          ok: true,
          content: [
            `Browser: ${result.session.backend}`,
            `Session: ${result.session.id}`,
            `URL: ${result.snapshot.url}`,
            result.snapshot.title === undefined ? undefined : `Title: ${result.snapshot.title}`,
            botDetectionWarning === undefined ? undefined : `Warning: ${botDetectionWarning}`,
            "",
            renderBrowserSnapshot(result.snapshot, { maxChars: 4000 })
          ].filter((line) => line !== undefined).join("\n"),
          metadata: {
            url: redactUrlForMetadata(url),
            backend: result.session.backend,
            session: result.session,
            snapshot: result.snapshot,
            ...(result.metadata ?? {}),
            ...debugMetadata(debug)
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
      webConfig: ctx.webConfig,
      browserConfig: ctx.browserConfig,
      workspaceRoot: ctx.workspaceRoot,
      currentSessionId: () => ctx.currentSessionId(),
      mainRoute: ctx.mainRoute,
      snapshotAuxiliaryRoute: ctx.compressionRoute,
      providerExecutor: ctx.providerExecutor,
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

function createWebSearchTool(webConfig: WebResearchConfig | undefined): RegisteredTool {
  return {
    name: "web.search",
    description: "Search the web using a configured research provider.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "number" }
      },
      required: ["query"]
    },
    riskClass: "read-only-network",
    toolsets: ["web", "research"],
    progressLabel: "searching web",
    maxResultSizeChars: 8000,
    isAvailable: async () => (await selectWebResearchProvider("search", webConfig)).availability.available,
    run: async (input: { query?: string; maxResults?: number }, context) => {
      const query = input.query?.trim();
      if (query === undefined || query.length === 0) {
        return {
          ok: false,
          content: "No query found for web.search.",
          metadata: { reason: "missing-query" }
        };
      }

      const providerSelection = await selectWebResearchProvider("search", webConfig);
      if (!providerSelection.availability.available) {
        return unavailableWebResearchResult("web.search", "search", providerSelection);
      }

      if (providerSelection.provider?.search === undefined) {
        return unavailableWebResearchResult("web.search", "search", {
          ...providerSelection,
          availability: {
            available: false,
            reason: `Provider ${providerSelection.providerName ?? "unknown"} does not support web search.`
          }
        });
      }

      const results = await providerSelection.provider.search(query, {
        maxResults: input.maxResults,
        signal: context?.signal
      }).catch((error: unknown) => ({ error }));
      if ("error" in results) {
        return {
          ok: false,
          content: results.error instanceof Error ? results.error.message : "web.search provider failed.",
          metadata: {
            provider: providerSelection.providerName,
            reason: "provider-failed"
          }
        };
      }

      const bounded = results.slice(0, Math.max(1, Math.min(input.maxResults ?? 10, 20)));
      return {
        ok: true,
        content: bounded.length === 0
          ? "No web search results found."
          : bounded.map((result, index) => [
            `${index + 1}. ${truncate(result.title, 200)}`,
            result.url,
            result.snippet === undefined ? undefined : truncate(result.snippet, 500)
          ].filter((line) => line !== undefined).join("\n")).join("\n\n"),
        metadata: {
          provider: providerSelection.providerName,
          results: bounded,
          _estacoda_context_summary: webSearchContextSummary(bounded)
        }
      };
    }
  };
}

function createWebCrawlTool(webConfig: WebResearchConfig | undefined, guardUrl: UrlGuard): RegisteredTool {
  return {
    name: "web.crawl",
    description: "Crawl a URL using a configured research provider.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        text: { type: "string" },
        maxPages: { type: "number" },
        maxContentChars: { type: "number" }
      }
    },
    riskClass: "read-only-network",
    toolsets: ["web", "research"],
    progressLabel: "crawling web",
    maxResultSizeChars: 12000,
    isAvailable: async () => (await selectWebResearchProvider("crawl", webConfig)).availability.available,
    run: async (input: { url?: string; text?: string; maxPages?: number; maxContentChars?: number }, context) => {
      const url = normalizeUrl(input.url ?? extractFirstUrl(input.text ?? ""));
      if (url === undefined) {
        return {
          ok: false,
          content: "No URL found for web.crawl.",
          metadata: { reason: "missing-url" }
        };
      }

      const secretFailure = blockSecretUrl(url, "secret-in-url");
      if (secretFailure !== undefined) {
        return secretFailure;
      }

      const guardFailure = await guardUrl(url, {
        unsafeReason: "unsafe-url",
        policyReason: "website-policy"
      });
      if (guardFailure !== undefined) {
        return guardFailure;
      }

      const providerSelection = await selectWebResearchProvider("crawl", webConfig);
      if (!providerSelection.availability.available) {
        return unavailableWebResearchResult("web.crawl", "crawl", providerSelection);
      }

      if (providerSelection.provider?.crawl === undefined) {
        return unavailableWebResearchResult("web.crawl", "crawl", {
          ...providerSelection,
          availability: {
            available: false,
            reason: `Provider ${providerSelection.providerName ?? "unknown"} does not support web crawl.`
          }
        });
      }

      const result = await providerSelection.provider.crawl(url, {
        maxPages: input.maxPages,
        maxContentChars: input.maxContentChars,
        signal: context?.signal
      }).catch((error: unknown) => ({ error }));
      if ("error" in result) {
        return {
          ok: false,
          content: result.error instanceof Error ? result.error.message : "web.crawl provider failed.",
          metadata: {
            url: redactUrlForMetadata(url),
            provider: providerSelection.providerName,
            reason: "provider-failed"
          }
        };
      }

      const pages = result.pages.slice(0, Math.max(1, Math.min(input.maxPages ?? 10, 20)));
      return {
        ok: true,
        content: pages.length === 0
          ? `No pages crawled for ${redactUrlForMetadata(result.url)}.`
          : pages.map((page, index) => [
            `${index + 1}. ${page.title ?? page.url}`,
            page.url,
            truncate(page.content, input.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS)
          ].join("\n")).join("\n\n"),
        metadata: {
          provider: providerSelection.providerName,
          url: redactUrlForMetadata(result.url),
          pages
        }
      };
    }
  };
}

function unavailableWebResearchResult(
  toolName: string,
  capability: string,
  selection: Awaited<ReturnType<typeof selectWebResearchProvider>>
) {
  return {
    ok: false,
    content: `${toolName} is unavailable: ${selection.availability.reason ?? `No available web ${capability} provider configured.`}`,
    metadata: {
      provider: selection.providerName,
      capability,
      reason: selection.availability.reason ?? `No available web ${capability} provider configured.`,
      explicit: selection.explicit,
      fallback: selection.fallback
    }
  };
}

function formatWebExtractProviderResult(
  provider: WebResearchProvider,
  result: import("./web-research-provider.js").WebExtractResult
) {
  return {
    ok: result.status === undefined || (result.status >= 200 && result.status < 400),
    content: [
      `URL: ${result.url}`,
      result.title === undefined ? undefined : `Title: ${result.title}`,
      result.status === undefined ? undefined : `Status: ${result.status}`,
      "",
      result.content
    ].filter((line) => line !== undefined).join("\n"),
    metadata: {
      ...result,
      provider: provider.name,
      _estacoda_context_summary: webExtractContextSummary({
        url: result.url,
        title: result.title,
        contentLength: result.content.length,
        status: result.status,
        source: provider.name
      })
    }
  };
}

function webSearchContextSummary(results: WebSearchResult[]): string {
  const sources = results
    .slice(0, 5)
    .map((result) => {
      const domain = safeHostname(result.url);
      const source = domain === undefined ? result.url : domain;
      return `${truncate(result.title, 80)} (${truncate(source, 80)})`;
    })
    .join("; ");
  return truncateSummary(
    results.length === 0
      ? "Web search returned 0 results."
      : `Web search returned ${results.length} result(s). Top sources: ${sources}.`,
    500
  );
}

function webExtractContextSummary(input: {
  url: string;
  title?: string;
  contentLength: number;
  status?: number;
  source: string;
}): string {
  return truncateSummary([
    `Extracted ${input.contentLength} chars from ${redactUrlForMetadata(input.url)} using ${input.source}.`,
    input.title === undefined ? undefined : `Title: ${truncate(input.title, 120)}.`,
    input.status === undefined ? undefined : `Status: ${input.status}.`
  ].filter((line): line is string => line !== undefined).join(" "), 500);
}

function truncateSummary(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

type BrowserSessionInput = BrowserActionInput | BrowserNavigateInput;
type DeriveBrowserInput = <TInput extends BrowserSessionInput>(input: TInput) => TInput & { sessionId: string };

function createBrowserSnapshotTool(
  browserBackend: BrowserBackend,
  deriveBrowserInput: DeriveBrowserInput,
  options: {
    browserConfig?: Pick<import("../config/runtime-config.js").LoadedRuntimeConfig["browser"], "summarizeSnapshots" | "snapshotSummarizeThreshold">;
    mainRoute?: ResolvedModelRoute;
    snapshotAuxiliaryRoute?: ResolvedAuxiliaryRoute;
    providerExecutor?: Pick<ProviderExecutor, "complete">;
  } = {}
): RegisteredTool {
  return {
    name: "browser.snapshot",
    description: "Get a text snapshot of the current browser page with interactive element refs like @e1.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        full: { type: "boolean" }
      }
    },
    riskClass: "read-only-network",
    toolsets: ["browser", "web", "research"],
    progressLabel: "snapshotting browser",
    maxResultSizeChars: 8000,
    isAvailable: () => browserBackend.isAvailable(),
    run: async (input: BrowserActionInput, context) => {
      const debug = createBrowserDebugSession();
      if (browserBackend.snapshot === undefined) {
        return withDebug(unsupportedBrowserTool(browserBackend, "browser.snapshot"), debug);
      }
      const browserInput = deriveBrowserInput(input);
      const snapshot = await browserBackend.snapshot(browserInput).catch((error: unknown) => ({ error }));
      if ("error" in snapshot) {
        return withDebug({
          ok: false,
          content: snapshot.error instanceof Error ? snapshot.error.message : "Browser snapshot failed.",
          metadata: { backend: browserBackend.kind }
        }, debug);
      }
      const renderedSnapshot = renderBrowserSnapshot(snapshot, { full: browserInput.full === true });
      const summarizeResult = await maybeSummarizeSnapshot({
        renderedSnapshot,
        userTask: browserInput.text,
        signal: context?.signal
      }, {
        mode: options.browserConfig?.summarizeSnapshots ?? "auto",
        threshold: options.browserConfig?.snapshotSummarizeThreshold ?? 8_000,
        maxResultSizeChars: 8_000,
        providerExecutor: options.providerExecutor,
        auxiliaryRoute: options.snapshotAuxiliaryRoute,
        mainRoute: options.mainRoute,
        debug
      });
      return {
        ok: true,
        content: summarizeResult.content,
        metadata: {
          backend: browserBackend.kind,
          snapshot,
          ...(summarizeResult.summarized ? { summarized: true } : {}),
          ...debugMetadata(debug)
        }
      };
    }
  };
}

function createBrowserActionTool(input: {
  name: string;
  description: string;
  progressLabel: string;
  browserBackend: BrowserBackend;
  deriveBrowserInput: DeriveBrowserInput;
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
      const browserInput = input.deriveBrowserInput(toolInput);
      const snapshot = await method(browserInput).catch((error: unknown) => ({ error }));
      if ("error" in snapshot) {
        return {
          ok: false,
          content: snapshot.error instanceof Error ? snapshot.error.message : `${input.name} failed.`,
          metadata: { backend: input.browserBackend.kind }
        };
      }
      return {
        ok: true,
        content: renderBrowserSnapshot(snapshot, { maxChars: 8000 }),
        metadata: { backend: input.browserBackend.kind, snapshot }
      };
    }
  };
}

function withDerivedBrowserSessionId<TInput extends { sessionId?: string }>(
  input: TInput,
  currentSessionId: (() => string) | undefined
): TInput & { sessionId: string } {
  const sessionId = deriveBrowserSessionKey({
    currentSessionId: () => {
      if (currentSessionId === undefined) {
        throw new Error("Browser session key requires a current runtime session ID when no explicit browser sessionId is provided.");
      }
      return currentSessionId();
    }
  }, input.sessionId);
  return {
    ...input,
    sessionId
  };
}

function withDebug<T extends { metadata?: Record<string, unknown> }>(result: T, debug: BrowserDebugSession): T {
  if (!debug.enabled) {
    return result;
  }
  return {
    ...result,
    metadata: withDebugMetadata(result.metadata ?? {}, debug)
  };
}

function withDebugMetadata(metadata: Record<string, unknown>, debug: BrowserDebugSession): Record<string, unknown> {
  return {
    ...metadata,
    ...debugMetadata(debug)
  };
}

function debugMetadata(debug: BrowserDebugSession): Record<string, unknown> {
  if (!debug.enabled) {
    return {};
  }
  const events = debug.flush();
  return events.length === 0 ? {} : { debug: events };
}

function describeValueShape(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (value !== null && typeof value === "object") {
    return { type: "object", keys: Object.keys(value).slice(0, 20) };
  }
  return { type: typeof value };
}

async function saveBrowserScreenshot(workspaceRoot: string | undefined, base64: string): Promise<{ path: string; bytes: number }> {
  const root = workspaceRoot ?? process.cwd();
  const path = join(root, ".estacoda", "browser", "screenshots", `browser-${Date.now()}.png`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(base64, "base64"));
  const file = await stat(path);
  return { path, bytes: file.size };
}

type BrowserSnapshotRenderOptions = {
  full?: boolean;
  maxChars?: number;
};

function renderBrowserSnapshot(snapshot: BrowserSnapshot, options: BrowserSnapshotRenderOptions = {}): string {
  const elements = snapshot.elements ?? [];
  const pendingDialogs = snapshot.pendingDialogs ?? [];
  const frameTree = snapshot.frameTree ?? [];
  const consoleHistory = snapshot.consoleHistory ?? [];
  const content = [
    options.full === true ? "[Full page snapshot]" : "[Compact viewport snapshot]",
    "",
    snapshot.text,
    pendingDialogs.length === 0 ? undefined : "",
    pendingDialogs.length === 0 ? undefined : "Pending dialogs:",
    ...pendingDialogs.slice(0, 5).map((dialog) => {
      const prompt = dialog.defaultPrompt === undefined ? "" : ` default=${dialog.defaultPrompt}`;
      return `${dialog.id} ${dialog.type}: ${dialog.message}${prompt}`.slice(0, 500);
    }),
    frameTree.length === 0 ? undefined : "",
    frameTree.length === 0 ? undefined : "Frames:",
    ...frameTree.slice(0, 10).map((frame) => {
      const parent = frame.parentFrameId === undefined ? "" : ` parent=${frame.parentFrameId}`;
      const oopif = frame.isOopif ? " oopif" : "";
      return `${frame.frameId} ${frame.url} origin=${frame.origin}${parent}${oopif}`.slice(0, 500);
    }),
    consoleHistory.length === 0 ? undefined : "",
    consoleHistory.length === 0 ? undefined : "Console:",
    ...consoleHistory.slice(-10).map((entry) => {
      const timestamp = entry.timestamp === undefined ? "" : ` ${entry.timestamp}`;
      return `[${entry.level}]${timestamp} ${entry.text}`.trim().slice(0, 500);
    }),
    elements.length === 0 ? undefined : "",
    elements.length === 0 ? undefined : "Interactive elements:",
    ...elements.map((element) => renderBrowserSnapshotElement(element))
  ].filter((line) => line !== undefined).join("\n");
  return truncateRenderedBrowserSnapshot(content, options.maxChars);
}

function renderBrowserSnapshotElement(element: NonNullable<BrowserSnapshot["elements"]>[number]): string {
  const details = [
    element.name,
    element.value === undefined ? undefined : `value=${JSON.stringify(element.value)}`,
    element.disabled === undefined ? undefined : `disabled=${element.disabled}`,
    element.checked === undefined ? undefined : `checked=${element.checked}`
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return `${element.ref} ${element.role ?? "element"} ${details.join(" ")}`.trim();
}

function truncateRenderedBrowserSnapshot(content: string, maxChars: number | undefined): string {
  if (maxChars === undefined || content.length <= maxChars) {
    return content;
  }
  return truncateSnapshotText(content, maxChars);
}

const BOT_DETECTION_TITLE_PATTERNS = [
  "access denied",
  "bot detected",
  "captcha",
  "cloudflare",
  "checking your browser",
  "just a moment",
  "attention required"
];

function browserBotDetectionWarning(snapshot: BrowserSnapshot): string | undefined {
  const haystack = [snapshot.title, snapshot.text].filter((value): value is string => typeof value === "string").join("\n").toLowerCase();
  if (BOT_DETECTION_TITLE_PATTERNS.some((pattern) => haystack.includes(pattern))) {
    return "The page may be showing a bot-detection, CAPTCHA, or access-denied interstitial. Navigation succeeded, but browser actions may be limited.";
  }
  return undefined;
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
    if (CDP_READ_ONLY_METHODS.has(method)) {
      return undefined;
    }
    return {
      ok: false,
      content: "Blocked raw CDP method that is not on the read-only allowlist.",
      metadata: {
        ...metadata,
        reason: "cdp-method-not-allowlisted"
      }
    };
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
  debug: BrowserDebugSession;
  signal?: AbortSignal;
}) {
  const timeout = createTimeoutSignal({
    timeoutMs: 30_000,
    parentSignal: input.signal
  });

  try {
    const { response, url, redirectCount } = await fetchWithGuardedRedirects(input.url, {
      fetch: input.fetch,
      guardUrl: input.guardUrl,
      signal: timeout.signal
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
    input.debug.log("web.extract.complete", {
      provider: "fetch",
      url,
      status: response.status,
      redirectCount,
      contentLength: result.content.length
    });

    return withDebug({
      ok: response.ok,
      content: [
        `URL: ${result.url}`,
        result.title === undefined ? undefined : `Title: ${result.title}`,
        `Status: ${response.status} ${response.statusText}`,
        "",
        result.content
      ].filter((line) => line !== undefined).join("\n"),
      metadata: {
        ...result,
        _estacoda_context_summary: webExtractContextSummary({
          url: result.url,
          title: result.title,
          contentLength: result.content.length,
          status: result.status,
          source: "fetch"
        })
      }
    }, input.debug);
  } catch (error) {
    if (isUrlGuardFailure(error)) {
      input.debug.log("web.extract.blocked", {
        provider: "fetch",
        reason: error.metadata.reason,
        url: error.metadata.url
      });
      return withDebug(error, input.debug);
    }
    input.debug.log("web.extract.error", {
      provider: "fetch",
      url: input.url,
      reason: "fetch-failed",
      error: error instanceof Error ? error.message : "web.extract failed."
    });
    return withDebug({
      ok: false,
      content: error instanceof Error ? error.message : "web.extract failed.",
      metadata: {
        url: redactUrlForMetadata(input.url),
        reason: "fetch-failed"
      }
    }, input.debug);
  } finally {
    timeout.cleanup();
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
  redirectCount: number;
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
      return { response, url: currentUrl, redirectCount };
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
