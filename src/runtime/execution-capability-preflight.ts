import type {
  ExecutionPlanCapabilityAssessment,
  ExecutionPlanCapabilityPreflight as ExecutionPlanCapabilityPreflightResult,
  ExecutionPlanCapabilityResolution,
  ExecutionPlanCapabilityRequirement,
  ExecutionPlanWriteContext
} from "../contracts/execution-plan.js";
import { EXECUTION_PLAN_MAX_PROTECTED_PATHS } from "../contracts/execution-plan.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { resolveRegisteredToolCapability } from "../tools/tool-capability.js";

/**
 * Assesses declared Mission requirements against the final, session-owned tool
 * registry. It only inspects declarations and availability; it never invokes a
 * tool, resolves approval, or claims remote account permissions.
 */
export class ExecutionCapabilityPreflight {
  readonly #registry: Pick<ToolRegistry, "get">;
  readonly #browserSourceAvailable: (() => boolean | Promise<boolean>) | undefined;

  constructor(options: {
    registry: Pick<ToolRegistry, "get">;
    browserSourceAvailable?: () => boolean | Promise<boolean>;
  }) {
    this.#registry = options.registry;
    this.#browserSourceAvailable = options.browserSourceAvailable;
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
