export const ACTION_IDS = ['sessions.resume', 'sessions.send', 'sessions.cancelTurn', 'tasks.pause', 'tasks.resume', 'tasks.cancel', 'tasks.retry', 'tasks.guide',
  'approve_once', 'reject', 'open_work', 'inspect_result', 'review_setup', 'review_trust', 'review_evolution', 'review_delivery'] as const;
export type ActionId = typeof ACTION_IDS[number];
/** Omitted actions on older peers mean unknown, never permission to execute. */
export type ActionProjection = { id: ActionId; enabled: boolean; reason?: string; stepId?: string; sessionId?: string };
/** Display references only; core resolves ownership, paths and current authority. */
export type TargetReference = { targetId: string; targetGeneration: number };
export type TargetProjection = TargetReference & { label: string; isolation: "host" | "sandboxed" | "unknown" };
export const WORK_STATUSES = ["draft", "queued", "running", "needs_attention", "paused", "completed", "partial", "failed", "cancelled"] as const;
export type WorkDisplayStatus = typeof WORK_STATUSES[number];
export type WorkProjection = {
  actions?: ActionProjection[];
  id: string; canonicalId: string; profileId: string;
  kind: "session" | "task" | "task_attempt" | "schedule" | "scheduled_execution" | "evolution_review";
  parentWorkId?: string;
  title: string; status: WorkDisplayStatus; reason?: string; updatedAt: number;
  target: TargetProjection | null;
};
export type UsageProjection = { reportedTokens: number | null; cost: { amount: number; currency: string } | null };
export type EvidenceProjection = { state: "verified" | "unverified" | "partial" | "failed"; summary: string; artifactIds: string[] };
type ActivityBase = { id: string; workId: string; profileId: string; sequence: number; timestamp: number };
export type ActivityProjection = ActivityBase & (
  | { kind: "message"; role: "user" | "assistant"; text: string }
  | { kind: "assistant_delta"; text: string }
  | { kind: "tool"; name: string; state: "running" | "completed" | "failed" | "cancelled"; summary: string }
  | { kind: "plan"; steps: { id: string; title: string; status: "pending" | "running" | "completed" | "failed" }[] }
  | { kind: "result"; status: WorkDisplayStatus; evidence: EvidenceProjection; usage: UsageProjection }
  | { kind: "status"; status: WorkDisplayStatus; reason?: string }
);
export type InboxProjection = {
  actions?: ActionProjection[];
  id: string; profileId: string; workId: string | null;
  kind: "approval" | "input" | "trust" | "setup" | "failure" | "evolution" | "delivery";
  title: string; summary: string; createdAt: number;
  approval: { id: string; sessionId: string; target: TargetReference; actionSummary: string;
    scope: "once"; decisions: ("approved" | "denied")[] } | null;
};
export type ModelProjection = {
  id: string; providerId: string; label: string; runnable: boolean;
  credentialState: "not_required" | "missing" | "present" | "expired";
  role: "primary" | "fallback" | "auxiliary" | "session_override" | null;
};
export type ProviderProjection = { id: string; label: string; authMethods: ("api_key" | "oauth" | "none")[];
  state: "ready" | "unconfigured" | "repair_required" | "unknown" };
export type ConnectionProjection = {
  id: string; profileId: string; channel: "telegram" | "discord" | "email" | "whatsapp";
  configurationState: "configured" | "unconfigured" | "repair_required";
  runtimeState: "running" | "stopped" | "disconnected" | "unknown";
  authorizationState: "denied" | "configured" | "pairing_required" | "unknown";
  summary: string;
};
export type Page<T> = { items: T[]; nextCursor: string | null };
