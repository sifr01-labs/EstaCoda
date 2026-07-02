import type { LoadedRuntimeConfig, MCPServerConfig } from "../../config/runtime-config.js";

export type McpSecurityDiagnostic = {
  readonly status: "ready" | "warning";
  readonly serverCount: number;
  readonly enabledCount: number;
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
};

const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh"]);
const SECRET_ENV_KEY_PATTERN = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH|COOKIE)(?:_|$)/iu;

export function diagnoseMcpSecurity(config: LoadedRuntimeConfig | undefined): McpSecurityDiagnostic {
  if (config === undefined) {
    return emptyDiagnostic();
  }

  const warnings: string[] = [];
  const notes: string[] = [];
  const entries = Object.entries(config.mcp.servers);
  const enabledEntries = entries.filter(([, server]) => server.enabled !== false);

  for (const [name, server] of enabledEntries) {
    warnings.push(...diagnoseServer(name, server));
  }
  if (entries.length === 0) {
    notes.push("MCP: no servers configured.");
  }

  return {
    status: warnings.length > 0 ? "warning" : "ready",
    serverCount: entries.length,
    enabledCount: enabledEntries.length,
    warnings,
    notes
  };
}

function diagnoseServer(name: string, server: MCPServerConfig): readonly string[] {
  const warnings: string[] = [];
  const transport = server.transport ?? (server.url === undefined ? "stdio" : "http");

  if (transport === "stdio") {
    if (server.command === undefined || server.command.trim().length === 0) {
      warnings.push(`MCP server ${name} is missing a stdio command.`);
    } else if (isShellWrapper(server.command)) {
      warnings.push(`MCP server ${name} uses shell wrapper command: ${server.command}`);
    }
    if ((server.args ?? []).some(isShellExecutionArg)) {
      warnings.push(`MCP server ${name} passes shell execution flags in args.`);
    }
  }

  if (transport === "http") {
    if (server.url === undefined || !/^https?:\/\//iu.test(server.url)) {
      warnings.push(`MCP server ${name} has an invalid HTTP URL.`);
    }
    if (server.trust === undefined || server.trust === "read-only-network") {
      warnings.push(`MCP server ${name} uses network MCP trust: ${server.trust ?? "unspecified"}`);
    }
  }

  const secretEnvKeys = Object.keys(server.env ?? {}).filter((key) => SECRET_ENV_KEY_PATTERN.test(key)).sort();
  if (secretEnvKeys.length > 0) {
    warnings.push(`MCP server ${name} passes secret-looking env keys: ${secretEnvKeys.join(", ")}`);
  }
  if (server.includeTools === undefined && server.tools?.include === undefined && server.excludeTools === undefined && server.tools?.exclude === undefined) {
    warnings.push(`MCP server ${name} has broad tool exposure.`);
  }
  if (server.exposeResources === true && server.resourceReadRiskClass === undefined) {
    warnings.push(`MCP server ${name} exposes resources without an explicit resource risk class.`);
  }
  if (server.exposePrompts === true && server.promptGetRiskClass === undefined) {
    warnings.push(`MCP server ${name} exposes prompts without an explicit prompt risk class.`);
  }

  return warnings;
}

function isShellWrapper(command: string): boolean {
  const normalized = command.trim().split(/[\\/]/u).at(-1)?.toLowerCase().replace(/\.(?:exe|cmd)$/iu, "") ?? "";
  return SHELL_WRAPPERS.has(normalized);
}

function isShellExecutionArg(arg: string): boolean {
  const normalized = arg.trim().toLowerCase();
  return normalized === "-c" || normalized === "/c" || normalized === "--command";
}

function emptyDiagnostic(): McpSecurityDiagnostic {
  return {
    status: "ready",
    serverCount: 0,
    enabledCount: 0,
    warnings: [],
    notes: []
  };
}
