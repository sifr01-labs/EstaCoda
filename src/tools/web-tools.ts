import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import type { SessionToolProvider } from "../contracts/tool.js";
import type {
  BrowserActionInput,
  BrowserActionPreflight,
  BrowserActionPreflightKind,
  BrowserActionDelta,
  BrowserActionDeltaElement,
  BrowserBackend,
  BrowserFindResult,
  BrowserLocatorCandidate,
  BrowserNavigateInput,
  BrowserSnapshot,
  BrowserStateIdentity,
  BrowserTab,
  WebExtractionResult
} from "../contracts/browser.js";
import type { BrowserFieldSecureInputDestination, GroupedSecureInputRequestHandler, SecureInputKind, SecureInputRetention } from "../contracts/secure-input.js";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import { resolveGlobalStateHome } from "../config/profile-home.js";
import { createBrowserDebugSession, type BrowserDebugSession } from "../browser/browser-debug.js";
import { createUnconfiguredBrowserBackend } from "../browser/browser-backend.js";
import { browserSessionStateReason } from "../browser/session-state.js";
import { browserTargetFailureMetadata, isBrowserStateIdentity } from "../browser/browser-locator.js";
import { isActionableBrowserRole } from "../browser/snapshot-state.js";
import { deriveBrowserSessionKey } from "../browser/session-key.js";
import { maybeSummarizeSnapshot, truncateSnapshotText } from "../browser/snapshot-summarizer.js";
import { isAlwaysBlockedUrl, isSafeUrl, redactUrlForMetadata, scanUrlForSecrets, type ResolveHostnameFn } from "../browser/url-safety.js";
import { checkWebsiteAccess, loadWebsiteBlocklist } from "../browser/website-policy.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";
import {
  createGovernedVisionArtifactDispatcher,
  type GovernedVisionArtifactDispatcher
} from "./vision-tools.js";
import { inheritEphemeralVisionImages } from "../vision/ephemeral-vision-content.js";
import { createTimeoutSignal } from "../utils/timeout-signal.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { buildBrowserActionSecuritySummary } from "./tool-target-summary.js";
import {
  registerDefaultWebResearchProviders,
  selectWebResearchProvider,
  type WebResearchProviderSelectionOptions
} from "./web-research-registry.js";
import type {
  WebResearchConfig,
  WebResearchProvider,
  WebResearchPythonCapabilityPathResolver,
  WebResearchPythonCapabilityStatusChecker,
  WebResearchSubprocessSpawn,
  WebSearchResult
} from "./web-research-provider.js";

export type WebToolOptions = {
  fetch?: FetchLike;
  pythonStateRoot?: string;
  pythonCapabilityStatusChecker?: WebResearchPythonCapabilityStatusChecker;
  pythonCapabilityPathResolver?: WebResearchPythonCapabilityPathResolver;
  subprocessSpawn?: WebResearchSubprocessSpawn;
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
  artifactStore?: ArtifactStore;
  visionDispatcher?: GovernedVisionArtifactDispatcher;
};

