import type {
  ExecutionPlanCapabilityAssessment,
  ExecutionPlanCapabilityPreflight as ExecutionPlanCapabilityPreflightResult,
  ExecutionPlanCapabilityResolution,
  ExecutionPlanCapabilityRequirement,
  ExecutionPlanWriteContext
} from "../contracts/execution-plan.js";
import { EXECUTION_PLAN_MAX_PROTECTED_PATHS } from "../contracts/execution-plan.js";
import type { RegisteredTool } from "../contracts/tool.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import {
  resolveRegisteredToolCapability,
  type ResolvedRegisteredToolCapability
} from "../tools/tool-capability.js";
import { namedConnectorIdsForRequest } from "./provider-tool-narrowing.js";

export type GovernedTransferPreflightRequest = {
  connectorId: string;
  requiresArtifactTransfer: boolean;
  requiresCredentialTransfer: boolean;
};

export type GovernedTransferPreflightReason =
  | "destination_connector_missing"
  | "artifact_import_missing"
  | "protected_arguments_missing"
  | "protected_source_unsupported"
  | "result_redaction_missing"
  | "verification_missing"
  | "capability_metadata_invalid"
  | "tool_unavailable";

export type GovernedTransferPreflightResult =
  | {
      status: "ready";
      connectorId: string;
      mutationTools: string[];
      verificationTools: string[];
    }
  | {
      status: "blocked";
      connectorId: string;
      reasonCode: GovernedTransferPreflightReason;
    };

/**
 * Assesses declared Mission requirements against the final, session-owned tool
 * registry. It only inspects declarations and availability; it never invokes a
 * tool, resolves approval, or claims remote account permissions.
 */
export class ExecutionCapabilityPreflight {
  readonly #registry: Pick<ToolRegistry, "get" | "getRegisteredByToolset" | "list">;
  readonly #browserSourceAvailable: (() => boolean | Promise<boolean>) | undefined;

  constructor(options: {
    registry: Pick<ToolRegistry, "get" | "getRegisteredByToolset" | "list">;
    browserSourceAvailable?: () => boolean | Promise<boolean>;
  }) {
    this.#registry = options.registry;
    this.#browserSourceAvailable = options.browserSourceAvailable;
  }

  async assessRoutedGovernedTransfer(input: {
    userText: string;
    selectedSkillName?: string;
  }): Promise<GovernedTransferPreflightResult | undefined> {
    const request = detectRoutedGovernedTransfer({
      ...input,
      namedConnectorIds: namedConnectorIdsForRequest({
        tools: this.#registry.list(),
        userText: input.userText
      })
    });
    return request === undefined ? undefined : await this.assessGovernedTransfer(request);
  }

