import type {
  BrowserBackend,
  BrowserProtectedSourceRejectionReason,
  BrowserProtectedSourceVerificationPhase
} from "../contracts/browser.js";
import type {
  BrowserFieldSecureInputSource,
  SecureInputKind,
} from "../contracts/secure-input.js";

export type VerifiedSecureInputSource = {
  source: BrowserFieldSecureInputSource;
  label: string;
};

export type ProtectedBrowserValueSource = {
  prepare(input: {
    source: BrowserFieldSecureInputSource;
    kind: SecureInputKind;
    signal: AbortSignal;
  }): Promise<VerifiedSecureInputSource>;
  reverify(input: {
    verified: VerifiedSecureInputSource;
    kind: SecureInputKind;
    signal: AbortSignal;
  }): Promise<void>;
  read(input: {
    verified: VerifiedSecureInputSource;
    kind: SecureInputKind;
    signal: AbortSignal;
  }): Promise<Uint8Array>;
  release(source: BrowserFieldSecureInputSource): Promise<void>;
};

/** Safe typed rejection propagated without browser text, values, or raw exceptions. */
export class ProtectedBrowserValueSourceError extends Error {
  readonly code = "protected-browser-source-rejected" as const;

  constructor(
    readonly reason: BrowserProtectedSourceRejectionReason,
    readonly phase: BrowserProtectedSourceVerificationPhase
  ) {
    super(`Protected browser source rejected: ${reason}.`);
    this.name = "ProtectedBrowserValueSourceError";
  }
}

/** Runtime-only browser source. It returns bytes only to the protected coordinator. */
export function createProtectedBrowserValueSource(backend: BrowserBackend): ProtectedBrowserValueSource {
  return {
    prepare: async ({ source, kind, signal }) => {
      if (backend.kind !== "local-cdp" || backend.verifyProtectedSource === undefined ||
          backend.readProtectedSource === undefined || backend.releaseProtectedSource === undefined ||
          !await backend.isAvailable()) {
        throw new Error("Protected browser source is unavailable.");
      }
      const result = await backend.verifyProtectedSource({
        source: structuredClone(source),
        kind,
        phase: "before-authorization",
        signal,
      });
      if (result.status !== "verified") {
        throw new ProtectedBrowserValueSourceError(result.reason, "before-authorization");
      }
      return { source: structuredClone(source), label: result.sourceLabel };
    },
    reverify: async ({ verified, kind, signal }) => {
      if (backend.verifyProtectedSource === undefined || backend.readProtectedSource === undefined) {
        throw new Error("Protected browser source is unavailable.");
      }
      const verification = await backend.verifyProtectedSource({
        source: structuredClone(verified.source),
        kind,
        phase: "before-delivery",
        signal,
      });
      if (verification.status !== "verified") {
        throw new ProtectedBrowserValueSourceError(verification.reason, "before-delivery");
      }
      if (verification.sourceLabel !== verified.label) {
        throw new ProtectedBrowserValueSourceError("source-replaced", "before-delivery");
      }
    },
    read: async ({ verified, kind, signal }) => {
      if (backend.readProtectedSource === undefined) throw new Error("Protected browser source is unavailable.");
      const result = await backend.readProtectedSource({
        source: structuredClone(verified.source),
        kind,
        signal,
      });
      if (result.status === "rejected") {
        throw new ProtectedBrowserValueSourceError(result.reason, "before-delivery");
      }
      return result.value;
    },
    release: async (source) => {
      await backend.releaseProtectedSource?.(structuredClone(source));
    },
  };
}
