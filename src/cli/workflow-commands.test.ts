import { describe, expect, it } from "vitest";
import { workflowCommand } from "./workflow-commands.js";

describe("workflowCommand", () => {
  it("fails explicitly after the Task persistence cutover", async () => {
    const result = await workflowCommand({ argv: [], workspaceRoot: "/tmp" } as never, ["list"]);

    expect(result).toEqual({
      handled: true,
      exitCode: 1,
      output: "Workflow commands have been retired. Durable Task commands are not available in this build yet."
    });
  });
});
