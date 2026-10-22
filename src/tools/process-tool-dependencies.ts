/** Schema exposure only. Each invocation still requires its own authorization. */
export const PROCESS_COMPANION_TOOLS = ["process.start", "process.list", "process.logs", "process.stop"] as const;

export function processCompanionNames(selected: ReadonlySet<string>): readonly string[] {
  return selected.has("terminal.run") || selected.has("process.start") ? PROCESS_COMPANION_TOOLS : [];
}
