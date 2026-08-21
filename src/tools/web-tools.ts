import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import type { RegisteredTool, SessionToolProvider, ToolResult, ToolSecurityResolution } from "../contracts/tool.js";
import type {
  BrowserActionInput,
  BrowserActionPreflight,
  BrowserActionPreflightKind,
  BrowserActionDelta,
  BrowserActionDeltaElement,
  BrowserBackend,
  BrowserDownloadInput,
  BrowserFindResult,
  BrowserLocatorCandidate,
  BrowserNavigateInput,
  BrowserScreenshotResult,
  BrowserSnapshot,
  BrowserStateIdentity,
  BrowserTab,
  WebExtractionResult
} from "../contracts/browser.js";
import type { BrowserFieldSecureInputDestination, GroupedSecureInputRequestHandler, SecureInputKind, SecureInputRetention } from "../contracts/secure-input.js";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import { resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import { createBrowserDebugSession, type BrowserDebugSession } from "../browser/browser-debug.js";
import { createUnconfiguredBrowserBackend } from "../browser/browser-backend.js";
import { browserSessionStateReason } from "../browser/session-state.js";
import { BrowserTargetError, browserTargetFailureMetadata, isBrowserStateIdentity } from "../browser/browser-locator.js";
import { isBrowserSnapshotElementInteractable } from "../browser/browser-interactability.js";
import { isActionableBrowserRole } from "../browser/snapshot-state.js";
import { deriveBrowserSessionKey } from "../browser/session-key.js";
import { compactBrowserSnapshot } from "../browser/snapshot-compactor.js";
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
import { enabledBrowserCapabilities } from "../browser/browser-capabilities.js";
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
  /** Runtime-selected profile-local root; never accepted from model input. */
  browserDownloadRoot?: string;
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
        const declaredCapabilities = status.capabilities ?? browserBackend.capabilities;
        const capabilities = enabledBrowserCapabilities(declaredCapabilities);

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
            `Capabilities: ${capabilities.length === 0 ? "none" : capabilities.join(", ")}`,
            status.reason === undefined ? undefined : `Reason: ${status.reason}`
          ].filter((line) => line !== undefined).join("\n"),
          metadata: { ...status, capabilities: declaredCapabilities }
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
      description: browserBackend.capabilities.visibleRegionActions && browserBackend.capabilities.screenshots
        ? "Click by semantic locator, current element/region ref, or a one-use visualTarget from a governed screenshot. Visual coordinates must resolve to a grounded current target and still pass normal native-action security."
        : browserBackend.capabilities.visibleRegionActions
          ? "Click by semantic locator, element ref, or a runtime-grounded visible regionRef with its source canonical identity and tabRef. Region coordinates are resolved and hit-tested by the browser; the model never supplies coordinates."
        : "Click by semantic locator or element ref with its source canonical identity and tabRef.",
      progressLabel: "clicking browser element",
      browserBackend,
      deriveBrowserInput,
      method: "click",
      inputSchema: {
        type: "object",
        properties: {
          ...browserTargetInputProperties({
            allowRegion: browserBackend.capabilities.visibleRegionActions,
            allowVisual: browserBackend.capabilities.visibleRegionActions && browserBackend.capabilities.screenshots
          }),
          sessionId: { type: "string" },
          ...browserWaitInputProperties()
        },
        oneOf: browserTargetOneOf({
          allowRegion: browserBackend.capabilities.visibleRegionActions,
          allowVisual: browserBackend.capabilities.visibleRegionActions && browserBackend.capabilities.screenshots
        })
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
      isAvailable: async () => browserBackend.capabilities.snapshots && await browserBackend.isAvailable(),
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
      isAvailable: async () => browserBackend.capabilities.snapshots && await browserBackend.isAvailable(),
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
      isAvailable: async () => browserBackend.capabilities.tabs && browserBackend.tabs !== undefined && await browserBackend.isAvailable(),
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
      isAvailable: async () => browserBackend.capabilities.tabs && browserBackend.switchTab !== undefined && await browserBackend.isAvailable(),
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
      isAvailable: async () => browserBackend.capabilities.rawCdp && await browserBackend.isAvailable(),
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
      description: "Capture a sanitized, viewport-bounded screenshot of the current controlled tab for explicit visual inspection.",
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
      isAvailable: async () => browserBackend.capabilities.screenshots && await browserBackend.isAvailable(),
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
            `Bytes: ${saved.bytes}`,
            screenshot.observation === undefined ? undefined : `Screenshot ID: ${screenshot.observation.screenshotId}`,
            screenshot.observation === undefined ? undefined : `Viewport pixels: ${screenshot.observation.viewport.pixelWidth}x${screenshot.observation.viewport.pixelHeight}`,
            screenshot.observation === undefined ? undefined : `Sanitized masks: ${screenshot.observation.maskedRegionCount}`
          ].filter((line): line is string => line !== undefined).join("\n"),
          metadata: {
            backend: browserBackend.kind,
            path: saved.path,
            mimeType: screenshot.mimeType,
            bytes: saved.bytes,
            ...(screenshot.observation === undefined ? {} : { observation: screenshot.observation })
          }
        };
      }
    },
    createBrowserDownloadTool(browserBackend, deriveBrowserInput, urlGuard, {
      artifactStore: options.artifactStore,
      downloadRoot: options.browserDownloadRoot ?? join(options.workspaceRoot ?? process.cwd(), ".estacoda", "browser", "downloads")
    }),
    {
      name: "browser.vision",
      description: "Fallback visual inspection for ambiguous, missing, conflicting, or ineffective semantic browser evidence. Captures only the sanitized current viewport.",
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
      isAvailable: async () => browserBackend.capabilities.screenshots && await browserBackend.isAvailable() &&
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
          prompt: governedBrowserVisionPrompt(input.prompt, screenshot.observation),
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
            screenshotBytes: saved.bytes,
            ...(screenshot.observation === undefined ? {} : { observation: screenshot.observation })
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
          disposition: { type: "string", enum: ["current-tab", "new-tab"] },
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
        if (input.disposition === "new-tab" && !browserBackend.capabilities.controlledNewTabs) {
          return withDebug({
            ok: false,
            content: "This browser backend does not support controlled new-tab navigation.",
            metadata: { backend: browserBackend.kind, reason: "controlled-new-tabs-unavailable" }
          }, debug);
        }
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
          disposition: input.disposition,
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
      browserDownloadRoot: join(
        resolveProfileStateHome({ homeDir: ctx.homeDir, profileId: ctx.profileId }).tempPath,
        "browser-downloads"
      ),
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
    isAvailable: async () => browserBackend.capabilities.snapshots && await browserBackend.isAvailable(),
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
      const full = browserInput.full === true;
      const summarizeMode = options.browserConfig?.summarizeSnapshots ?? "auto";
      const summarizeThreshold = options.browserConfig?.snapshotSummarizeThreshold ?? 8_000;
      const verboseRenderedSnapshot = renderBrowserSnapshot(snapshot, { full });
      const compaction = full
        ? {
            content: verboseRenderedSnapshot,
            mode: "full" as const,
            compacted: false,
            truncated: false,
            inputChars: verboseRenderedSnapshot.length,
            outputChars: verboseRenderedSnapshot.length,
            omittedItems: 0
          }
        : compactBrowserSnapshot(snapshot, {
            maxChars: 8_000,
            inputChars: verboseRenderedSnapshot.length
          });
      const summarizeResult = await maybeSummarizeSnapshot({
        renderedSnapshot: compaction.content,
        thresholdChars: summarizeMode === true ? compaction.inputChars : compaction.outputChars,
        userTask: browserInput.text,
        signal: context?.signal,
        executionSessionId: options.currentSessionId?.(),
        visibleTurnId: context?.visibleTurnId
      }, {
        mode: summarizeMode,
        threshold: summarizeThreshold,
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
          compaction: {
            mode: compaction.mode,
            compacted: compaction.compacted,
            truncated: compaction.truncated || summarizeResult.content.endsWith("\n... [truncated]"),
            inputChars: compaction.inputChars,
            outputChars: summarizeResult.content.length,
            omittedItems: compaction.omittedItems
          },
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
    isAvailable: async () => input.browserBackend.capabilities.semanticActions && await input.browserBackend.isAvailable(),
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
      let browserInput: BrowserActionInput = input.deriveBrowserInput(toolInput);
      if (securityAction !== undefined && context?.securityResolution !== undefined) {
        const reviewed = reviewedBrowserAction(context.securityResolution);
        if (reviewed === undefined || reviewed.action !== securityAction ||
            reviewed.key !== browserActionSecurityKey(securityAction, toolInput)) {
          return browserActionSecurityFailure(input.browserBackend);
        }
        if (reviewed.status === "rejected") {
          return browserActionSecurityFailure(input.browserBackend, reviewed.error);
        }
        if (reviewed.status === "bound") {
          browserInput = bindReviewedBrowserActionInput(browserInput, reviewed.preflight);
        }
      }
      const snapshot = await method(browserInput).catch((error: unknown) => ({ error }));
      if ("error" in snapshot) {
        return {
          ok: false,
          content: renderBrowserActionFailure(snapshot.error, `${input.name} failed.`),
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
  resolution: BrowserActionSecurityResolution;
};

const REVIEWED_BROWSER_ACTION = Symbol("reviewed-browser-action");

type ReviewedBrowserAction = {
  action: BrowserActionPreflightKind;
  key?: string;
} & (
  | { status: "safe-unbound" }
  | { status: "bound"; preflight: BrowserActionPreflight }
  | { status: "rejected"; error?: unknown }
);

type BrowserActionSecurityResolution = ToolSecurityResolution & {
  /** Runtime-only binding. Symbols are not persisted, logged, or shown for approval. */
  [REVIEWED_BROWSER_ACTION]: ReviewedBrowserAction;
};

const SAFE_BROWSER_KEYS = new Set([
  "arrowdown", "arrowleft", "arrowright", "arrowup", "end", "escape", "home",
  "pagedown", "pageup", "tab"
]);

async function resolveBrowserActionSecurity(
  action: BrowserActionPreflightKind,
  toolInput: BrowserActionInput,
  browserBackend: BrowserBackend,
  deriveBrowserInput: DeriveBrowserInput
): Promise<BrowserActionSecurityResult> {
  const browserInput = deriveBrowserInput(toolInput);
  const key = browserActionSecurityKey(action, toolInput);
  if ((action === "press" && key !== undefined && SAFE_BROWSER_KEYS.has(key)) ||
      (action === "dialog" && key === "dismiss")) {
    return browserActionSecurityResult(
      action,
      browserInput,
      key,
      undefined,
      "read-only-network",
      { status: "safe-unbound", action, ...(key === undefined ? {} : { key }) }
    );
  }

  if (browserBackend.preflightAction === undefined) {
    return browserActionSecurityResult(
      action,
      browserInput,
      key,
      undefined,
      "read-only-network",
      { status: "rejected", action, ...(key === undefined ? {} : { key }) }
    );
  }

  let preflight: BrowserActionPreflight;
  try {
    preflight = await browserBackend.preflightAction(action, browserInput);
  } catch (error) {
    return browserActionSecurityResult(
      action,
      browserInput,
      key,
      undefined,
      "read-only-network",
      { status: "rejected", action, ...(key === undefined ? {} : { key }), error }
    );
  }
  const safeLink = action === "click" && preflight.target?.kind === "link" &&
    preflight.target.tag === "a" && preflight.target.submit === false && isHttpUrl(preflight.target.href);
  const targetBound = preflight.action === action && preflight.target?.ref !== undefined;
  return browserActionSecurityResult(
    action,
    browserInput,
    key,
    preflight,
    safeLink || !targetBound ? "read-only-network" : "external-side-effect",
    targetBound
      ? { status: "bound", action, ...(key === undefined ? {} : { key }), preflight }
      : { status: "rejected", action, ...(key === undefined ? {} : { key }) }
  );
}

function browserActionSecurityResult(
  action: BrowserActionPreflightKind,
  browserInput: BrowserActionInput,
  key: string | undefined,
  preflight: BrowserActionPreflight | undefined,
  riskClass: "read-only-network" | "external-side-effect",
  reviewed: ReviewedBrowserAction
): BrowserActionSecurityResult {
  const targetKeyMaterial = preflight === undefined
    ? {
        action,
        sessionId: browserInput.sessionId,
        ref: browserInput.ref ?? browserInput.regionRef,
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
      targetSummary: buildBrowserActionSecuritySummary({ action, key, preflight }),
      [REVIEWED_BROWSER_ACTION]: reviewed
    }
  };
}

function reviewedBrowserAction(resolution: ToolSecurityResolution): ReviewedBrowserAction | undefined {
  return (resolution as Partial<BrowserActionSecurityResolution>)[REVIEWED_BROWSER_ACTION];
}

function browserActionSecurityKey(
  action: BrowserActionPreflightKind,
  input: BrowserActionInput
): string | undefined {
  return action === "press" ? normalizedBrowserKey(input.key) : action === "dialog" ? input.action : undefined;
}

function bindReviewedBrowserActionInput(
  input: BrowserActionInput,
  preflight: BrowserActionPreflight
): BrowserActionInput {
  const ref = preflight.target!.ref!;
  const isRegionRef = ref.startsWith("@r");
  return {
    ...input,
    sessionId: preflight.sessionId,
    ref: isRegionRef ? undefined : ref,
    regionRef: isRegionRef ? ref : undefined,
    identity: { ...preflight.identity },
    tabRef: preflight.tabRef,
    locator: undefined,
    visualTarget: undefined
  };
}

function browserActionSecurityFailure(
  backend: BrowserBackend,
  error?: unknown
): ToolResult {
  return {
    ok: false,
    content: renderBrowserActionFailure(
      error,
      "Browser action target could not be bound to the state reviewed by security policy."
    ),
    metadata: {
      ...browserFailureMetadata(backend, error, "browser-action-security-binding-failed"),
      reason: browserTargetFailureMetadata(error)?.reason ?? "browser-action-security-binding-failed"
    }
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
    isAvailable: async () => browserBackend.capabilities.semanticActions && await browserBackend.isAvailable(),
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
    isAvailable: async () => browserBackend.capabilities.protectedInput && await browserBackend.isAvailable(),
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
    isAvailable: async () => browserBackend.capabilities.semanticActions && browserBackend.find !== undefined && await browserBackend.isAvailable(),
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
    description: "Extract bounded visible text and safe grounded actions/links from one current browser element or visible region. Hidden inputs, protected values, and arbitrary DOM state are never returned.",
    inputSchema: {
      type: "object",
      properties: {
        ...browserTargetInputProperties({ allowRegion: true }),
        sessionId: { type: "string" }
      },
      oneOf: browserTargetOneOf({ allowRegion: true })
    },
    riskClass: "read-only-network",
    toolsets: ["browser", "web", "research"],
    progressLabel: "extracting browser element",
    maxResultSizeChars: 5000,
    isAvailable: async () => browserBackend.capabilities.semanticActions && browserBackend.extract !== undefined && await browserBackend.isAvailable(),
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
          result.value === undefined ? undefined : `Value: ${result.value}`,
          result.actions === undefined || result.actions.length === 0 ? undefined : "Actions:",
          ...(result.actions ?? []).map(renderBrowserLocatorCandidate),
          result.links === undefined || result.links.length === 0 ? undefined : "Links:",
          ...(result.links ?? []).map((link) => `- ${JSON.stringify(link.text)} -> ${redactUrlForMetadata(link.href)}`)
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

const MAX_GOVERNED_BROWSER_DOWNLOAD_BYTES = 25 * 1024 * 1024;

function createBrowserDownloadTool(
  browserBackend: BrowserBackend,
  deriveBrowserInput: DeriveBrowserInput,
  guardUrl: UrlGuard,
  options: {
    artifactStore?: ArtifactStore;
    downloadRoot: string;
  }
): RegisteredTool {
  const artifactStore = options.artifactStore ?? new ArtifactStore();
  return {
    name: "browser.download",
    description: "Capture a safe document or data download by an exact current browser element ref. The runtime chooses constrained storage; URL and destination-path input are not accepted.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        identity: browserIdentityInputSchema(),
        tabRef: { type: "string" },
        sessionId: { type: "string" }
      },
      required: ["ref", "identity", "tabRef"]
    },
    riskClass: "read-only-network",
    toolsets: ["browser", "web", "research"],
    progressLabel: "capturing browser download",
    maxResultSizeChars: 3_000,
    isAvailable: async () => browserBackend.capabilities.downloads &&
      browserBackend.download !== undefined &&
      await browserBackend.isAvailable(),
    run: async (input: BrowserActionInput) => {
      if (!browserBackend.capabilities.downloads || browserBackend.download === undefined) {
        return unsupportedBrowserTool(browserBackend, "browser.download");
      }
      const browserInput = deriveBrowserInput(input);
      const root = resolve(options.downloadRoot);
      const sessionOwner = createHash("sha256").update(browserInput.sessionId).digest("hex").slice(0, 24);
      const sessionRoot = resolve(root, sessionOwner);
      if (!sessionRoot.startsWith(`${root}${sep}`)) {
        return browserDownloadFailure(browserBackend, "download-blocked", "invalid-session-artifact-root");
      }

      await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
      const captureDirectory = await mkdtemp(join(sessionRoot, "capture-"));
      const runtimeInput: BrowserDownloadInput = {
        ...browserInput,
        destinationDirectory: captureDirectory,
        maxBytes: MAX_GOVERNED_BROWSER_DOWNLOAD_BYTES
      };
      let capture: Awaited<ReturnType<NonNullable<BrowserBackend["download"]>>>;
      try {
        capture = await browserBackend.download(runtimeInput);
      } catch (error) {
        await rm(captureDirectory, { recursive: true, force: true });
        const targetFailure = browserTargetFailureMetadata(error);
        if (targetFailure !== undefined) {
          return {
            ok: false,
            content: "The grounded browser download target is no longer current. Use the returned current browser evidence to retarget once.",
            metadata: {
              backend: browserBackend.kind,
              outcome: "download-blocked",
              ...targetFailure
            }
          };
        }
        return browserDownloadFailure(
          browserBackend,
          "download-failed",
          error instanceof Error && error.name === "AbortError" ? "download-cancelled" : "download-capture-failed"
        );
      }

      if (capture.outcome !== "download-completed" || capture.localPath === undefined || capture.sourceUrl === undefined) {
        await rm(captureDirectory, { recursive: true, force: true });
        return browserDownloadFailure(browserBackend, capture.outcome, capture.reason);
      }

      if (
        scanUrlForSecrets(capture.sourceUrl) !== undefined ||
        await guardUrl(capture.sourceUrl, {
          unsafeReason: "unsafe-download-redirect",
          policyReason: "download-website-policy",
          metadata: { backend: browserBackend.kind }
        }) !== undefined
      ) {
        await rm(captureDirectory, { recursive: true, force: true });
        return browserDownloadFailure(browserBackend, "download-blocked", "unsafe-download-redirect");
      }

      try {
        const localPath = resolve(capture.localPath);
        if (!localPath.startsWith(`${resolve(captureDirectory)}${sep}`)) {
          return browserDownloadFailure(browserBackend, "download-blocked", "download-path-escaped-capture-root");
        }
        const file = await stat(localPath);
        if (!file.isFile()) return browserDownloadFailure(browserBackend, "download-failed", "download-is-not-file");
        if (file.size > MAX_GOVERNED_BROWSER_DOWNLOAD_BYTES) {
          return browserDownloadFailure(browserBackend, "download-too-large", "download-too-large");
        }

        const bytes = await readFile(localPath);
        const filename = sanitizeBrowserDownloadFilename(capture.suggestedFilename ?? basename(localPath));
        const inspection = inspectBrowserDownload(filename, bytes);
        if (inspection.allowed === false) {
          return browserDownloadFailure(browserBackend, "download-type-blocked", inspection.reason);
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const artifactDirectory = join(sessionRoot, "artifacts");
        await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
        const artifactPath = join(artifactDirectory, `${randomUUID()}-${filename}`);
        await rename(localPath, artifactPath);
        await chmod(artifactPath, 0o600);
        const sourceOrigin = new URL(capture.sourceUrl).origin;
        const artifact = artifactStore.record({
          path: artifactPath,
          kind: inspection.kind,
          bytes: bytes.byteLength,
          mimeType: inspection.mimeType,
          summary: "Governed browser download captured from a current grounded page target.",
          metadata: {
            filename,
            sha256,
            sourceOrigin,
            outcome: "download-completed"
          }
        });
        const receipt = {
          artifactId: artifact.id,
          filename,
          mimeType: inspection.mimeType,
          sizeBytes: bytes.byteLength,
          sha256,
          sourceOrigin,
          outcome: "download-completed" as const
        };
        return {
          ok: true,
          content: [
            `Artifact: artifact://${artifact.id}`,
            `Filename: ${filename}`,
            `MIME: ${inspection.mimeType}`,
            `Bytes: ${bytes.byteLength}`,
            `SHA-256: ${sha256}`,
            `Source origin: ${sourceOrigin}`
          ].join("\n"),
          metadata: receipt
        };
      } finally {
        await rm(captureDirectory, { recursive: true, force: true });
      }
    }
  };
}

function browserDownloadFailure(
  backend: BrowserBackend,
  outcome: import("../contracts/browser.js").BrowserDownloadOutcome,
  reason = "browser-download-failed"
): ToolResult {
  return {
    ok: false,
    content: `Browser download did not complete (${outcome}).`,
    metadata: { backend: backend.kind, outcome, reason }
  };
}

function sanitizeBrowserDownloadFilename(value: string): string {
  const leaf = basename(value.replaceAll("\\", "/"));
  const normalized = leaf.normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[^A-Za-z0-9._ -]/gu, "_")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, 160);
  return normalized.length === 0 ? "download.bin" : normalized;
}

type BrowserDownloadInspection =
  | { allowed: true; mimeType: string; kind: "data" | "document" }
  | { allowed: false; reason: string };

function inspectBrowserDownload(filename: string, bytes: Uint8Array): BrowserDownloadInspection {
  const extension = extname(filename).toLowerCase();
  if (looksExecutableOrScript(bytes)) return { allowed: false, reason: "executable-or-script-content" };

  if (extension === ".pdf") {
    return startsWithAscii(bytes, "%PDF-")
      ? { allowed: true, mimeType: "application/pdf", kind: "document" }
      : { allowed: false, reason: "invalid-pdf-content" };
  }
  if (extension === ".zip") {
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2] ?? -1)
      ? { allowed: true, mimeType: "application/zip", kind: "data" }
      : { allowed: false, reason: "invalid-zip-content" };
  }
  if (![".json", ".yaml", ".yml", ".txt", ".md", ".csv"].includes(extension)) {
    return { allowed: false, reason: "unsupported-download-type" };
  }
  if (!isSafeTextBytes(bytes)) return { allowed: false, reason: "binary-content-in-text-download" };
  if (extension === ".json") {
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return { allowed: false, reason: "invalid-json-content" };
    }
    return { allowed: true, mimeType: "application/json", kind: "data" };
  }
  if (extension === ".yaml" || extension === ".yml") {
    return { allowed: true, mimeType: "application/yaml", kind: "data" };
  }
  if (extension === ".csv") return { allowed: true, mimeType: "text/csv", kind: "data" };
  if (extension === ".md") return { allowed: true, mimeType: "text/markdown", kind: "document" };
  return { allowed: true, mimeType: "text/plain", kind: "document" };
}

