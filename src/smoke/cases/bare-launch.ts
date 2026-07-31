import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SmokeCase } from "../smoke-case.js";
import { launchInteractiveSession } from "../../cli/interactive-launcher.js";

export const bare_launch_case: SmokeCase = {
  id: "bare-launch",
  name: "Bare first launch selects onboarding",
  tags: ["lifecycle", "launch"],
  run: async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-smoke-bare-launch-"));
    const workspaceRoot = join(tempHome, "workspace");

    try {
      await mkdir(workspaceRoot, { recursive: true });
      const result = await launchInteractiveSession({
        workspaceRoot,
        homeDir: tempHome,
        canRunInteractive: () => true,
      });

      if (result.kind !== "run-setup" || result.setupMode !== "onboarding") {
        throw new Error(`Expected bare first launch to select onboarding, got ${result.kind}: ${result.output}`);
      }
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  }
};
