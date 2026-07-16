import type { FileChangePreviewViewModel } from "./view-model.js";
import type { SessionCompressionTrigger } from "./session.js";
import type {
  ProviderFinishReason,
  ProviderReasoningMetadata,
  ProviderRouteRole,
  ProviderUsage
} from "./provider.js";
import type {
  SkillRouteTelemetryDetails,
  SkillRouteFinalOutcomeStatus
} from "./skill.js";

export type ContextEstimateStage =
  | "input"
  | "memory"
  | "skill"
  | "tools"
  | "preflight"
  | "provider-tool-feedback"
  | "assembled-prompt";

export type RuntimeEvent =
  | {
      kind: "agent-start";
      sessionId: string;
      input: string;
    }
  | {
      kind: "intent";
      labels: string[];
      confidence: number;
    }
  | {
      kind: "skill";
      name: string;
    }
  | {
      kind: "tool-start";
      tool: string;
      stepId?: string;
      targetSummary?: string;
      displayPreview?: string;
      activityId?: string;
    }
  | {
      kind: "tool-result";
      tool: string;
      decision?: string;
      riskClass?: string;
      ok?: boolean;
      chars?: number;
      sentChars?: number;
      truncated?: boolean;
      fileChangePreview?: FileChangePreviewViewModel;
      targetSummary?: string;
      displayPreview?: string;
      activityId?: string;
    }
  | {
      kind: "provider-attempt";
      provider: string;
      model: string;
      fallback: boolean;
    }
  | {
      kind: "provider-token";
      provider: string;
      model: string;
      text: string;
    }
  | {
      kind: "provider-tool-call";
      provider: string;
      model: string;
      index?: number;
      id?: string;
      name?: string;
      argumentsText?: string;
    }
  | {
      kind: "provider-result";
      provider: string;
      model: string;
      ok: boolean;
      fallback: boolean;
      willFallback: boolean;
      errorClass?: string;
      finishReason?: ProviderFinishReason;
      incompleteReason?: string;
      usage?: ProviderUsage;
      reasoningMetadata?: ProviderReasoningMetadata;
    }
  | {
      kind: "provider-serving-transition";
      transition: "fallback-active" | "primary-recovered";
      provider: string;
      model: string;
    }
  | {
      kind: "provider-budget-exhausted";
      budget: string;
      limit: number;
      observed: number;
      reason: string;
    }
  | {
      kind: "context-estimate";
      filled: number;
      total: number;
      source: "live-estimate" | "assembled-prompt";
      stage: ContextEstimateStage;
    }
  | {
      kind: "context-window-usage";
      usedTokens: number;
      totalTokens: number;
      provider: string;
      model: string;
      source: "provider-actual";
      routeRole?: ProviderRouteRole;
    }
  | {
      /** @deprecated Compatibility event for consumers that have not migrated to the split context contracts. */
      kind: "context-usage";
      filled: number;
      total: number;
      source: "live-estimate" | "assembled-prompt" | "provider-actual";
    }
  | {
      kind: "session-compacted";
      originalSessionId: string;
      activeSessionId: string;
      rotated: boolean;
      trigger: SessionCompressionTrigger;
      postTokens: number;
    }
  | {
      kind: "memory-curation";
      trigger: "turn-count" | "compact" | "handoff" | "runtime-dispose" | "manual";
      status: "auto-applied" | "pending-review" | "ignored" | "failed";
      extractedFactCount: number;
      candidateCount: number;
      autoAppliedCount: number;
      pendingReviewCount: number;
      ignoredCount: number;
      failedCount: number;
      warningCount: number;
    }
  | {
      kind: "security-risk-escalated";
      from: string;
      to: string;
      reason: string;
    }
  | {
      kind: "skill-route-telemetry";
      promptHash: string;
      selectedSkill?: string;
      finalSkillUsed?: string;
      taskClass?: string;
      primarySkill?: string;
      supportingSkills?: string[];
      candidateSkills?: string[];
      candidatesRejected?: Array<{ skillName: string; reason?: string }>;
      rejectedCandidates?: Array<{ skillName: string; reason?: string }>;
      deferredCandidates?: Array<{ skillName: string; reason?: string }>;
      shadowSemanticRoute?: SkillRouteTelemetryDetails["shadowSemanticRoute"];
      shadowLlmRerank?: SkillRouteTelemetryDetails["shadowLlmRerank"];
      confidence: number;
      routeConfidence?: number;
      candidatesShown?: string[];
      finalOutcomeStatus?: SkillRouteFinalOutcomeStatus;
      candidates: Array<{
        skillName: string;
        selected: boolean;
        explicitInvocation: boolean;
        confidence: number;
        sourceKind: string;
        role?: string;
      }>;
      details?: SkillRouteTelemetryDetails;
    }
  | {
      kind: "skill-route-advisory";
      promptHash: string;
      selectedSkill?: string;
      action: "reject_route" | "search_routes" | "rerank";
      details: SkillRouteTelemetryDetails;
    }
  | {
      kind: "skill-lifecycle-changed";
      skillName: string;
      from?: string;
      to: string;
      reason?: string;
    }
  | {
      kind: "session-recall-decision";
      triggered: boolean;
      reason: string;
      sourceSessionIds: string[];
    }
  | {
      kind: "agent-cancelled";
      reason: string;
      resumeNote?: string;
    }
  | {
      kind: "agent-final";
      text: string;
    }
  | {
      kind: "delegation-progress";
      subagentId: string;
      childSessionId: string;
      parentSessionId: string;
      role: "leaf" | "orchestrator";
      depth: number;
      taskIndex?: number;
      batchId?: string;
      taskLabel?: string;
      batchTaskCount?: number;
      childEvent: {
        kind:
          | "agent-start"
          | "tool-start"
          | "tool-result"
          | "provider-attempt"
          | "provider-result"
          | "provider-budget-exhausted"
          | "agent-final"
          | "agent-cancelled"
          | "delegation-result";
        sessionId?: string;
        tool?: string;
        activityId?: string;
        displayPreview?: string;
        decision?: string;
        riskClass?: string;
        ok?: boolean;
        chars?: number;
        sentChars?: number;
        truncated?: boolean;
        provider?: string;
        model?: string;
        fallback?: boolean;
        willFallback?: boolean;
        errorClass?: string;
        finishReason?: ProviderFinishReason;
        incompleteReason?: string;
        budget?: string;
        limit?: number;
        observed?: number;
        reason?: string;
        status?: "completed" | "blocked" | "failed" | "timeout" | "cancelled";
      };
    };

export type RuntimeEventSink = (event: RuntimeEvent) => void | Promise<void>;