  /**
   * Checks a routed cross-system transfer against reviewed connector metadata.
   * The request only states the user's transfer shape; concrete tools and all
   * security-sensitive mappings come from the session-owned registry.
   */
  async assessGovernedTransfer(
    request: GovernedTransferPreflightRequest
  ): Promise<GovernedTransferPreflightResult> {
    const connectorId = request.connectorId.normalize("NFKC").trim();
    const registered = this.#registry.getRegisteredByToolset("mcp")
      .filter((tool) => tool.connector?.kind === "mcp" && tool.connector.id === connectorId)
      .sort((left, right) => left.name.localeCompare(right.name));
    if (registered.length === 0) {
      return blockedTransfer(connectorId, "destination_connector_missing");
    }

    const resolved = registered.map((tool) => ({ tool, capability: resolveRegisteredToolCapability(tool) }));
    if (resolved.some((entry) => entry.capability.ok === false)) {
      return blockedTransfer(connectorId, "capability_metadata_invalid");
    }
    const capabilities = resolved.map((entry) => ({
      tool: entry.tool,
      capability: entry.capability.ok ? entry.capability.capability : undefined
    })).filter((entry): entry is {
      tool: (typeof registered)[number];
      capability: NonNullable<typeof entry.capability>;
    } => entry.capability !== undefined);

    const artifactCandidates = request.requiresArtifactTransfer
      ? capabilities.filter((entry) => entry.capability.artifactInput !== undefined)
      : [undefined];
    if (artifactCandidates.length === 0) {
      return blockedTransfer(connectorId, "artifact_import_missing");
    }

    const protectedCandidates = request.requiresCredentialTransfer
      ? capabilities.filter((entry) => entry.capability.protectedInput !== undefined)
      : [undefined];
    if (protectedCandidates.length === 0) {
      return blockedTransfer(connectorId, "protected_arguments_missing");
    }
    if (request.requiresCredentialTransfer && protectedCandidates.every((entry) =>
      entry === undefined || !entry.capability.protectedInput?.sources.includes("browser")
    )) {
      return blockedTransfer(connectorId, "protected_source_unsupported");
    }
    if (!capabilities.some((entry) => entry.capability.resultRedaction !== undefined)) {
      return blockedTransfer(connectorId, "result_redaction_missing");
    }

    const selections = selectGovernedMutationAndVerificationTools({
      artifactCandidates,
      protectedCandidates,
      verificationCandidates: capabilities.filter((entry) => entry.capability.verification !== undefined)
    });
    if (selections.length === 0) {
      return blockedTransfer(connectorId, "verification_missing");
    }

    const protectedToolNames = new Set(
      protectedCandidates.flatMap((entry) => entry === undefined ? [] : [entry.tool.name])
    );
    let firstFailure: ExecutionPlanCapabilityAssessment | undefined;
    for (const selection of selections) {
      const requirements: ExecutionPlanCapabilityRequirement[] = [
        ...selection.mutations.map((tool, index) => ({
          id: `governed-mutation-${index + 1}`,
          itemId: "governed-transfer",
          tool: tool.name,
          capability: "mutate" as const,
          ...(protectedToolNames.has(tool.name) ? { requiresProtectedInput: true } : {})
        })),
        ...selection.verifications.map((tool, index) => ({
          id: `governed-verification-${index + 1}`,
          itemId: "governed-transfer",
          tool: tool.name,
          capability: "verify" as const
        }))
      ];
      const assessment = await this.assess(requirements, {
        protectedTransferAvailable: true,
        groupedProtectedTransferAvailable: true
      });
      const failure = assessment.assessments.find((entry) => entry.status !== "ready");
      if (failure === undefined) {
        return {
          status: "ready",
          connectorId,
          mutationTools: selection.mutations.map((tool) => tool.name),
          verificationTools: selection.verifications.map((tool) => tool.name)
        };
      }
      firstFailure ??= failure;
    }

    return blockedTransfer(
      connectorId,
      firstFailure?.reasonCode === "verification_missing"
        ? "verification_missing"
        : firstFailure?.reasonCode === "protected_source_unsupported"
          ? "protected_source_unsupported"
          : firstFailure?.reasonCode === "capability_metadata_invalid" || firstFailure?.reasonCode === "risk_class_missing"
            ? "capability_metadata_invalid"
            : "tool_unavailable"
    );
  }

