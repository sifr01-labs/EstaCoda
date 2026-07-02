import { describe, expect, it } from "vitest";
import type { LoadedRuntimeConfig } from "../../config/runtime-config.js";
import { diagnoseMcpSecurity } from "./mcp-security.js";

describe("diagnoseMcpSecurity", () => {
  it("reports no configured MCP servers as ready with a note", () => {
    const diagnostic = diagnoseMcpSecurity(configWithServers({}));

    expect(diagnostic.status).toBe("ready");
    expect(diagnostic.serverCount).toBe(0);
    expect(diagnostic.notes).toEqual(["MCP: no servers configured."]);
  });

  it("flags shell wrappers, broad exposure, and secret-looking env keys without env values", () => {
    const diagnostic = diagnoseMcpSecurity(configWithServers({
      localDev: {
        transport: "stdio",
        command: "sh",
        args: ["-c", "node server.js"],
        env: {
          API_TOKEN: "super-secret-token",
          SAFE_FLAG: "1"
        }
      }
    }));

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.warnings).toEqual(expect.arrayContaining([
      "MCP server localDev uses shell wrapper command: sh",
      "MCP server localDev passes shell execution flags in args.",
      "MCP server localDev passes secret-looking env keys: API_TOKEN",
      "MCP server localDev has broad tool exposure."
    ]));
    expect(diagnostic.warnings.join("\n")).not.toContain("super-secret-token");
  });

  it("flags risky HTTP and resource exposure shapes", () => {
    const diagnostic = diagnoseMcpSecurity(configWithServers({
      remote: {
        transport: "http",
        url: "https://mcp.example.test",
        trust: "read-only-network",
        includeTools: ["search"],
        exposeResources: true,
        exposePrompts: true
      }
    }));

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.warnings).toEqual(expect.arrayContaining([
      "MCP server remote uses network MCP trust: read-only-network",
      "MCP server remote exposes resources without an explicit resource risk class.",
      "MCP server remote exposes prompts without an explicit prompt risk class."
    ]));
  });

  it("ignores disabled servers", () => {
    const diagnostic = diagnoseMcpSecurity(configWithServers({
      disabled: {
        enabled: false,
        command: "sh",
        env: { API_TOKEN: "hidden" }
      }
    }));

    expect(diagnostic.status).toBe("ready");
    expect(diagnostic.serverCount).toBe(1);
    expect(diagnostic.enabledCount).toBe(0);
    expect(diagnostic.warnings).toEqual([]);
  });
});

function configWithServers(servers: LoadedRuntimeConfig["mcp"]["servers"]): LoadedRuntimeConfig {
  return { mcp: { servers } } as LoadedRuntimeConfig;
}
