import type {
  ExecutionPlanCapabilityAssessment,
  ExecutionPlanCapabilityPreflight as ExecutionPlanCapabilityPreflightResult,
  ExecutionPlanCapabilityRequirement,
  ExecutionPlanWriteContext
} from "../contracts/execution-plan.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

const READ_RISK_CLASSES = new Set<ToolRiskClass>(["read-only-local", "read-only-network"]);
const MUTATION_RISK_CLASSES = new Set<ToolRiskClass>([
  "workspace-write",
  "external-side-effect",
  "destructive-local",
  "shared-state-mutation",
  "spend-money"
]);

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

      if (!riskMatches(requirement.capability, tool.riskClass) ||
        (requirement.capability === "verify" && mutationTools.has(requirement.tool))) {
        assessments.push(failed(requirement, "incompatible", "risk_mismatch"));
        continue;
      }

      if (requirement.protectedPaths !== undefined) {
        const declaredPaths = new Set((tool.protectedArguments ?? []).map((entry) => entry.path));
        if (requirement.protectedPaths.some((path) => !declaredPaths.has(path))) {
          assessments.push(failed(requirement, "incompatible", "protected_path_missing"));
          continue;
        }
        const requiresGroupedTransfer = requirement.protectedPaths.length > 1 ||
          requirement.protectedPaths.some((path) => path.split("/").includes("*"));
        if (context.protectedTransferAvailable !== true ||
          (requiresGroupedTransfer && context.groupedProtectedTransferAvailable !== true) ||
          (requirement.protectedSource === "browser" && !await assessBrowserSource())) {
          assessments.push(failed(requirement, "unavailable", "tool_unavailable"));
          continue;
        }
      }

      assessments.push({
        requirementId: requirement.id,
        itemId: requirement.itemId,
        tool: requirement.tool,
        capability: requirement.capability,
        status: "ready"
      });
    }

    return {
      status: assessments.every((assessment) => assessment.status === "ready") ? "ready" : "blocked",
      assessments
    };
  }
}

export function formatExecutionCapabilityBlocker(input: {
  assessment: ExecutionPlanCapabilityAssessment;
  requirement?: ExecutionPlanCapabilityRequirement;
  locale?: "en" | "ar";
}): string {
  const { assessment, requirement } = input;
  const locale = input.locale ?? "en";
  const tool = `"${assessment.tool}"`;
  if (locale === "ar") {
    if (assessment.reasonCode === "tool_missing") {
      return `الأداة المطلوبة ${tool} غير متاحة في هذه الجلسة.`;
    }
    if (assessment.reasonCode === "protected_path_missing") {
      return `الأداة ${tool} لا تعلن مسارات الإدخال المحمي المطلوبة.`;
    }
    if (assessment.reasonCode === "risk_mismatch") {
      return assessment.capability === "verify"
        ? `الأداة ${tool} ليست أداة تحقق مستقلة وآمنة للقراءة.`
        : `تصنيف مخاطر الأداة ${tool} لا يطابق القدرة المطلوبة.`;
    }
    if (requirement?.protectedSource === "browser") {
      return `النقل المحمي من المتصفح إلى الأداة ${tool} غير متاح.`;
    }
    if (requirement?.protectedPaths !== undefined) {
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
  if (assessment.reasonCode === "risk_mismatch") {
    return assessment.capability === "verify"
      ? `Tool ${tool} is not an independent read-safe verification tool.`
      : `Tool ${tool} has a risk class incompatible with the required capability.`;
  }
  if (requirement?.protectedSource === "browser") {
    return `Protected browser-to-tool transfer is unavailable for ${tool}.`;
  }
  if (requirement?.protectedPaths !== undefined) {
    return `Protected input transfer is unavailable for ${tool}.`;
  }
  return `Required tool ${tool} is currently unavailable.`;
}

function riskMatches(capability: ExecutionPlanCapabilityRequirement["capability"], riskClass: ToolRiskClass): boolean {
  return capability === "mutate"
    ? MUTATION_RISK_CLASSES.has(riskClass)
    : READ_RISK_CLASSES.has(riskClass);
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
