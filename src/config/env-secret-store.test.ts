import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeEnvSecret, loadDotEnvSecrets, defaultEnvPath, hasSavedEnvSecret } from "./env-secret-store.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-env-secret-test-"));
}

describe("writeEnvSecret", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates .env file with the key-value pair", async () => {
    const result = await writeEnvSecret({
      homeDir: tempDir,
      key: "OPENAI_API_KEY",
      value: "sk-test-1234",
    });

    expect(result.path).toBe(join(tempDir, ".estacoda", ".env"));
    expect(result.key).toBe("OPENAI_API_KEY");

    const content = await readFile(result.path, "utf8");
    expect(content).toContain('OPENAI_API_KEY="sk-test-1234"');
  });

  it("replaces existing key instead of duplicating", async () => {
    await writeEnvSecret({ homeDir: tempDir, key: "OPENAI_API_KEY", value: "old-value" });
    await writeEnvSecret({ homeDir: tempDir, key: "OPENAI_API_KEY", value: "new-value" });

    const content = await readFile(join(tempDir, ".estacoda", ".env"), "utf8");
    const matches = content.match(/OPENAI_API_KEY=/gu);
    expect(matches).toHaveLength(1);
    expect(content).toContain('OPENAI_API_KEY="new-value"');
  });

  it("preserves unrelated keys when replacing", async () => {
    await writeEnvSecret({ homeDir: tempDir, key: "OPENAI_API_KEY", value: "old-value" });
    await writeEnvSecret({ homeDir: tempDir, key: "DEEPSEEK_API_KEY", value: "ds-key" });

    const content = await readFile(join(tempDir, ".estacoda", ".env"), "utf8");
    expect(content).toContain('OPENAI_API_KEY="old-value"');
    expect(content).toContain('DEEPSEEK_API_KEY="ds-key"');
  });

  it("quotes special characters safely", async () => {
    await writeEnvSecret({
      homeDir: tempDir,
      key: "SPECIAL_KEY",
      value: 'val\\with"quotes\nnewline',
    });

    const content = await readFile(join(tempDir, ".estacoda", ".env"), "utf8");
    expect(content).toContain('SPECIAL_KEY="val\\\\with\\"quotes\\nnewline"');
  });

  it("sets file permissions to 0600 where supported", async () => {
    await writeEnvSecret({ homeDir: tempDir, key: "K", value: "v" });
    const s = await stat(join(tempDir, ".estacoda", ".env"));
    if (process.platform !== "win32") {
      expect(s.mode & 0o777).toBe(0o600);
    }
  });

  it("uses explicit path when provided", async () => {
    const explicitPath = join(tempDir, "custom.env");
    const result = await writeEnvSecret({ path: explicitPath, key: "K", value: "v" });
    expect(result.path).toBe(explicitPath);
    const content = await readFile(explicitPath, "utf8");
    expect(content).toContain('K="v"');
  });
});

describe("loadDotEnvSecrets", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads secrets into process.env and returns loaded keys", async () => {
    await writeEnvSecret({ homeDir: tempDir, key: "TEST_LOAD_KEY", value: "loaded-val" });
    delete process.env.TEST_LOAD_KEY;

    const loaded = await loadDotEnvSecrets({ homeDir: tempDir });
    expect(loaded).toContain("TEST_LOAD_KEY");
    expect(process.env.TEST_LOAD_KEY).toBe("loaded-val");

    delete process.env.TEST_LOAD_KEY;
  });

  it("does not override existing env vars by default", async () => {
    process.env.TEST_LOAD_KEY = "existing";
    await writeEnvSecret({ homeDir: tempDir, key: "TEST_LOAD_KEY", value: "new-val" });

    const loaded = await loadDotEnvSecrets({ homeDir: tempDir });
    expect(loaded).not.toContain("TEST_LOAD_KEY");
    expect(process.env.TEST_LOAD_KEY).toBe("existing");

    delete process.env.TEST_LOAD_KEY;
  });

  it("overrides existing env vars when override=true", async () => {
    process.env.TEST_LOAD_KEY = "existing";
    await writeEnvSecret({ homeDir: tempDir, key: "TEST_LOAD_KEY", value: "new-val" });

    const loaded = await loadDotEnvSecrets({ homeDir: tempDir, override: true });
    expect(loaded).toContain("TEST_LOAD_KEY");
    expect(process.env.TEST_LOAD_KEY).toBe("new-val");

    delete process.env.TEST_LOAD_KEY;
  });

  it("returns empty array for missing file", async () => {
    const loaded = await loadDotEnvSecrets({ homeDir: tempDir });
    expect(loaded).toEqual([]);
  });

  it("ignores comment lines", async () => {
    await writeEnvSecret({ homeDir: tempDir, key: "REAL_KEY", value: "real" });
    const path = join(tempDir, ".estacoda", ".env");
    const content = await readFile(path, "utf8");
    await writeFile(path, `# comment\n${content}`, "utf8");

    delete process.env.REAL_KEY;
    const loaded = await loadDotEnvSecrets({ homeDir: tempDir });
    expect(loaded).toContain("REAL_KEY");
    expect(process.env.REAL_KEY).toBe("real");
    delete process.env.REAL_KEY;
  });
});