  async assess(
    requirements: readonly ExecutionPlanCapabilityRequirement[],
    context: ExecutionPlanWriteContext = {}
  ): Promise<ExecutionPlanCapabilityPreflightResult> {
    const mutationTools = new Set(
      requirements.filter((requirement) => requirement.capability === "mutate").map((requirement) => requirement.tool)
    );
    let browserSourceAvailable: boolean | undefined;
    const assessBrowserSource = async (): Promise<boolean> => {
      if (browserSourceAvailable !== undefined) return browserSourceAvailable;
      try {
        browserSourceAvailable = await this.#browserSourceAvailable?.() === true;
      } catch {
        browserSourceAvailable = false;
      }
      return browserSourceAvailable;
    };

    const assessments: ExecutionPlanCapabilityAssessment[] = [];
    for (const requirement of requirements) {
      const tool = this.#registry.get(requirement.tool);
      if (tool === undefined) {
        assessments.push(failed(requirement, "missing", "tool_missing"));
        continue;
      }

      const registered = resolveRegisteredToolCapability(tool);
      if (!registered.ok) {
        assessments.push(failed(requirement, "incompatible", registered.reason));
        continue;
      }
      let available = false;
      try {
        available = await tool.isAvailable();
      } catch {
        available = false;
      }
      if (!available) {
        assessments.push(failed(requirement, "unavailable", "tool_unavailable"));
        continue;
      }

      const capability = registered.capability;
      if (!classificationMatches(requirement.capability, capability.classification)) {
        assessments.push(failed(requirement, "incompatible", "risk_mismatch"));
        continue;
      }

      let verification: ExecutionPlanCapabilityResolution["verification"];
      if (requirement.capability === "verify") {
        const candidates = [...mutationTools].filter((mutationTool) => mutationTool !== requirement.tool);
        const verifiedMutationTools = capability.verification === undefined
          ? candidates
          : candidates.filter((mutationTool) => capability.verification!.verifies.includes(mutationTool));
        if (verifiedMutationTools.length === 0) {
          assessments.push(failed(requirement, "incompatible", "verification_missing"));
          continue;
        }
        verification = { mutationTools: verifiedMutationTools };
      }

      let protectedInput: ExecutionPlanCapabilityResolution["protectedInput"];
      if (requirement.requiresProtectedInput === true) {
        if (capability.protectedInput === undefined || capability.protectedInput.paths.length === 0) {
          assessments.push(failed(requirement, "incompatible", "protected_path_missing"));
          continue;
        }
        if (capability.protectedInput.paths.length > EXECUTION_PLAN_MAX_PROTECTED_PATHS) {
          assessments.push(failed(requirement, "incompatible", "capability_metadata_invalid"));
          continue;
        }
        const requiresGroupedTransfer = capability.protectedInput.paths.length > 1 ||
          capability.protectedInput.paths.some((path) => path.split("/").includes("*"));
        if (requiresGroupedTransfer && !capability.protectedInput.groupedDelivery) {
          assessments.push(failed(requirement, "incompatible", "grouped_transfer_unsupported"));
          continue;
        }
        if (requirement.protectedSource === "browser" && !capability.protectedInput.sources.includes("browser")) {
          assessments.push(failed(requirement, "incompatible", "protected_source_unsupported"));
          continue;
        }
        if (context.protectedTransferAvailable !== true ||
          (requiresGroupedTransfer && context.groupedProtectedTransferAvailable !== true)) {
          assessments.push(failed(requirement, "unavailable", "protected_transfer_unavailable"));
          continue;
        }
        if (requirement.protectedSource === "browser" && !await assessBrowserSource()) {
          assessments.push(failed(requirement, "unavailable", "protected_source_unavailable"));
          continue;
        }
        protectedInput = {
          paths: [...capability.protectedInput.paths],
          grouped: requiresGroupedTransfer,
          ...(requirement.protectedSource === undefined ? {} : { source: requirement.protectedSource })
        };
      }

      assessments.push({
        requirementId: requirement.id,
        itemId: requirement.itemId,
        tool: requirement.tool,
        capability: requirement.capability,
        status: "ready",
        resolution: {
          canonicalTool: capability.canonicalTool,
          riskClass: capability.riskClass,
          classification: capability.classification as "read" | "mutate",
          ...(protectedInput === undefined ? {} : { protectedInput }),
          ...(verification === undefined ? {} : { verification })
        }
      });
    }

    enforceIndependentVerificationCoverage(assessments, mutationTools);

    return {
      status: assessments.every((assessment) => assessment.status === "ready") ? "ready" : "blocked",
      assessments
    };
  }
}

type GovernedCapabilityEntry = {
  tool: RegisteredTool;
  capability: ResolvedRegisteredToolCapability;
};

function selectGovernedMutationAndVerificationTools(input: {
  artifactCandidates: Array<GovernedCapabilityEntry | undefined>;
  protectedCandidates: Array<GovernedCapabilityEntry | undefined>;
  verificationCandidates: GovernedCapabilityEntry[];
}): Array<{ mutations: GovernedCapabilityEntry["tool"][]; verifications: GovernedCapabilityEntry["tool"][] }> {
  const selections: Array<{
    mutations: GovernedCapabilityEntry["tool"][];
    verifications: GovernedCapabilityEntry["tool"][];
  }> = [];
  for (const artifact of input.artifactCandidates) {
    for (const protectedEntry of input.protectedCandidates) {
      const mutations = [...new Map(
        [artifact, protectedEntry]
          .filter((entry): entry is GovernedCapabilityEntry => entry !== undefined)
          .map((entry) => [entry.tool.name, entry.tool])
      ).values()];
      const uncovered = new Set(mutations.map((tool) => tool.name));
      const verifications: GovernedCapabilityEntry["tool"][] = [];
      for (const candidate of input.verificationCandidates) {
        const verifies = candidate.capability.verification?.verifies ?? [];
        if (!verifies.some((tool) => uncovered.has(tool))) continue;
        verifications.push(candidate.tool);
        for (const tool of verifies) uncovered.delete(tool);
        if (uncovered.size === 0) break;
      }
      if (mutations.length > 0 && uncovered.size === 0) {
        selections.push({ mutations, verifications });
      }
    }
  }
  return selections;
}

function blockedTransfer(
  connectorId: string,
  reasonCode: GovernedTransferPreflightReason
): GovernedTransferPreflightResult {
  return { status: "blocked", connectorId, reasonCode };
}

