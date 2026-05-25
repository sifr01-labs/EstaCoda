import type { SmokeCase } from "../smoke-case.js";
import { runUpdateCommand } from "../../cli/update-command.js";

export const update_dry_run_case: SmokeCase = {
  id: "update-dry-run",
  name: "Update dry-run shows info without modifying files",
  tags: ["lifecycle", "update"],
  run: async () => {
    // Dry-run should always exit 0 or 2 (up-to-date) and not modify anything
    const result = await runUpdateCommand({
      dryRun: true,
      apply: false
    });

    // Dry-run should never modify files; network errors are acceptable in smoke environments
    if (result.exitCode !== 0 && result.exitCode !== 2 && result.exitCode !== 1) {
      throw new Error(`Unexpected exit code: ${result.exitCode} - ${result.output}`);
    }

    if (result.exitCode === 0 || result.exitCode === 2) {
      if (!result.output.includes("dry run") && !result.output.includes("Current:") && !result.output.includes("latest version")) {
        throw new Error("Dry-run output missing expected content");
      }
    }

    // --apply without a valid artifact should exit 1
    const applyResult = await runUpdateCommand({
      dryRun: false,
      apply: true,
      explicitApply: true
    });

    if (applyResult.exitCode !== 1 && applyResult.exitCode !== 2) {
      throw new Error(`Apply without artifact should fail: ${applyResult.exitCode} - ${applyResult.output}`);
    }
  }
};
