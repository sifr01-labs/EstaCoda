export const DEFAULT_CLIPBOARD_MAX_TEXT_LENGTH = 16_384;

export type ClipboardSourceReadOptions = {
  readonly signal?: AbortSignal;
};

export type ClipboardSource =
  | {
      readonly readText: (
        options?: ClipboardSourceReadOptions
      ) => string | Promise<string>;
    }
  | {
      readonly read: (
        options?: ClipboardSourceReadOptions
      ) => ClipboardPayload | Promise<ClipboardPayload>;
    };

export type ClipboardPayload =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "binary" | "image" | "unknown"; readonly byteLength?: number };

export type ClipboardHelperOptions = {
  readonly source: ClipboardSource;
  readonly enabled?: boolean;
  readonly maxTextLength?: number;
  readonly filterText?: (text: string) => boolean;
};

export type ClipboardTextResult =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "empty" }
  | { readonly type: "unavailable"; readonly reason: string }
  | { readonly type: "error"; readonly error: ClipboardHelperError }
  | { readonly type: "canceled"; readonly canceled: true };

export type ClipboardHelperError = {
  readonly message: string;
  readonly recoverable?: boolean;
};

export function createClipboardHelper(options: ClipboardHelperOptions): {
  readonly readText: (signal?: AbortSignal) => Promise<ClipboardTextResult>;
} {
  const maxTextLength = positiveIntegerOrDefault(
    options.maxTextLength,
    DEFAULT_CLIPBOARD_MAX_TEXT_LENGTH
  );

  return {
    readText: async (signal) => {
      if (isSignalAborted(signal)) return { type: "canceled", canceled: true };
      if (options.enabled !== true) return { type: "unavailable", reason: "Clipboard helper is disabled" };

      try {
        const payload = await readClipboardPayload(options.source, { signal });
        if (isSignalAborted(signal)) return { type: "canceled", canceled: true };
        return normalizeClipboardPayload(payload, {
          maxTextLength,
          filterText: options.filterText,
        });
      } catch (error) {
        return {
          type: "error",
          error: clipboardError(error),
        };
      }
    },
  };
}

async function readClipboardPayload(
  source: ClipboardSource,
  options: ClipboardSourceReadOptions
): Promise<ClipboardPayload> {
  if ("readText" in source) {
    return {
      type: "text",
      text: await source.readText(options),
    };
  }
  return await source.read(options);
}

function normalizeClipboardPayload(
  payload: ClipboardPayload,
  options: {
    readonly maxTextLength: number;
    readonly filterText?: (text: string) => boolean;
  }
): ClipboardTextResult {
  if (payload.type !== "text") {
    return { type: "unavailable", reason: "Clipboard does not contain text" };
  }

  const text = payload.text;
  if (text.length === 0) return { type: "empty" };
  if (text.length > options.maxTextLength) {
    return { type: "unavailable", reason: "Clipboard text exceeds the configured maximum length" };
  }
  if (isSensitiveLookingClipboardText(text) || options.filterText?.(text) === false) {
    return { type: "unavailable", reason: "Clipboard text was filtered" };
  }

  return { type: "text", text };
}

function isSensitiveLookingClipboardText(text: string): boolean {
  return /\b(password|passwd|token|api[_-]?key|secret)\s*=/iu.test(text)
    || /\b[A-Z0-9_]*SECRET[A-Z0-9_]*=/u.test(text);
}

function clipboardError(error: unknown): ClipboardHelperError {
  if (error instanceof Error) return { message: error.message, recoverable: true };
  return { message: String(error), recoverable: true };
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