export function formatGovernedTransferBlocker(input: {
  result: Extract<GovernedTransferPreflightResult, { status: "blocked" }>;
  locale?: "en" | "ar";
}): string {
  const connector = `"${input.result.connectorId}"`;
  if (input.locale === "ar") {
    switch (input.result.reasonCode) {
      case "destination_connector_missing":
        return `لا يمكن بدء النقل: موصل الوجهة ${connector} غير مهيأ في الملف الشخصي المحدد.`;
      case "artifact_import_missing":
        return `لا يمكن بدء النقل إلى ${connector}: وسيطة استيراد الملفات المُراجعة غير مهيأة. هيّئ artifactToolArguments ثم أعد المحاولة.`;
      case "protected_arguments_missing":
        return `لا يمكن بدء نقل بيانات الاعتماد إلى ${connector}: وسائط بيانات الاعتماد المحمية غير مهيأة. هيّئ protectedToolArguments ثم أعد المحاولة.`;
      case "protected_source_unsupported":
        return `لا يمكن بدء نقل بيانات الاعتماد إلى ${connector}: النقل المحمي من المتصفح غير مهيأ.`;
      case "result_redaction_missing":
        return `لا يمكن بدء النقل إلى ${connector}: تنقيح نتائج الموصل غير مهيأ. هيّئ redactedToolResultPaths ثم أعد المحاولة.`;
      case "verification_missing":
        return `لا يمكن بدء النقل إلى ${connector}: علاقات التحقق المستقل غير مهيأة. هيّئ toolVerificationRelationships ثم أعد المحاولة.`;
      case "capability_metadata_invalid":
        return `لا يمكن بدء النقل إلى ${connector}: إعداد قدرة الموصل غير صالح في الملف الشخصي المحدد.`;
      case "tool_unavailable":
        return `لا يمكن بدء النقل إلى ${connector}: إحدى أدوات النقل المُراجعة غير متاحة حاليًا.`;
    }
  }
  switch (input.result.reasonCode) {
    case "destination_connector_missing":
      return `Governed transfer cannot start: destination connector ${connector} is not configured in the selected profile.`;
    case "artifact_import_missing":
      return `Governed transfer to ${connector} cannot start: no reviewed artifact-import argument is configured. Configure artifactToolArguments and retry.`;
    case "protected_arguments_missing":
      return `Credential transfer to ${connector} cannot start: no reviewed protected credential arguments are configured. Configure protectedToolArguments and retry.`;
    case "protected_source_unsupported":
      return `Credential transfer to ${connector} cannot start: protected browser relay is not configured.`;
    case "result_redaction_missing":
      return `Governed transfer to ${connector} cannot start: connector result redaction is not configured. Configure redactedToolResultPaths and retry.`;
    case "verification_missing":
      return `Governed transfer to ${connector} cannot start: independent verification relationships are not configured. Configure toolVerificationRelationships and retry.`;
    case "capability_metadata_invalid":
      return `Governed transfer to ${connector} cannot start: the selected profile has invalid connector capability metadata.`;
    case "tool_unavailable":
      return `Governed transfer to ${connector} cannot start: a reviewed transfer tool is currently unavailable.`;
  }
}

export function detectRoutedGovernedTransfer(input: {
  userText: string;
  selectedSkillName?: string;
  namedConnectorIds: readonly string[];
}): GovernedTransferPreflightRequest | undefined {
  if (input.selectedSkillName !== "api-integration") return undefined;
  const connectorIds = [...new Set(input.namedConnectorIds)];
  if (connectorIds.length !== 1) return undefined;
  const normalized = input.userText.normalize("NFKC").toLocaleLowerCase("en-US");
  const requiresCredentialTransfer = /\b(?:credentials?|api\s+keys?|keys?|secrets?|tokens?|authentication|auth)\b/iu.test(normalized);
  const requiresArtifactTransfer = /\b(?:apis?|products?|openapi|swagger|specifications?|specs?|collections?)\b/iu.test(normalized);
  if (!requiresArtifactTransfer && !requiresCredentialTransfer) return undefined;
  return {
    connectorId: connectorIds[0]!,
    requiresArtifactTransfer,
    requiresCredentialTransfer
  };
}

function enforceIndependentVerificationCoverage(
  assessments: ExecutionPlanCapabilityAssessment[],
  mutationTools: ReadonlySet<string>
): void {
  if (mutationTools.size === 0) return;
  const covered = new Set(
    assessments.flatMap((assessment) =>
      assessment.status === "ready" && assessment.capability === "verify"
        ? assessment.resolution?.verification?.mutationTools ?? []
        : []
    )
  );
  if ([...mutationTools].every((tool) => covered.has(tool))) return;
  const verification = assessments.find((assessment) =>
    assessment.status === "ready" && assessment.capability === "verify"
  );
  if (verification === undefined) return;
  verification.status = "incompatible";
  verification.reasonCode = "verification_missing";
  verification.resolution = undefined;
}

