import type { BrowserBackend, BrowserBackendCapabilities } from "../contracts/browser.js";

export const NO_BROWSER_CAPABILITIES: Readonly<BrowserBackendCapabilities> = Object.freeze({
  snapshots: false,
  semanticActions: false,
  visibleRegionActions: false,
  nativePointer: false,
  tabs: false,
  controlledNewTabs: false,
  popupObservation: false,
  downloads: false,
  protectedInput: false,
  protectedSourceRelay: false,
  screenshots: false,
  rawCdp: false
});

export function browserCapabilities(
  enabled: Partial<BrowserBackendCapabilities> = {}
): BrowserBackendCapabilities {
  return { ...NO_BROWSER_CAPABILITIES, ...enabled };
}

const REQUIRED_METHODS: Readonly<Record<keyof BrowserBackendCapabilities, readonly (keyof BrowserBackend)[]>> = {
  snapshots: ["snapshot"],
  semanticActions: ["find", "click", "type", "select", "extract"],
  visibleRegionActions: ["snapshot", "click"],
  nativePointer: ["click"],
  tabs: ["tabs", "switchTab"],
  controlledNewTabs: ["navigate"],
  popupObservation: ["click"],
  downloads: ["download"],
  protectedInput: ["prepareProtectedField", "verifyProtectedField", "deliverProtectedField", "releaseProtectedField"],
  protectedSourceRelay: ["verifyProtectedSource", "readProtectedSource", "releaseProtectedSource"],
  screenshots: ["screenshot"],
  rawCdp: ["cdp"]
};

/** Fails closed when a trusted capability declaration overstates its backend implementation. */
export function validateBrowserBackendCapabilities<T extends BrowserBackend>(backend: T): T {
  for (const [capability, methods] of Object.entries(REQUIRED_METHODS) as Array<[
    keyof BrowserBackendCapabilities,
    readonly (keyof BrowserBackend)[]
  ]>) {
    if (!backend.capabilities[capability]) continue;
    const missing = methods.filter((method) => typeof backend[method] !== "function");
    if (missing.length > 0) {
      throw new TypeError(
        `Browser backend ${backend.kind} declares ${capability} without implementing ${missing.join(", ")}.`
      );
    }
  }
  return backend;
}

export function enabledBrowserCapabilities(capabilities: BrowserBackendCapabilities): string[] {
  return (Object.entries(capabilities) as Array<[keyof BrowserBackendCapabilities, boolean]>)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}
