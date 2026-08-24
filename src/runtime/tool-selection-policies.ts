import type { IntentRoute, IntentTaskClass } from "../contracts/intent.js";
import type { ToolRiskClass, ToolsetName } from "../contracts/tool.js";

export type ToolSelectionPolicyName =
  | "conversation"
  | "repo-inspection"
  | "repo-modification"
  | "provider-diagnostics"
  | "browser-operation"
  | "named-connector-operation"
  | "research"
  | "bounded-general";

export type ToolSelectionPolicy = {
  name: ToolSelectionPolicyName;
  toolsets: readonly ToolsetName[];
  allowedRiskClasses: readonly ToolRiskClass[];
  plan: "never" | "actionable" | "long-running";
};

const READ_ONLY_RISKS = ["read-only-local", "read-only-network"] as const;
const REPOSITORY_MUTATION_RISKS = [...READ_ONLY_RISKS, "workspace-write"] as const;

export const TOOL_SELECTION_POLICIES: Readonly<Record<ToolSelectionPolicyName, ToolSelectionPolicy>> = {
  conversation: {
    name: "conversation",
    toolsets: [],
    allowedRiskClasses: [],
    plan: "never"
  },
  "repo-inspection": {
    name: "repo-inspection",
    toolsets: ["files", "shell-readonly"],
    allowedRiskClasses: READ_ONLY_RISKS,
    plan: "long-running"
  },
  "repo-modification": {
    name: "repo-modification",
    toolsets: ["files", "shell-readonly", "shell-write", "coding"],
    allowedRiskClasses: REPOSITORY_MUTATION_RISKS,
    plan: "actionable"
  },
  "provider-diagnostics": {
    name: "provider-diagnostics",
    toolsets: ["provider", "configuration", "diagnostics"],
    allowedRiskClasses: [...READ_ONLY_RISKS, "shared-state-mutation"],
    plan: "long-running"
  },
  "browser-operation": {
    name: "browser-operation",
    toolsets: ["browser"],
    allowedRiskClasses: [
      ...READ_ONLY_RISKS,
      "workspace-write",
      "shared-state-mutation",
      "external-side-effect"
    ],
    plan: "actionable"
  },
  "named-connector-operation": {
    name: "named-connector-operation",
    toolsets: [],
    allowedRiskClasses: [],
    plan: "actionable"
  },
  research: {
    name: "research",
    toolsets: ["web", "files"],
    allowedRiskClasses: READ_ONLY_RISKS,
    plan: "long-running"
  },
  "bounded-general": {
    name: "bounded-general",
    toolsets: ["web", "files"],
    allowedRiskClasses: READ_ONLY_RISKS,
    plan: "never"
  }
};

export function selectToolSelectionPolicy(input: {
  intent: IntentRoute;
  userText?: string;
  namedConnectorOperation: boolean;
  selectedSkill: boolean;
  readyAttachments: boolean;
}): ToolSelectionPolicy {
  const baseName = (
    (input.selectedSkill || input.readyAttachments) &&
    (input.intent.taskClass === undefined || input.intent.taskClass === "general")
  )
    ? "conversation"
    : policyNameForTaskClass(input.intent.taskClass, input.intent.nativeIntent);
  if (input.namedConnectorOperation) {
    const basePolicy = TOOL_SELECTION_POLICIES[baseName];
    const keepBasePolicy = baseName !== "conversation" && baseName !== "bounded-general";
    return {
      ...TOOL_SELECTION_POLICIES["named-connector-operation"],
      toolsets: keepBasePolicy ? basePolicy.toolsets : [],
      allowedRiskClasses: keepBasePolicy ? basePolicy.allowedRiskClasses : []
    };
  }
  return TOOL_SELECTION_POLICIES[baseName];
}

export function shouldIncludePlan(input: {
  policy: ToolSelectionPolicy;
  userText?: string;
  selectedSkillPlaybookSteps?: number;
}): boolean {
  if ((input.selectedSkillPlaybookSteps ?? 0) >= 3) return true;
  if (input.policy.plan === "never") return false;
  return looksLongRunning(input.userText ?? "");
}

export function isActionableToolRequest(userText: string): boolean {
  const normalized = userText.normalize("NFKC").toLocaleLowerCase("en-US");
  return /\b(?:use|add|update|create|import|configure|connect|transfer|generate|sync|read|get|list|find|search|inspect|review|delete|remove|send|open|fetch|download|upload|run|check|diagnose|debug|fix|click|press|select|fill|set\s+up|continue)\b/iu.test(normalized) ||
    /\b(?:let'?s\s+do\s+(?:it|this)|go\s+ahead|carry\s+on|proceed)\b/iu.test(normalized) ||
    /(?:استخدم|أضف|اضف|حد[ّ]?ث|أنشئ|انشئ|استورد|اضبط|اربط|انقل|ول[ّ]?د|زامن|اقرأ|اجلب|اعرض|ابحث|افحص|راجع|احذف|أرسل|ارسل|افتح|نز[ّ]?ل|ارفع|شغ[ّ]?ل|تحق[ّ]?ق|شخ[ّ]?ص|صح[ّ]?ح|انقر|اضغط|اختر|املأ|تابع)/u.test(normalized);
}

function policyNameForTaskClass(
  taskClass: IntentTaskClass | undefined,
  nativeIntent: IntentRoute["nativeIntent"]
): ToolSelectionPolicyName {
  if (nativeIntent === "browser-control" || taskClass === "browser-operation") return "browser-operation";
  switch (taskClass) {
    case "conversation":
    case "architecture-advice":
      return "conversation";
    case "repo-inspection":
    case "code-review":
      return "repo-inspection";
    case "repo-change":
    case "docs-writing":
    case "release-validation":
      return "repo-modification";
    case "provider-diagnostics":
      return "provider-diagnostics";
    case "research":
      return "research";
    case "media-generation":
    case "attachment-analysis":
      return "conversation";
    case "general":
    case undefined:
      return "bounded-general";
  }
}

function looksLongRunning(userText: string): boolean {
  const normalized = userText.normalize("NFKC").toLocaleLowerCase("en-US");
  return /\b(?:all|every|multiple|several|end[- ]to[- ]end|across|migrate|set\s+up|then|after that|step by step)\b/iu.test(normalized) ||
    /\b(?:and|then)\s+(?:run|test|verify|validate|check|import|configure|connect|transfer|download|upload)\b/iu.test(normalized) ||
    /(?:كل|جميع|متعدد|عد[ّ]?ة|شامل|عبر|رح[ّ]?ل|إعداد|اعداد|ثم|بعد ذلك|خطوة بخطوة)/u.test(normalized);
}