const BROWSER_TARGET_DISCOVERY_GUIDANCE = "For target discovery, prefer a URL supplied by the user, then existing controlled tabs, then normal permitted web lookup, then one focused clarification. Reading local browser profile data requires explicit authorization and is not an ordinary discovery shortcut.";

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
    createWebSearchTool(options.webConfig, options),
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

        const providerSelection = await selectWebResearchProvider("extract", options.webConfig, webResearchSelectionOptions(options));
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
    createWebCrawlTool(options.webConfig, urlGuard, options),
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
            status.sessionState === undefined ? undefined : `Session state: ${status.sessionState}`,
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
      providerExecutor: options.providerExecutor,
      currentSessionId: options.currentSessionId
    }),
    createBrowserFindTool(browserBackend, deriveBrowserInput),
    createBrowserActionTool({
      name: "browser.click",
      description: "Click by semantic locator, or by a ref with its source canonical identity and tabRef. Ambiguous locators return candidates instead of guessing.",
      progressLabel: "clicking browser element",
      browserBackend,
      deriveBrowserInput,
      method: "click",
      inputSchema: {
        type: "object",
        properties: {
          ...browserTargetInputProperties(),
          sessionId: { type: "string" },
          ...browserWaitInputProperties()
        },
        oneOf: browserTargetOneOf()
      }
    }),
    createBrowserTypeTool(browserBackend, deriveBrowserInput),
    createBrowserProtectedFormTool(browserBackend, deriveBrowserInput),
    createBrowserActionTool({
      name: "browser.select",
      description: "Select an option by value or visible option text using a semantic locator, or a ref with its source canonical identity and tabRef.",
      progressLabel: "selecting browser option",
      browserBackend,
      deriveBrowserInput,
      method: "select",
      inputSchema: {
        type: "object",
        properties: {
          ...browserTargetInputProperties(),
          value: { type: "string" },
          sessionId: { type: "string" },
          ...browserWaitInputProperties()
        },
        required: ["value"],
        oneOf: browserTargetOneOf()
      }
    }),
    createBrowserExtractTool(browserBackend, deriveBrowserInput),
    createBrowserActionTool({
      name: "browser.scroll",
      description: "Scroll the current browser page, wait for a requested or stable state, and return a concise delta.",
      progressLabel: "scrolling browser",
      browserBackend,
      deriveBrowserInput,
      method: "scroll",
      inputSchema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down"] },
          amount: { type: "number" },
          sessionId: { type: "string" },
          ...browserWaitInputProperties()
        }
      }
    }),
    createBrowserActionTool({
      name: "browser.press",
      description: "Press a keyboard key, wait for a requested or stable state, and return a concise delta.",
      progressLabel: "pressing browser key",
      browserBackend,
      deriveBrowserInput,
      method: "press",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string" },
          sessionId: { type: "string" },
          ...browserWaitInputProperties()
        }
      }
    }),
    createBrowserActionTool({
      name: "browser.back",
      description: "Navigate back, wait for a requested or stable state, and return a concise delta.",
      progressLabel: "going back in browser",
      browserBackend,
      deriveBrowserInput,
      method: "back",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          ...browserWaitInputProperties()
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
            metadata: browserFailureMetadata(browserBackend, images.error)
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
            metadata: browserFailureMetadata(browserBackend, entries.error)
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
      name: "browser.tabs",
      description: "List safe page tabs only when the authoritative browser-state projection is missing or stale. The controlled tab is the one EstaCoda will inspect and operate. Use browser.switch_tab rather than polling an unchanged list.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" }
        }
      },
      riskClass: "read-only-network",
      toolsets: ["browser", "web", "research"],
      progressLabel: "listing browser tabs",
      maxResultSizeChars: 5000,
      isAvailable: async () => browserBackend.tabs !== undefined && await browserBackend.isAvailable(),
      run: async (input: BrowserActionInput) => {
        if (browserBackend.tabs === undefined) {
          return unsupportedBrowserTool(browserBackend, "browser.tabs");
        }
        const browserInput = deriveBrowserInput(input);
        const result = await browserBackend.tabs(browserInput).catch((error: unknown) => ({ error }));
        if ("error" in result) {
          return {
            ok: false,
            content: result.error instanceof Error ? result.error.message : "Browser tab listing failed.",
            metadata: browserFailureMetadata(browserBackend, result.error)
          };
        }
        return {
          ok: true,
          content: [
            result.tabs.length === 0 ? "No safe page tabs are available." : result.tabs.map(renderBrowserTab).join("\n"),
            result.blockedCount === 0 ? undefined : `${result.blockedCount} tab(s) hidden by browser URL policy.`
          ].filter((line) => line !== undefined).join("\n"),
          metadata: { backend: browserBackend.kind, ...result }
        };
      }
    },
    {
      name: "browser.switch_tab",
      description: "Switch EstaCoda's controlled browser page to a safe tab ref returned by browser.tabs and focus it in the visible browser.",
      inputSchema: {
        type: "object",
        properties: {
          tabRef: { type: "string" },
          sessionId: { type: "string" },
          ...browserWaitInputProperties()
        },
        required: ["tabRef"]
      },
      riskClass: "read-only-network",
      toolsets: ["browser", "web", "research"],
      progressLabel: "switching browser tab",
      maxResultSizeChars: 8000,
      isAvailable: async () => browserBackend.switchTab !== undefined && await browserBackend.isAvailable(),
      run: async (input: BrowserActionInput & { tabRef?: string }) => {
        if (browserBackend.switchTab === undefined) {
          return unsupportedBrowserTool(browserBackend, "browser.switch_tab");
        }
        const browserInput = deriveBrowserInput(input);
        const result = await browserBackend.switchTab({
          sessionId: browserInput.sessionId,
          tabRef: input.tabRef ?? "",
          waitFor: browserInput.waitFor,
          waitTimeoutMs: browserInput.waitTimeoutMs,
          signal: browserInput.signal
        }).catch((error: unknown) => ({ error }));
        if ("error" in result) {
          return {
            ok: false,
            content: result.error instanceof Error ? result.error.message : "Browser tab switch failed.",
            metadata: browserFailureMetadata(browserBackend, result.error)
          };
        }
        return {
          ok: true,
          content: [
            `Controlled tab: ${renderBrowserTab(result.tab)}`,
            "",
            renderBrowserActionResult(result.snapshot, 7500)
          ].join("\n"),
          metadata: { backend: browserBackend.kind, tab: result.tab, snapshot: result.snapshot }
        };
      }
    },
    {
      name: "browser.cdp",
      description: "Run a raw Chrome DevTools Protocol method against the active local-CDP browser session. Use browser.tabs and browser.switch_tab for ordinary tab discovery and switching.",
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
            metadata: browserFailureMetadata(browserBackend, result.error)
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
      run: async (input: BrowserActionInput, context) => {
        if (browserBackend.screenshot === undefined) {
          return unsupportedBrowserTool(browserBackend, "browser.screenshot");
        }
        const browserInput = deriveBrowserInput(input);
        const screenshot = await browserBackend.screenshot(browserInput).catch((error: unknown) => ({ error }));
        if ("error" in screenshot) {
          return {
            ok: false,
            content: screenshot.error instanceof Error ? screenshot.error.message : "Browser screenshot failed.",
            metadata: browserFailureMetadata(browserBackend, screenshot.error)
          };
        }
        const saved = await saveBrowserScreenshot(
          options.workspaceRoot,
          screenshot.base64,
          options.artifactStore,
          context?.visibleTurnId
        );
        return {
          ok: true,
          content: [
            `Screenshot: ${saved.path}`,
            `MIME: ${screenshot.mimeType}`,
            `Bytes: ${saved.bytes}`
          ].join("\n"),
          metadata: {
            backend: browserBackend.kind,
            path: saved.path,
            mimeType: screenshot.mimeType,
            bytes: saved.bytes
          }
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
      isAvailable: async () => await browserBackend.isAvailable() &&
        options.visionDispatcher?.isAvailable({ mode: "screenshot" }) === true,
      resolveSecurity: (input: BrowserActionInput & { prompt?: string }, context) =>
        options.visionDispatcher?.resolveSecurity({
          prompt: input.prompt,
          mode: "screenshot"
        }, context, "browser-artifact"),
      run: async (input: BrowserActionInput & { prompt?: string }, context) => {
        if (browserBackend.screenshot === undefined) {
          return unsupportedBrowserTool(browserBackend, "browser.vision");
        }
        if (options.visionDispatcher === undefined) {
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
            metadata: browserFailureMetadata(browserBackend, screenshot.error)
          };
        }
        const saved = await saveBrowserScreenshot(
          options.workspaceRoot,
          screenshot.base64,
          options.artifactStore,
          context?.visibleTurnId
        );
        const analysis = await options.visionDispatcher.dispatch({
          path: saved.path,
          prompt: input.prompt,
          mode: "screenshot"
        }, context);
        return inheritEphemeralVisionImages({
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
        }, analysis);
      }
    },
    createBrowserActionTool({
      name: "browser.dialog",
      description: "Accept or dismiss a native JavaScript dialog, wait for a requested or stable state, and return a concise delta.",
      progressLabel: "responding to browser dialog",
      browserBackend,
      deriveBrowserInput,
      method: "dialog",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          action: { type: "string", enum: ["accept", "dismiss"] },
          promptText: { type: "string" },
          ...browserWaitInputProperties()
        }
      }
    }),
    {
      name: "browser.navigate",
      description: `Navigate a browser backend to a URL, wait for the requested or stable state, and return a concise action delta. ${BROWSER_TARGET_DISCOVERY_GUIDANCE}`,
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          text: { type: "string" },
          sessionId: { type: "string" },
          ...browserWaitInputProperties()
        }
      },
      riskClass: "read-only-network",
      toolsets: ["browser", "web", "research"],
      progressLabel: "navigating browser",
      maxResultSizeChars: 4000,
      isAvailable: () => browserBackend.isAvailable(),
      run: async (input: Omit<BrowserNavigateInput, "url"> & { url?: string; text?: string }, context) => {
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

        const browserInput = deriveBrowserInput({
          url,
          sessionId: input.sessionId,
          waitFor: input.waitFor,
          waitTimeoutMs: input.waitTimeoutMs,
          signal: context?.signal
        });
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
              ...browserFailureMetadata(browserBackend, result.error, "navigation-failed")
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
            browserSessionRecoveryWarning(result.metadata),
            botDetectionWarning === undefined ? undefined : `Warning: ${botDetectionWarning}`,
            "",
            renderBrowserActionResult(result.snapshot, 4000)
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
    const channelMediaRoot = requireProviderDependency("web", "channelMediaRoot", ctx.channelMediaRoot);
    const imageCacheRoot = ctx.imageCacheRoot;
    const visionDispatcher = createGovernedVisionArtifactDispatcher({
      workspaceRoot: ctx.workspaceRoot,
      profileId: ctx.profileId,
      allowedRoots: [channelMediaRoot, ...(imageCacheRoot === undefined ? [] : [imageCacheRoot])],
      imageCacheRoot,
      visionAuxiliaryRoute: ctx.visionRoute,
      mainRoute: ctx.mainRoute,
      mainFallbackRoutes: ctx.mainFallbackRoutes,
      providerExecutor: ctx.providerExecutor,
      artifactStore: ctx.artifactStore,
      currentSessionId: () => ctx.currentSessionId()
    });
    return createWebTools({
      fetch: ctx.webFetch,
      browserBackend: requireProviderDependency("web", "browserBackend", ctx.browserBackend),
      enableNetwork: ctx.enableWebNetwork,
      maxContentChars: ctx.webMaxContentChars,
      webConfig: ctx.webConfig,
      pythonStateRoot: resolveGlobalStateHome({ homeDir: ctx.homeDir }).stateRoot,
      browserConfig: ctx.browserConfig,
      workspaceRoot: ctx.workspaceRoot,
      currentSessionId: () => ctx.currentSessionId(),
      mainRoute: ctx.mainRoute,
      snapshotAuxiliaryRoute: ctx.compressionRoute,
      providerExecutor: ctx.providerExecutor,
      artifactStore: ctx.artifactStore,
      securityConfig: ctx.securityConfig,
      visionDispatcher
    });
  }
};

