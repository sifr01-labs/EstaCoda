import type { ChannelKind } from "./channel.js";
import type { ToolRiskClass } from "./tool.js";

export type SecurityDecision = "allow" | "ask" | "deny";

export type SecurityContext = {
  trustedWorkspace: boolean;
  activeChannel?: ChannelKind;
  targetChannel?: ChannelKind;
  targetConversationIsActive?: boolean;
};

export type SecurityRequest = {
  riskClass: ToolRiskClass;
  description: string;
  context: SecurityContext;
};

export type SecurityPolicy = {
  decide(request: SecurityRequest): SecurityDecision;
};

export const capabilityFirstDefaults: SecurityPolicy = {
  decide(request) {
    if (request.riskClass === "read-only-local" && request.context.trustedWorkspace) {
      return "allow";
    }

    if (request.riskClass === "read-only-network") {
      return "allow";
    }

    if (request.riskClass === "workspace-write" && request.context.trustedWorkspace) {
      return "allow";
    }

    if (request.riskClass === "shared-state-mutation" && request.context.trustedWorkspace) {
      return "allow";
    }

    if (
      request.riskClass === "external-side-effect" &&
      request.context.targetConversationIsActive
    ) {
      return "allow";
    }

    if (
      request.riskClass === "credential-access" ||
      request.riskClass === "destructive-local" ||
      request.riskClass === "spend-money" ||
      request.riskClass === "sandbox-escape"
    ) {
      return "ask";
    }

    return "ask";
  }
};