function looksExecutableOrScript(bytes: Uint8Array): boolean {
  if (startsWithAscii(bytes, "MZ") || startsWithAscii(bytes, "\u007fELF") || startsWithAscii(bytes, "#!")) return true;
  if (bytes.length < 4) return false;
  const magic = [bytes[0], bytes[1], bytes[2], bytes[3]].map((value) => value?.toString(16).padStart(2, "0")).join("");
  return ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(magic);
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  const prefix = Buffer.from(value, "binary");
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

function isSafeTextBytes(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function browserIdentityInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      documentEpoch: { type: "number" },
      actionRevision: { type: "number" },
      observationId: { type: "number" }
    },
    required: ["documentEpoch", "actionRevision", "observationId"]
  };
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
  const elements = (snapshot.elements ?? []).filter(isBrowserSnapshotElementInteractable);
  const regions = snapshot.regions ?? [];
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
    regions.length === 0 ? undefined : "",
    regions.length === 0 ? undefined : "Visible regions:",
    ...regions.slice(0, 30).map((region) => [
      `${region.ref} identity=${JSON.stringify(snapshot.identity)}`,
      snapshot.tab === undefined ? undefined : `tab=${snapshot.tab.ref}`,
      JSON.stringify(redactSensitiveText(region.text).slice(0, 600)),
      region.hitTestable ? "hitTestable=true" : "hitTestable=false",
      region.blockedBy === undefined ? undefined : `blockedBy=${JSON.stringify(redactSensitiveText(region.blockedBy).slice(0, 120))}`,
      region.actionRefs.length === 0 ? undefined : `actions=${region.actionRefs.join(",")}`,
      region.links.length === 0 ? undefined : `links=${region.links.map((link) => JSON.stringify(link.text)).join(",")}`
    ].filter((part): part is string => part !== undefined).join(" ")),
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
    isBrowserSnapshotElementInteractable(element) && element.ref.startsWith("@e")
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
  const heading = delta.outcome === "dispatched-unverified"
    ? "Action was dispatched, but settlement verification failed. Do not retry automatically; inspect the current browser state first."
    : delta.outcome === "timeout"
    ? "Action wait timed out; current browser state was captured."
    : delta.outcome === "new-tab-opened"
      ? "A new browser tab opened. One safe tab is controlled automatically; multiple safe tabs remain explicit choices."
    : delta.outcome === "popup-blocked"
      ? "Chrome blocked a popup. Use a different strategy; when a safe destination is shown, browser.navigate with disposition=new-tab can open it once without changing Chrome permissions."
    : delta.outcome === "same-tab-navigation"
      ? "Action completed with navigation in the controlled tab."
    : delta.outcome === "action-no-change"
      ? "Action was dispatched, but no observable browser state change occurred."
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
    ...(delta.outcome !== "dispatched-unverified" ? [] : [
      `State observation: ${delta.stateObservation === "post-dispatch" ? "post-dispatch" : "last known before dispatch"}`,
      `Document change observed: ${delta.documentChangeObserved === true ? "yes" : "no"}`
    ]),
    url,
    ...(delta.addedElements ?? []).map((element) => `Added: ${renderDeltaElement(element)}`),
    ...(delta.removedElements ?? []).map((element) => `Removed: ${renderDeltaElement(element)}`),
    ...(delta.openedTabs ?? []).map((tab) => `Opened tab: ${tab.ref}${tab.title === undefined ? "" : ` ${tab.title}`} — ${tab.url}`),
    ...((delta.openedTabs?.length ?? 0) > 1 ? ["Multiple safe tabs opened; choose one explicitly with browser.switch_tab."] : []),
    ...(delta.popup === undefined ? [] : [
      `Popup attempt: ${delta.popup.userGesture ? "user-gesture" : "no-user-gesture"}`,
      delta.popup.destination === undefined
        ? "Popup destination is unavailable under browser URL policy."
        : `Safe popup destination: ${delta.popup.destination}`
    ]),
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
  const actionable = (snapshot.elements ?? [])
    .filter((element) => isBrowserSnapshotElementInteractable(element) && isActionableBrowserRole(element.role));
  const targetRegion = snapshot.actionDelta?.target?.regionText ?? snapshot.actionDelta?.target?.withinText;
  const related = targetRegion === undefined
    ? []
    : actionable.filter((element) => browserRegionMatchesTarget(element, targetRegion));
  const refs = [...related, ...actionable.filter((element) => !related.includes(element))].slice(0, 20);
  return [
    `Identity: ${renderBrowserIdentity(snapshot.identity)}`,
    `URL: ${redactUrlForMetadata(snapshot.url)}`,
    snapshot.title === undefined ? undefined : `Title: ${redactSensitiveText(snapshot.title).slice(0, 240)}`,
    snapshot.readiness === undefined ? undefined : `Readiness: ${snapshot.readiness}`,
    snapshot.tab === undefined ? undefined : `Controlled tab: ${renderSafeBrowserTab(snapshot.tab)}`,
    refs.length === 0
      ? "Actionable refs: none"
      : related.length === 0
        ? "Current actionable refs:"
        : `Current actionable refs (related region first: ${JSON.stringify(redactSensitiveText(targetRegion!).slice(0, 240))}):`,
    ...refs.map((element) => [
      element.ref,
      `identity=${JSON.stringify(snapshot.identity)}`,
      snapshot.tab === undefined ? undefined : `tab=${snapshot.tab.ref}`,
      element.role,
      element.name === undefined ? undefined : JSON.stringify(redactSensitiveText(element.name).slice(0, 160)),
      element.label === undefined ? undefined : `label=${JSON.stringify(redactSensitiveText(element.label).slice(0, 160))}`,
      element.regionText === undefined ? undefined : `region=${JSON.stringify(redactSensitiveText(element.regionText).slice(0, 240))}`,
    ].filter((part): part is string => part !== undefined).join(" ")),
  ].filter((line): line is string => line !== undefined).join("\n");
}

