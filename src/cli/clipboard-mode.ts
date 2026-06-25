export const CLIPBOARD_MODE_ENV_VAR = "ESTACODA_CLIPBOARD";

export type ClipboardMode = "off" | "on";

export type ResolveClipboardModeOptions = {
  readonly env?: Record<string, string | undefined>;
};

export function parseClipboardMode(value: string | undefined): ClipboardMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "on") return "on";
  return "off";
}

export function resolveClipboardMode(options?: ResolveClipboardModeOptions): ClipboardMode {
  const env = options?.env ?? process.env;
  return parseClipboardMode(env[CLIPBOARD_MODE_ENV_VAR]);
}
