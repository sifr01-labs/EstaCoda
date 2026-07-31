import type { SmokeCase } from "../smoke-case.js";
import { launchInteractiveSession } from "../../cli/interactive-launcher.js";

export const bare_launch_case: SmokeCase = {
  id: "bare-launch",
  name: "Bare launch returns appropriate status",
  tags: ["lifecycle", "launch"],
  run: async () => {
    const result = await launchInteractiveSession({
      workspaceRoot: process.cwd()
    });

    // In CI or non-TTY, it should report that TTY is required.
    // In a TTY, it returns a typed launch, setup, or clean-exit action.
    if (!result.launched && result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(`Unexpected bare launch result: ${result.exitCode} - ${result.output}`);
    }
  }
};