function browserRegionMatchesTarget(
  element: NonNullable<BrowserSnapshot["elements"]>[number],
  targetRegion: string
): boolean {
  const elementRegion = element.regionText ?? element.withinText;
  if (elementRegion === undefined) return false;
  const safeElementRegion = redactSensitiveText(elementRegion);
  return safeElementRegion === targetRegion || safeElementRegion.startsWith(targetRegion);
}

function renderDeltaElement(element: BrowserActionDeltaElement): string {
  return [element.role ?? "element", element.name === undefined ? undefined : JSON.stringify(element.name)]
    .filter((value): value is string => value !== undefined)
    .join(" ");
}

function renderBrowserFindResult(result: BrowserFindResult): string {
  if (result.status === "not-found") {
    const heading = `No visible, enabled browser element matched exactly at ${renderBrowserIdentity(result.identity)} on tab ${result.tabRef}.`;
    const escalation = renderVisualEscalation(result.visualEscalation?.reason);
    if ((result.nearbyCandidates?.length ?? 0) === 0) return [heading, escalation].filter(Boolean).join("\n");
    return [
      heading,
      "Nearby current-document candidates (not exact matches; inspect structure before acting):",
      ...renderBrowserCandidateRegions(result.nearbyCandidates!),
      escalation
    ].filter((line): line is string => line !== undefined).join("\n");
  }
  const heading = result.status === "ambiguous"
    ? `Locator is ambiguous: ${result.candidates.length} candidates matched. Refine it instead of guessing.`
    : result.candidates[0]?.kind === "region"
      ? "Found one grounded visible region. It may be used with browser.extract or browser.click via regionRef."
      : "Found one browser element.";
  return [heading, ...result.candidates.map(renderBrowserLocatorCandidate), renderVisualEscalation(result.visualEscalation?.reason)]
    .filter((line): line is string => line !== undefined).join("\n");
}

