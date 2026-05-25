import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("installer scripts", () => {
  it("renders standalone installer help without mutating HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "estacoda-install-help-home-"));
    try {
      const result = await execFileAsync("bash", [resolve(process.cwd(), "scripts/install.sh"), "--help"], {
        encoding: "utf8",
        env: { ...process.env, HOME: home }
      });

      expect(result.stdout).toContain("EstaCoda source installer");
      expect(result.stdout).toContain("--branch <branch>");
      expect(result.stdout).toContain("--skip-init");
      expect(result.stderr).toBe("");
      await expect(readdir(home)).resolves.toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("renders manual setup help without mutating HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "estacoda-setup-help-home-"));
    try {
      const result = await execFileAsync("bash", [resolve(process.cwd(), "scripts/setup-estacoda.sh"), "--help"], {
        encoding: "utf8",
        env: { ...process.env, HOME: home }
      });

      expect(result.stdout).toContain("EstaCoda manual source setup");
      expect(result.stdout).toContain("--skip-init");
      expect(result.stderr).toBe("");
      await expect(readdir(home)).resolves.toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
