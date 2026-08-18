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

  it("stores MCP environment references without storing secret values", async () => {
    const tmpDir = await makeTempDir();
    try {
      const result = await runCliCommand({
        argv: [
          "mcp",
          "setup",
          "--name",
          "postman",
          "--command",
          "npx",
          "--args",
          "@postman/postman-mcp-server",
          "--env-ref",
          "POSTMAN_API_KEY=POSTMAN_API_KEY",
        ],
        workspaceRoot: tmpDir,
        homeDir: tmpDir,
      });

      expect(result.exitCode).toBe(0);
      const rawConfig = await readFile(profileConfigPath(tmpDir), "utf8");
      const config = JSON.parse(rawConfig) as {
        mcpServers?: Record<string, { env?: Record<string, string>; envRefs?: Record<string, string> }>;
      };
      expect(config.mcpServers?.postman?.envRefs).toEqual({ POSTMAN_API_KEY: "POSTMAN_API_KEY" });
      expect(config.mcpServers?.postman?.env).toBeUndefined();
      expect(rawConfig).not.toContain("postman-secret-value");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("stores per-tool MCP risk overrides", async () => {
    const tmpDir = await makeTempDir();
    try {
      const result = await runCliCommand({
        argv: [
          "mcp", "setup", "--name", "postman", "--command", "npx",
          "--tool-risk-classes",
          "getCollection=read-only-network,updateCollection=external-side-effect"
        ],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });
      expect(result.exitCode).toBe(0);
      const config = JSON.parse(await readFile(profileConfigPath(tmpDir), "utf8")) as {
        mcpServers?: Record<string, { toolRiskClasses?: Record<string, string> }>;
      };
      expect(config.mcpServers?.postman?.toolRiskClasses).toEqual({
        getCollection: "read-only-network",
        updateCollection: "external-side-effect"
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("stores generic protected delivery and verification metadata without credential values", async () => {
    const tmpDir = await makeTempDir();
    try {
      const protectedConfig = {
        updateRecords: {
          paths: ["/values/*/value"],
          handling: { persistence: "destination-managed", sharing: "workspace" },
          groupedDelivery: true,
          browserRelay: true
        }
      };
      const initial = await runCliCommand({
        argv: [
          "mcp", "setup", "--name", "records", "--command", "records-mcp",
          "--env-ref", "API_TOKEN=RECORDS_API_TOKEN"
        ],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });
      expect(initial.exitCode).toBe(0);
      const result = await runCliCommand({
        argv: [
          "mcp", "setup", "--name", "records",
          "--tool-risk-classes", "updateRecords=external-side-effect,readRecords=read-only-network",
          "--protected-tool-arguments-json", JSON.stringify(protectedConfig),
          "--tool-verification-relationships-json", JSON.stringify({ readRecords: ["updateRecords"] })
        ],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });

      expect(result.exitCode).toBe(0);
      const rawConfig = await readFile(profileConfigPath(tmpDir), "utf8");
      const config = JSON.parse(rawConfig) as {
        mcpServers?: Record<string, {
          command?: string;
          envRefs?: Record<string, string>;
          protectedToolArguments?: unknown;
          toolVerificationRelationships?: unknown;
        }>;
      };
      expect(config.mcpServers?.records?.command).toBe("records-mcp");
      expect(config.mcpServers?.records?.envRefs).toEqual({ API_TOKEN: "RECORDS_API_TOKEN" });
      expect(config.mcpServers?.records?.protectedToolArguments).toEqual(protectedConfig);
      expect(config.mcpServers?.records?.toolVerificationRelationships).toEqual({
        readRecords: ["updateRecords"]
      });
      expect(rawConfig).not.toContain("credential-value");

      const status = await runCliCommand({
        argv: ["mcp", "status"],
        workspaceRoot: tmpDir,
        homeDir: tmpDir
      });
      expect(status.output).toContain("protected delivery configured: yes");
      expect(status.output).toContain("grouped delivery supported: yes");
      expect(status.output).toContain("browser relay supported: yes");
      expect(status.output).toContain("verification configured: yes");
      expect(status.output).not.toContain("/values/*/value");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
