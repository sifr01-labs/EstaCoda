import type { CliCommandResult, CliOptions } from "./cli.js";

/**
 * Workflow persistence was removed by the Task schema cutover. Keep the command
 * boundary explicit until the Task operator surface replaces this registration;
 * never reopen the retired tables or silently run an in-memory Workflow.
 */
export async function workflowCommand(
  _options: CliOptions,
  _args: string[]
): Promise<CliCommandResult> {
  return {
    handled: true,
    exitCode: 1,
    output: "Workflow commands have been retired. Durable Task commands are not available in this build yet."
  };
}
