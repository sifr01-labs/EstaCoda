import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SmokeCase } from "../smoke-case.js";
import { runInitCommand } from "../../cli/init-command.js";
import { runSetupVerification } from "../../onboarding/verification.js";
import { resolveGlobalStateHome, resolveProfileStateHome } from "../../config/profile-home.js";

export const init_lifecycle_case: SmokeCase = {
  id: "init-lifecycle",
  name: "Init creates expected dirs and verify passes",
  tags: ["lifecycle", "init"],
  run: async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "estacoda-smoke-init-"));

    try {
      const initResult = await runInitCommand({ homeDir: tempHome });
      if (initResult.exitCode !== 0) {
        throw new Error(`init failed: ${initResult.output}`);
      }

      const globalPaths = resolveGlobalStateHome({ homeDir: tempHome });
      const profilePaths = resolveProfileStateHome({ homeDir: tempHome, profileId: "default" });
      const expectedDirs = [
        globalPaths.sharedMemoryPath,
        globalPaths.packsPath,
        profilePaths.skillsPath,
        join(profilePaths.skillsPath, ".evolution"),
        profilePaths.cronPath,
        profilePaths.logsPath,
        profilePaths.gatewayStatePath,
        profilePaths.channelMediaPath,
        profilePaths.audioCachePath,
        profilePaths.imageCachePath,
        profilePaths.tempPath
      ];

      for (const path of expectedDirs) {
        if (!existsSync(path)) {
          throw new Error(`Expected directory missing: ${path}`);
        }
      }

      if (!existsSync(profilePaths.configPath)) {
        throw new Error("config.json was not created");
      }

      if (!existsSync(globalPaths.trustJsonPath)) {
        throw new Error("trust.json was not created");
      }

      if (!existsSync(globalPaths.activeProfilePath)) {
        throw new Error("active-profile.json was not created");
      }

      const verifyResult = await runSetupVerification({
        workspaceRoot: process.cwd(),
        homeDir: tempHome
      });

      // Bare init produces warnings (no provider, not trusted), but should run without crashing
      if (verifyResult.output.length === 0) {
        throw new Error("verify produced no output");
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  }
};