describe("hasSavedEnvSecret", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.SAVED_ONLY_KEY;
    delete process.env.SHELL_ONLY_KEY;
  });

  it("detects a present saved env var without exposing its value", async () => {
    await writeEnvSecret({ homeDir: tempDir, key: "SAVED_ONLY_KEY", value: "saved-secret-value" });

    const result = await hasSavedEnvSecret({ homeDir: tempDir, key: "SAVED_ONLY_KEY" });

    expect(result).toEqual({
      path: join(tempDir, ".estacoda", ".env"),
      exists: true,
    });
    expect(JSON.stringify(result)).not.toContain("saved-secret-value");
  });

  it("detects a missing saved env var", async () => {
    await writeEnvSecret({ homeDir: tempDir, key: "SAVED_ONLY_KEY", value: "saved-secret-value" });

    await expect(hasSavedEnvSecret({ homeDir: tempDir, key: "MISSING_KEY" })).resolves.toEqual({
      path: join(tempDir, ".estacoda", ".env"),
      exists: false,
    });
  });

  it("detects empty and whitespace-only saved env vars as absent", async () => {
    const path = join(tempDir, ".estacoda", ".env");
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    await writeFile(path, [
      "EMPTY_KEY=",
      "QUOTED_EMPTY_KEY=\"\"",
      "SPACE_KEY=\"   \"",
      "",
    ].join("\n"), "utf8");

    await expect(hasSavedEnvSecret({ homeDir: tempDir, key: "EMPTY_KEY" })).resolves.toEqual({ path, exists: false });
    await expect(hasSavedEnvSecret({ homeDir: tempDir, key: "QUOTED_EMPTY_KEY" })).resolves.toEqual({ path, exists: false });
    await expect(hasSavedEnvSecret({ homeDir: tempDir, key: "SPACE_KEY" })).resolves.toEqual({ path, exists: false });
  });

  it("does not expose the secret value for direct file entries", async () => {
    const path = join(tempDir, ".estacoda", ".env");
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    await writeFile(path, "SAVED_ONLY_KEY=plain-secret-value\n", "utf8");

    const result = await hasSavedEnvSecret({ homeDir: tempDir, key: "SAVED_ONLY_KEY" });

    expect(result.exists).toBe(true);
    expect(JSON.stringify(result)).not.toContain("plain-secret-value");
  });

  it("does not treat shell env as a saved profile .env secret", async () => {
    process.env.SHELL_ONLY_KEY = "shell-secret-value";

    const result = await hasSavedEnvSecret({ homeDir: tempDir, key: "SHELL_ONLY_KEY" });

    expect(result).toEqual({
      path: join(tempDir, ".estacoda", ".env"),
      exists: false,
    });
    expect(JSON.stringify(result)).not.toContain("shell-secret-value");
  });
});

describe("defaultEnvPath", () => {
  it("returns path under homeDir when provided", () => {
    expect(defaultEnvPath("/home/user")).toBe(join("/home/user", ".estacoda", ".env"));
  });

  it("uses ESTACODA_HOME before HOME for state paths", async () => {
    const prodHome = await mkdtemp(join(tmpdir(), "estacoda-env-prod-home-"));
    const devHome = await mkdtemp(join(tmpdir(), "estacoda-env-dev-home-"));
    const originalHome = process.env.HOME;
    const originalEstacodaHome = process.env.ESTACODA_HOME;

    try {
      process.env.HOME = prodHome;
      process.env.ESTACODA_HOME = devHome;

      expect(defaultEnvPath()).toBe(join(devHome, ".estacoda", ".env"));

      const result = await writeEnvSecret({ key: "DEV_HOME_KEY", value: "value" });
      expect(result.path).toBe(join(devHome, ".estacoda", ".env"));
    } finally {
      restoreEnv("HOME", originalHome);
      restoreEnv("ESTACODA_HOME", originalEstacodaHome);
      await rm(prodHome, { recursive: true, force: true });
      await rm(devHome, { recursive: true, force: true });
    }
  });
});

function restoreEnv(key: "HOME" | "ESTACODA_HOME", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

// Helper to write file content directly for comment-line test
async function writeFile(path: string, content: string, encoding: BufferEncoding): Promise<void> {
  const { writeFile: wf } = await import("node:fs/promises");
  await wf(path, content, encoding);
}
