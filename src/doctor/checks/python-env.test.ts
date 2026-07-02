import { describe, expect, it } from "vitest";
import type { LoadedRuntimeConfig } from "../../config/runtime-config.js";
import {
  DDGS_CAPABILITY_ID,
  EDGE_TTS_CAPABILITY_ID,
  FASTER_WHISPER_CAPABILITY_ID,
  type ManagedPythonCapabilityEnvSpec
} from "../../python-env/capability-registry.js";
import type { ManagedPythonCapabilityInstallStatus } from "../../python-env/capability-manager.js";
import { diagnosePythonEnvironments } from "./python-env.js";

describe("diagnosePythonEnvironments", () => {
  it("warns when a configured DDGS capability is missing and system Python is unavailable", async () => {
    const diagnostic = await diagnosePythonEnvironments({
      stateRoot: "/state",
      config: runtimeConfig({
        raw: { web: { searchBackend: "ddgs" } },
        web: { searchBackend: "ddgs" }
      }),
      registeredSpecs: [],
      findSystemPython: async () => undefined,
      checkCapabilityStatus: async () => missingCapability(DDGS_CAPABILITY_ID)
    });

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.requiredCapabilities).toEqual([
      expect.objectContaining({
        id: DDGS_CAPABILITY_ID,
        required: true,
        status: "missing"
      })
    ]);
    expect(diagnostic.warnings).toEqual([
      "System Python 3 was not found; managed Python setup cannot run.",
      "Managed Python capability ddgs is not ready: Managed Python capability environment has not been installed."
    ]);
  });

  it("reports a ready configured Edge TTS capability", async () => {
    const diagnostic = await diagnosePythonEnvironments({
      stateRoot: "/state",
      config: runtimeConfig({
        raw: { tts: { provider: "edge" } },
        tts: { provider: "edge" }
      }),
      registeredSpecs: [],
      findSystemPython: async () => "python3",
      checkCapabilityStatus: async () => readyCapability(EDGE_TTS_CAPABILITY_ID)
    });

    expect(diagnostic.status).toBe("ready");
    expect(diagnostic.requiredCapabilities).toEqual([
      expect.objectContaining({
        id: EDGE_TTS_CAPABILITY_ID,
        required: true,
        status: "ready",
        pythonPath: "/state/python-envs/edge-tts/bin/python"
      })
    ]);
    expect(diagnostic.warnings).toEqual([]);
  });

  it("checks the legacy faster-whisper environment only when configured without custom Python", async () => {
    const diagnostic = await diagnosePythonEnvironments({
      stateRoot: "/state",
      config: runtimeConfig({
        raw: { stt: { provider: "local" } },
        stt: {
          provider: "local",
          local: {
            engine: "faster-whisper",
            fasterWhisper: { enabled: true }
          }
        }
      }),
      registeredSpecs: [],
      findSystemPython: async () => "python3",
      checkLegacyEnvironment: async () => ({ kind: "missing" })
    });

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.requiredCapabilities).toEqual([
      expect.objectContaining({
        id: FASTER_WHISPER_CAPABILITY_ID,
        kind: "legacy-faster-whisper",
        status: "missing"
      })
    ]);
  });

  it("does not require managed faster-whisper when a custom STT python binary is configured", async () => {
    let checkedLegacy = false;
    const diagnostic = await diagnosePythonEnvironments({
      stateRoot: "/state",
      config: runtimeConfig({
        raw: { stt: { provider: "local" } },
        stt: {
          provider: "local",
          local: {
            engine: "faster-whisper",
            pythonBinary: "/operator/python",
            fasterWhisper: { enabled: true }
          }
        }
      }),
      registeredSpecs: [],
      findSystemPython: async () => "python3",
      checkLegacyEnvironment: async () => {
        checkedLegacy = true;
        return { kind: "missing" };
      }
    });

    expect(checkedLegacy).toBe(false);
    expect(diagnostic.status).toBe("ready");
    expect(diagnostic.requiredCapabilities).toEqual([]);
  });

  it("keeps missing optional capabilities as notes", async () => {
    const diagnostic = await diagnosePythonEnvironments({
      stateRoot: "/state",
      config: runtimeConfig({}),
      registeredSpecs: [spec(DDGS_CAPABILITY_ID)],
      findSystemPython: async () => "python3",
      checkCapabilityStatus: async () => missingCapability(DDGS_CAPABILITY_ID)
    });

    expect(diagnostic.status).toBe("ready");
    expect(diagnostic.warnings).toEqual([]);
    expect(diagnostic.notes).toEqual([
      "Optional managed Python capabilities not installed: ddgs",
      "No configured feature currently requires a managed Python environment."
    ]);
  });
});

function runtimeConfig(input: {
  raw?: LoadedRuntimeConfig["config"];
  web?: Partial<LoadedRuntimeConfig["web"]>;
  tts?: Partial<LoadedRuntimeConfig["tts"]>;
  stt?: Partial<LoadedRuntimeConfig["stt"]>;
}): LoadedRuntimeConfig {
  return {
    config: input.raw ?? {},
    web: { enableNetwork: false, ...input.web },
    tts: { provider: "openai", speed: 1, ...input.tts },
    stt: { provider: "openai", ...input.stt }
  } as LoadedRuntimeConfig;
}

function spec(id: string): ManagedPythonCapabilityEnvSpec {
  return {
    id,
    version: "1.0.0",
    packages: [],
    verifyImports: []
  };
}

function readyCapability(capabilityId: string): ManagedPythonCapabilityInstallStatus {
  return {
    ok: true,
    status: "verified",
    capabilityId,
    version: "1.0.0",
    specHash: "hash",
    installedGroups: [],
    installedPackages: [],
    pythonPath: `/state/python-envs/${capabilityId}/bin/python`,
    envPath: `/state/python-envs/${capabilityId}`,
    manifest: {
      id: capabilityId,
      version: "1.0.0",
      specHash: "hash",
      installedPackages: [],
      installedGroups: [],
      pythonPath: `/state/python-envs/${capabilityId}/bin/python`,
      envPath: `/state/python-envs/${capabilityId}`,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      verifiedAt: "2026-07-01T00:00:00.000Z",
      status: "verified"
    }
  };
}

function missingCapability(capabilityId: string): ManagedPythonCapabilityInstallStatus {
  return {
    ok: false,
    capabilityId,
    reason: "install_required",
    message: "Managed Python capability environment has not been installed."
  };
}
