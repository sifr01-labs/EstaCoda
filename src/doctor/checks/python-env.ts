import type { LoadedRuntimeConfig } from "../../config/runtime-config.js";
import {
  DDGS_CAPABILITY_ID,
  EDGE_TTS_CAPABILITY_ID,
  FASTER_WHISPER_CAPABILITY_ID,
  listRegisteredPythonCapabilitySpecs,
  type ManagedPythonCapabilityEnvSpec
} from "../../python-env/capability-registry.js";
import {
  checkManagedPythonCapabilityStatus,
  type ManagedPythonCapabilityInstallStatus
} from "../../python-env/capability-manager.js";
import {
  checkManagedEnvironment,
  findSystemPython,
  type PythonEnvironmentStatus
} from "../../python-env/manager.js";

export type PythonEnvironmentDiagnosticStatus = "ready" | "warning";

export type PythonCapabilityDiagnostic = {
  readonly id: string;
  readonly kind: "legacy-faster-whisper" | "capability";
  readonly required: boolean;
  readonly status: "ready" | "missing" | "warning";
  readonly message?: string;
  readonly pythonPath?: string;
  readonly envPath?: string;
};

export type PythonEnvironmentDiagnostic = {
  readonly status: PythonEnvironmentDiagnosticStatus;
  readonly systemPython: string | undefined;
  readonly requiredCapabilities: readonly PythonCapabilityDiagnostic[];
  readonly optionalCapabilities: readonly PythonCapabilityDiagnostic[];
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
};

export type PythonSystemFinder = () => Promise<string | undefined>;
export type LegacyPythonEnvironmentChecker = (options: { readonly stateRoot: string }) => Promise<PythonEnvironmentStatus>;
export type PythonCapabilityStatusChecker = (options: {
  readonly stateRoot: string;
  readonly capabilityId: string;
}) => Promise<ManagedPythonCapabilityInstallStatus>;

export async function diagnosePythonEnvironments(options: {
  readonly stateRoot: string;
  readonly config?: LoadedRuntimeConfig;
  readonly findSystemPython?: PythonSystemFinder;
  readonly checkLegacyEnvironment?: LegacyPythonEnvironmentChecker;
  readonly checkCapabilityStatus?: PythonCapabilityStatusChecker;
  readonly registeredSpecs?: readonly ManagedPythonCapabilityEnvSpec[];
}): Promise<PythonEnvironmentDiagnostic> {
  const systemPython = await (options.findSystemPython ?? findSystemPython)();
  const requiredIds = requiredPythonCapabilities(options.config);
  const checkLegacyEnvironment = options.checkLegacyEnvironment ?? checkManagedEnvironment;
  const checkCapabilityStatus = options.checkCapabilityStatus ?? checkManagedPythonCapabilityStatus;
  const requiredCapabilities: PythonCapabilityDiagnostic[] = [];
  const optionalCapabilities: PythonCapabilityDiagnostic[] = [];

  if (requiredIds.has(FASTER_WHISPER_CAPABILITY_ID)) {
    requiredCapabilities.push(await diagnoseLegacyFasterWhisper({
      stateRoot: options.stateRoot,
      checkLegacyEnvironment
    }));
  }

  for (const capabilityId of [...requiredIds].filter((id) => id !== FASTER_WHISPER_CAPABILITY_ID).sort()) {
    requiredCapabilities.push(await diagnoseManagedCapability({
      stateRoot: options.stateRoot,
      capabilityId,
      required: true,
      checkCapabilityStatus
    }));
  }

  for (const spec of options.registeredSpecs ?? listRegisteredPythonCapabilitySpecs()) {
    if (requiredIds.has(spec.id) || spec.id === FASTER_WHISPER_CAPABILITY_ID) continue;
    optionalCapabilities.push(await diagnoseManagedCapability({
      stateRoot: options.stateRoot,
      capabilityId: spec.id,
      required: false,
      checkCapabilityStatus
    }));
  }

  const warnings: string[] = [];
  const notes: string[] = [];
  if (systemPython === undefined && requiredCapabilities.some((capability) => capability.status !== "ready")) {
    warnings.push("System Python 3 was not found; managed Python setup cannot run.");
  } else if (systemPython === undefined) {
    notes.push("System Python 3 was not found; managed Python setup would require Python 3.");
  }

  for (const capability of requiredCapabilities) {
    if (capability.status !== "ready") {
      warnings.push(`Managed Python capability ${capability.id} is not ready: ${capability.message ?? capability.status}`);
    }
  }

  const optionalMissing = optionalCapabilities.filter((capability) => capability.status !== "ready");
  if (optionalMissing.length > 0) {
    notes.push(`Optional managed Python capabilities not installed: ${optionalMissing.map((capability) => capability.id).join(", ")}`);
  }
  if (requiredCapabilities.length === 0) {
    notes.push("No configured feature currently requires a managed Python environment.");
  }

  return {
    status: warnings.length > 0 ? "warning" : "ready",
    systemPython,
    requiredCapabilities,
    optionalCapabilities,
    warnings,
    notes
  };
}