function requireProviderDependency<T>(provider: string, dependency: string, value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError(`${provider}ToolProvider requires ${dependency}.`);
  }
  return value;
}

function webResearchSelectionOptions(options: WebToolOptions): WebResearchProviderSelectionOptions {
  return {
    fetch: options.fetch,
    pythonStateRoot: options.pythonStateRoot,
    pythonCapabilityStatusChecker: options.pythonCapabilityStatusChecker,
    pythonCapabilityPathResolver: options.pythonCapabilityPathResolver,
    subprocessSpawn: options.subprocessSpawn
  };
}

function createWebSearchTool(webConfig: WebResearchConfig | undefined, options: WebToolOptions): RegisteredTool {
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
    isAvailable: async () => (await selectWebResearchProvider("search", webConfig, webResearchSelectionOptions(options))).availability.available,
    run: async (input: { query?: string; maxResults?: number }, context) => {
      const query = input.query?.trim();
      if (query === undefined || query.length === 0) {
        return {
          ok: false,
          content: "No query found for web.search.",
          metadata: { reason: "missing-query" }
        };
      }

      const providerSelection = await selectWebResearchProvider("search", webConfig, webResearchSelectionOptions(options));
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

function createWebCrawlTool(webConfig: WebResearchConfig | undefined, guardUrl: UrlGuard, options: WebToolOptions): RegisteredTool {
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
    isAvailable: async () => (await selectWebResearchProvider("crawl", webConfig, webResearchSelectionOptions(options))).availability.available,
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

      const providerSelection = await selectWebResearchProvider("crawl", webConfig, webResearchSelectionOptions(options));
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

function browserFailureMetadata(
  backend: BrowserBackend,
  error: unknown,
  fallbackReason?: string
): Record<string, unknown> {
  const targetFailure = browserTargetFailureMetadata(error);
  const reason = browserSessionStateReason(error) ?? fallbackReason;
  return {
    backend: backend.kind,
    ...(reason === undefined ? {} : { reason }),
    ...(targetFailure ?? {})
  };
}

function browserSessionRecoveryWarning(metadata: Record<string, unknown> | undefined): string | undefined {
  const recovery = metadata?.sessionRecovery;
  if (
    typeof recovery !== "object" ||
    recovery === null ||
    !("authenticationPreserved" in recovery) ||
    recovery.authenticationPreserved !== false
  ) {
    return undefined;
  }
  return "Warning: a new browser session was created after the previous session was lost. Authentication was not preserved; sign-in may be required again.";
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
    currentSessionId?: () => string;
  } = {}
): RegisteredTool {
  return {
    name: "browser.snapshot",
    description: "Get a text snapshot of the current browser page with interactive element refs like @e1. Act on the result instead of polling an unchanged page.",
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
          metadata: browserFailureMetadata(browserBackend, snapshot.error)
        }, debug);
      }
      const renderedSnapshot = renderBrowserSnapshot(snapshot, { full: browserInput.full === true });
      const summarizeResult = await maybeSummarizeSnapshot({
        renderedSnapshot,
        userTask: browserInput.text,
        signal: context?.signal,
        executionSessionId: options.currentSessionId?.(),
        visibleTurnId: context?.visibleTurnId
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
  method: "click" | "type" | "select" | "scroll" | "press" | "back" | "dialog";
  inputSchema: RegisteredTool["inputSchema"];
}): RegisteredTool {
  const securityAction = browserSecurityAction(input.method);
  return {
    name: input.name,
    description: input.description,
    inputSchema: input.inputSchema,
    riskClass: "read-only-network",
    toolsets: ["browser", "web", "research"],
    progressLabel: input.progressLabel,
    maxResultSizeChars: 8000,
    isAvailable: () => input.browserBackend.isAvailable(),
    ...(securityAction === undefined ? {} : {
      resolveSecurity: async (toolInput: BrowserActionInput) => (
        await resolveBrowserActionSecurity(securityAction, toolInput, input.browserBackend, input.deriveBrowserInput)
      ).resolution
    }),
    run: async (toolInput: BrowserActionInput, context) => {
      const method = input.browserBackend[input.method];
      if (method === undefined) {
        return unsupportedBrowserTool(input.browserBackend, input.name);
      }
      if (securityAction !== undefined && context?.securityResolution !== undefined) {
        const verified = await resolveBrowserActionSecurity(
          securityAction,
          toolInput,
          input.browserBackend,
          input.deriveBrowserInput
        );
        if (!verified.executable || verified.resolution.targetKey !== context.securityResolution.targetKey ||
            verified.resolution.riskClass !== context.securityResolution.riskClass) {
          return {
            ok: false,
            content: "Browser action target changed or could not be re-verified after security review. Take a fresh snapshot and retry.",
            metadata: { reason: "browser-action-security-preflight-mismatch" }
          };
        }
      }
      const browserInput = input.deriveBrowserInput(toolInput);
      const snapshot = await method(browserInput).catch((error: unknown) => ({ error }));
      if ("error" in snapshot) {
        return {
          ok: false,
          content: snapshot.error instanceof Error ? snapshot.error.message : `${input.name} failed.`,
          metadata: browserFailureMetadata(input.browserBackend, snapshot.error)
        };
      }
      return {
        ok: true,
        content: renderBrowserActionResult(snapshot, 8000),
        metadata: { backend: input.browserBackend.kind, snapshot }
      };
    }
  };
}

function browserSecurityAction(value: string): BrowserActionPreflightKind | undefined {
  return value === "click" || value === "press" || value === "dialog" ? value : undefined;
}

type BrowserActionSecurityResult = {
  resolution: {
    riskClass: "read-only-network" | "external-side-effect";
    targetKey: string;
    targetSummary: string;
  };
  executable: boolean;
};

const SAFE_BROWSER_KEYS = new Set([
  "arrowdown", "arrowleft", "arrowright", "arrowup", "end", "escape", "home",
  "pagedown", "pageup", "tab"
]);
const BROWSER_ACTION_PREFLIGHT_ATTEMPTS = 2;

async function resolveBrowserActionSecurity(
  action: BrowserActionPreflightKind,
  toolInput: BrowserActionInput,
  browserBackend: BrowserBackend,
  deriveBrowserInput: DeriveBrowserInput
): Promise<BrowserActionSecurityResult> {
  const browserInput = deriveBrowserInput(toolInput);
  const key = action === "press" ? normalizedBrowserKey(toolInput.key) : action === "dialog" ? toolInput.action : undefined;
  if ((action === "press" && key !== undefined && SAFE_BROWSER_KEYS.has(key)) ||
      (action === "dialog" && key === "dismiss")) {
    return browserActionSecurityResult(action, browserInput, key, undefined, "read-only-network", true);
  }

  if (browserBackend.preflightAction === undefined) {
    return browserActionSecurityResult(action, browserInput, key, undefined, "external-side-effect", false);
  }

  const preflight = await resolveBrowserActionPreflight(action, browserInput, browserBackend);
  if (preflight === undefined) {
    return browserActionSecurityResult(action, browserInput, key, undefined, "external-side-effect", false);
  }
  const safeLink = action === "click" && preflight.target?.kind === "link" &&
    preflight.target.tag === "a" && preflight.target.submit === false && isHttpUrl(preflight.target.href);
  const targetBound = preflight.action === action && preflight.target?.ref !== undefined;
  return browserActionSecurityResult(
    action,
    browserInput,
    key,
    preflight,
    safeLink ? "read-only-network" : "external-side-effect",
    targetBound
  );
}

async function resolveBrowserActionPreflight(
  action: BrowserActionPreflightKind,
  browserInput: BrowserActionInput,
  browserBackend: BrowserBackend
): Promise<BrowserActionPreflight | undefined> {
  for (let attempt = 0; attempt < BROWSER_ACTION_PREFLIGHT_ATTEMPTS; attempt += 1) {
    try {
      return await browserBackend.preflightAction!(action, browserInput);
    } catch {
      // A live page may replace an otherwise unchanged target while its DOM settles.
      // Retry the read-only inspection once; execution still requires a separate,
      // matching preflight below and therefore remains fail-closed.
    }
  }
  return undefined;
}

function browserActionSecurityResult(
  action: BrowserActionPreflightKind,
  browserInput: BrowserActionInput,
  key: string | undefined,
  preflight: BrowserActionPreflight | undefined,
  riskClass: "read-only-network" | "external-side-effect",
  executable: boolean
): BrowserActionSecurityResult {
  const targetKeyMaterial = preflight === undefined
    ? {
        action,
        sessionId: browserInput.sessionId,
        ref: browserInput.ref,
        tabRef: browserInput.tabRef,
        identity: browserInput.identity,
        key,
        unresolved: true
      }
    : {
        action,
        sessionId: preflight.sessionId,
        tabRef: preflight.tabRef,
        documentEpoch: preflight.identity.documentEpoch,
        actionRevision: preflight.identity.actionRevision,
        ref: preflight.target?.ref,
        kind: preflight.target?.kind,
        tag: preflight.target?.tag,
        role: preflight.target?.role,
        href: preflight.target?.href,
        formAssociated: preflight.target?.formAssociated,
        submit: preflight.target?.submit,
        key
      };
  return {
    resolution: {
      riskClass,
      targetKey: `browser-action:${createHash("sha256").update(JSON.stringify(targetKeyMaterial)).digest("hex")}`,
      targetSummary: buildBrowserActionSecuritySummary({ action, key, preflight })
    },
    executable
  };
}

function normalizedBrowserKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  return normalized.length === 0 ? undefined : normalized.slice(0, 32);
}

