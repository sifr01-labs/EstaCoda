import type { FileChangePreviewViewModel } from "./view-model.js";
import type { SessionCompressionTrigger } from "./session.js";
import type {
  ProviderFinishReason,
  ProviderReasoningMetadata,
  ProviderUsage
} from "./provider.js";

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
      kind: "provider-budget-exhausted";
      budget: string;
      limit: number;
      observed: number;
      reason: string;
    }
  | {
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
      kind: "security-risk-escalated";
      from: string;
      to: string;
      reason: string;
    }
  | {
      kind: "skill-route-telemetry";
      promptHash: string;
      selectedSkill?: string;
      confidence: number;
      candidates: Array<{
        skillName: string;
        selected: boolean;
        explicitInvocation: boolean;
        confidence: number;
        sourceKind: string;
      }>;
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
    };

export type RuntimeEventSink = (event: RuntimeEvent) => void | Promise<void>;
