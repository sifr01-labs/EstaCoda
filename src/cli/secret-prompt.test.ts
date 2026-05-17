import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promptForApiKey, promptForApiKeyInput, maskSecret, redactInObject } from "./secret-prompt.js";
import type { Prompt } from "./readline-prompt.js";
import { resolveProfileStateHome } from "../config/profile-home.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-secret-prompt-test-"));
}

function fakePrompt(answer: string): Prompt {
  const prompt = Object.assign(
    async (_question: string, _options?: { secret?: boolean }) => answer,
    {
      select: async <T>(input: { options: { value: T }[]; defaultIndex?: number }) =>
        input.options[input.defaultIndex ?? 0]?.value ?? input.options[0]!.value,
      onboardingCard: () => undefined,
      close: () => undefined,
    }
  );
  return prompt as Prompt;
}

function profileEnvPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).envPath;
}

describe("promptForApiKey", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes non-empty key to .env and returns stored reference", async () => {
    const result = await promptForApiKey({
      prompt: fakePrompt("sk-test-key-1234"),
      providerId: "openai",
      envVarName: "OPENAI_API_KEY",
      homeDir: tempDir,
    });

    expect(result.kind).toBe("stored");
    if (result.kind === "stored") {
      expect(result.envVarName).toBe("OPENAI_API_KEY");
      expect(result.envPath).toBe(profileEnvPath(tempDir));
    }

    const envContent = await readFile(profileEnvPath(tempDir), "utf8");
    expect(envContent).toContain('OPENAI_API_KEY="sk-test-key-1234"');
  });

  it("returns skipped when user enters empty input", async () => {
    const result = await promptForApiKey({
      prompt: fakePrompt("   "),
      providerId: "openai",
      envVarName: "OPENAI_API_KEY",
      homeDir: tempDir,
    });

    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") {
      expect(result.envVarName).toBe("OPENAI_API_KEY");
    }

    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
  });

  it("does not print raw key in any returned field", async () => {
    const result = await promptForApiKey({
      prompt: fakePrompt("sk-super-secret-9999"),
      providerId: "openai",
      envVarName: "OPENAI_API_KEY",
      homeDir: tempDir,
    });

    const json = JSON.stringify(result);
    expect(json).not.toContain("sk-super-secret-9999");
    expect(json).toContain("OPENAI_API_KEY");
  });

  it("writes .env with 0600 permissions where supported", async () => {
    await promptForApiKey({
      prompt: fakePrompt("sk-test-key"),
      providerId: "openai",
      envVarName: "OPENAI_API_KEY",
      homeDir: tempDir,
    });

    const s = await stat(profileEnvPath(tempDir));
    // 0o100600 on Unix; on Windows this may differ, so only assert on non-Windows
    if (process.platform !== "win32") {
      expect(s.mode & 0o777).toBe(0o600);
    }
  });
});

describe("promptForApiKeyInput", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("collects non-empty key without writing .env", async () => {
    const result = await promptForApiKeyInput({
      prompt: fakePrompt("sk-deferred-key-1234"),
      providerId: "openai",
      envVarName: "OPENAI_API_KEY",
    });

    expect(result).toEqual({
      kind: "entered",
      envVarName: "OPENAI_API_KEY",
      value: "sk-deferred-key-1234",
    });
    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
  });

  it("returns skipped for empty input without writing .env", async () => {
    const result = await promptForApiKeyInput({
      prompt: fakePrompt("   "),
      providerId: "openai",
      envVarName: "OPENAI_API_KEY",
    });

    expect(result).toEqual({ kind: "skipped", envVarName: "OPENAI_API_KEY" });
    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
  });
});

describe("maskSecret", () => {
  it("masks values longer than 8 characters", () => {
    expect(maskSecret("sk-abc1234567890")).toBe("sk-****7890");
  });

  it("masks short values fully", () => {
    expect(maskSecret("short")).toBe("****");
    expect(maskSecret("12345678")).toBe("****");
  });
});

describe("redactInObject", () => {
  it("redacts string values under secret-like keys", () => {
    const input = {
      provider: "openai",
      apiKey: "sk-secret-key-1234",
      config: {
        secretToken: "abc-def-ghi",
      },
    };
    const result = redactInObject(input) as Record<string, unknown>;
    expect(result.apiKey).toBe("sk-****1234");
    expect((result.config as Record<string, unknown>).secretToken).toBe("abc****-ghi");
    expect(result.provider).toBe("openai");
  });

  it("leaves non-secret keys untouched", () => {
    const input = {
      name: "test",
      baseUrl: "https://api.openai.com",
    };
    const result = redactInObject(input) as Record<string, unknown>;
    expect(result.name).toBe("test");
    expect(result.baseUrl).toBe("https://api.openai.com");
  });

  it("handles arrays", () => {
    const input = [
      { apiKey: "sk-aaaa" },
      { apiKey: "sk-bbbb" },
    ];
    const result = redactInObject(input) as Array<Record<string, unknown>>;
    expect(result[0]!.apiKey).toBe("****");
    expect(result[1]!.apiKey).toBe("****");
  });
});
