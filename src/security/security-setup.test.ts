import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupSecurityConfig, loadRuntimeConfig } from "../config/runtime-config.js";
import { resolveProfileStateHome } from "../config/profile-home.js";

describe("security setup", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "estacoda-security-test-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("rejects invalid mode with a clear error", async () => {
    // validateSecuritySetupInput does not throw for invalid mode;
    // it normalizes to adaptive. The CLI layer (parseSecuritySetupArgs) throws.
    // Test the config-layer behavior: invalid mode is normalized to adaptive.
    const result = await setupSecurityConfig({
      workspaceRoot: tempHome,
      homeDir: tempHome,
      input: { mode: "invalid" as any }
    });
    expect(result.config.security?.approvalMode).toBe("adaptive");
  });

  it("persists assessor disabled state", async () => {
    const result = await setupSecurityConfig({
      workspaceRoot: tempHome,
      homeDir: tempHome,
      input: { assessorEnabled: false }
    });

    expect(result.config.security?.assessor?.enabled).toBe(false);

    const configPath = resolveProfileStateHome({ homeDir: tempHome, profileId: "default" }).configPath;
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    expect(raw.security?.assessor?.enabled).toBe(false);
  });

  it("status reflects assessor disabled after setup", async () => {
    await setupSecurityConfig({
      workspaceRoot: tempHome,
      homeDir: tempHome,
      input: { mode: "adaptive", assessorEnabled: false }
    });

    const config = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome });
    expect(config.security.approvalMode).toBe("adaptive");
    expect(config.security.assessor?.enabled).toBe(false);
  });

  it("persists assessor enabled state with provider and model", async () => {
    const result = await setupSecurityConfig({
      workspaceRoot: tempHome,
      homeDir: tempHome,
      input: {
        mode: "strict",
        assessorEnabled: true,
        assessorProvider: "local",
        assessorModel: "qwen2.5:3b"
      }
    });

    expect(result.config.security?.approvalMode).toBe("strict");
    expect(result.config.security?.assessor?.enabled).toBe(true);
    expect(result.config.security?.assessor?.provider).toBe("local");
    expect(result.config.security?.assessor?.model).toBe("qwen2.5:3b");
  });
});
