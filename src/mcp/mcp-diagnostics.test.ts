import { describe, expect, it } from "vitest";
import { mcpFailureDiagnostics, mcpRecoveryGuidance, sanitizeMcpDiagnostic } from "./mcp-diagnostics.js";
import type { MCPServerSnapshot } from "./mcp-tools.js";

describe("MCP recovery diagnostics", () => {
  it("bounds output and removes configured values, secret assignments, control codes and local paths", () => {
    const result = sanitizeMcpDiagnostic("\x1b[31mfailed opaque-credential at /Users/example/private/file API_KEY=hidden\n" + "x".repeat(2000), ["opaque-credential"]);
    expect(result).not.toMatch(/opaque-credential|hidden|\/Users|\x1b|\n/u);
    expect(result).toContain("[REDACTED]");
    expect(result.length).toBeLessThanOrEqual(1200);
  });
  it("reports only enabled unavailable connectors, with stage and actionable guidance", () => {
    const failed = { name: "example", enabled: true, available: false, failureStage: "connection", error: "initialize timed out" } as MCPServerSnapshot;
    expect(mcpFailureDiagnostics([failed, { ...failed, enabled: false }, { ...failed, available: true }]))
      .toEqual(["example: connection: initialize timed out"]);
    expect(mcpRecoveryGuidance()).toContain("/reload-mcp");
    expect(mcpRecoveryGuidance("ar")).toContain("⁦/reload-mcp⁩");
  });
});
