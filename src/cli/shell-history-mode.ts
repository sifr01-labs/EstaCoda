export const SHELL_HISTORY_MODE_ENV_VAR = "ESTACODA_SHELL_HISTORY";

export type ShellHistoryMode = "off" | "on";

export type ResolveShellHistoryModeOptions = {
  readonly env?: Record<string, string | undefined>;
};

export function parseShellHistoryMode(value: string | undefined): ShellHistoryMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "on") return "on";
  return "off";
}

export function resolveShellHistoryMode(options?: ResolveShellHistoryModeOptions): ShellHistoryMode {
  const env = options?.env ?? process.env;
  return parseShellHistoryMode(env[SHELL_HISTORY_MODE_ENV_VAR]);
}