function isHttpUrl(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

type BrowserProtectedInputDescriptor = {
  kind?: SecureInputKind;
  purpose?: string;
  retention?: SecureInputRetention;
};

const BROWSER_PROTECTED_INPUT_KINDS = [
  "account-identifier",
  "password",
  "one-time-code",
  "api-key",
  "client-secret",
  "access-token",
  "private-key",
  "recovery-code",
  "generic-secret",
] as const satisfies readonly SecureInputKind[];

function createBrowserTypeTool(
  browserBackend: BrowserBackend,
  deriveBrowserInput: DeriveBrowserInput
): RegisteredTool {
  return {
    name: "browser.type",
    description: "Type ordinary text or request one protected value for a verified field. For a one-time-code challenge, include submitRef from the same snapshot to bind, enter, and immediately submit the code without another model turn. If the current form has multiple related protected fields, use one browser.fill_protected_form call instead. Protected values bypass model context and browser snapshots.",
    inputSchema: {
      type: "object",
      properties: {
        ...browserTargetInputProperties(),
        text: { type: "string" },
        protectedInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: BROWSER_PROTECTED_INPUT_KINDS },
            purpose: { type: "string" },
            retention: { type: "string", enum: ["use-once"] },
          },
          required: ["kind", "purpose"],
        },
        submitRef: {
          type: "string",
          description: "Optional same-state submit control for one-time-code protected input. Providing the code will immediately submit this control locally.",
        },
        sessionId: { type: "string" },
        ...browserWaitInputProperties(),
      },
      oneOf: browserTargetOneOf().flatMap((target) => [
        { required: [...target.required, "text"] },
        { required: [...target.required, "protectedInput"] },
      ]),
    },
    riskClass: "read-only-network",
    resolveSecurity: (input: BrowserActionInput, context) =>
      resolveProtectedBrowserSubmitSecurity(input, context.sessionId, deriveBrowserInput),
    toolsets: ["browser", "web", "research"],
    progressLabel: "typing in browser",
    maxResultSizeChars: 8_000,
    isAvailable: () => browserBackend.isAvailable(),
    run: async (toolInput: BrowserActionInput & { protectedInput?: BrowserProtectedInputDescriptor }, context) => {
      const browserInput = deriveBrowserInput(toolInput);
      if (toolInput.protectedInput === undefined) {
        if (toolInput.submitRef !== undefined) {
          return protectedBrowserFailure("submitRef is available only with one-time-code protected browser input.");
        }
        if (typeof toolInput.text !== "string" || browserBackend.type === undefined) {
          return unsupportedBrowserTool(browserBackend, "browser.type");
        }
        const snapshot = await browserBackend.type(browserInput).catch((error: unknown) => ({ error }));
        if ("error" in snapshot) {
          return {
            ok: false,
            content: snapshot.error instanceof Error ? snapshot.error.message : "browser.type failed.",
            metadata: browserFailureMetadata(browserBackend, snapshot.error),
          };
        }
        return {
          ok: true,
          content: renderBrowserActionResult(snapshot, 8_000),
          metadata: { backend: browserBackend.kind, snapshot },
        };
      }

      const descriptor = parseBrowserProtectedInput(toolInput.protectedInput);
      if (descriptor === undefined) {
        return protectedBrowserFailure("Protected browser input requires a supported kind, purpose, and use-once retention.");
      }
      if (toolInput.submitRef !== undefined && descriptor.kind !== "one-time-code") {
        return protectedBrowserFailure("Atomic protected submission is limited to one-time-code challenges.");
      }
      if (context?.onSecureInputRequest === undefined || browserBackend.prepareProtectedField === undefined) {
        return protectedBrowserFailure("Protected browser input is unavailable on this runtime.");
      }
      const destination = await browserBackend.prepareProtectedField(browserInput).catch(() => undefined);
      if (destination === undefined) {
        return protectedBrowserFailure("The protected browser field could not be resolved to a current verified destination.");
      }
      const receipt = await context.onSecureInputRequest({
        kind: descriptor.kind,
        purpose: descriptor.purpose,
        destination,
        retention: descriptor.retention,
      }, async () => undefined).catch(() => undefined);
      if (receipt === undefined) {
        return protectedBrowserFailure("Protected browser input delivery failed.");
      }
      const deliveryResult = receipt.status === "delivered"
        ? browserBackend.takeProtectedFieldDeliveryResult?.(destination)
        : undefined;
      if (toolInput.submitRef !== undefined && deliveryResult === undefined) {
        return protectedBrowserFailure("Protected input was delivered, but its browser submission result was unavailable.");
      }
      const submissionFailed = deliveryResult?.submission === "failed" || deliveryResult?.challengeState === "still-present";
      return {
        ok: receipt.status === "delivered" && !submissionFailed,
        content: receipt.status === "delivered"
          ? deliveryResult === undefined
            ? `Protected input delivered to ${receipt.destinationLabel}.`
            : renderProtectedDeliveryResult(deliveryResult)
          : `Protected input ${receipt.status}: ${receipt.reason ?? "delivery did not complete."}`,
        metadata: {
          backend: browserBackend.kind,
          secureInputReceipt: receipt,
          ...(deliveryResult === undefined ? {} : {
            protectedDelivery: {
              delivery: deliveryResult.delivery,
              submission: deliveryResult.submission,
              documentChanged: deliveryResult.documentChanged,
              challengeState: deliveryResult.challengeState,
              conditionMet: deliveryResult.conditionMet,
              beforeIdentity: deliveryResult.beforeIdentity,
              afterIdentity: deliveryResult.afterIdentity,
              sensitiveInputActive: deliveryResult.sensitiveInputActive,
            },
            snapshot: deliveryResult.snapshot,
          }),
        },
      };
    },
  };
}