function renderVisualEscalation(
  reason: NonNullable<BrowserFindResult["visualEscalation"]>["reason"] | undefined
): string | undefined {
  if (reason === undefined) return undefined;
  return reason === "semantic-match-ambiguous"
    ? "Semantic matches remain ambiguous. Request browser.vision for bounded current-viewport layout evidence if semantic refinement cannot disambiguate them."
    : reason === "visible-text-without-grounded-action"
      ? "The requested text is visible but no grounded action matches it. Request browser.vision to inspect its current layout."
      : "No grounded target was found. Request browser.vision if the control may be visually discoverable.";
}

function governedBrowserVisionPrompt(
  prompt: string | undefined,
  observation: BrowserScreenshotResult["observation"]
): string {
  return [
    prompt?.trim().length ? prompt.trim() : "Inspect the current viewport for the browser control or layout relevant to the active task.",
    "This image is a sanitized, current-viewport fallback. Describe only visible layout and candidate controls; do not infer or reconstruct masked values.",
    observation === undefined
      ? "Prefer semantic labels and relative layout. Do not propose arbitrary JavaScript or DOM access."
      : `For a visual click fallback, report only candidates that appear to be real controls, using screenshot pixel coordinates within ${observation.viewport.pixelWidth}x${observation.viewport.pixelHeight} and screenshotId ${observation.screenshotId}. Coordinates remain advisory until the runtime resolves them to a grounded current target.`
  ].join("\n\n");
}

