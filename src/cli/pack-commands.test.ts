import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { packCommand } from "./pack-commands.js";
import { installPack } from "../packs/pack-installer.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import type { PackManifest } from "../contracts/pack.js";

function makeManifest(overrides?: Partial<PackManifest>): PackManifest {
  return {
    id: "cli-sp",
    name: "CLI Test Pack",
    version: "1.0.0",
    description: "A test pack",
    packType: "skill_pack",
    entrypoints: { skills: ["SKILL.md"] },
    permissions: {
      filesystem: { read: ["."] },
      shell: { allowedCommands: [], requiresApproval: true },
      network: { allowedHosts: [], requiresApproval: true },
      secrets: { requiredEnvironmentVariables: [], requiredCredentialFiles: [] },
      memory: { canRead: false, canWrite: false, requiresPromotionApproval: true },
      channels: { canSendMessages: false, canReceiveMessages: false, requiresApproval: true }
    },
    provenance: { origin: "local", trustLevel: "local_user" },
    sandbox: {
      defaultMode: "deny",
      filesystemMode: "read_only",
      shellMode: "deny",
      networkMode: "deny",
      secretsMode: "deny"
    },
    ...overrides
  };
}

function writePack(dir: string, manifest: PackManifest): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pack.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function packSkillsPath(homeDir: string, packId: string): string {
  return join(resolveProfileStateHome({ homeDir, profileId: "default" }).skillsPath, "packs", packId);
}

describe("packCommand", () => {
  let tmpDir: string;
  let sourceDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "estacoda-packs-cmd-test-"));
    sourceDir = join(tmpDir, "source-pack");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists installed packs", async () => {
    const manifest = makeManifest();
    writePack(sourceDir, manifest);
    await installPack({ homeDir: tmpDir, sourcePath: sourceDir, actor: "test" });

    const result = await packCommand(
      { argv: ["packs", "list"], workspaceRoot: process.cwd(), homeDir: tmpDir },
      ["list"]
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("cli-sp");
    expect(result.output).toContain("CLI Test Pack");
  });

  it("inspects a pack", async () => {
    const manifest = makeManifest({
      evals: [{ name: "test-eval", command: "echo test" }]
    });
    writePack(sourceDir, manifest);
    await installPack({ homeDir: tmpDir, sourcePath: sourceDir, actor: "test" });

    const result = await packCommand(
      { argv: ["packs", "inspect"], workspaceRoot: process.cwd(), homeDir: tmpDir },
      ["inspect", "cli-sp"]
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("\"id\": \"cli-sp\"");
    expect(result.output).toContain("\"status\": \"enabled\"");
    expect(result.output).toContain("Eval hooks are not executed in EstaCoda v0.1.0");
  });

  it("returns error for missing inspect id", async () => {
    const result = await packCommand(
      { argv: ["packs", "inspect"], workspaceRoot: process.cwd(), homeDir: tmpDir },
      ["inspect"]
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage: estacoda packs inspect <id>");
  });

  it("returns error for missing pack on inspect", async () => {
    const result = await packCommand(
      { argv: ["packs", "inspect"], workspaceRoot: process.cwd(), homeDir: tmpDir },
      ["inspect", "missing"]
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("pack not found: missing");
  });

  it("installs from path", async () => {
    const manifest = makeManifest();
    writePack(sourceDir, manifest);

    const result = await packCommand(
      { argv: ["packs", "install"], workspaceRoot: process.cwd(), homeDir: tmpDir },
      ["install", sourceDir]
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Installed pack");
  });

  it("returns error for missing install path", async () => {
    const result = await packCommand(
      { argv: ["packs", "install"], workspaceRoot: process.cwd(), homeDir: tmpDir },
      ["install"]
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage: estacoda packs install <path>");
  });

  it("enables a disabled pack", async () => {
    const manifest = makeManifest();
    writePack(sourceDir, manifest);
    await installPack({ homeDir: tmpDir, sourcePath: sourceDir, actor: "test" });

    // Disable first so we can test enable
    await packCommand(
      { argv: ["packs", "disable"], workspaceRoot: process.cwd(), homeDir: tmpDir },
      ["disable", "cli-sp"]
    );

    const result = await packCommand(
      { argv: ["packs", "enable"], workspaceRoot: process.cwd(), homeDir: tmpDir },
      ["enable", "cli-sp"]
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Enabled pack");
    expect(existsSync(join(tmpDir, ".estacoda", "packs", "cli-sp"))).toBe(true);
  });

  it("disables an enabled pack", async () => {
    const manifest = makeManifest();
    writePack(sourceDir, manifest);
    await installPack({ homeDir: tmpDir, sourcePath: sourceDir, actor: "test" });

    const result = await packCommand(
      { argv: ["packs", "disable"], workspaceRoot: process.cwd(), homeDir: tmpDir },
      ["disable", "cli-sp"]
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Disabled pack");
    expect(existsSync(packSkillsPath(tmpDir, "cli-sp"))).toBe(false);
  });

  it("uninstalls a pack", async () => {
    const manifest = makeManifest();
    writePack(sourceDir, manifest);
    await installPack({ homeDir: tmpDir, sourcePath: sourceDir, actor: "test" });

    const result = await packCommand(
      { argv: ["packs", "uninstall"], workspaceRoot: process.cwd(), homeDir: tmpDir },
      ["uninstall", "cli-sp"]
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Uninstalled pack");
    expect(existsSync(packSkillsPath(tmpDir, "cli-sp"))).toBe(false);
  });

  it("uninstall with --keep-files preserves files", async () => {
    const manifest = makeManifest();
    writePack(sourceDir, manifest);
    await installPack({ homeDir: tmpDir, sourcePath: sourceDir, actor: "test" });

    const result = await packCommand(
      { argv: ["packs", "uninstall"], workspaceRoot: process.cwd(), homeDir: tmpDir },
      ["uninstall", "cli-sp", "--keep-files"]
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Pack files preserved");
    expect(existsSync(join(tmpDir, ".estacoda", "packs", "cli-sp"))).toBe(true);
  });

  it("shows usage for unknown subcommand", async () => {
    const result = await packCommand(
      { argv: ["packs"], workspaceRoot: process.cwd(), homeDir: tmpDir },
      []
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage: estacoda packs <subcommand>");
  });
});
