import { join } from "node:path";
import { requireRegisteredPythonCapabilitySpec } from "./capability-registry.js";

export type ManagedPythonCapabilityEnvPaths = {
  envPath: string;
  pythonPath: string;
  pipCacheDir: string;
  manifestPath: string;
};

export type ManagedPythonCapabilityPathOptions = {
  stateRoot: string;
  capabilityId: string;
};

export function resolveManagedPythonCapabilityEnvPath(options: ManagedPythonCapabilityPathOptions): string {
  const spec = requireRegisteredPythonCapabilitySpec(options.capabilityId);
  return join(options.stateRoot, "python-envs", spec.id);
}

export function resolveManagedPythonCapabilityPipCacheDir(options: ManagedPythonCapabilityPathOptions): string {
  const spec = requireRegisteredPythonCapabilitySpec(options.capabilityId);
  return join(options.stateRoot, "cache", "pip", spec.id);
}

export function resolveManagedPythonCapabilityManifestPath(options: ManagedPythonCapabilityPathOptions): string {
  return join(resolveManagedPythonCapabilityEnvPath(options), "env.json");
}

export function resolveManagedPythonCapabilityPythonPath(options: ManagedPythonCapabilityPathOptions): string {
  return venvPythonBinary(resolveManagedPythonCapabilityEnvPath(options));
}

export function resolveManagedPythonCapabilityPaths(
  options: ManagedPythonCapabilityPathOptions
): ManagedPythonCapabilityEnvPaths {
  return {
    envPath: resolveManagedPythonCapabilityEnvPath(options),
    pythonPath: resolveManagedPythonCapabilityPythonPath(options),
    pipCacheDir: resolveManagedPythonCapabilityPipCacheDir(options),
    manifestPath: resolveManagedPythonCapabilityManifestPath(options)
  };
}

export function venvPythonBinary(venvPath: string): string {
  return process.platform === "win32"
    ? join(venvPath, "Scripts", "python.exe")
    : join(venvPath, "bin", "python");
}
