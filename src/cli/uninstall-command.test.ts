import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runUninstallCommand } from "./uninstall-command.js";
import type { InstallMethodInfo } from "../lifecycle/install-method.js";

describe("runUninstallCommand", () => {
  it("renders help without mutating", async () => {
    const result = await runUninstallCommand({ args: ["--help"] });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Usage: estacoda uninstall");
  });

  it("rejects unknown flags", async () => {
    const result = await runUninstallCommand({ args: ["--dangerous"] });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Unknown uninstall option");
  });

  it("passes --purge --yes into uninstall execution", async () => {
    const temp = mkdtempSync(join(tmpdir(), "estacoda-uninstall-command-"));
    const homeDir = join(temp, "home");
    const installDir = join(temp, "estacoda");
    await mkdir(join(homeDir, ".estacoda"), { recursive: true });
    await mkdir(installDir, { recursive: true });

    const result = await runUninstallCommand({
      args: ["--purge", "--yes"],
      homeDir,
      installMethodInfo: managedSource(installDir),
      wrapperPaths: [],
      teardownGateway: async () => ({ ok: true, message: "test teardown" })
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Mode: purge");
    expect(result.output).toContain("Removed user data");
  });
});

function managedSource(installDir: string): InstallMethodInfo {
  return {
    method: "managed-source",
    source: "stamp",
    installDir,
    sourceUrl: "https://github.com/sifr01-labs/EstaCoda.git",
    branch: "main",
    expectedBranch: "main",
    stampPath: join(installDir, ".install-method.json"),
    recommendedUpdateCommand: "estacoda update",
    canSelfUpdate: true,
    reason: "Install method stamp declares managed-source."
  };
}
