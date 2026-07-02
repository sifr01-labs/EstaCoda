import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";

export type ExternalToolDiagnostic = {
  readonly status: "ready" | "warning";
  readonly available: readonly string[];
  readonly missingRequired: readonly string[];
  readonly missingOptional: readonly string[];
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
};

export type CommandExists = (command: string) => Promise<boolean>;

const REQUIRED_TOOLS = ["git", "node", "pnpm", "rg"] as const;
const OPTIONAL_TOOLS = ["docker", "ssh", "python3"] as const;

export async function diagnoseExternalTools(options: {
  readonly commandExists?: CommandExists;
} = {}): Promise<ExternalToolDiagnostic> {
  const commandExists = options.commandExists ?? defaultCommandExists;
  const available: string[] = [];
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];

  for (const tool of REQUIRED_TOOLS) {
    if (await commandExists(tool)) {
      available.push(tool);
    } else {
      missingRequired.push(tool);
    }
  }
  for (const tool of OPTIONAL_TOOLS) {
    if (await commandExists(tool)) {
      available.push(tool);
    } else {
      missingOptional.push(tool);
    }
  }

  const warnings = missingRequired.length > 0
    ? [`Required external tools are missing: ${missingRequired.join(", ")}`]
    : [];
  const notes = missingOptional.length > 0
    ? [`Optional external tools not found: ${missingOptional.join(", ")}`]
    : [];

  return {
    status: warnings.length > 0 ? "warning" : "ready",
    available,
    missingRequired,
    missingOptional,
    warnings,
    notes
  };
}

async function defaultCommandExists(command: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.trim().length === 0) continue;
    try {
      await access(join(directory, command), constants.X_OK);
      return true;
    } catch {
      // Keep probing PATH entries.
    }
  }
  return false;
}
