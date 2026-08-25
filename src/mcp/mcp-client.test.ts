import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MCPClient,
  __defaultMcpConnectTimeoutMsForTest,
  __resolveNpxCachedBinaryForTest
} from "./mcp-client.js";

async function withHomeEnv<T>(
  env: { HOME?: string; ESTACODA_HOME?: string },
  run: () => Promise<T>
): Promise<T> {
  const previousHome = process.env.HOME;
  const previousEstacodaHome = process.env.ESTACODA_HOME;

  if (env.HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = env.HOME;
  }

  if (env.ESTACODA_HOME === undefined) {
    delete process.env.ESTACODA_HOME;
  } else {
    process.env.ESTACODA_HOME = env.ESTACODA_HOME;
  }

  try {
    return await run();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousEstacodaHome === undefined) {
      delete process.env.ESTACODA_HOME;
    } else {
      process.env.ESTACODA_HOME = previousEstacodaHome;
    }
  }
}

describe("MCPClient stdio lifecycle", () => {
  it("allows cold stdio connector startup without widening normal request timeouts", () => {
    expect(__defaultMcpConnectTimeoutMsForTest("stdio", 10_000, "npx")).toBe(30_000);
    expect(__defaultMcpConnectTimeoutMsForTest("stdio", 45_000, "npx")).toBe(45_000);
    expect(__defaultMcpConnectTimeoutMsForTest("stdio", 10_000, "node")).toBe(10_000);
    expect(__defaultMcpConnectTimeoutMsForTest("stdio", 10_000, "pnpm", ["dlx"])).toBe(30_000);
    expect(__defaultMcpConnectTimeoutMsForTest("http", 10_000)).toBe(10_000);
  });

  it("rejects startup when a stdio child exits before initialize can complete", async () => {
    const client = new MCPClient({
      name: "exits-immediately",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      connectTimeoutMs: 1_000,
      timeoutMs: 1_000
    });

    await expect(client.start()).rejects.toThrow(/MCP server exits-immediately (?:stdin write failed|connection is closed|exited|closed)/u);
    await expect(client.stop()).resolves.toBeUndefined();
  });

  it("rejects requests after a stdio child closes", async () => {
    const script = [
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  for (const line of chunk.trim().split(/\\n+/u)) {",
      "    if (line.length === 0) continue;",
      "    const message = JSON.parse(line);",
      "    if (message.method === 'initialize') {",
      "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { capabilities: { tools: {} } } }) + '\\n');",
      "    }",
      "    if (message.method === 'notifications/initialized') {",
      "      setTimeout(() => process.exit(0), 10);",
      "    }",
      "  }",
      "});",
      "process.stdin.resume();"
    ].join("\n");
    const client = new MCPClient({
      name: "closes-after-initialize",
      command: process.execPath,
      args: ["-e", script],
      connectTimeoutMs: 1_000,
      timeoutMs: 1_000
    });

    await client.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(client.listTools()).rejects.toThrow(/MCP server closes-after-initialize (?:stdin write failed|connection is closed|exited|closed)/u);
    await expect(client.stop()).resolves.toBeUndefined();
  });
});

describe("npx cache lookup", () => {
  it("uses OS home, not ESTACODA_HOME, for user cache lookup", async () => {
    const prodHome = await mkdtemp(join(tmpdir(), "estacoda-mcp-prod-home-"));
    const devHome = await mkdtemp(join(tmpdir(), "estacoda-mcp-dev-home-"));

    try {
      await withHomeEnv({ HOME: prodHome, ESTACODA_HOME: devHome }, async () => {
        const cacheRoot = join(prodHome, ".npm", "_npx", "fixture-cache");
        const packageRoot = join(cacheRoot, "node_modules", "fixture-pkg");
        const binaryPath = join(cacheRoot, "node_modules", ".bin", "fixture");

        await mkdir(packageRoot, { recursive: true });
        await mkdir(join(cacheRoot, "node_modules", ".bin"), { recursive: true });
        await writeFile(join(packageRoot, "package.json"), JSON.stringify({
          name: "fixture-pkg",
          bin: { fixture: "bin/fixture.js" }
        }));
        await writeFile(binaryPath, "");

        await expect(__resolveNpxCachedBinaryForTest("fixture-pkg")).resolves.toBe(binaryPath);
      });
    } finally {
      await rm(prodHome, { recursive: true, force: true });
      await rm(devHome, { recursive: true, force: true });
    }
  });
});
