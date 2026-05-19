import type { ChannelKind } from "./channel.js";
import type { ContextReference } from "./context.js";
import type { IntentRoute } from "./intent.js";
import type { ProviderErrorClass } from "./provider.js";
import type { PromptBudgetReport } from "./prompt.js";
import type { ArtifactRecord } from "./artifact.js";
import type { MemoryConclusion, SkillOutcome } from "./memory.js";
import type { SecurityAssessment, SecurityDecision } from "./security.js";
import type { ToolResult, ToolRiskClass } from "./tool.js";
import type { ToolCallPlan } from "./tool-plan.js";
import type { SkillLifecycleState, SkillRouteTelemetry, SkillWorkflowPlan } from "./skill.js";
import type { FailureRecord } from "./failure.js";

export type SessionRole = "user" | "agent" | "system" | "tool";

export type SessionRecord = {
  id: string;
  profileId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  parentSessionId?: string;
  metadata?: Record<string, unknown>;
};

export type SessionMessage = {
  id: string;
  sessionId: string;
  role: SessionRole;
  content: string;
  createdAt: string;
  channel?: ChannelKind;
  metadata?: Record<string, unknown>;
};

export type SessionEvent =
  | {
      kind: "intent-routed";
      route: IntentRoute;
    }
  | {
      kind: "skill-selected";
      skill: string;
    }
  | {
      kind: "skill-workflow-planned";
      plan: SkillWorkflowPlan;
    }
  | {
      kind: "skill-workflow-step";
      skill: string;
      stepId: string;
      description: string;
      status: "tool-executed" | "no-tool" | "blocked" | "skipped";
      toolsets: string[];
      tool?: string;
      reason?: string;
    }
  | {
      kind: "security-decided";
      decision: SecurityDecision;
      description: string;
      mode?: string;
      reason?: string;
    }
  | {
      kind: "security-assessed";
      tool: string;
      riskClass: ToolRiskClass;
      targetKey?: string;
      targetSummary?: string;
      assessment: SecurityAssessment;
    }
  | {
      kind: "trajectory-linked";
      trajectoryId: string;
    }
  | {
      kind: "context-expanded";
      references: ContextReference[];
      blocks: Array<{
        source: string;
        status: string;
        bytes: number;
        warnings: string[];
      }>;
      warnings: string[];
    }
  | {
      kind: "delegation-started";
      childSessionId: string;
      task: string;
      allowedToolsets: string[];
      allowedTools?: string[];
    }
  | {
      kind: "delegation-finished";
      childSessionId: string;
      summary: string;
      status: "completed" | "blocked" | "failed";
    }
  | {
      kind: "tool-called";
      tool: string;
      input: Record<string, unknown>;
    }
  | {
      kind: "tool-gated";
      tool: string;
      decision: SecurityDecision;
      riskClass: ToolRiskClass;
    }
  | {
      kind: "tool-result";
      tool: string;
      result: ToolResult;
    }
  | {
      kind: "artifact-created";
      artifact: ArtifactRecord;
      tool?: string;
    }
  | {
      kind: "provider-completion";
      iteration?: number;
      ok: boolean;
      attempts: Array<{
        provider: string;
        model: string;
        credentialId?: string;
        ok: boolean;
        errorClass?: ProviderErrorClass | string;
      }>;
      fallbackUsed: boolean;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      };
    }
  | {
      kind: "provider-continuation";
      iteration?: number;
      ok: boolean;
      attempts: Array<{
        provider: string;
        model: string;
        credentialId?: string;
        ok: boolean;
        errorClass?: ProviderErrorClass | string;
      }>;
      toolPlans: Array<{
        id: string;
        tool: string;
        status: string;
      }>;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      };
    }
  | {
      kind: "provider-iteration";
      iteration: number;
      phase: "initial" | "continuation";
      ok: boolean;
      toolCalls: number;
      executedTools: number;
      exhausted: boolean;
    }
  | {
      kind: "prompt-assembled";
      budget: PromptBudgetReport;
    }
  | {
      kind: "session-history-packed";
      sourceMessageCount: number;
      summarizedMessageCount: number;
      protectedMessageCount: number;
      protectedToolPairCount?: number;
      estimatedTokens: number;
      summary?: string;
    }
  | {
      kind: "provider-budget-exhausted";
      budget: string;
      limit: number;
      observed: number;
      reason: string;
    }
  | {
      kind: "skill-route-usage";
      timestamp: string;
      skillName?: string;
      nativeIntent: string;
      labels: string[];
      selected: boolean;
      invoked: boolean;
      deferred: boolean;
      deferReason?: string;
      confidence: number;
      evidenceKinds: string[];
      surface?: string;
    }
  | {
      kind: "skill-route-telemetry";
      telemetry: {
        promptHash: string;
        labels: string[];
        confidence: number;
        selectedSkill?: string;
        explicitInvocation: boolean;
        candidates: SkillRouteTelemetry[];
      };
    }
  | {
      kind: "skill-lifecycle-changed";
      skillName: string;
      from?: SkillLifecycleState;
      to: SkillLifecycleState;
      reason?: string;
    }
  | {
      kind: "security-risk-escalated";
      from: ToolRiskClass;
      to: ToolRiskClass;
      reason: string;
    }
  | {
      kind: "agent-cancelled";
      reason: string;
      resumeNote?: string;
      activeSkill?: string;
      activeToolPlans?: Array<{
        id: string;
        tool: string;
        status: string;
      }>;
    }
  | {
      kind: "tool-plan";
      plan: ToolCallPlan;
    }
  | {
      kind: "memory-write";
      provider: string;
      outcome: SkillOutcome;
    }
  | {
      kind: "memory-conclusion";
      provider: string;
      conclusion: MemoryConclusion;
    }
  | {
      kind: "memory-file-compaction";
      file?: string;
      dryRun?: boolean;
      status: string;
      backupId?: string;
      preRestoreBackupId?: string;
      originalChars?: number;
      compactedChars?: number;
      restoredChars?: number;
    }
  | {
      kind: "skill-learned";
      action: "observed" | "candidate" | "created";
      record: {
        key: string;
        name: string;
        content: string;
        occurrences: number;
        sourceSessionIds: string[];
        tools: string[];
        requiredToolsets: string[];
        bounded: boolean;
        status: "observed" | "candidate" | "created";
        createdSkillName?: string;
        createdSkillPath?: string;
        updatedAt: string;
      };
    }
  | {
      kind: "user-correction";
      correctionText: string;
      skillName?: string;
      reason?: string;
    };

export type SessionSearchResult = {
  session: SessionRecord;
  message: SessionMessage;
  score: number;
};

export type CreateSessionInput = {
  id?: string;
  profileId: string;
  title?: string;
  parentSessionId?: string;
  metadata?: Record<string, unknown>;
};

export type AppendMessageInput = {
  id?: string;
  sessionId: string;
  role: SessionRole;
  content: string;
  channel?: ChannelKind;
  metadata?: Record<string, unknown>;
};

export type SessionDB = {
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  listSessions(profileId?: string): Promise<SessionRecord[]>;
  appendMessage(input: AppendMessageInput): Promise<SessionMessage>;
  appendEvent(sessionId: string, event: SessionEvent): Promise<void>;
  listMessages(sessionId: string): Promise<SessionMessage[]>;
  listEvents(sessionId: string): Promise<SessionEvent[]>;
  search(query: string, options?: { profileId?: string; limit?: number }): Promise<SessionSearchResult[]>;
  saveFailure?(record: FailureRecord): Promise<void>;
};
