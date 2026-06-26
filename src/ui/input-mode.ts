export const UI_INPUT_MODE_ENV_VAR = "ESTACODA_INPUT_MODE";

export const UI_INPUT_MODES = ["readline", "raw"] as const;

export type UiInputMode = typeof UI_INPUT_MODES[number];

export type ResolveUiInputModeOptions = {
  env?: Record<string, string | undefined>;
};

export function parseUiInputMode(value: string | undefined): UiInputMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "raw") return "raw";
  return "readline";
}

export function resolveUiInputMode(options?: ResolveUiInputModeOptions): UiInputMode {
  const env = options?.env ?? process.env;
  return parseUiInputMode(env[UI_INPUT_MODE_ENV_VAR]);
}