export function formatExecutionCapabilityBlocker(input: {
  assessment: ExecutionPlanCapabilityAssessment;
  locale?: "en" | "ar";
}): string {
  const { assessment } = input;
  const locale = input.locale ?? "en";
  const tool = `"${assessment.tool}"`;
  if (locale === "ar") {
    if (assessment.reasonCode === "tool_missing") {
      return `الأداة المطلوبة ${tool} غير متاحة في هذه الجلسة.`;
    }
    if (assessment.reasonCode === "protected_path_missing") {
      return `الأداة ${tool} لا تعلن مسارات الإدخال المحمي المطلوبة.`;
    }
    if (assessment.reasonCode === "risk_class_missing") {
      return `الأداة ${tool} لا تعلن تصنيف مخاطر صالحًا.`;
    }
    if (assessment.reasonCode === "capability_metadata_invalid") {
      return `بيانات قدرة الأداة ${tool} غير صالحة.`;
    }
    if (assessment.reasonCode === "grouped_transfer_unsupported") {
      return `الأداة ${tool} لا تدعم تسليم الإدخالات المحمية كمجموعة ذرية.`;
    }
    if (assessment.reasonCode === "protected_source_unsupported") {
      return `الأداة ${tool} لا تدعم النقل المحمي من المتصفح.`;
    }
    if (assessment.reasonCode === "verification_missing") {
      return `الأداة ${tool} لا تعلن تحققًا مستقلاً للتغيير المطلوب.`;
    }
    if (assessment.reasonCode === "risk_mismatch") {
      return assessment.capability === "verify"
        ? `الأداة ${tool} ليست أداة تحقق مستقلة وآمنة للقراءة.`
        : `تصنيف مخاطر الأداة ${tool} لا يطابق القدرة المطلوبة.`;
    }
    if (assessment.reasonCode === "protected_source_unavailable") {
      return `النقل المحمي من المتصفح إلى الأداة ${tool} غير متاح.`;
    }
    if (assessment.reasonCode === "protected_transfer_unavailable") {
      return `نقل الإدخال المحمي إلى الأداة ${tool} غير متاح.`;
    }
    return `الأداة المطلوبة ${tool} غير متاحة حاليًا.`;
  }
  if (assessment.reasonCode === "tool_missing") {
    return `Required tool ${tool} is not exposed to this session.`;
  }
  if (assessment.reasonCode === "protected_path_missing") {
    return `Tool ${tool} does not declare the required protected input paths.`;
  }
  if (assessment.reasonCode === "risk_class_missing") {
    return `Tool ${tool} does not declare a valid runtime risk class.`;
  }
  if (assessment.reasonCode === "capability_metadata_invalid") {
    return `Tool ${tool} has invalid runtime capability metadata.`;
  }
  if (assessment.reasonCode === "grouped_transfer_unsupported") {
    return `Tool ${tool} does not support atomic grouped protected delivery.`;
  }
  if (assessment.reasonCode === "protected_source_unsupported") {
    return `Tool ${tool} does not support protected browser-source relay.`;
  }
  if (assessment.reasonCode === "verification_missing") {
    return `Tool ${tool} does not declare independent verification for the required mutation.`;
  }
  if (assessment.reasonCode === "risk_mismatch") {
    return assessment.capability === "verify"
      ? `Tool ${tool} is not an independent read-safe verification tool.`
      : `Tool ${tool} has a risk class incompatible with the required capability.`;
  }
  if (assessment.reasonCode === "protected_source_unavailable") {
    return `Protected browser-to-tool transfer is unavailable for ${tool}.`;
  }
  if (assessment.reasonCode === "protected_transfer_unavailable") {
    return `Protected input transfer is unavailable for ${tool}.`;
  }
  return `Required tool ${tool} is currently unavailable.`;
}

function classificationMatches(
  capability: ExecutionPlanCapabilityRequirement["capability"],
  classification: "read" | "mutate" | "unsupported"
): boolean {
  return capability === "mutate"
    ? classification === "mutate"
    : classification === "read";
}

function failed(
  requirement: ExecutionPlanCapabilityRequirement,
  status: "missing" | "unavailable" | "incompatible",
  reasonCode: NonNullable<ExecutionPlanCapabilityAssessment["reasonCode"]>
): ExecutionPlanCapabilityAssessment {
  return {
    requirementId: requirement.id,
    itemId: requirement.itemId,
    tool: requirement.tool,
    capability: requirement.capability,
    status,
    reasonCode
  };
}
