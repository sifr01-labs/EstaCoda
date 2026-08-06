import type {
  SecurityApprovalMode,
  SecurityAssessment,
  SecurityDataEgressContext,
  SecurityRequest
} from "../contracts/security.js";

export function dataEgressHardBlock(
  request: SecurityRequest
): { code: string; reason: string } | undefined {
  const egress = request.context.dataEgress;
  if (egress?.inference !== "hosted" || !egress.sensitivePath) return undefined;
  return {
    code: "sensitive-hosted-data-egress",
    reason: "EstaCoda will not send an image from a sensitive local path to a hosted inference provider."
  };
}

export function assessDataEgress(
  request: SecurityRequest,
  mode: SecurityApprovalMode
): SecurityAssessment | undefined {
  const egress = request.context.dataEgress;
  if (egress?.inference !== "hosted") return undefined;

  const hardBlock = dataEgressHardBlock(request);
  if (hardBlock !== undefined) {
    return assessment("deny", mode, hardBlock.reason, "high", hardBlock.code);
  }

  if (mode === "open") {
    return assessment(
      "allow",
      mode,
      "Open mode allows this non-sensitive hosted image transfer.",
      "medium",
      "open-hosted-vision-egress"
    );
  }

  if (mode === "adaptive" && isExpectedUserSource(egress)) {
    return assessment(
      "allow",
      mode,
      adaptiveExpectedSourceReason(egress),
      "low",
      `adaptive-${egress.sourceProvenance}`
    );
  }

  return assessment(
    "ask",
    mode,
    mode === "strict"
      ? "Strict mode requires approval before sending an image to a hosted inference provider."
      : "Approval is required because the agent discovered this local image instead of receiving or explicitly referencing it in the current turn.",
    "medium",
    mode === "strict" ? "strict-hosted-vision-egress" : "adaptive-agent-discovered-egress"
  );
}

function isExpectedUserSource(egress: SecurityDataEgressContext): boolean {
  return egress.sourceProvenance === "current-turn-attachment" ||
    egress.sourceProvenance === "explicit-reference" ||
    egress.sourceProvenance === "browser-artifact" ||
    egress.sourceProvenance === "generated-artifact";
}

function adaptiveExpectedSourceReason(egress: SecurityDataEgressContext): string {
  switch (egress.sourceProvenance) {
    case "current-turn-attachment":
      return "Adaptive mode allows the current-turn user image attachment to use the configured hosted vision route.";
    case "explicit-reference":
      return "Adaptive mode allows the image because the user explicitly referenced it in the current turn.";
    case "browser-artifact":
      return "Adaptive mode allows the browser screenshot produced by the current tool call to use the configured hosted vision route.";
    case "generated-artifact":
      return "Adaptive mode allows the image generated in the selected profile cache to use the configured hosted vision route.";
    case "agent-discovered":
      return "Approval is required for an agent-discovered image.";
  }
}

function assessment(
  decision: SecurityAssessment["decision"],
  mode: SecurityApprovalMode,
  reason: string,
  risk: SecurityAssessment["risk"],
  deterministicRule: string
): SecurityAssessment {
  return {
    decision,
    mode,
    reason,
    risk,
    deterministicRule,
    assessor: { used: false, status: "disabled" }
  };
}
