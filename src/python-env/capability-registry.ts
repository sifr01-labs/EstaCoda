export type ManagedPythonCapabilityOptionalGroup = {
  packages: string[];
  verifyImports: string[];
  estimatedInstallSizeMb?: number;
};

export type ManagedPythonCapabilityEnvSpec = {
  id: string;
  version: string;
  packages: string[];
  verifyImports: string[];
  pythonVersion?: string;
  estimatedInstallSizeMb?: number;
  optionalGroups?: Record<string, ManagedPythonCapabilityOptionalGroup>;
};

export const FASTER_WHISPER_CAPABILITY_ID = "faster-whisper";

const REGISTERED_CAPABILITY_SPECS: ManagedPythonCapabilityEnvSpec[] = [
  {
    id: FASTER_WHISPER_CAPABILITY_ID,
    version: "1.2.1",
    packages: ["faster-whisper==1.2.1"],
    verifyImports: ["faster_whisper"]
  }
];

const specsById = new Map(REGISTERED_CAPABILITY_SPECS.map((spec) => [spec.id, spec]));

export function listRegisteredPythonCapabilitySpecs(): ManagedPythonCapabilityEnvSpec[] {
  return REGISTERED_CAPABILITY_SPECS.map(cloneSpec);
}

export function getRegisteredPythonCapabilitySpec(id: string): ManagedPythonCapabilityEnvSpec | undefined {
  const spec = specsById.get(id);
  return spec === undefined ? undefined : cloneSpec(spec);
}

export function requireRegisteredPythonCapabilitySpec(id: string): ManagedPythonCapabilityEnvSpec {
  const spec = getRegisteredPythonCapabilitySpec(id);
  if (spec === undefined) {
    throw new Error(`Unknown managed Python capability: ${id}`);
  }
  return spec;
}

export function isRegisteredPythonCapabilityId(id: string): boolean {
  return specsById.has(id);
}

function cloneSpec(spec: ManagedPythonCapabilityEnvSpec): ManagedPythonCapabilityEnvSpec {
  return {
    ...spec,
    packages: [...spec.packages],
    verifyImports: [...spec.verifyImports],
    optionalGroups: spec.optionalGroups === undefined
      ? undefined
      : Object.fromEntries(Object.entries(spec.optionalGroups).map(([groupId, group]) => [
        groupId,
        {
          ...group,
          packages: [...group.packages],
          verifyImports: [...group.verifyImports]
        }
      ]))
  };
}
