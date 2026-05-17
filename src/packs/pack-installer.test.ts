import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installPack,
  enablePack,
  disablePack,
  uninstallPack
} from "./pack-installer.js";
import { PackRegistry } from "./pack-registry.js";
import { resolveProfileStateHome, writeActiveProfile } from "../config/profile-home.js";
import type { PackManifest } from "../contracts/pack.js";

function makeManifest(overrides?: Partial<PackManifest>): PackManifest {
  return {
    id: "test-sp",
    name: "Test pack",
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
    provenance: {
      origin: "local",
      trustLevel: "local_user"
    },
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
  writeFileSync(join(dir, "SKILL.md"), "# Test Skill\n", "utf8");
}

function packSkillsPath(homeDir: string, packId: string): string {
  return join(resolveProfileStateHome({ homeDir, profileId: "default" }).skillsPath, "packs", packId);
}

describe("pack-installer", () => {
  let tmpDir: string;
  let sourceDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "estacoda-sp-inst-test-"));
    sourceDir = join(tmpDir, "source-pack");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("installs a local pack as enabled", async () => {
    const manifest = makeManifest();
    writePack(sourceDir, manifest);

    const result = await installPack({
      homeDir: tmpDir,
      sourcePath: sourceDir,
      actor: "test-user"
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Installed pack: Test pack (test-sp)");
    expect(result.output).toContain("Status: enabled");

    const skillsDest = packSkillsPath(tmpDir, "test-sp");
    expect(existsSync(skillsDest)).toBe(true);
    expect(existsSync(join(skillsDest, "SKILL.md"))).toBe(true);

    const registry = new PackRegistry({ homeDir: tmpDir });
    const entry = await registry.find("test-sp");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("enabled");
  });

  it("installs enabled pack skills into the selected profile", async () => {
    const manifest = makeManifest();
    writePack(sourceDir, manifest);
    writeActiveProfile("research", { homeDir: tmpDir });

    const result = await installPack({
      homeDir: tmpDir,
      sourcePath: sourceDir,
      actor: "test-user"
    });

    expect(result.ok).toBe(true);
    const selectedProfileDest = join(resolveProfileStateHome({ homeDir: tmpDir, profileId: "research" }).skillsPath, "packs", "test-sp");
    const defaultProfileDest = packSkillsPath(tmpDir, "test-sp");
    expect(existsSync(join(selectedProfileDest, "SKILL.md"))).toBe(true);
    expect(existsSync(defaultProfileDest)).toBe(false);
  });

  it("installs an external pack as disabled", async () => {
    const manifest = makeManifest({
      provenance: { origin: "external", trustLevel: "external_reviewed" }
    });
    writePack(sourceDir, manifest);

    const prompt = async (question: string) => "yes";

    const result = await installPack({
      homeDir: tmpDir,
      sourcePath: sourceDir,
      actor: "test-user",
      prompt
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Status: disabled");

    const skillsDest = packSkillsPath(tmpDir, "test-sp");
    expect(existsSync(skillsDest)).toBe(false);

    const registry = new PackRegistry({ homeDir: tmpDir });
    const entry = await registry.find("test-sp");
    expect(entry!.status).toBe("disabled");
  });

  it("installs external low-risk pack as disabled without confirmation", async () => {
    const manifest = makeManifest({
      provenance: { origin: "external", trustLevel: "first_party" }
    });
    writePack(sourceDir, manifest);

    // No prompt provided — should not require interaction for low risk
    const result = await installPack({
      homeDir: tmpDir,
      sourcePath: sourceDir,
      actor: "test-user"
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Status: disabled");

    const registry = new PackRegistry({ homeDir: tmpDir });
    const entry = await registry.find("test-sp");
    expect(entry!.status).toBe("disabled");
  });

  it("installs medium-risk local pack as disabled after confirmation", async () => {
    const manifest = makeManifest({
      provenance: { origin: "local", trustLevel: "local_user" },
      permissions: {
        filesystem: { read: ["."] },
        shell: { allowedCommands: [], requiresApproval: true },
        network: { allowedHosts: ["example.com"], requiresApproval: true },
        secrets: { requiredEnvironmentVariables: [], requiredCredentialFiles: [] },
        memory: { canRead: false, canWrite: false, requiresPromotionApproval: true },
        channels: { canSendMessages: false, canReceiveMessages: false, requiresApproval: true }
      },
      sandbox: {
        defaultMode: "deny",
        filesystemMode: "read_only",
        shellMode: "deny",
        networkMode: "allow_list",
        secretsMode: "deny"
      }
    });
    writePack(sourceDir, manifest);

    const prompt = async (question: string) => "yes";

    const result = await installPack({
      homeDir: tmpDir,
      sourcePath: sourceDir,
      actor: "test-user",
      prompt
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Status: disabled");
    expect(result.output).toContain("Risk: medium");

    const skillsDest = packSkillsPath(tmpDir, "test-sp");
    expect(existsSync(skillsDest)).toBe(false);

    const registry = new PackRegistry({ homeDir: tmpDir });
    const entry = await registry.find("test-sp");
    expect(entry!.status).toBe("disabled");
  });

  it("installs high-risk local pack as disabled after confirmation", async () => {
    const manifest = makeManifest({
      provenance: { origin: "local", trustLevel: "local_user" },
      permissions: {
        filesystem: { read: ["."], write: ["/tmp"] },
        shell: { allowedCommands: ["ls"], requiresApproval: true },
        network: { allowedHosts: [], requiresApproval: true },
        secrets: { requiredEnvironmentVariables: [], requiredCredentialFiles: [] },
        memory: { canRead: false, canWrite: false, requiresPromotionApproval: true },
        channels: { canSendMessages: false, canReceiveMessages: false, requiresApproval: true }
      },
      sandbox: {
        defaultMode: "deny",
        filesystemMode: "scoped_write",
        shellMode: "allow_list",
        networkMode: "deny",
        secretsMode: "deny"
      }
    });
    writePack(sourceDir, manifest);

    const prompt = async (question: string) => "yes";

    const result = await installPack({
      homeDir: tmpDir,
      sourcePath: sourceDir,
      actor: "test-user",
      prompt
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Status: disabled");
    expect(result.output).toContain("Risk: high");

    const skillsDest = packSkillsPath(tmpDir, "test-sp");
    expect(existsSync(skillsDest)).toBe(false);

    const registry = new PackRegistry({ homeDir: tmpDir });
    const entry = await registry.find("test-sp");
    expect(entry!.status).toBe("disabled");
  });

  it("rejects blocked pack without --force", async () => {
    const manifest = makeManifest({
      permissions: {
        filesystem: { write: ["/"] },
        shell: { allowedCommands: ["*"], requiresApproval: false },
        network: { allowedHosts: ["*"], requiresApproval: false },
        secrets: { requiredEnvironmentVariables: ["*"], requiredCredentialFiles: [] },
        memory: { canRead: false, canWrite: false, requiresPromotionApproval: true },
        channels: { canSendMessages: false, canReceiveMessages: false, requiresApproval: true }
      },
      sandbox: {
        defaultMode: "deny",
        filesystemMode: "scoped_write",
        shellMode: "allow_list",
        networkMode: "allow_list",
        secretsMode: "explicit_only"
      }
    });
    writePack(sourceDir, manifest);

    const result = await installPack({
      homeDir: tmpDir,
      sourcePath: sourceDir,
      actor: "test-user"
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("Blocked");
  });

  it("--force with correct typed confirmation proceeds and writes audit record", async () => {
    const manifest = makeManifest({
      permissions: {
        filesystem: { write: ["/"] },
        shell: { allowedCommands: ["*"], requiresApproval: false },
        network: { allowedHosts: ["*"], requiresApproval: false },
        secrets: { requiredEnvironmentVariables: ["*"], requiredCredentialFiles: [] },
        memory: { canRead: false, canWrite: false, requiresPromotionApproval: true },
        channels: { canSendMessages: false, canReceiveMessages: false, requiresApproval: true }
      },
      sandbox: {
        defaultMode: "deny",
        filesystemMode: "scoped_write",
        shellMode: "allow_list",
        networkMode: "allow_list",
        secretsMode: "explicit_only"
      }
    });
    writePack(sourceDir, manifest);

    const prompt = async (question: string) => {
      if (question.includes("Type the pack id")) return "test-sp";
      return "";
    };

    const result = await installPack({
      homeDir: tmpDir,
      sourcePath: sourceDir,
      actor: "test-user",
      force: true,
      prompt
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Status: disabled");

    const registry = new PackRegistry({ homeDir: tmpDir });
    const entry = await registry.find("test-sp");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("disabled");

    const auditPath = join(tmpDir, ".estacoda", "packs", "audit", "force-overrides.jsonl");
    expect(existsSync(auditPath)).toBe(true);
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    const record = JSON.parse(lines[lines.length - 1]);
    expect(record.packId).toBe("test-sp");
    expect(record.overrideActor).toBe("test-user");
  });

  it("--force with wrong typed confirmation aborts", async () => {
    const manifest = makeManifest({
      permissions: {
        filesystem: { write: ["/"] },
        shell: { allowedCommands: ["*"], requiresApproval: false },
        network: { allowedHosts: ["*"], requiresApproval: false },
        secrets: { requiredEnvironmentVariables: ["*"], requiredCredentialFiles: [] },
        memory: { canRead: false, canWrite: false, requiresPromotionApproval: true },
        channels: { canSendMessages: false, canReceiveMessages: false, requiresApproval: true }
      },
      sandbox: {
        defaultMode: "deny",
        filesystemMode: "scoped_write",
        shellMode: "allow_list",
        networkMode: "allow_list",
        secretsMode: "explicit_only"
      }
    });
    writePack(sourceDir, manifest);

    const prompt = async (question: string) => {
      if (question.includes("Type the pack id")) return "wrong-id";
      return "";
    };

    const result = await installPack({
      homeDir: tmpDir,
      sourcePath: sourceDir,
      actor: "test-user",
      force: true,
      prompt
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("Override aborted");
  });

  it("enable copies skills and updates status", async () => {
    const manifest = makeManifest();
    writePack(sourceDir, manifest);

    await installPack({
      homeDir: tmpDir,
      sourcePath: sourceDir,
      actor: "test-user"
    });

    // First disable so we can test enable
    const { disablePack } = await import("./pack-installer.js");
    await disablePack({ homeDir: tmpDir, id: "test-sp" });

    const result = await enablePack({
      homeDir: tmpDir,
      id: "test-sp",
      actor: "test-user"
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Enabled pack");

    const skillsDest = packSkillsPath(tmpDir, "test-sp");
    expect(existsSync(skillsDest)).toBe(true);
    expect(existsSync(join(skillsDest, "SKILL.md"))).toBe(true);

    const registry = new PackRegistry({ homeDir: tmpDir });
    const entry = await registry.find("test-sp");
    expect(entry!.status).toBe("enabled");
  });

  it("disable removes skills and updates status", async () => {
    const manifest = makeManifest();
    writePack(sourceDir, manifest);

    await installPack({
      homeDir: tmpDir,
      sourcePath: sourceDir,
      actor: "test-user"
    });

    const result = await disablePack({
      homeDir: tmpDir,
      id: "test-sp"
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Disabled pack");

    const skillsDest = packSkillsPath(tmpDir, "test-sp");
    expect(existsSync(skillsDest)).toBe(false);

    const registry = new PackRegistry({ homeDir: tmpDir });
    const entry = await registry.find("test-sp");
    expect(entry!.status).toBe("disabled");
  });

  it("uninstall backs up, removes registry entry, and deletes files", async () => {
    const manifest = makeManifest();
    writePack(sourceDir, manifest);

    await installPack({
      homeDir: tmpDir,
      sourcePath: sourceDir,
      actor: "test-user"
    });

    const result = await uninstallPack({
      homeDir: tmpDir,
      id: "test-sp",
      actor: "test-user"
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Uninstalled pack");

    const packPath = join(tmpDir, ".estacoda", "packs", "test-sp");
    expect(existsSync(packPath)).toBe(false);

    const registry = new PackRegistry({ homeDir: tmpDir });
    const entry = await registry.find("test-sp");
    expect(entry).toBeUndefined();

    const backupsDir = join(tmpDir, ".estacoda", "packs", "backups");
    expect(existsSync(backupsDir)).toBe(true);
  });

  it("uninstall with --keep-files preserves pack files", async () => {
    const manifest = makeManifest();
    writePack(sourceDir, manifest);

    await installPack({
      homeDir: tmpDir,
      sourcePath: sourceDir,
      actor: "test-user"
    });

    const result = await uninstallPack({
      homeDir: tmpDir,
      id: "test-sp",
      actor: "test-user",
      keepFiles: true
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Pack files preserved");

    const packPath = join(tmpDir, ".estacoda", "packs", "test-sp");
    expect(existsSync(packPath)).toBe(true);

    const registry = new PackRegistry({ homeDir: tmpDir });
    expect(await registry.find("test-sp")).toBeUndefined();
  });

  it("requires pack.json", async () => {
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "README.md"), "# No manifest\n", "utf8");

    const result = await installPack({
      homeDir: tmpDir,
      sourcePath: sourceDir,
      actor: "test-user"
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("pack.json not found");
  });

  it("shows eval hooks informational note when evals are defined", async () => {
    const manifest = makeManifest({
      evals: [{ name: "test-eval", command: "echo test", description: "A test eval" }]
    });
    writePack(sourceDir, manifest);

    const result = await installPack({
      homeDir: tmpDir,
      sourcePath: sourceDir,
      actor: "test-user"
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Eval hooks are not executed in EstaCoda v0.1.0");
  });
});
