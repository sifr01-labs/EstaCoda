import type {
  ExecutionCheckpointCreationInput,
  ExecutionCheckpointOperationRequirement,
  ExecutionCheckpointQualificationReason
} from "../contracts/execution-checkpoint.js";
import type { ExecutionCompletionFloor } from "../contracts/execution-plan.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { LoadedSkill, SkillDefinition } from "../contracts/skill.js";

export function qualifyForegroundExecution(input: {
  originTurnId: string;
  userText: string;
  intent: IntentRoute;
  selectedSkill?: LoadedSkill | SkillDefinition;
  completionFloor: ExecutionCompletionFloor;
  connectorIds?: readonly string[];
}): ExecutionCheckpointCreationInput | undefined {
  const toolsets = new Set([
    ...input.intent.suggestedToolsets,
    ...(input.selectedSkill?.requiredToolsets ?? []),
    ...(input.selectedSkill?.optionalToolsets ?? [])
  ]);
  const external = input.intent.taskClass === "browser-operation" || toolsets.has("browser") || toolsets.has("mcp");

  const reasons = new Set<ExecutionCheckpointQualificationReason>();
  const hasBrowser = input.intent.taskClass === "browser-operation" || toolsets.has("browser");
  const hasConnector = toolsets.has("mcp") || (input.connectorIds?.length ?? 0) > 0;
  if (hasBrowser && hasConnector) reasons.add("cross_system");
  if (input.completionFloor === "mutation_with_verification") reasons.add("verified_mutation");
  if (external && (input.selectedSkill?.playbook.length ?? 0) >= 3) reasons.add("external_multi_step");
  if (external && looksLikeAuthentication(input.userText)) reasons.add("user_input_interruption");
  if (external && looksLikeMultiItemExternalWork(input.userText)) reasons.add("multi_item");
  if (reasons.size === 0) return undefined;

  return {
    originTurnId: input.originTurnId,
    originalObjective: input.userText,
    qualificationReasons: [...reasons],
    ...(input.selectedSkill === undefined ? {} : { selectedSkillName: input.selectedSkill.name }),
    ...(input.intent.taskClass === undefined ? {} : { taskClass: input.intent.taskClass }),
    intentLabels: [...new Set(input.intent.labels)].slice(0, 16),
    requiredOperations: requiredOperations(input),
    connectorIds: [...new Set(input.connectorIds ?? [])].slice(0, 8),
    completionFloor: input.completionFloor
  };
}

function requiredOperations(input: {
  userText: string;
  selectedSkill?: LoadedSkill | SkillDefinition;
  completionFloor: ExecutionCompletionFloor;
}): ExecutionCheckpointOperationRequirement[] {
  const required = new Set<ExecutionCheckpointOperationRequirement>();
  if (input.completionFloor !== "none") required.add("read");
  if (input.completionFloor === "mutation" || input.completionFloor === "mutation_with_verification") {
    required.add("mutation");
  }
  if (input.completionFloor === "mutation_with_verification") required.add("verification");
  if (input.selectedSkill?.name === "api-integration" && /\b(?:swagger|openapi|spec(?:ification)?|download|import)\b/iu.test(input.userText)) {
    required.add("artifact_relay");
  }
  if (/\b(?:credential|credentials|secret|api[ -]?key|client[ -]?secret|key\s+and\s+secret)\b/iu.test(input.userText)) {
    required.add("protected_transfer");
  }
  if (required.size === 0) required.add("read");
  return [...required];
}

function looksLikeAuthentication(text: string): boolean {
  return /\b(?:log[ -]?in|sign[ -]?in|authenticate|authentication|2fa|mfa|otp|one[ -]?time\s+(?:code|password)|verification\s+code)\b/iu.test(text) ||
    /(?:تسجيل الدخول|المصادقة|رمز التحقق|رمز لمرة واحدة)/u.test(text);
}

function looksLikeMultiItemExternalWork(text: string): boolean {
  return /\b(?:all|every|multiple|several|each|\d+\s+(?:products?|items?|apis?|accounts?|collections?))\b/iu.test(text) ||
    /(?:كل|جميع|متعدد|عد[ّ]?ة)/u.test(text);
}
