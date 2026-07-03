import { describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectInstallMethod } from "./install-method.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "estacoda-install-method-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("detectInstallMethod", () => {
  it("detects managed-source stamps as self-updatable", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, ".install-method.json"), JSON.stringify({
        method: "managed-source",
        sourceUrl: "https://github.com/sifr01-labs/EstaCoda.git",
        branch: "main",
        installDir: dir
      }));

      const result = await detectInstallMethod({ cwd: dir, includeRuntimeHints: false, pathHints: [] });

      expect(result.method).toBe("managed-source");
      expect(result.source).toBe("stamp");
      expect(result.canSelfUpdate).toBe(true);
      expect(result.sourceUrl).toBe("https://github.com/sifr01-labs/EstaCoda.git");
      expect(result.branch).toBe("main");
      expect(result.expectedBranch).toBe("main");
      expect(result.installDir).toBe(dir);
      expect(result.recommendedUpdateCommand).toBe("estacoda update");
    });
  });

  it("detects manual-source stamps as non-self-updatable", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, ".install-method.json"), JSON.stringify({
        method: "manual-source",
        sourceUrl: "git@github.com:sifr01-labs/EstaCoda.git",
        branch: "feature/local",
        installDir: dir
      }));

      const result = await detectInstallMethod({ cwd: dir, includeRuntimeHints: false, pathHints: [] });

      expect(result.method).toBe("manual-source");
      expect(result.source).toBe("stamp");
      expect(result.canSelfUpdate).toBe(false);
      expect(result.recommendedUpdateCommand).toBe("git fetch origin && git status");
    });
  });

  it("ignores invalid stamps and falls back safely", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, ".install-method.json"), "{not-json");

      const result = await detectInstallMethod({
        cwd: dir,
        includeRuntimeHints: false,
        pathHints: [],
        containerProbe: {
          dockerEnvPath: join(dir, "missing-docker"),
          containerEnvPath: join(dir, "missing-container"),
          cgroupPath: join(dir, "missing-cgroup")
        }
      });

      expect(result.method).toBe("unknown");
      expect(result.canSelfUpdate).toBe(false);
      expect(result.recommendedUpdateCommand).toBe("reinstall using documented install path");
      expect(result.reason).toContain("Invalid install method stamp");
    });
  });

  it("does not trust managed-source stamps without source metadata", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, ".install-method.json"), JSON.stringify({
        method: "managed-source"
      }));

      const result = await detectInstallMethod({
        cwd: dir,
        includeRuntimeHints: false,
        pathHints: [],
        containerProbe: {
          dockerEnvPath: join(dir, "missing-docker"),
          containerEnvPath: join(dir, "missing-container"),
          cgroupPath: join(dir, "missing-cgroup")
        }
      });

      expect(result.method).toBe("unknown");
      expect(result.canSelfUpdate).toBe(false);
      expect(result.reason).toContain("Invalid install method stamp");
    });
  });

  it("treats a plain git checkout as manual-source, not managed-source", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, ".git"));

      const result = await detectInstallMethod({
        cwd: dir,
        includeRuntimeHints: false,
        pathHints: [],
        containerProbe: {
          dockerEnvPath: join(dir, "missing-docker"),
          containerEnvPath: join(dir, "missing-container"),
          cgroupPath: join(dir, "missing-cgroup")
        }
      });

      expect(result.method).toBe("manual-source");
      expect(result.source).toBe("path");
      expect(result.canSelfUpdate).toBe(false);
    });
  });

  it("detects containers when no stronger stamp exists", async () => {
    await withTempDir(async (dir) => {
      const dockerEnv = join(dir, ".dockerenv");
      await writeFile(dockerEnv, "");

      const result = await detectInstallMethod({
        cwd: dir,
        includeRuntimeHints: false,
        pathHints: [],
        containerProbe: {
          dockerEnvPath: dockerEnv,
          containerEnvPath: join(dir, "missing-container"),
          cgroupPath: join(dir, "missing-cgroup")
        }
      });

      expect(result.method).toBe("docker");
      expect(result.source).toBe("container");
      expect(result.recommendedUpdateCommand).toBe("docker pull ghcr.io/kemetresearch/estacoda:latest");
    });
  });

  it("gives stamps priority over container markers", async () => {
    await withTempDir(async (dir) => {
      const dockerEnv = join(dir, ".dockerenv");
      await writeFile(dockerEnv, "");
      await writeFile(join(dir, ".install-method.json"), JSON.stringify({
        method: "managed-source",
        sourceUrl: "https://github.com/sifr01-labs/EstaCoda.git",
        branch: "main"
      }));

      const result = await detectInstallMethod({
        cwd: dir,
        includeRuntimeHints: false,
        pathHints: [],
        containerProbe: {
          dockerEnvPath: dockerEnv,
          containerEnvPath: join(dir, "missing-container"),
          cgroupPath: join(dir, "missing-cgroup")
        }
      });

      expect(result.method).toBe("managed-source");
      expect(result.source).toBe("stamp");
    });
  });

  it("detects Homebrew paths", async () => {
    const result = await detectInstallMethod({
      includeCwd: false,
      includeRuntimeHints: false,
      pathHints: ["/opt/homebrew/Cellar/estacoda/0.1.0/bin/estacoda"],
      containerProbe: {
        dockerEnvPath: "/tmp/estacoda-missing-docker",
        containerEnvPath: "/tmp/estacoda-missing-container",
        cgroupPath: "/tmp/estacoda-missing-cgroup"
      }
    });

    expect(result.method).toBe("homebrew");
    expect(result.source).toBe("path");
    expect(result.recommendedUpdateCommand).toBe("brew upgrade kemetresearch/tap/estacoda");
  });

  it("detects npm global paths when reliable", async () => {
    const result = await detectInstallMethod({
      includeCwd: false,
      includeRuntimeHints: false,
      pathHints: ["/usr/local/lib/node_modules/estacoda/dist/index.js"],
      containerProbe: {
        dockerEnvPath: "/tmp/estacoda-missing-docker",
        containerEnvPath: "/tmp/estacoda-missing-container",
        cgroupPath: "/tmp/estacoda-missing-cgroup"
      }
    });

    expect(result.method).toBe("npm-global");
    expect(result.source).toBe("package-manager");
    expect(result.recommendedUpdateCommand).toBe("npm install -g estacoda@latest");
  });

  it("detects pnpm global paths when reliable", async () => {
    const result = await detectInstallMethod({
      includeCwd: false,
      includeRuntimeHints: false,
      pathHints: ["/Users/example/.local/share/pnpm/global/5/node_modules/.pnpm/estacoda@0.1.0/node_modules/estacoda/dist/index.js"],
      containerProbe: {
        dockerEnvPath: "/tmp/estacoda-missing-docker",
        containerEnvPath: "/tmp/estacoda-missing-container",
        cgroupPath: "/tmp/estacoda-missing-cgroup"
      }
    });

    expect(result.method).toBe("pnpm-global");
    expect(result.source).toBe("package-manager");
    expect(result.recommendedUpdateCommand).toBe("pnpm add -g estacoda@latest");
  });

  it("falls back to unknown guidance when detection is unreliable", async () => {
    await withTempDir(async (dir) => {
      const result = await detectInstallMethod({
        cwd: dir,
        includeRuntimeHints: false,
        pathHints: [],
        containerProbe: {
          dockerEnvPath: join(dir, "missing-docker"),
          containerEnvPath: join(dir, "missing-container"),
          cgroupPath: join(dir, "missing-cgroup")
        }
      });

      expect(result.method).toBe("unknown");
      expect(result.canSelfUpdate).toBe(false);
      expect(result.recommendedUpdateCommand).toBe("reinstall using documented install path");
    });
  });
});
