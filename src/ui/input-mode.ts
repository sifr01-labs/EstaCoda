export const UI_INPUT_MODE_ENV_VAR = "ESTACODA_INPUT_MODE";

export const UI_INPUT_MODES = ["raw"] as const;

export type UiInputMode = "readline" | typeof UI_INPUT_MODES[number];

export type ResolveUiInputModeOptions = {
  env?: Record<string, string | undefined>;
  defaultMode?: UiInputMode;
};

export type ResolveCoreSessionUiInputModeOptions = Omit<ResolveUiInputModeOptions, "defaultMode"> & {
  isInteractiveTty: boolean;
};

export function parseUiInputMode(value: string | undefined, defaultMode: UiInputMode = "raw"): UiInputMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "readline") return "raw";
  if (normalized === "raw") return "raw";
  return defaultMode;
}

export function resolveUiInputMode(options?: ResolveUiInputModeOptions): UiInputMode {
  const env = options?.env ?? process.env;
  return parseUiInputMode(env[UI_INPUT_MODE_ENV_VAR], options?.defaultMode);
}

export function resolveCoreSessionUiInputMode(options: ResolveCoreSessionUiInputModeOptions): UiInputMode {
  return resolveUiInputMode({
    env: options.env,
    defaultMode: options.isInteractiveTty ? "raw" : "readline",
  });
}
