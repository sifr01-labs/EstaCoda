import type {ArtifactReference} from './artifacts.js';
export const ACTION_IDS = ['sessions.resume', 'sessions.send', 'sessions.cancelTurn', 'tasks.pause', 'tasks.resume', 'tasks.cancel', 'tasks.retry', 'tasks.guide',
  'approve_once', 'reject', 'open_work', 'inspect_result', 'review_setup', 'review_trust', 'review_evolution', 'review_delivery'] as const;
export type ActionId = typeof ACTION_IDS[number];
/** Omitted actions on older peers mean unknown, never permission to execute. */
export type ActionProjection = { id: ActionId; enabled: boolean; reason?: string; stepId?: string; sessionId?: string };
/** Display references only; core resolves ownership, paths and current authority. */
export type TargetReference = { targetId: string; targetGeneration: number };
export type TargetProjection = TargetReference & { label: string; isolation: "host" | "sandboxed" | "unknown"; approvalMode?: "strict" | "adaptive" | "open" };
export const WORK_STATUSES = ["draft", "queued", "running", "needs_attention", "paused", "completed", "partial", "failed", "cancelled"] as const;
export type WorkDisplayStatus = typeof WORK_STATUSES[number];
export type TaskProgressProjection = {
  fileOutput: string | null; fileVerified: boolean; truncated: boolean;
  steps: { id: string; title: string; role: string; status: string; accepted: boolean; diagnostic: boolean;
    attempts: number; reason?: string; attemptWorkId?: string }[];
};
export type ExecutionModelProjection = { providerId: string; modelId: string; fallback: boolean; state: "attempting" | "responded" | "failed" };
export type WorkProjection = {
  executionModel?: ExecutionModelProjection;
  executionModelActive?: boolean;
  taskProgress?: TaskProgressProjection;
  modelBinding?: {sessionId:string;taskId?:string};
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
  | { kind: "message"; role: "user" | "assistant"; text: string; phase?: "progress" | "response" }
  | { kind: "assistant_delta"; text: string }
  | { kind: "tool"; name: string; state: "running" | "completed" | "failed" | "cancelled"; summary: string; callId?: string }
  | { kind: "artifact"; reference: ArtifactReference; label: string; bytes: number; mimeType: string }
  | { kind: "plan"; steps: { id: string; title: string; status: "pending" | "running" | "completed" | "failed" }[] }
  | { kind: "result"; status: WorkDisplayStatus; evidence: EvidenceProjection; usage: UsageProjection; recoveredErrors?: boolean }
  | { kind: "model"; executionModel: ExecutionModelProjection }
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
export type ModelCatalogProjection = {
  configured: boolean; catalogOnly: boolean; contextTokens: number | null; outputTokens: number | null;
  tools: boolean; vision: boolean; lifecycle: "available" | "deprecated" | "retired";
  source: "models-dev" | "configured" | "manual" | "fallback-known";
  price: { inputPerMillion: number | null; outputPerMillion: number | null } | null;
};
export const ROUTE_HEALTH_STATES = ['not_configured', 'credential_required', 'authorization_expired', 'configured', 'ready', 'unreachable', 'invalid_credential', 'model_unavailable', 'catalog_only', 'unsupported', 'network_disabled'] as const;
export type ModelProjection = {
  health?: typeof ROUTE_HEALTH_STATES[number];
  catalog?: ModelCatalogProjection;
  id: string; providerId: string; label: string; runnable: boolean;
  credentialState: "not_required" | "missing" | "present" | "expired";
  role: "primary" | "fallback" | "auxiliary" | "session_override" | null;
};
export type ProviderProjection = { health?: typeof ROUTE_HEALTH_STATES[number]; metadata?: { configurable: boolean; runnable: boolean; catalogOnly: boolean; apiMode: string; defaultEndpoint: string | null }; id: string; label: string; authMethods: ("api_key" | "oauth" | "none")[];
  state: "ready" | "unconfigured" | "repair_required" | "unknown" };
export type ConnectionProjection = {
  telegram?: {configured?:boolean;status:"disabled"|"credential_missing"|"authorization_missing"|"pairing_pending"|"ready";
    allowedUsers:number;allowedChats:number;pairingExpiresAt:number|null;
    polling:"unknown"|"starting"|"healthy"|"degraded"|"stopped";observedAt:number|null;lastVerifiedAt:number|null};
  id: string; profileId: string; channel: "telegram" | "discord" | "email" | "whatsapp";
  configurationState: "configured" | "unconfigured" | "repair_required";
  runtimeState: "running" | "stopped" | "disconnected" | "unknown";
  authorizationState: "denied" | "configured" | "pairing_required" | "unknown";
  summary: string;
};
export type Page<T> = { items: T[]; nextCursor: string | null };