function renderBrowserLocatorCandidate(candidate: BrowserLocatorCandidate): string {
  return [
    `${candidate.ref} identity=${JSON.stringify(candidate.identity)} tab=${candidate.tabRef}`,
    candidate.kind === "region" ? "visible-region" : undefined,
    candidate.role,
    candidate.name === undefined ? undefined : JSON.stringify(candidate.name),
    candidate.label === undefined ? undefined : `label=${JSON.stringify(candidate.label)}`,
    candidate.withinText === undefined ? undefined : `within=${JSON.stringify(candidate.withinText)}`,
    candidate.regionText === undefined ? undefined : `region=${JSON.stringify(candidate.regionText)}`
  ].filter((part): part is string => part !== undefined).join(" ");
}

function renderBrowserActionFailure(error: unknown, fallback: string): string {
  if (!(error instanceof BrowserTargetError)) return error instanceof Error ? error.message : fallback;
  return [
    error.message,
    error.nearbyCandidates.length === 0
      ? "No action was dispatched."
      : "No action was dispatched. Grounded current-document alternatives:",
    ...renderBrowserCandidateRegions(error.nearbyCandidates)
  ].join("\n");
}

function renderBrowserCandidateRegions(candidates: readonly BrowserLocatorCandidate[]): string[] {
  const regions = new Map<string, BrowserLocatorCandidate[]>();
  const ungrouped: BrowserLocatorCandidate[] = [];
  for (const candidate of candidates) {
    const region = candidate.regionText ?? candidate.withinText;
    if (region === undefined || region.trim().length === 0) {
      ungrouped.push(candidate);
      continue;
    }
    const existing = regions.get(region) ?? [];
    existing.push(candidate);
    regions.set(region, existing);
  }
  return [
    ...[...regions.entries()].flatMap(([region, actions]) => [
      `Region: ${JSON.stringify(region)}`,
      "Actions:",
      ...actions.map(renderBrowserLocatorCandidate)
    ]),
    ...ungrouped.map(renderBrowserLocatorCandidate)
  ];
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

function browserTargetInputProperties(options: { allowRegion?: boolean; allowVisual?: boolean } = {}): Record<string, unknown> {
  return {
    ref: { type: "string", description: "Element ref from a snapshot; canonical identity and tabRef are required with refs." },
    ...(options.allowRegion === true ? {
      regionRef: { type: "string", description: "Runtime-grounded visible region ref from browser.find/snapshot; canonical identity and tabRef are required." }
    } : {}),
    ...(options.allowVisual === true ? {
      visualTarget: {
        type: "object",
        additionalProperties: false,
        description: "One-use fallback from the most recent governed viewport screenshot. Pixel coordinates must hit a runtime-grounded current target.",
        properties: {
          screenshotId: { type: "string" },
          x: { type: "number", minimum: 0 },
          y: { type: "number", minimum: 0 }
        },
        required: ["screenshotId", "x", "y"]
      }
    } : {}),
    identity: browserStateIdentitySchema("Canonical snapshot identity that produced ref."),
    tabRef: { type: "string", description: "Controlled tab that produced ref." },
    locator: browserLocatorSchema()
  };
}

function browserTargetOneOf(options: { allowRegion?: boolean; allowVisual?: boolean } = {}): Array<{ required: string[] }> {
  return [
    { required: ["locator"] },
    { required: ["ref", "identity", "tabRef"] },
    ...(options.allowRegion === true ? [{ required: ["regionRef", "identity", "tabRef"] }] : []),
    ...(options.allowVisual === true ? [{ required: ["visualTarget"] }] : [])
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
      description: "Post-action condition to wait for. Each kind requires only its matching fields.",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["url"] },
            contains: { type: "string", minLength: 1, maxLength: 500 }
          },
          required: ["kind", "contains"]
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["text"] },
            value: { type: "string", minLength: 1, maxLength: 500 }
          },
          required: ["kind", "value"]
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["element"] },
            role: { type: "string", minLength: 1, maxLength: 500 },
            name: { type: "string", minLength: 1, maxLength: 500 }
          },
          required: ["kind"],
          anyOf: [{ required: ["role"] }, { required: ["name"] }]
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { kind: { type: "string", enum: ["dialog"] } },
          required: ["kind"]
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { kind: { type: "string", enum: ["dom-stable"] } },
          required: ["kind"]
        }
      ]
    },
    waitTimeoutMs: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 10_000,
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
