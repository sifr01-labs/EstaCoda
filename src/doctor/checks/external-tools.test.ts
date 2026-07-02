import { describe, expect, it } from "vitest";
import { diagnoseExternalTools } from "./external-tools.js";

describe("diagnoseExternalTools", () => {
  it("reports required tools as ready when they are available", async () => {
    const diagnostic = await diagnoseExternalTools({
      commandExists: async (command) => ["git", "node", "pnpm", "rg"].includes(command)
    });

    expect(diagnostic.status).toBe("ready");
    expect(diagnostic.missingRequired).toEqual([]);
    expect(diagnostic.missingOptional).toEqual(["docker", "ssh", "python3"]);
    expect(diagnostic.warnings).toEqual([]);
    expect(diagnostic.notes).toEqual(["Optional external tools not found: docker, ssh, python3"]);
  });

  it("warns when required tools are missing without probing optional tools over the network", async () => {
    const seen: string[] = [];
    const diagnostic = await diagnoseExternalTools({
      commandExists: async (command) => {
        seen.push(command);
        return command === "git" || command === "node";
      }
    });

    expect(seen).toEqual(["git", "node", "pnpm", "rg", "docker", "ssh", "python3"]);
    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.missingRequired).toEqual(["pnpm", "rg"]);
    expect(diagnostic.warnings).toEqual(["Required external tools are missing: pnpm, rg"]);
  });
});
