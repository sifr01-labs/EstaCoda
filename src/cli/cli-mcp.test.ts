import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { runCliCommand } from "./cli.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-cli-mcp-test-"));
}

function profileConfigPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
}

describe("cli mcp setup", () => {
  it("renders MCP-specific server trust help", async () => {
    const result = await runCliCommand({
      argv: ["mcp"],
      workspaceRoot: "/tmp",
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("--server-trust read-only-network");
    expect(result.output).not.toContain(`--${"trust"} read-only-network`);
  });

  it("stores MCP server trust with --server-trust", async () => {
    const tmpDir = await makeTempDir();
    try {
      const result = await runCliCommand({
        argv: [
          "mcp",
          "setup",
          "--name",
          "remote",
          "--transport",
          "http",
          "--url",
          "http://127.0.0.1:3000/mcp",
          "--server-trust",
          "read-only-network",
        ],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
      });

      expect(result.exitCode).toBe(0);
      const config = JSON.parse(await readFile(profileConfigPath(tmpDir), "utf8")) as {
        mcpServers?: Record<string, { trust?: string }>;
      };
      expect(config.mcpServers?.remote?.trust).toBe("read-only-network");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