function requiredPythonCapabilities(config: LoadedRuntimeConfig | undefined): Set<string> {
  const required = new Set<string>();
  if (config === undefined) return required;

  const rawStt = config.config.stt;
  const sttConfigured = rawStt !== undefined;
  const customSttPython = config.stt.local?.pythonBinary;
  const usesManagedFasterWhisper = sttConfigured &&
    config.stt.enabled !== false &&
    config.stt.provider === "local" &&
    config.stt.local?.engine !== "command" &&
    (customSttPython === undefined || customSttPython.trim().length === 0) &&
    (config.stt.local?.engine === "faster-whisper" || config.stt.local?.fasterWhisper?.enabled === true);
  if (usesManagedFasterWhisper) {
    required.add(FASTER_WHISPER_CAPABILITY_ID);
  }

  if (config.config.tts !== undefined && config.tts.enabled !== false && config.tts.provider === "edge") {
    required.add(EDGE_TTS_CAPABILITY_ID);
  }

  const webConfigured = config.config.web !== undefined;
  if (webConfigured && (config.web.searchBackend === "ddgs" || config.web.backend === "ddgs")) {
    required.add(DDGS_CAPABILITY_ID);
  }

  return required;
}

async function diagnoseLegacyFasterWhisper(options: {
  readonly stateRoot: string;
  readonly checkLegacyEnvironment: LegacyPythonEnvironmentChecker;
}): Promise<PythonCapabilityDiagnostic> {
  const status = await options.checkLegacyEnvironment({ stateRoot: options.stateRoot });
  switch (status.kind) {
    case "ready":
      return {
        id: FASTER_WHISPER_CAPABILITY_ID,
        kind: "legacy-faster-whisper",
        required: true,
        status: "ready",
        pythonPath: status.pythonBinary
      };
    case "missing":
      return {
        id: FASTER_WHISPER_CAPABILITY_ID,
        kind: "legacy-faster-whisper",
        required: true,
        status: "missing",
        message: "legacy faster-whisper environment is missing"
      };
    case "corrupted":
      return {
        id: FASTER_WHISPER_CAPABILITY_ID,
        kind: "legacy-faster-whisper",
        required: true,
        status: "warning",
        message: status.reason
      };
  }
}

async function diagnoseManagedCapability(options: {
  readonly stateRoot: string;
  readonly capabilityId: string;
  readonly required: boolean;
  readonly checkCapabilityStatus: PythonCapabilityStatusChecker;
}): Promise<PythonCapabilityDiagnostic> {
  const status = await options.checkCapabilityStatus({
    stateRoot: options.stateRoot,
    capabilityId: options.capabilityId
  });
  if (status.ok) {
    return {
      id: options.capabilityId,
      kind: "capability",
      required: options.required,
      status: "ready",
      pythonPath: status.pythonPath,
      envPath: status.envPath
    };
  }
  return {
    id: options.capabilityId,
    kind: "capability",
    required: options.required,
    status: status.reason === "install_required" ? "missing" : "warning",
    message: status.message
  };
}
