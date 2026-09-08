import type {
  RegisteredTool,
  ToolExecutionEffect,
  ToolRiskClass
} from "../contracts/tool.js";
import { isProtectedArgumentPattern } from "../security/protected-argument-path.js";

const TOOL_RISK_CLASSES = new Set<ToolRiskClass>([
  "read-only-local",
  "read-only-network",
  "workspace-write",
  "external-side-effect",
  "credential-access",
  "destructive-local",
  "shared-state-mutation",
  "spend-money",
  "sandbox-escape"
]);
const READ_RISK_CLASSES = new Set<ToolRiskClass>(["read-only-local", "read-only-network"]);
const MUTATION_RISK_CLASSES = new Set<ToolRiskClass>([
  "workspace-write",
  "external-side-effect",
  "destructive-local",
  "shared-state-mutation",
  "spend-money"
]);
const EXECUTION_MUTATION_RISK_CLASSES = new Set<ToolRiskClass>([
  ...MUTATION_RISK_CLASSES,
  "sandbox-escape"
]);

export type ResolvedRegisteredToolCapability = {
  canonicalTool: string;
  riskClass: ToolRiskClass;
  classification: "read" | "mutate" | "unsupported";
  connector?: { kind: "mcp"; id: string };
  protectedInput?: {
    paths: string[];
    groupedDelivery: boolean;
    sources: "browser"[];
  };
  verification?: {
    verifies: string[];
  };
  artifactInput?: {
    paths: string[];
  };
  resultRedaction?: {
    paths: string[];
  };
};

export type RegisteredToolCapabilityResolution =
  | { ok: true; capability: ResolvedRegisteredToolCapability }
  | { ok: false; reason: "risk_class_missing" | "capability_metadata_invalid" };

/** Resolves trusted execution facts without consulting model-authored Plan text. */
export function resolveRegisteredToolCapability(
  tool: RegisteredTool
): RegisteredToolCapabilityResolution {
  if (!isToolRiskClass(tool.riskClass)) {
    return { ok: false, reason: "risk_class_missing" };
  }
  const classification = READ_RISK_CLASSES.has(tool.riskClass)
    ? "read"
    : MUTATION_RISK_CLASSES.has(tool.riskClass) ? "mutate" : "unsupported";

  const paths = tool.protectedArguments?.map((entry) => entry.path) ?? [];
  if (paths.some((path) => !isProtectedArgumentPattern(path)) || new Set(paths).size !== paths.length) {
    return { ok: false, reason: "capability_metadata_invalid" };
  }

  const protectedMetadata = tool.capabilityMetadata?.protectedInput;
  if (
    protectedMetadata !== undefined &&
    (paths.length === 0 ||
      typeof protectedMetadata.groupedDelivery !== "boolean" ||
      !Array.isArray(protectedMetadata.sources) ||
      protectedMetadata.sources.some((source) => source !== "browser"))
  ) {
    return { ok: false, reason: "capability_metadata_invalid" };
  }

  const verifies = tool.capabilityMetadata?.verification?.verifies;
  if (
    verifies !== undefined &&
    (!Array.isArray(verifies) ||
      verifies.length === 0 ||
      verifies.some((name) => typeof name !== "string" || name.trim().length === 0 || name.length > 160) ||
      new Set(verifies).size !== verifies.length)
  ) {
    return { ok: false, reason: "capability_metadata_invalid" };
  }
  if ((protectedMetadata !== undefined && classification !== "mutate") ||
    (verifies !== undefined && classification !== "read")) {
    return { ok: false, reason: "capability_metadata_invalid" };
  }
  const artifactPaths = tool.capabilityMetadata?.artifactInput?.paths;
  if (
    artifactPaths !== undefined &&
    (classification !== "mutate" ||
      !Array.isArray(artifactPaths) ||
      artifactPaths.length === 0 ||
      artifactPaths.length > 8 ||
      artifactPaths.some((path) => !isProtectedArgumentPattern(path)) ||
      new Set(artifactPaths).size !== artifactPaths.length)
  ) {
    return { ok: false, reason: "capability_metadata_invalid" };
  }
  const redactedResultPaths = tool.capabilityMetadata?.resultRedaction?.paths;
  if (
    redactedResultPaths !== undefined &&
    (!Array.isArray(redactedResultPaths) ||
      redactedResultPaths.length === 0 ||
      redactedResultPaths.length > 8 ||
      redactedResultPaths.some((path) => !isProtectedArgumentPattern(path)) ||
      new Set(redactedResultPaths).size !== redactedResultPaths.length)
  ) {
    return { ok: false, reason: "capability_metadata_invalid" };
  }

  return {
    ok: true,
    capability: {
      canonicalTool: tool.name,
      riskClass: tool.riskClass,
      classification,
      ...(tool.connector === undefined ? {} : { connector: { ...tool.connector } }),
      ...(protectedMetadata === undefined ? {} : {
        protectedInput: {
          paths: [...paths],
          groupedDelivery: protectedMetadata.groupedDelivery,
          sources: [...protectedMetadata.sources]
        }
      }),
      ...(verifies === undefined ? {} : { verification: { verifies: [...verifies] } }),
      ...(artifactPaths === undefined ? {} : { artifactInput: { paths: [...artifactPaths] } }),
      ...(redactedResultPaths === undefined ? {} : { resultRedaction: { paths: [...redactedResultPaths] } })
    }
  };
}

/**
 * Projects trusted registration metadata into the bounded effect facts carried
 * by an execution record. Dynamic risk escalation is authoritative over the
 * registered base classification.
 */
export function resolveToolExecutionEffect(
  tool: RegisteredTool,
  effectiveRiskClass: ToolRiskClass
): ToolExecutionEffect | undefined {
  const resolution = resolveRegisteredToolCapability(tool);
  if (resolution.ok === false) return undefined;

  const connector = resolution.capability.connector;
  if (EXECUTION_MUTATION_RISK_CLASSES.has(effectiveRiskClass)) {
    return {
      kind: "mutation",
      ...(connector === undefined ? {} : { connector: { ...connector } })
    };
  }
  if (!READ_RISK_CLASSES.has(effectiveRiskClass)) return undefined;

  const verifies = resolution.capability.verification?.verifies;
  if (verifies !== undefined) {
    return {
      kind: "verification",
      verifies: [...verifies],
      ...(connector === undefined ? {} : { connector: { ...connector } })
    };
  }
  return {
    kind: "read",
    ...(connector === undefined ? {} : { connector: { ...connector } })
  };
}

function isToolRiskClass(input: unknown): input is ToolRiskClass {
  return typeof input === "string" && TOOL_RISK_CLASSES.has(input as ToolRiskClass);
}