function renderProtectedDeliveryResult(
  result: import("../contracts/browser.js").BrowserProtectedFieldDeliveryResult
): string {
  if (result.sensitiveInputActive) {
    return [
      "Protected authentication transaction active.",
      "Page content is intentionally suppressed.",
      "State: settling.",
    ].join("\n");
  }
  if (result.submission === "not-requested") {
    return `Protected input delivered. Current browser identity: ${renderBrowserIdentity(result.afterIdentity)}.`;
  }
  const submission = result.submission === "automatic"
    ? "The page submitted the challenge automatically."
    : result.submission === "clicked"
      ? "The bound submit control was clicked immediately."
      : "The bound submit control could not be activated.";
  const challenge = result.challengeState === "departed"
    ? "The original challenge is no longer present; authentication itself still requires post-submit verification."
    : result.challengeState === "still-present"
      ? "The original challenge is still present, so the authentication attempt did not complete."
      : "The resulting challenge state is unknown; do not claim authentication is complete without fresh evidence.";
  return [
    "Protected input delivered without exposing its value.",
    submission,
    challenge,
    `Identity: ${renderBrowserIdentity(result.beforeIdentity)} → ${renderBrowserIdentity(result.afterIdentity)}.`,
  ].join("\n");
}

type BrowserProtectedFormField = {
  id?: string;
  ref?: string;
  kind?: SecureInputKind;
  purpose?: string;
};

type BrowserProtectedFormInput = {
  purpose?: string;
  fields?: BrowserProtectedFormField[];
  sessionId?: string;
  identity?: BrowserStateIdentity;
  tabRef?: string;
  submitRef?: string;
};

function createBrowserProtectedFormTool(
  browserBackend: BrowserBackend,
  deriveBrowserInput: DeriveBrowserInput
): RegisteredTool {
  return {
    name: "browser.fill_protected_form",
    description: "Request and fill every currently visible protected field in one verified form flow (for example account identifier plus password). Use this once for all related fields instead of separate browser.type calls. Values bypass model context. When submitRef is provided, supplying the values also submits that prebound authentication control locally without another model turn.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        purpose: { type: "string", description: "Overall operator-visible purpose, such as Sign in to MTN." },
        sessionId: { type: "string" },
        identity: browserStateIdentitySchema("Canonical snapshot identity that produced every field ref."),
        tabRef: { type: "string", description: "Controlled tab that produced every field ref." },
        submitRef: {
          type: "string",
          description: "Optional same-state authentication control. Supplying every protected value will immediately submit this prebound control locally.",
        },
        fields: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", description: "Unique safe label for this field, such as email or password." },
              ref: { type: "string", description: "Element ref from the same current snapshot." },
              kind: { type: "string", enum: BROWSER_PROTECTED_INPUT_KINDS },
              purpose: { type: "string", description: "Optional field-specific operator description." },
            },
            required: ["id", "ref", "kind"],
          },
        },
      },
      required: ["purpose", "identity", "tabRef", "fields"],
    },
    riskClass: "read-only-network",
    resolveSecurity: (input: BrowserProtectedFormInput, context) =>
      resolveProtectedBrowserSubmitSecurity(input, context.sessionId, deriveBrowserInput),
    toolsets: ["browser", "web", "research"],
    progressLabel: "filling protected browser form",
    maxResultSizeChars: 8_000,
    isAvailable: () => browserBackend.isAvailable(),
    run: async (input: BrowserProtectedFormInput, context) => {
      const parsed = parseBrowserProtectedForm(input);
      if (parsed === undefined) {
        return protectedBrowserFailure("Protected form input requires one to eight unique current refs with supported kinds and a bounded purpose.");
      }
      const requestGroup = (context?.onSecureInputRequest as Partial<GroupedSecureInputRequestHandler> | undefined)?.requestGroup;
      if (requestGroup === undefined || browserBackend.prepareProtectedField === undefined) {
        return protectedBrowserFailure("Grouped protected browser input is unavailable on this runtime.");
      }

      const destinations: BrowserFieldSecureInputDestination[] = [];
      for (const field of parsed.fields) {
        const destination = await browserBackend.prepareProtectedField(deriveBrowserInput({
          sessionId: input.sessionId,
          identity: parsed.identity,
          tabRef: parsed.tabRef,
          ref: field.ref,
          ...(parsed.submitRef === undefined ? {} : { submitRef: parsed.submitRef }),
        })).catch(() => undefined);
        if (destination === undefined) {
          return protectedBrowserFailure("A protected browser field could not be resolved to a current verified destination.");
        }
        destinations.push(destination);
      }
      const first = destinations[0]!;
      if (destinations.some((destination) =>
        destination.sessionId !== first.sessionId ||
        destination.tabRef !== first.tabRef ||
        destination.frameId !== first.frameId ||
        destination.expectedOrigin !== first.expectedOrigin
      )) {
        return protectedBrowserFailure("Every protected form field must belong to the same current origin, tab, and frame.");
      }

      const receipt = await requestGroup({
        purpose: parsed.purpose,
        items: parsed.fields.map((field, index) => ({
          id: field.id,
          request: {
            kind: field.kind,
            purpose: field.purpose ?? `${parsed.purpose}: ${field.id}`,
            destination: destinations[index]!,
            retention: "use-once",
          },
          consume: async () => undefined,
        })),
      }).catch(() => undefined);
      if (receipt === undefined) {
        return protectedBrowserFailure("Protected browser form delivery failed.");
      }
      const deliveryResult = receipt.status === "delivered" && parsed.submitRef !== undefined
        ? browserBackend.takeProtectedFieldDeliveryResult?.(destinations.at(-1)!)
        : undefined;
      if (receipt.status === "delivered" && parsed.submitRef !== undefined && deliveryResult === undefined) {
        return protectedBrowserFailure("Protected form values were delivered, but the bound browser submission result was unavailable.");
      }
      const submissionFailed = deliveryResult?.submission === "failed" || deliveryResult?.challengeState === "still-present";
      return {
        ok: receipt.status === "delivered" && !submissionFailed,
        content: receipt.status === "delivered"
          ? deliveryResult === undefined
            ? `Protected form fields delivered (${receipt.items.length}). The form was not submitted.`
            : [`Protected form fields delivered (${receipt.items.length}).`, renderProtectedDeliveryResult(deliveryResult)].join("\n")
          : `Protected form input ${receipt.status}: ${receipt.reason ?? "delivery did not complete."}`,
        metadata: {
          backend: browserBackend.kind,
          secureInputGroupReceipt: receipt,
          ...(deliveryResult === undefined ? {} : {
            protectedDelivery: {
              delivery: deliveryResult.delivery,
              submission: deliveryResult.submission,
              documentChanged: deliveryResult.documentChanged,
              challengeState: deliveryResult.challengeState,
              conditionMet: deliveryResult.conditionMet,
              beforeIdentity: deliveryResult.beforeIdentity,
              afterIdentity: deliveryResult.afterIdentity,
              sensitiveInputActive: deliveryResult.sensitiveInputActive,
            },
            snapshot: deliveryResult.snapshot,
          }),
        },
      };
    },
  };
}

