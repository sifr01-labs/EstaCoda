import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FASTER_WHISPER_CAPABILITY_ID,
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

  it("registers faster-whisper as a runtime-owned capability spec", () => {
    const specs = listRegisteredPythonCapabilitySpecs();

    expect(specs).toEqual([
      {
        id: "faster-whisper",
        version: "1.2.1",
        packages: ["faster-whisper==1.2.1"],
        verifyImports: ["faster_whisper"]
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

    await expect(readManagedPythonCapabilityManifest({
      stateRoot: tempDir,
      capabilityId: FASTER_WHISPER_CAPABILITY_ID
    })).resolves.toEqual(manifest);
    expect(await readdir(paths.envPath)).toEqual(["env.json"]);
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
