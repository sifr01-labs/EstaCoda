export const UI_RENDERER_ENV_VAR = "ESTACODA_UI_RENDERER";

export const UI_RENDERER_MODES = ["papyrus"] as const;

export type UiRendererMode = typeof UI_RENDERER_MODES[number];

export type ResolveUiRendererModeOptions = {
  env?: Record<string, string | undefined>;
};

export function parseUiRendererMode(value: string | undefined): UiRendererMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "legacy") return "papyrus";
  return "papyrus";
}

export function resolveUiRendererMode(options?: ResolveUiRendererModeOptions): UiRendererMode {
  const env = options?.env ?? process.env;
  return parseUiRendererMode(env[UI_RENDERER_ENV_VAR]);
}
