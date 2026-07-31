import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SmokeCase } from "../smoke-case.js";
import { ensureDefaultProfileState } from "../../cli/profile-state.js";
import { resolveGlobalStateHome, resolveProfileStateHome } from "../../config/profile-home.js";
import { runSetupVerification } from "../../setup/verification.js";
import { ensureGlobalStateDirectories } from "../../storage/state-bootstrap.js";

export const state_bootstrap_case: SmokeCase = {
  id: "state-bootstrap",
  name: "First-run bootstrap creates non-authorizing state",
  tags: ["lifecycle", "setup"],
  run: async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "estacoda-smoke-bootstrap-"));

    try {
      await ensureGlobalStateDirectories({ homeDir: tempHome });
      await ensureDefaultProfileState({ homeDir: tempHome });

      const globalPaths = resolveGlobalStateHome({ homeDir: tempHome });
      const profilePaths = resolveProfileStateHome({ homeDir: tempHome, profileId: "default" });
      const expectedDirs = [
        globalPaths.sharedMemoryPath,
        globalPaths.packsPath,
        profilePaths.skillsPath,
        join(profilePaths.skillsPath, ".evolution"),
        profilePaths.cronPath,
        join(profilePaths.cronPath, "output"),
        join(profilePaths.cronPath, "locks"),
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

      if (existsSync(globalPaths.trustJsonPath)) {
        throw new Error("bootstrap must not create workspace trust state");
      }

      if (!existsSync(globalPaths.activeProfilePath)) {
        throw new Error("active-profile.json was not created");
      }

      const verifyResult = await runSetupVerification({
        workspaceRoot: process.cwd(),
        homeDir: tempHome
      });

      if (verifyResult.output.length === 0) {
        throw new Error("verify produced no output");
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  }
};