function parseBrowserProtectedForm(input: BrowserProtectedFormInput): {
  purpose: string;
  identity: BrowserStateIdentity;
  tabRef: string;
  submitRef?: string;
  fields: Array<{ id: string; ref: string; kind: SecureInputKind; purpose?: string }>;
} | undefined {
  if (!hasOnlyKeys(input, ["purpose", "fields", "sessionId", "identity", "tabRef", "submitRef"])) return undefined;
  if (typeof input.purpose !== "string" || input.purpose.trim().length === 0 || input.purpose.length > 500) return undefined;
  if (!isBrowserStateIdentity(input.identity)) return undefined;
  if (typeof input.tabRef !== "string" || input.tabRef.length === 0 || input.tabRef.length > 256) return undefined;
  if (input.submitRef !== undefined && (typeof input.submitRef !== "string" || !/^@e[1-9]\d*$/u.test(input.submitRef))) return undefined;
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > 8) return undefined;
  const ids = new Set<string>();
  const refs = new Set<string>();
  const kinds = new Set<SecureInputKind>(BROWSER_PROTECTED_INPUT_KINDS);
  const fields = [];
  for (const field of input.fields) {
    if (!hasOnlyKeys(field, ["id", "ref", "kind", "purpose"])) return undefined;
    if (typeof field.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(field.id) || ids.has(field.id)) return undefined;
    if (typeof field.ref !== "string" || !/^@e[1-9]\d*$/u.test(field.ref) || refs.has(field.ref)) return undefined;
    if (field.kind === undefined || !kinds.has(field.kind)) return undefined;
    if (field.purpose !== undefined && (typeof field.purpose !== "string" || field.purpose.trim().length === 0 || field.purpose.length > 500)) return undefined;
    ids.add(field.id);
    refs.add(field.ref);
    fields.push({
      id: field.id,
      ref: field.ref,
      kind: field.kind,
      ...(field.purpose === undefined ? {} : { purpose: field.purpose.trim() }),
    });
  }
  if (input.submitRef !== undefined && refs.has(input.submitRef)) return undefined;
  return {
    purpose: input.purpose.trim(),
    identity: { ...input.identity },
    tabRef: input.tabRef,
    ...(input.submitRef === undefined ? {} : { submitRef: input.submitRef }),
    fields,
  };
}

function resolveProtectedBrowserSubmitSecurity(
  input: { sessionId?: string; tabRef?: string; submitRef?: string },
  runtimeSessionId: string,
  deriveBrowserInput: DeriveBrowserInput
): import("../contracts/tool.js").ToolSecurityResolution | undefined {
  if (typeof input.submitRef !== "string" || input.submitRef.length === 0) return undefined;
  const sessionId = (() => {
    try {
      return deriveBrowserInput(input).sessionId;
    } catch {
      return runtimeSessionId;
    }
  })();
  const identity = [sessionId, typeof input.tabRef === "string" ? input.tabRef : "", input.submitRef].join("\u0000");
  return {
    riskClass: "external-side-effect",
    targetKey: `browser-protected-submit:${createHash("sha256").update(identity).digest("hex")}`,
    targetSummary: "Submit a verified protected browser authentication control",
  };
}

