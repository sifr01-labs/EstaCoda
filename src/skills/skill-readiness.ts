import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { LoadedSkill, SkillDefinition, SkillPythonCapabilitySetupStatus } from "../contracts/skill.js";
import { resolveOsHomeDir } from "../config/home-dir.js";
import { getRegisteredPythonCapabilitySpec } from "../python-env/capability-registry.js";

export type SkillConfiguredValues = Record<string, unknown> | undefined;

export type SkillSetupContext = {
  skillDirectory?: string;
  requiredEnvironmentVariables: Array<{ name: string; present: boolean }>;
  requiredCredentialFiles: Array<{ path: string; present: boolean; resolvedPath?: string }>;
  pythonCapabilities: Array<{
    id: string;
    required: boolean;
    groups: string[];
    status: "available" | "unavailable" | "unknown";
    reason?: string;
    message?: string;
    repairCommand?: string;
    packages: string[];
    estimatedInstallSizeMb?: number;
    installedGroups?: string[];
  }>;
  configFields: Array<{
    key: string;
    description?: string;
    required?: boolean;
    value?: unknown;
    source: "config" | "default" | "missing";
  }>;
};

export function resolveSkillSetupContext(
  skill: LoadedSkill | SkillDefinition,
  configuredValues: SkillConfiguredValues
): SkillSetupContext {
  return {
    skillDirectory: isLoadedSkill(skill) ? dirname(skill.sourcePath) : undefined,
    requiredEnvironmentVariables: (skill.requiredEnvironmentVariables ?? []).map((name) => ({
      name,
      present: typeof process.env[name] === "string" && process.env[name]!.length > 0
    })),
    requiredCredentialFiles: (skill.requiredCredentialFiles ?? []).map((path) => ({
      path,
      present: credentialFileExists(path),
      resolvedPath: expandUserEnvPath(path)
    })),
    pythonCapabilities: resolvePythonCapabilitySetup(skill),
    configFields: (skill.configFields ?? []).map((field) => {
      const configuredValue = resolveConfiguredSkillValue(configuredValues, field.key);
      if (configuredValue !== undefined) {
        return {
          key: field.key,
          description: field.description,
          required: field.required,
          value: configuredValue,
          source: "config" as const
        };
      }

      if (field.defaultValue !== undefined) {
        return {
          key: field.key,
          description: field.description,
          required: field.required,
          value: field.defaultValue,
          source: "default" as const
        };
      }

      return {
        key: field.key,
        description: field.description,
        required: field.required,
        source: "missing" as const
      };
    })
  };
}

export function buildSkillReadinessMetadata(
  _skill: LoadedSkill | SkillDefinition,
  setup: SkillSetupContext
): {
  setup_needed: boolean;
  readiness_status: "available" | "missing-setup";
  missing_required_environment_variables: string[];
  missing_required_credential_files: string[];
  missing_config_fields: string[];
  missing_required_python_capabilities: string[];
  setup_note?: string;
} {
  const missingRequiredEnvironmentVariables = setup.requiredEnvironmentVariables
    .filter((entry) => !entry.present)
    .map((entry) => entry.name);
  const missingRequiredCredentialFiles = setup.requiredCredentialFiles
    .filter((entry) => !entry.present)
    .map((entry) => entry.path);
  const missingConfigFields = setup.configFields
    .filter((field) => field.required === true && field.source === "missing")
    .map((field) => field.key);
  const missingRequiredPythonCapabilities = setup.pythonCapabilities
    .filter((capability) => capability.required && capability.status !== "available")
    .map((capability) => capability.id);
  const missingCount = missingRequiredEnvironmentVariables.length +
    missingRequiredCredentialFiles.length +
    missingConfigFields.length +
    missingRequiredPythonCapabilities.length;
  const setupNeeded = missingCount > 0;

  return {
    setup_needed: setupNeeded,
    readiness_status: setupNeeded ? "missing-setup" : "available",
    missing_required_environment_variables: missingRequiredEnvironmentVariables,
    missing_required_credential_files: missingRequiredCredentialFiles,
    missing_config_fields: missingConfigFields,
    missing_required_python_capabilities: missingRequiredPythonCapabilities,
    setup_note: setupNeeded
      ? `Missing ${missingCount} required setup item${missingCount === 1 ? "" : "s"}.`
      : undefined
  };
}

function resolvePythonCapabilitySetup(skill: LoadedSkill | SkillDefinition): SkillSetupContext["pythonCapabilities"] {
  const runtimeByDeclaration = new Map<string, SkillPythonCapabilitySetupStatus>();
  for (const status of skill.pythonCapabilitySetup ?? []) {
    runtimeByDeclaration.set(capabilityDeclarationKey(status.id, status.groups), status);
  }

  return (skill.pythonCapabilities ?? []).map((capability) => {
    const runtime = runtimeByDeclaration.get(capabilityDeclarationKey(capability.id, capability.groups));
    const packageInfo = packagesForCapability(capability.id, capability.groups);
    return {
      id: capability.id,
      required: capability.required,
      groups: [...capability.groups],
      status: runtime?.status ?? "unknown",
      reason: runtime?.reason,
      message: runtime?.message,
      repairCommand: runtime?.repairCommand,
      packages: packageInfo.packages,
      estimatedInstallSizeMb: packageInfo.estimatedInstallSizeMb,
      installedGroups: runtime?.installedGroups
    };
  });
}

function packagesForCapability(capabilityId: string, groups: string[]): { packages: string[]; estimatedInstallSizeMb?: number } {
  const spec = getRegisteredPythonCapabilitySpec(capabilityId);
  if (spec === undefined) {
    return { packages: [] };
  }
  const selectedGroups = [...new Set(groups)].sort();
  const packages = [
    ...spec.packages,
    ...selectedGroups.flatMap((group) => spec.optionalGroups?.[group]?.packages ?? [])
  ];
  const estimates = [
    spec.estimatedInstallSizeMb,
    ...selectedGroups.map((group) => spec.optionalGroups?.[group]?.estimatedInstallSizeMb)
  ].filter((value): value is number => typeof value === "number");
  return {
    packages,
    estimatedInstallSizeMb: estimates.length === 0
      ? undefined
      : estimates.reduce((sum, value) => sum + value, 0)
  };
}

function capabilityDeclarationKey(id: string, groups: string[]): string {
  return `${id}\0${[...groups].sort().join("\0")}`;
}

function isLoadedSkill(skill: LoadedSkill | SkillDefinition): skill is LoadedSkill {
  return "instructions" in skill && "sourcePath" in skill;
}

function credentialFileExists(path: string): boolean {
  const resolved = expandUserEnvPath(path);
  return existsSync(resolved);
}

function expandUserEnvPath(path: string): string {
  const withHome = path.startsWith("~/")
    ? `${resolveOsHomeDir()}/${path.slice(2)}`
    : path;

  return withHome.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? "");
}

function resolveConfiguredSkillValue(
  configuredValues: Record<string, unknown> | undefined,
  key: string
): unknown {
  if (configuredValues === undefined) {
    return undefined;
  }

  const variants = new Set<string>([key, toSnakeCase(key), toCamelCase(key)]);

  for (const variant of variants) {
    if (configuredValues[variant] !== undefined) {
      return configuredValues[variant];
    }
  }

  return undefined;
}

function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}
