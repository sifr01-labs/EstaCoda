import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { runCliCommand } from "./cli.js";

const cleanup: string[] = [];

afterEach(async () => {
  delete process.env.VISION_CLI_VERIFY_KEY;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("estacoda verify vision", () => {
  it("routes to the consent-gated bilingual verifier without contacting a hosted provider", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-vision-verify-cli-"));
    cleanup.push(homeDir);
    const configPath = resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
      providers: {
        openai: {
          kind: "openai-compatible",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "VISION_CLI_VERIFY_KEY",
          models: ["gpt-4o"],
          enableNetwork: true,
        },
      },
      auxiliaryModels: { vision: { provider: "main" } },
    }), "utf8");
    process.env.VISION_CLI_VERIFY_KEY = "cli-private-key";
    let providerCalls = 0;

    const result = await runCliCommand({
      argv: ["verify", "vision"],
      workspaceRoot: homeDir,
      homeDir,
      profileId: "default",
      providerFetch: async () => {
        providerCalls++;
        throw new Error("hosted provider must not be called without consent");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Status: consent-required");
    expect(result.output).toContain("Hosted consent: missing");
    expect(result.output).not.toContain("cli-private-key");
    expect(providerCalls).toBe(0);
  });

  it("rejects unknown verification targets explicitly", async () => {
    const result = await runCliCommand({
      argv: ["verify", "unknown"],
      workspaceRoot: process.cwd(),
    });
    expect(result).toMatchObject({ exitCode: 1, output: "Unknown verification target: unknown. Available: vision" });
  });
});
