export const INPUT_KEYMAP_MODE_ENV_VAR = "ESTACODA_INPUT_KEYMAP";

export type InputKeymapMode = "default" | "vim";

export type ResolveInputKeymapModeOptions = {
  readonly env?: Record<string, string | undefined>;
};

export function parseInputKeymapMode(value: string | undefined): InputKeymapMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "vim") return "vim";
  return "default";
}

export function resolveInputKeymapMode(options?: ResolveInputKeymapModeOptions): InputKeymapMode {
  const env = options?.env ?? process.env;
  return parseInputKeymapMode(env[INPUT_KEYMAP_MODE_ENV_VAR]);
}
