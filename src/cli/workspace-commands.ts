import { readActiveProfile } from "../config/profile-home.js";
import { WorkspaceRegistry } from "../workspaces/workspace-registry.js";
import type { CliCommandResult, CliOptions } from "./cli.js";

const help = [
  "estacoda workspace add <alias> [path]",
  "estacoda workspace list",
  "estacoda workspace show <alias-or-id>",
  "estacoda workspace rename <alias-or-id> <new-alias>",
  "estacoda workspace move <alias-or-id> <existing-path>",
  "estacoda workspace remove <alias-or-id>",
  "estacoda workspace open <alias-or-id>",
  "estacoda --workspace <alias> [prompt]",
  "Names are profile-local. Registration and moves do not grant trust or move files.",
].join("\n");

export async function workspaceCommand(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [command, selector, value] = args;
  if (!command || args.includes("--help") || args.includes("-h")) return { handled: true, exitCode: 0, output: help };
  const count = command === "list" ? [1] : command === "add" ? [2, 3] : ["rename", "move"].includes(command) ? [3] : [2];
  if (!["add", "list", "show", "rename", "move", "remove", "open"].includes(command) || !count.includes(args.length)) {
    return { handled: true, exitCode: 1, output: help };
  }
  let registry: WorkspaceRegistry | undefined;
  try {
    registry = new WorkspaceRegistry({ homeDir: options.homeDir, profileId: options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId });
    if (command === "list") return { handled: true, exitCode: 0, output: registry.list().map((entry) => `${entry.alias}\t${entry.identity.canonicalPath}\t${entry.id}`).join("\n") || "No registered workspaces." };
    if (command === "remove") {
      registry.remove(selector);
      return { handled: true, exitCode: 0, output: "Workspace registration removed. Files and existing sessions are retained." };
    }
    const record = command === "add" ? await registry.add(selector, value ?? options.workspaceRoot)
      : command === "rename" ? registry.rename(selector, value)
      : command === "open" ? await registry.resolve(selector)
      : registry.get(selector);
    if (!record) throw new Error("Workspace not found in the selected profile.");
    const updated = command === "move" ? await registry.move(record.id, value, record.locationRevision) : record;
    return { handled: true, exitCode: 0, output: command === "open" ? "" : JSON.stringify(updated, null, 2),
      ...(command === "open" ? { workspaceHandoff: updated } : {}) };
  } catch (error) {
    return { handled: true, exitCode: 1, output: error instanceof Error ? error.message : String(error) };
  } finally { registry?.close(); }
}
