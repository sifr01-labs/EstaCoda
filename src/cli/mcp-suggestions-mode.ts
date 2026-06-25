export const MCP_SUGGESTIONS_MODE_ENV_VAR = "ESTACODA_MCP_SUGGESTIONS";

export type McpSuggestionsMode = "off" | "on";

export type ResolveMcpSuggestionsModeOptions = {
  readonly env?: Record<string, string | undefined>;
};

export function parseMcpSuggestionsMode(value: string | undefined): McpSuggestionsMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "on") return "on";
  return "off";
}

export function resolveMcpSuggestionsMode(options?: ResolveMcpSuggestionsModeOptions): McpSuggestionsMode {
  const env = options?.env ?? process.env;
  return parseMcpSuggestionsMode(env[MCP_SUGGESTIONS_MODE_ENV_VAR]);
}
