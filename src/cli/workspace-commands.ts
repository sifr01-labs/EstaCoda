import { workspaceChangeSummary } from "../ui/workspace-change-summary.js";
import { ChangeApplicationStore } from "../workspaces/change-application.js";
import { ChangeAuthorizationStore, parseApplicationPlan } from "../workspaces/change-authorization.js";
import { ChangeArtifactStore } from "../workspaces/change-artifact.js";
import { prepareTemporaryCopy } from "../workspaces/temporary-copy.js";
import { readFileSync, statSync } from "node:fs";
import { readActiveProfile } from "../config/profile-home.js";
import { WorkspaceRegistry } from "../workspaces/workspace-registry.js";
import type { CliCommandResult, CliOptions } from "./cli.js";

const help = [
  "estacoda workspace finish <copy-target-id>",
  "estacoda workspace recover <change-artifact-id>",
  "estacoda workspace apply <change-artifact-id>",
  "estacoda workspace changes <copy-target-id>",
  "estacoda workspace copy <source-alias> <new-directory> <manifest.json>",
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
  const json = args.includes("--json");
  args = args.filter((arg) => arg !== "--json");
  const [command, selector, value] = args;
  if (!command || args.includes("--help") || args.includes("-h")) return { handled: true, exitCode: 0, output: help };
  if (["finish", "apply", "recover"].includes(command) && args.length === 2) {
    const store = new ChangeApplicationStore({ homeDir: options.homeDir, profileId: options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId });
    try {
      const result = command === "finish" ? await store.finish(selector!, selector!) : command === "recover" ? await store.recover(selector!) : await store.apply(selector!);
      return { handled: true, exitCode: ["attention", "conflict"].includes(result.status) ? 1 : 0, output: json ? JSON.stringify(result, null, 2) : workspaceChangeSummary(result) };
    } catch (error) { return { handled: true, exitCode: 1, output: error instanceof Error ? error.message : String(error) }; }
    finally { store.close(); }
  }
  if (command === "changes" && args.length === 2) {
    const store = new ChangeArtifactStore({ homeDir: options.homeDir, profileId: options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId });
    try { return { handled: true, exitCode: 0, output: JSON.stringify(await store.export(selector!, selector!), null, 2) }; }
    catch (error) { return { handled: true, exitCode: 1, output: error instanceof Error ? error.message : String(error) }; }
    finally { store.close(); }
  }
  if (command === "copy" && args.length === 4) {
    try {
      if (statSync(args[3]!).size > 1024 * 1024) throw new Error("Manifest is too large.");
      const manifest = JSON.parse(readFileSync(args[3]!, "utf8"));
      const application = parseApplicationPlan(manifest.application ?? { version: 1, outcome: "review", paths: [] });
      const target = await prepareTemporaryCopy({ homeDir: options.homeDir, profileId: options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId,
        source: selector!, destination: value!, manifest });
      const authority = new ChangeAuthorizationStore({ homeDir: options.homeDir, profileId: target.profileId });
      try { await authority.authorize(target.id, application); } finally { authority.close(); }
      return { handled: true, exitCode: 0, output: JSON.stringify(target, null, 2) };
    } catch (error) { return { handled: true, exitCode: 1, output: error instanceof Error ? error.message : String(error) }; }
  }
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
