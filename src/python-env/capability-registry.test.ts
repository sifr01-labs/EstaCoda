import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FASTER_WHISPER_CAPABILITY_ID,
  PDF_EDITOR_CAPABILITY_ID,
  PDF_EXTRACTION_CAPABILITY_ID,
  getRegisteredPythonCapabilitySpec,
  listRegisteredPythonCapabilitySpecs
} from "./capability-registry.js";
import {
  resolveManagedPythonCapabilityManifestPath,
  resolveManagedPythonCapabilityPaths
} from "./capability-paths.js";
import {
  readManagedPythonCapabilityManifest,
  writeManagedPythonCapabilityManifest
} from "./manifest.js";
import { fingerprintManagedPythonCapabilitySpec } from "./spec-hash.js";
import type { ManagedPythonCapabilityEnvManifest } from "./manifest.js";
import type { ManagedPythonCapabilityEnvSpec } from "./capability-registry.js";

describe("managed Python capability substrate", () => {
  let tempDir: string;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "estacoda-python-capability-test-"));
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  });

  afterEach(() => {
    if (originalPlatform !== undefined) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers runtime-owned capability specs", () => {
    const specs = listRegisteredPythonCapabilitySpecs();

    expect(specs).toEqual([
      {
        id: "faster-whisper",
        version: "1.2.1",
        packages: ["faster-whisper==1.2.1"],
        verifyImports: ["faster_whisper"]
      },
      {
        id: "pdf-extraction",
        version: "0.1.0",
        packages: [
          "pymupdf==1.27.2.3",
          "pymupdf4llm==1.27.2.3"
        ],
        verifyImports: [
          "pymupdf",
          "pymupdf4llm"
        ],
        estimatedInstallSizeMb: 120,
        optionalGroups: {
          tables: {
            packages: [
              "pandas==3.0.3",
              "tabulate==0.10.0"
            ],
            verifyImports: [
              "pandas",
              "tabulate"
            ],
            estimatedInstallSizeMb: 160
          },
          advancedOcr: {
            packages: ["marker-pdf==1.10.2"],
            verifyImports: ["marker"],
            estimatedInstallSizeMb: 5000
          }
        }
      },
      {
        id: "pdf-editor",
        version: "0.1.0",
        packages: ["nano-pdf==0.2.1"],
        verifyImports: ["nano_pdf"],
        estimatedInstallSizeMb: 100
      }
    ]);
  });

  it("returns defensive copies of registered package lists", () => {
    const spec = getRegisteredPythonCapabilitySpec(FASTER_WHISPER_CAPABILITY_ID);
    expect(spec).toBeDefined();
    spec?.packages.push("untrusted-package==0.0.1");

    expect(getRegisteredPythonCapabilitySpec(FASTER_WHISPER_CAPABILITY_ID)?.packages).toEqual([
      "faster-whisper==1.2.1"
    ]);
  });

  it("returns defensive copies of optional capability groups", () => {
    const spec = getRegisteredPythonCapabilitySpec(PDF_EXTRACTION_CAPABILITY_ID);
    expect(spec).toBeDefined();
    spec?.optionalGroups?.tables?.packages.push("untrusted-package==0.0.1");

    expect(getRegisteredPythonCapabilitySpec(PDF_EXTRACTION_CAPABILITY_ID)?.optionalGroups?.tables?.packages).toEqual([
      "pandas==3.0.3",
      "tabulate==0.10.0"
    ]);
  });

  it("registers PDF editor capability with nano-pdf import verification", () => {
    expect(getRegisteredPythonCapabilitySpec(PDF_EDITOR_CAPABILITY_ID)).toMatchObject({
      id: "pdf-editor",
      packages: ["nano-pdf==0.2.1"],
      verifyImports: ["nano_pdf"]
    });
  });

  it("resolves deterministic capability env, pip cache, manifest, and python paths under state root", () => {
    setPlatform("linux");

    expect(resolveManagedPythonCapabilityPaths({
      stateRoot: tempDir,
      capabilityId: FASTER_WHISPER_CAPABILITY_ID
    })).toEqual({
      envPath: join(tempDir, "python-envs", "faster-whisper"),
      pythonPath: join(tempDir, "python-envs", "faster-whisper", "bin", "python"),
      pipCacheDir: join(tempDir, "cache", "pip", "faster-whisper"),
      manifestPath: join(tempDir, "python-envs", "faster-whisper", "env.json")
    });
  });

  it("resolves Windows capability python paths", () => {
    setPlatform("win32");

    expect(resolveManagedPythonCapabilityPaths({
      stateRoot: tempDir,
      capabilityId: FASTER_WHISPER_CAPABILITY_ID
    }).pythonPath).toBe(join(tempDir, "python-envs", "faster-whisper", "Scripts", "python.exe"));
  });

  it("rejects paths for unregistered capability ids", () => {
    expect(() => resolveManagedPythonCapabilityPaths({
      stateRoot: tempDir,
      capabilityId: "sada30"
    })).toThrow("Unknown managed Python capability: sada30");
  });

  it("reads and writes capability env manifests atomically at env.json", async () => {
    const paths = resolveManagedPythonCapabilityPaths({
      stateRoot: tempDir,
      capabilityId: FASTER_WHISPER_CAPABILITY_ID
    });
    const manifest: ManagedPythonCapabilityEnvManifest = {
      id: FASTER_WHISPER_CAPABILITY_ID,
      version: "1.2.1",
      specHash: "abc123",
      installedPackages: ["faster-whisper==1.2.1"],
      installedGroups: [],
      pythonPath: paths.pythonPath,
      envPath: paths.envPath,
      createdAt: "2026-06-13T00:00:00.000Z",
      updatedAt: "2026-06-13T00:00:00.000Z",
      verifiedAt: "2026-06-13T00:00:01.000Z",
      status: "verified"
    };

    await expect(readManagedPythonCapabilityManifest({
      stateRoot: tempDir,
      capabilityId: FASTER_WHISPER_CAPABILITY_ID
    })).resolves.toBeUndefined();
    await writeManagedPythonCapabilityManifest({
      stateRoot: tempDir,
      capabilityId: FASTER_WHISPER_CAPABILITY_ID
    }, manifest);
    await writeManagedPythonCapabilityManifest({
      stateRoot: tempDir,
      capabilityId: FASTER_WHISPER_CAPABILITY_ID
    }, {
      ...manifest,
      updatedAt: "2026-06-13T00:00:02.000Z"
    });

    await expect(readManagedPythonCapabilityManifest({
      stateRoot: tempDir,
      capabilityId: FASTER_WHISPER_CAPABILITY_ID
    })).resolves.toEqual({
      ...manifest,
      updatedAt: "2026-06-13T00:00:02.000Z"
    });
    expect(await readdir(paths.envPath)).toEqual(["env.json"]);
    expect(existsSync(paths.manifestPath)).toBe(true);
  });

  it("rejects manifest writes when the manifest id does not match the registered capability path", async () => {
    const paths = resolveManagedPythonCapabilityPaths({
      stateRoot: tempDir,
      capabilityId: FASTER_WHISPER_CAPABILITY_ID
    });
    const manifest: ManagedPythonCapabilityEnvManifest = {
      id: "other",
      version: "1.2.1",
      specHash: "abc123",
      installedPackages: [],
      installedGroups: [],
      pythonPath: paths.pythonPath,
      envPath: paths.envPath,
      createdAt: "2026-06-13T00:00:00.000Z",
      updatedAt: "2026-06-13T00:00:00.000Z",
      status: "installed"
    };

    await expect(writeManagedPythonCapabilityManifest({
      stateRoot: tempDir,
      capabilityId: FASTER_WHISPER_CAPABILITY_ID
    }, manifest)).rejects.toThrow("does not match requested capability");
  });

  it("rejects invalid manifest shape on read", async () => {
    const manifestPath = resolveManagedPythonCapabilityManifestPath({
      stateRoot: tempDir,
      capabilityId: FASTER_WHISPER_CAPABILITY_ID
    });
    await mkdir(join(tempDir, "python-envs", FASTER_WHISPER_CAPABILITY_ID), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({ id: FASTER_WHISPER_CAPABILITY_ID }), "utf8");

    await expect(readManagedPythonCapabilityManifest({
      stateRoot: tempDir,
      capabilityId: FASTER_WHISPER_CAPABILITY_ID
    })).rejects.toThrow("field 'version' must be a non-empty string");
  });

  it("fingerprints the effective spec plus selected optional groups deterministically", () => {
    const spec: ManagedPythonCapabilityEnvSpec = {
      id: "example",
      version: "0.1.0",
      pythonVersion: "3.12",
      packages: ["base-a==1", "base-b==2"],
      verifyImports: ["base_a", "base_b"],
      optionalGroups: {
        second: {
          packages: ["second==1"],
          verifyImports: ["second"]
        },
        first: {
          packages: ["first==1"],
          verifyImports: ["first"],
          estimatedInstallSizeMb: 50
        }
      }
    };

    const firstOrder = fingerprintManagedPythonCapabilitySpec(spec, ["second", "first"]);
    const secondOrder = fingerprintManagedPythonCapabilitySpec(spec, ["first", "second", "first"]);
    const baseOnly = fingerprintManagedPythonCapabilitySpec(spec);

    expect(firstOrder).toMatch(/^[a-f0-9]{64}$/);
    expect(firstOrder).toBe(secondOrder);
    expect(firstOrder).not.toBe(baseOnly);
  });

  it("fingerprints all meaningful spec fields without machine-local paths or timestamps", () => {
    const base: ManagedPythonCapabilityEnvSpec = {
      id: "example",
      version: "0.1.0",
      pythonVersion: "3.12",
      packages: ["base-a==1"],
      verifyImports: ["base_a"],
      estimatedInstallSizeMb: 10,
      optionalGroups: {
        alpha: {
          verifyImports: ["alpha"],
          packages: ["alpha==1"],
          estimatedInstallSizeMb: 20
        }
      }
    };
    const reorderedKeys: ManagedPythonCapabilityEnvSpec = {
      optionalGroups: {
        alpha: {
          estimatedInstallSizeMb: 20,
          packages: ["alpha==1"],
          verifyImports: ["alpha"]
        }
      },
      estimatedInstallSizeMb: 10,
      verifyImports: ["base_a"],
      packages: ["base-a==1"],
      pythonVersion: "3.12",
      version: "0.1.0",
      id: "example"
    };
    const baseline = fingerprintManagedPythonCapabilitySpec(base, ["alpha"]);

    expect(fingerprintManagedPythonCapabilitySpec(reorderedKeys, ["alpha"])).toBe(baseline);
    expect(fingerprintManagedPythonCapabilitySpec({ ...base, version: "0.2.0" }, ["alpha"])).not.toBe(baseline);
    expect(fingerprintManagedPythonCapabilitySpec({ ...base, pythonVersion: "3.13" }, ["alpha"])).not.toBe(baseline);
    expect(fingerprintManagedPythonCapabilitySpec({ ...base, packages: ["base-a==2"] }, ["alpha"])).not.toBe(baseline);
    expect(fingerprintManagedPythonCapabilitySpec({ ...base, verifyImports: ["base_b"] }, ["alpha"])).not.toBe(baseline);
    expect(fingerprintManagedPythonCapabilitySpec({ ...base, estimatedInstallSizeMb: 11 }, ["alpha"])).not.toBe(baseline);
    expect(fingerprintManagedPythonCapabilitySpec({
      ...base,
      optionalGroups: {
        alpha: {
          packages: ["alpha==2"],
          verifyImports: ["alpha"],
          estimatedInstallSizeMb: 20
        }
      }
    }, ["alpha"])).not.toBe(baseline);
    expect(fingerprintManagedPythonCapabilitySpec(base)).not.toBe(baseline);
  });

  it("rejects unknown optional groups while fingerprinting", () => {
    expect(() => fingerprintManagedPythonCapabilitySpec({
      id: "example",
      version: "0.1.0",
      packages: [],
      verifyImports: []
    }, ["missing"])).toThrow("Unknown optional group 'missing'");
  });
});

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform
  });
}
