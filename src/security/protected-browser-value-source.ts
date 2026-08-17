import type { BrowserBackend } from "../contracts/browser.js";
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
  read(input: {
    verified: VerifiedSecureInputSource;
    kind: SecureInputKind;
    signal: AbortSignal;
  }): Promise<Uint8Array>;
  release(source: BrowserFieldSecureInputSource): Promise<void>;
};

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
      if (result.status !== "verified") throw new Error("Protected browser source could not be verified.");
      return { source: structuredClone(source), label: result.sourceLabel };
    },
    read: async ({ verified, kind, signal }) => {
      if (backend.verifyProtectedSource === undefined || backend.readProtectedSource === undefined) {
        throw new Error("Protected browser source is unavailable.");
      }
      const verification = await backend.verifyProtectedSource({
        source: structuredClone(verified.source),
        kind,
        phase: "before-delivery",
        signal,
      });
      if (verification.status !== "verified" || verification.sourceLabel !== verified.label) {
        throw new Error("Protected browser source changed before delivery.");
      }
      return await backend.readProtectedSource({
        source: structuredClone(verified.source),
        kind,
        signal,
      });
    },
    release: async (source) => {
      await backend.releaseProtectedSource?.(structuredClone(source));
    },
  };
}