function parseBrowserProtectedInput(
  value: BrowserProtectedInputDescriptor
): { kind: SecureInputKind; purpose: string; retention: "use-once" } | undefined {
  if (!hasOnlyKeys(value, ["kind", "purpose", "retention"])) return undefined;
  const kinds = new Set<SecureInputKind>(BROWSER_PROTECTED_INPUT_KINDS);
  if (value.kind === undefined || !kinds.has(value.kind)) return undefined;
  if (typeof value.purpose !== "string" || value.purpose.trim().length === 0 || value.purpose.length > 500) return undefined;
  if (value.retention !== undefined && value.retention !== "use-once") return undefined;
  return { kind: value.kind, purpose: value.purpose.trim(), retention: "use-once" };
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function protectedBrowserFailure(content: string): ToolResult {
  return {
    ok: false,
    content,
    metadata: { reason: "protected-browser-input-unavailable" },
  };
}

function createBrowserFindTool(
  browserBackend: BrowserBackend,
  deriveBrowserInput: DeriveBrowserInput
): RegisteredTool {
  return {
    name: "browser.find",
    description: "Find current visible, enabled browser elements by semantic role, name, text, label, or surrounding text. Returns candidates without guessing when ambiguous.",
    inputSchema: {
      type: "object",
      properties: {
        locator: browserLocatorSchema(),
        sessionId: { type: "string" }
      },
      required: ["locator"]
    },
    riskClass: "read-only-network",
    toolsets: ["browser", "web", "research"],
    progressLabel: "finding browser element",
    maxResultSizeChars: 5000,
    isAvailable: async () => browserBackend.find !== undefined && await browserBackend.isAvailable(),
    run: async (input: BrowserActionInput) => {
      if (browserBackend.find === undefined) return unsupportedBrowserTool(browserBackend, "browser.find");
      const result = await browserBackend.find(deriveBrowserInput(input)).catch((error: unknown) => ({ error }));
      if ("error" in result) {
        return {
          ok: false,
          content: result.error instanceof Error ? result.error.message : "Browser element lookup failed.",
          metadata: browserFailureMetadata(browserBackend, result.error, "browser-find-failed")
        };
      }
      return {
        ok: true,
        content: renderBrowserFindResult(result),
        metadata: { backend: browserBackend.kind, ...result }
      };
    }
  };
}

function createBrowserExtractTool(
  browserBackend: BrowserBackend,
  deriveBrowserInput: DeriveBrowserInput
): RegisteredTool {
  return {
    name: "browser.extract",
    description: "Extract bounded text/value from one current browser element selected semantically, or by a ref with its source canonical identity and tabRef.",
    inputSchema: {
      type: "object",
      properties: {
        ...browserTargetInputProperties(),
        sessionId: { type: "string" }
      },
      oneOf: browserTargetOneOf()
    },
    riskClass: "read-only-network",
    toolsets: ["browser", "web", "research"],
    progressLabel: "extracting browser element",
    maxResultSizeChars: 5000,
    isAvailable: async () => browserBackend.extract !== undefined && await browserBackend.isAvailable(),
    run: async (input: BrowserActionInput) => {
      if (browserBackend.extract === undefined) return unsupportedBrowserTool(browserBackend, "browser.extract");
      const result = await browserBackend.extract(deriveBrowserInput(input)).catch((error: unknown) => ({ error }));
      if ("error" in result) {
        return {
          ok: false,
          content: result.error instanceof Error ? result.error.message : "Browser element extraction failed.",
          metadata: browserFailureMetadata(browserBackend, result.error, "browser-extract-failed")
        };
      }
      return {
        ok: true,
        content: [
          renderBrowserLocatorCandidate(result.target),
          result.text === undefined ? undefined : `Text: ${result.text}`,
          result.value === undefined ? undefined : `Value: ${result.value}`
        ].filter((line): line is string => line !== undefined).join("\n"),
        metadata: { backend: browserBackend.kind, ...result }
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

async function saveBrowserScreenshot(
  workspaceRoot: string | undefined,
  base64: string,
  artifactStore?: ArtifactStore,
  visibleTurnId?: string
): Promise<{ path: string; bytes: number }> {
  const root = workspaceRoot ?? process.cwd();
  const path = join(root, ".estacoda", "browser", "screenshots", `browser-${Date.now()}.png`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(base64, "base64"));
  const file = await stat(path);
  artifactStore?.record({
    path,
    kind: "image",
    bytes: file.size,
    mimeType: "image/png",
    summary: "Browser screenshot captured for governed visual analysis.",
    metadata: {
      visionProvenance: "browser-artifact",
      ...(visibleTurnId === undefined ? {} : { visionTurnId: visibleTurnId })
    }
  });
  return { path, bytes: file.size };
}

type BrowserSnapshotRenderOptions = {
  full?: boolean;
  maxChars?: number;
};

function renderBrowserSnapshot(snapshot: BrowserSnapshot, options: BrowserSnapshotRenderOptions = {}): string {
  if (snapshot.sensitiveInputActive === true) {
    return [
      "Protected authentication transaction active.",
      "Page content is intentionally suppressed.",
      "State: settling.",
    ].join("\n");
  }
  const elements = snapshot.elements ?? [];
  const pendingDialogs = snapshot.pendingDialogs ?? [];
  const frameTree = snapshot.frameTree ?? [];
  const consoleHistory = snapshot.consoleHistory ?? [];
  const protectedFormGuidance = renderProtectedFormGuidance(snapshot);
  const content = [
    options.full === true ? "[Full page snapshot]" : "[Compact viewport snapshot]",
    `Identity: ${renderBrowserIdentity(snapshot.identity)}`,
    `Observed: ${snapshot.observedAt}`,
    snapshot.readiness === undefined ? undefined : `Readiness: ${snapshot.readiness}`,
    snapshot.tab === undefined ? undefined : `Controlled tab: ${renderSafeBrowserTab(snapshot.tab)}`,
    snapshot.openedTabs === undefined || snapshot.openedTabs.length === 0 ? undefined : `Opened tabs: ${snapshot.openedTabs.map((tab) => tab.ref).join(", ")}`,
    "",
    snapshot.text,
    protectedFormGuidance === undefined ? undefined : "",
    protectedFormGuidance,
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

function renderSafeBrowserTab(tab: BrowserTab): string {
  const title = tab.title?.trim() === "" || tab.title === undefined
    ? "Untitled"
    : redactSensitiveText(tab.title).slice(0, 240);
  return `${redactSensitiveText(tab.ref).slice(0, 64)}${tab.controlled ? " [controlled]" : ""} ${title} — ${redactUrlForMetadata(tab.url)}`;
}

function renderProtectedFormGuidance(snapshot: BrowserSnapshot): string | undefined {
  if (snapshot.sensitiveInputActive === true || snapshot.tab === undefined) return undefined;
  const candidates = (snapshot.elements ?? []).filter((element) =>
    element.hidden !== true && element.disabled !== true && element.ref.startsWith("@e")
  );
  const account = candidates.filter((element) =>
    /email|e-mail|user\s*name|account(?:\s*id)?|login\s*id/iu.test([element.name, element.label].filter(Boolean).join(" "))
  );
  const password = candidates.filter((element) =>
    /password/iu.test([element.name, element.label].filter(Boolean).join(" "))
  );
  if (account.length !== 1 || password.length !== 1 || account[0]!.ref === password[0]!.ref) return undefined;
  return [
    "Protected form detected: request all related values in one browser.fill_protected_form call; do not request them one at a time.",
    `Use identity=${JSON.stringify(snapshot.identity)}, tabRef=${snapshot.tab.ref}, fields=[${account[0]!.ref}:account-identifier, ${password[0]!.ref}:password].`
  ].join("\n");
}

function renderBrowserActionDelta(delta: BrowserActionDelta): string {
  const heading = delta.outcome === "timeout"
    ? "Action wait timed out; current browser state was captured."
    : delta.outcome === "no-change"
      ? "Action dispatched; no observable page change was detected."
      : "Action completed with an observable page change.";
  const url = delta.url.changed
    ? `URL: ${delta.url.before ?? "new session"} → ${delta.url.after}`
    : `URL: unchanged (${delta.url.after})`;
  return [
    heading,
    `Identity: ${delta.beforeIdentity === undefined ? "new session" : renderBrowserIdentity(delta.beforeIdentity)} → ${renderBrowserIdentity(delta.afterIdentity)}`,
    `Wait: ${delta.waitCondition} (${delta.conditionMet ? "met" : "not met"})`,
    url,
    ...(delta.addedElements ?? []).map((element) => `Added: ${renderDeltaElement(element)}`),
    ...(delta.removedElements ?? []).map((element) => `Removed: ${renderDeltaElement(element)}`),
    ...(delta.openedTabs ?? []).map((tab) => `Opened tab: ${tab.ref}${tab.title === undefined ? "" : ` ${tab.title}`} — ${tab.url}`),
    ...(delta.tabTransition === undefined ? [] : [
      `Controlled tab: ${delta.tabTransition.source.ref} → ${delta.tabTransition.destination.ref}`,
      `Source: ${delta.tabTransition.source.url}`,
      `Destination: ${delta.tabTransition.destination.url}`
    ])
  ].join("\n");
}

function renderBrowserActionResult(snapshot: BrowserSnapshot, maxChars: number): string {
  if (snapshot.actionDelta === undefined) {
    return renderBrowserSnapshot(snapshot, { maxChars });
  }
  return truncateRenderedBrowserSnapshot([
    renderBrowserActionDelta(snapshot.actionDelta),
    "",
    "Current state:",
    renderBrowserActionCurrentState(snapshot)
  ].join("\n"), maxChars);
}

function renderBrowserActionCurrentState(snapshot: BrowserSnapshot): string {
  if (snapshot.sensitiveInputActive === true) {
    return [
      `Identity: ${renderBrowserIdentity(snapshot.identity)}`,
      "Protected authentication transaction active.",
      "Page content and actionable refs are intentionally suppressed.",
    ].join("\n");
  }
  const refs = (snapshot.elements ?? [])
    .filter((element) => element.hidden !== true && element.disabled !== true && isActionableBrowserRole(element.role))
    .slice(0, 20);
  return [
    `Identity: ${renderBrowserIdentity(snapshot.identity)}`,
    `URL: ${redactUrlForMetadata(snapshot.url)}`,
    snapshot.title === undefined ? undefined : `Title: ${redactSensitiveText(snapshot.title).slice(0, 240)}`,
    snapshot.readiness === undefined ? undefined : `Readiness: ${snapshot.readiness}`,
    snapshot.tab === undefined ? undefined : `Controlled tab: ${renderSafeBrowserTab(snapshot.tab)}`,
    refs.length === 0 ? "Actionable refs: none" : "Current actionable refs:",
    ...refs.map((element) => [
      element.ref,
      `identity=${JSON.stringify(snapshot.identity)}`,
      snapshot.tab === undefined ? undefined : `tab=${snapshot.tab.ref}`,
      element.role,
      element.name === undefined ? undefined : JSON.stringify(redactSensitiveText(element.name).slice(0, 160)),
      element.label === undefined ? undefined : `label=${JSON.stringify(redactSensitiveText(element.label).slice(0, 160))}`,
    ].filter((part): part is string => part !== undefined).join(" ")),
  ].filter((line): line is string => line !== undefined).join("\n");
}

function renderDeltaElement(element: BrowserActionDeltaElement): string {
  return [element.role ?? "element", element.name === undefined ? undefined : JSON.stringify(element.name)]
    .filter((value): value is string => value !== undefined)
    .join(" ");
}

function renderBrowserFindResult(result: BrowserFindResult): string {
  if (result.status === "not-found") {
    return `No visible, enabled browser element matched at ${renderBrowserIdentity(result.identity)} on tab ${result.tabRef}.`;
  }
  const heading = result.status === "ambiguous"
    ? `Locator is ambiguous: ${result.candidates.length} candidates matched. Refine it instead of guessing.`
    : "Found one browser element.";
  return [heading, ...result.candidates.map(renderBrowserLocatorCandidate)].join("\n");
}

function renderBrowserLocatorCandidate(candidate: BrowserLocatorCandidate): string {
  return [
    `${candidate.ref} identity=${JSON.stringify(candidate.identity)} tab=${candidate.tabRef}`,
    candidate.role,
    candidate.name === undefined ? undefined : JSON.stringify(candidate.name),
    candidate.label === undefined ? undefined : `label=${JSON.stringify(candidate.label)}`,
    candidate.withinText === undefined ? undefined : `within=${JSON.stringify(candidate.withinText)}`
  ].filter((part): part is string => part !== undefined).join(" ");
}

function browserLocatorSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      role: { type: "string" },
      name: { type: "string" },
      text: { type: "string" },
      label: { type: "string" },
      withinText: { type: "string" },
      exact: { type: "boolean" },
      identity: browserStateIdentitySchema("Optional canonical state binding for this semantic locator.")
    }
  };
}

function browserTargetInputProperties(): Record<string, unknown> {
  return {
    ref: { type: "string", description: "Element ref from a snapshot; canonical identity and tabRef are required with refs." },
    identity: browserStateIdentitySchema("Canonical snapshot identity that produced ref."),
    tabRef: { type: "string", description: "Controlled tab that produced ref." },
    locator: browserLocatorSchema()
  };
}

function browserTargetOneOf(): Array<{ required: string[] }> {
  return [
    { required: ["locator"] },
    { required: ["ref", "identity", "tabRef"] }
  ];
}

function browserStateIdentitySchema(description: string): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    description,
    properties: {
      documentEpoch: { type: "integer", minimum: 1 },
      actionRevision: { type: "integer", minimum: 1 },
      observationId: { type: "integer", minimum: 1 },
    },
    required: ["documentEpoch", "actionRevision", "observationId"],
  };
}

function renderBrowserIdentity(identity: BrowserStateIdentity): string {
  return `documentEpoch=${identity.documentEpoch} actionRevision=${identity.actionRevision} observationId=${identity.observationId}`;
}

function browserWaitInputProperties(): Record<string, unknown> {
  return {
    waitFor: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["url", "text", "element", "dialog", "dom-stable"] },
        contains: { type: "string" },
        value: { type: "string" },
        role: { type: "string" },
        name: { type: "string" }
      },
      required: ["kind"]
    },
    waitTimeoutMs: {
      type: "number",
      description: "Maximum wait for the requested browser state, capped at 10000 ms."
    }
  };
}

function renderBrowserTab(tab: BrowserTab): string {
  const title = tab.title?.trim() === "" || tab.title === undefined ? "Untitled" : tab.title;
  return `${tab.ref}${tab.controlled ? " [controlled]" : ""} ${title} — ${tab.url}`;
}

function renderBrowserSnapshotElement(element: NonNullable<BrowserSnapshot["elements"]>[number]): string {
  const details = [
    element.name,
    element.label === undefined || element.label === element.name ? undefined : `label=${JSON.stringify(element.label)}`,
    element.withinText === undefined ? undefined : `within=${JSON.stringify(element.withinText.slice(0, 120))}`,
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
