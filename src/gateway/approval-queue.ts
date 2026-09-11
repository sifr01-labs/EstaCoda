import { SQLiteTaskStore } from "../tasks/sqlite-task-store.js";
import { isTerminalTaskStatus, TASK_TOOL_RISK_CLASSES } from "../contracts/task.js";
import { validPendingAction, type PendingActionApproval } from "../security/pending-action-approval.js";
import { createHash, randomUUID } from "node:crypto";
import type { SQLiteDatabase } from "../storage/sqlite.js";
import type { WorkspaceApprovalController } from "../security/workspace-approval-controller.js";
import { assessHardlineFloor } from "../security/command-safety.js";
import type { ChannelAttachment, ChannelSessionKey } from "../contracts/channel.js";

export type PendingApprovalStatus = "pending" | "approved" | "denied" | "expired";
export type PendingApprovalChannel = "telegram" | "discord" | "email" | "cli" | "desktop";
export type PendingApprovalKind = "command" | "task" | "managed_python_capability_install";

export type ManagedPythonCapabilityApprovalPayload = {
  capabilityId: string;
  groups: string[];
  packages: string[];
  estimatedInstallSizeMb?: number;
  skillName?: string;
  reason?: string;
  repairCommand?: string;
  originalMessage?: ManagedPythonCapabilityApprovalMessagePayload;
};

export type ManagedPythonCapabilityApprovalMessagePayload = {
  id: string;
  channel: string;
  sessionKey: ChannelSessionKey;
  sender: {
    id: string;
    displayName?: string;
  };
  text: string;
  receivedAt: string;
  attachments?: ChannelAttachment[];
  metadata?: Record<string, unknown>;
};

export type PendingApproval = {
  desktopBinding?: { targetId: string; targetGeneration: number; riskClass: import("../contracts/tool.js").ToolRiskClass };
  taskApprovalLinkId?: string;
  executionApproval?: PendingActionApproval;
  id: string;
  sessionId: string;
  profileId: string;
  commandPreview: string;
  commandHash: string;
  commandPayload?: string;
  toolName: string;
  approvalKind?: PendingApprovalKind;
  requestPayload?: ManagedPythonCapabilityApprovalPayload;
  requestedAt: Date;
  expiresAt: Date;
  status: PendingApprovalStatus;
  resolvedAt?: Date;
  resolvedBy?: string;
  channel: PendingApprovalChannel;
  chatId?: string;
};

export type ApprovalResult = {
  status: "approved" | "denied" | "expired";
  approval: PendingApproval;
};

export type PendingApprovalCreationOptions = {
  /** Stable caller-owned key used to recover one durable approval after replay. */
  idempotencyKey?: string;
};

type PendingApprovalRow = {
  id: string;
  session_id: string;
  profile_id: string;
  command_preview: string;
  command_hash: string;
  command_payload: string | null;
  tool_name: string;
  approval_kind: PendingApprovalKind;
  request_payload: string | null;
  requested_at: string;
  expires_at: string;
  status: PendingApprovalStatus;
  resolved_at: string | null;
  resolved_by: string | null;
  channel: PendingApprovalChannel;
  chat_id: string | null;
};

type QueueClock = () => Date;
type Sleep = (ms: number) => Promise<void>;

const DEFAULT_POLL_INTERVAL_MS = 250;

export class GatewayApprovalQueue {
  readonly #db: SQLiteDatabase;
  readonly #controller: WorkspaceApprovalController;
  readonly #now: QueueClock;
  readonly #idFactory: () => string;
  readonly #sleep: Sleep;
  readonly #pollIntervalMs: number;

  constructor(options: {
    db: SQLiteDatabase;
    controller: WorkspaceApprovalController;
    now?: QueueClock;
    idFactory?: () => string;
    sleep?: Sleep;
    pollIntervalMs?: number;
  }) {
    this.#db = options.db;
    this.#controller = options.controller;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => randomUUID());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async requestApproval(
    approval: Omit<PendingApproval, "id" | "status">
  ): Promise<ApprovalResult> {
    const pending = await this.createPendingApproval(approval);
    if (pending.status !== "pending") {
      return {
        status: pending.status === "approved" ? "approved" : pending.status === "denied" ? "denied" : "expired",
        approval: pending
      };
    }

    return await this.waitForResolution(pending.id, {
      profileId: pending.profileId,
      sessionId: pending.sessionId
    });
  }

  async createPendingApproval(
    approval: Omit<PendingApproval, "id" | "status">,
    options: PendingApprovalCreationOptions = {}
  ): Promise<PendingApproval> {
    const profileId = requireScopeValue(approval.profileId, "profileId");
    const sessionId = requireScopeValue(approval.sessionId, "sessionId");
    const approvalKind = approval.approvalKind ?? "command";
    if (!["command", "task", "managed_python_capability_install"].includes(approvalKind)) throw new Error("Unknown approval kind.");
    if (approval.executionApproval !== undefined && (!validPendingAction(approval.executionApproval) ||
      approval.executionApproval.executionScope.profileId !== profileId || approval.executionApproval.executionScope.sessionId !== sessionId)) throw new Error("Invalid pending action ownership.");
    if (approval.channel === "desktop") this.#validateDesktopApproval(approval);
    if (approvalKind === "task") this.#validateTaskApproval(approval, "requesting");
    const id = options.idempotencyKey === undefined
      ? this.#idFactory()
      : idempotentApprovalId(profileId, sessionId, options.idempotencyKey);
    let existing = this.#getScopedRow(id, { profileId, sessionId });
    if (approvalKind === "task" && existing?.approval_kind === "command" && existing.status === "pending" && commandApprovalBinding(existing) === undefined) {
      // Recover the old queue representation only through its already validated
      // Task link. Unbound command rows cannot use this path.
      assertApprovalReplayMatches(existing, { ...approval, executionApproval: undefined }, "command");
      this.#db.query("update pending_approvals set approval_kind = 'task', request_payload = ? where id = ? and profile_id = ? and session_id = ? and status = 'pending' and approval_kind = 'command'")
        .run(JSON.stringify({ taskApprovalLinkId: approval.taskApprovalLinkId }), id, profileId, sessionId);
      existing = this.#getScopedRow(id, { profileId, sessionId });
    }
    if (existing !== null) {
      assertApprovalReplayMatches(existing, approval, approvalKind);
      return rowToPendingApproval(existing, { includePayload: false });
    }
    if (approvalKind === "command" || approvalKind === "task") {
      const command = approval.commandPayload ?? approval.commandPreview;
      const hardline = assessHardlineFloor(command);
      if (hardline !== undefined) {
        return {
          ...approval,
          id,
          profileId,
          sessionId,
          approvalKind,
          commandPayload: undefined,
          requestPayload: undefined,
          status: "denied",
          resolvedAt: this.#now(),
          resolvedBy: "security-policy"
        };
      }

      const preflight = this.#controller.preflightGatewayApproval({
        toolName: approval.toolName,
        commandPreview: approval.commandPreview,
        commandPayload: approval.commandPayload
      });

      if (preflight?.decision === "deny") {
        return {
          ...approval,
          id,
          profileId,
          sessionId,
          approvalKind,
          commandPayload: undefined,
          requestPayload: undefined,
          status: "denied",
          resolvedAt: this.#now(),
          resolvedBy: "security-policy"
        };
      }
    }

    const insert = options.idempotencyKey === undefined ? "insert" : "insert or ignore";
    this.#db
      .query(
        `${insert} into pending_approvals (
          id,
          session_id,
          profile_id,
          command_preview,
          command_hash,
          command_payload,
          tool_name,
          approval_kind,
          request_payload,
          requested_at,
          expires_at,
          status,
          resolved_at,
          resolved_by,
          channel,
          chat_id
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', null, null, ?, ?)`
      )
      .run(
        id,
        sessionId,
        profileId,
        approval.commandPreview,
        approval.commandHash,
        approval.commandPayload ?? null,
        approval.toolName,
        approvalKind,
        approvalKind === "task" ? JSON.stringify({ taskApprovalLinkId: approval.taskApprovalLinkId }) : approvalKind === "command" ? (approval.executionApproval === undefined ? null : JSON.stringify({ executionApproval: approval.executionApproval, ...(approval.desktopBinding ? { desktopBinding: approval.desktopBinding } : {}) })) : (approval.requestPayload === undefined ? null : JSON.stringify(approval.requestPayload)),
        approval.requestedAt.toISOString(),
        approval.expiresAt.toISOString(),
        approval.channel,
        approval.chatId ?? null
      );

    const row = this.#getScopedRow(id, { profileId, sessionId });
    if (row === null) {
      throw new Error("Pending approval disappeared before creation completed.");
    }
    assertApprovalReplayMatches(row, approval, approvalKind);
    return rowToPendingApproval(row, { includePayload: false });
  }

  async waitForResolution(
    id: string,
    scope: { profileId: string; sessionId?: string }
  ): Promise<ApprovalResult> {
    const profileId = requireScopeValue(scope.profileId, "profileId");
    while (true) {
      const row = this.#getScopedRow(id, { profileId, sessionId: scope.sessionId });
      if (row === null) {
        throw new Error("Pending approval disappeared before resolution.");
      }

      if (row.status !== "pending") {
        return {
          status: row.status === "approved" ? "approved" : row.status === "denied" ? "denied" : "expired",
          approval: rowToPendingApproval(row, { includePayload: false })
        };
      }

      if (new Date(row.expires_at).getTime() <= this.#now().getTime()) {
        await this.expireStaleApprovals();
        const expired = this.#getScopedRow(id, { profileId, sessionId: scope.sessionId }) ?? row;
        return {
          status: "expired",
          approval: rowToPendingApproval(expired, { includePayload: false })
        };
      }

      await this.#sleep(this.#pollIntervalMs);
    }
  }

  async getApproval(
    id: string,
    scope: { profileId: string; sessionId?: string }
  ): Promise<PendingApproval | undefined> {
    const profileId = requireScopeValue(scope.profileId, "profileId");
    const row = this.#getScopedRow(id, { profileId, sessionId: scope.sessionId });
    return row === null ? undefined : rowToPendingApproval(row, { includePayload: false });
  }

  async getApprovalRequest(
    id: string,
    scope: { profileId: string; sessionId?: string }
  ): Promise<PendingApproval | undefined> {
    const profileId = requireScopeValue(scope.profileId, "profileId");
    const row = this.#getScopedRow(id, { profileId, sessionId: scope.sessionId });
    return row === null ? undefined : rowToPendingApproval(row, {
      includePayload: false,
      includeRequestPayload: true
    });
  }

  #validateDesktopApproval(approval: Omit<PendingApproval, "id" | "status">): void {
    const binding = approval.desktopBinding;
    const session = this.#db.query<{ execution_target_json: string | null }>('select execution_target_json from sessions where id=? and profile_id=?').get(approval.sessionId, approval.profileId);
    const target = session?.execution_target_json ? JSON.parse(session.execution_target_json) : undefined;
    if (!binding || !target || target.targetId !== binding.targetId || target.targetGeneration !== binding.targetGeneration ||
      !TASK_TOOL_RISK_CLASSES.includes(binding.riskClass) || !validPendingAction(approval.executionApproval) ||
      approval.executionApproval.executionScope.workspaceIdentityHash !== target.workspace.identityHash) throw new Error('Desktop approval target binding changed.');
  }

  #validateTaskApproval(approval: Omit<PendingApproval, "id" | "status">, status: "requesting" | "pending", id?: string): void {
    const store = new SQLiteTaskStore({ db: this.#db, profileId: approval.profileId });
    const link = approval.taskApprovalLinkId === undefined ? null : store.getApprovalLink(approval.taskApprovalLinkId);
    const task = link === null ? null : store.getTask(link.taskId);
    const step = link === null ? null : store.getStep(link.stepId);
    const attempt = link === null ? null : store.getAttempt(link.attemptId);
    if (link === null || task === null || step === null || attempt === null ||
      (link.status !== status && !(status === "requesting" && link.status === "pending")) ||
      (id !== undefined && link.pendingApprovalId !== id) || link.authorizedSessionId !== approval.sessionId ||
      link.profileId !== approval.profileId || link.toolName !== approval.toolName ||
      link.targetFingerprint !== approval.commandHash || link.targetPreview !== approval.commandPreview ||
      link.requestedAt !== approval.requestedAt.toISOString() || link.expiresAt !== approval.expiresAt.toISOString() ||
      Date.parse(link.expiresAt) <= this.#now().getTime() || isTerminalTaskStatus(task.status) ||
      task.activePlanRevisionId !== link.planRevisionId || step.planRevisionId !== link.planRevisionId ||
      attempt.stepId !== step.id || attempt.taskId !== task.id ||
      task.authorityPolicy.riskClassPolicy[link.riskClass] === "forbid" ||
      step.authorityPolicy.riskClassPolicy[link.riskClass] === "forbid" ||
      task.authorityPolicy.blockedTools.includes(link.toolName) || step.authorityPolicy.blockedTools.includes(link.toolName) ||
      (task.authorityPolicy.allowedTools !== undefined && !task.authorityPolicy.allowedTools.includes(link.toolName)) ||
      (step.authorityPolicy.allowedTools !== undefined && !step.authorityPolicy.allowedTools.includes(link.toolName)) ||
      assessHardlineFloor(approval.commandPreview) !== undefined) {
      throw new Error("Task approval ownership or authority changed. Review the current Task action.");
    }
  }

  async resolveApproval(
    id: string,
    decision: "approved" | "denied",
    resolvedBy: string,
    scope: { profileId: string; sessionId?: string }
  ): Promise<void> {
    const profileId = requireScopeValue(scope.profileId, "profileId");
    const now = this.#now().toISOString();
    if (decision === "approved") {
      const current = this.#getScopedRow(id, { profileId, sessionId: scope.sessionId });
      if (current !== null && !["command", "task", "managed_python_capability_install"].includes(current.approval_kind)) throw new Error("Unknown approval kind.");
      if (current?.channel === "desktop" && current.status === "pending") this.#validateDesktopApproval(rowToPendingApproval(current, { includePayload: false }));
      if (current !== null && current.status === "pending" && current.expires_at > now && current.approval_kind === "task") this.#validateTaskApproval(rowToPendingApproval(current, { includePayload: false }), "pending", current.id);
      if (current !== null && current.status === "pending" && current.expires_at > now && current.approval_kind === "command") {
        const binding = commandApprovalBinding(current);
        if (binding === undefined) {
          if (current.request_payload !== null) throw new Error("Malformed command approval requires renewal in the owning session.");
          const store = new SQLiteTaskStore({ db: this.#db, profileId });
          const links = store.listApprovalLinks({ pendingApprovalId: id, authorizedSessionId: current.session_id, statuses: ["pending"], limit: 2 });
          if (links.length !== 1) throw new Error("Legacy or expired command approval requires renewal in the owning session.");
          this.#validateTaskApproval({ ...rowToPendingApproval(current, { includePayload: false }), taskApprovalLinkId: links[0]!.id }, "pending", id);
        } else {
          if (!validPendingAction(binding) || binding.expiresAt <= this.#now().getTime()) throw new Error("Legacy or expired command approval requires renewal in the owning session.");
          if (binding.executionScope.profileId !== profileId || binding.executionScope.sessionId !== current.session_id ||
            assessHardlineFloor(current.command_payload ?? current.command_preview) !== undefined) throw new Error("Command approval is no longer permitted.");
        }
      }
    }
    const result = scope.sessionId === undefined
      ? this.#db
          .query(
            `update pending_approvals
            set status = ?,
                resolved_at = ?,
                resolved_by = ?,
                command_payload = null,
                request_payload = null
            where id = ?
              and profile_id = ?
              and status = 'pending'
              and expires_at > ?`
          )
          .run(decision, now, resolvedBy, id, profileId, now)
      : this.#db
          .query(
            `update pending_approvals
            set status = ?,
                resolved_at = ?,
                resolved_by = ?,
                command_payload = null,
                request_payload = null
            where id = ?
              and profile_id = ?
              and session_id = ?
              and status = 'pending'
              and expires_at > ?`
          )
          .run(decision, now, resolvedBy, id, profileId, scope.sessionId, now);

    if (result.changes > 0) {
      return;
    }

    this.#throwResolveFailure(id, { profileId, sessionId: scope.sessionId });
  }

  async expireStaleApprovals(): Promise<number> {
    const result = this.#db
      .query(
        `update pending_approvals
        set status = 'expired',
            resolved_at = ?,
            resolved_by = coalesce(resolved_by, 'system-expiry'),
            command_payload = null,
            request_payload = null
        where status = 'pending' and expires_at <= ?`
      )
      .run(this.#now().toISOString(), this.#now().toISOString());
    return result.changes;
  }

  async listPending(options: { profileId: string; sessionId?: string }): Promise<PendingApproval[]> {
    const profileId = requireScopeValue(options.profileId, "profileId");
    await this.expireStaleApprovals();
    const rows = options.sessionId === undefined
      ? this.#db
          .query<PendingApprovalRow>(
            `select *
            from pending_approvals
            where profile_id = ? and status = 'pending'
            order by requested_at asc, id asc`
          )
          .all(profileId)
      : this.#db
          .query<PendingApprovalRow>(
            `select *
            from pending_approvals
            where profile_id = ? and session_id = ? and status = 'pending'
            order by requested_at asc, id asc`
          )
          .all(profileId, options.sessionId);

    return rows.map((row) => rowToPendingApproval(row, { includePayload: false }));
  }

  #getScopedRow(
    id: string,
    scope: { profileId: string; sessionId?: string }
  ): PendingApprovalRow | null {
    return scope.sessionId === undefined
      ? this.#db
          .query<PendingApprovalRow>("select * from pending_approvals where id = ? and profile_id = ?")
          .get(id, scope.profileId)
      : this.#db
          .query<PendingApprovalRow>(
            "select * from pending_approvals where id = ? and profile_id = ? and session_id = ?"
          )
          .get(id, scope.profileId, scope.sessionId);
  }

  #expireById(id: string): void {
    this.#db
      .query(
        `update pending_approvals
        set status = 'expired',
            resolved_at = ?,
            resolved_by = coalesce(resolved_by, 'system-expiry'),
            command_payload = null,
            request_payload = null
        where id = ? and status = 'pending'`
      )
      .run(this.#now().toISOString(), id);
  }

  #throwResolveFailure(id: string, scope: { profileId: string; sessionId?: string }): never {
    const scoped = this.#getScopedRow(id, scope);
    if (scoped !== null) {
      if (scoped.status === "pending" && new Date(scoped.expires_at).getTime() <= this.#now().getTime()) {
        this.#expireById(scoped.id);
        throw new Error("Pending approval has expired.");
      }
      throw rowResolveError(scoped);
    }

    if (scope.sessionId !== undefined) {
      const profileRow = this.#getScopedRow(id, { profileId: scope.profileId });
      if (profileRow !== null) {
        throw new Error("Pending approval not found for this session scope.");
      }
    }

    throw new Error("Pending approval not found for this profile or session scope.");
  }
}

function idempotentApprovalId(profileId: string, sessionId: string, key: string): string {
  const normalized = key.trim();
  if (normalized.length === 0 || normalized.length > 256 || /[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new Error("Gateway approval idempotency key must be a bounded non-empty token.");
  }
  return `approval_${createHash("sha256").update(JSON.stringify([profileId, sessionId, normalized])).digest("hex")}`;
}

function assertApprovalReplayMatches(
  row: PendingApprovalRow,
  approval: Omit<PendingApproval, "id" | "status">,
  approvalKind: PendingApprovalKind
): void {
  if (
    row.profile_id !== approval.profileId ||
    row.session_id !== approval.sessionId ||
    row.command_preview !== approval.commandPreview ||
    row.command_hash !== approval.commandHash ||
    row.tool_name !== approval.toolName ||
    row.approval_kind !== approvalKind ||
    row.requested_at !== approval.requestedAt.toISOString() ||
    row.expires_at !== approval.expiresAt.toISOString() ||
    row.channel !== approval.channel ||
    (row.channel === "desktop" && row.status === "pending" && JSON.stringify(desktopBinding(row)) !== JSON.stringify(approval.desktopBinding)) ||
    (approvalKind === "command" && row.status === "pending" && JSON.stringify(commandApprovalBinding(row)) !== JSON.stringify(approval.executionApproval)) ||
    (approvalKind === "task" && row.status === "pending" && taskApprovalLinkId(row) !== approval.taskApprovalLinkId) ||
    row.chat_id !== (approval.chatId ?? null)
  ) {
    throw new Error("Gateway approval idempotency key was reused for a different request.");
  }
}

export function createCommandHash(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

export function createCommandPreview(command: string, maxLength = 160): string {
  const normalized = command.trim().replace(/\s+/gu, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function rowToPendingApproval(
  row: PendingApprovalRow,
  options: { includePayload: boolean; includeRequestPayload?: boolean }
): PendingApproval {
  return {
    id: row.id,
    sessionId: row.session_id,
    profileId: row.profile_id,
    commandPreview: row.command_preview,
    commandHash: row.command_hash,
    commandPayload: options.includePayload ? row.command_payload ?? undefined : undefined,
    toolName: row.tool_name,
    approvalKind: row.approval_kind ?? "command",
    taskApprovalLinkId: taskApprovalLinkId(row),
    desktopBinding: desktopBinding(row),
    executionApproval: row.approval_kind === "command" ? commandApprovalBinding(row) : undefined,
    requestPayload: row.approval_kind === "managed_python_capability_install" && options.includeRequestPayload === true && row.request_payload !== null
      ? parseManagedPythonCapabilityApprovalPayload(row.request_payload)
      : undefined,
    requestedAt: new Date(row.requested_at),
    expiresAt: new Date(row.expires_at),
    status: row.status,
    resolvedAt: row.resolved_at === null ? undefined : new Date(row.resolved_at),
    resolvedBy: row.resolved_by ?? undefined,
    channel: row.channel,
    chatId: row.chat_id ?? undefined
  };
}

function parseManagedPythonCapabilityApprovalPayload(
  value: string
): ManagedPythonCapabilityApprovalPayload | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<ManagedPythonCapabilityApprovalPayload>;
    if (typeof parsed.capabilityId !== "string" || parsed.capabilityId.trim() === "") {
      return undefined;
    }
    if (!Array.isArray(parsed.groups) || !Array.isArray(parsed.packages)) {
      return undefined;
    }
    return {
      capabilityId: parsed.capabilityId,
      groups: parsed.groups.filter((item): item is string => typeof item === "string"),
      packages: parsed.packages.filter((item): item is string => typeof item === "string"),
      estimatedInstallSizeMb: typeof parsed.estimatedInstallSizeMb === "number"
        ? parsed.estimatedInstallSizeMb
        : undefined,
      skillName: typeof parsed.skillName === "string" ? parsed.skillName : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      repairCommand: typeof parsed.repairCommand === "string" ? parsed.repairCommand : undefined,
      originalMessage: parseApprovalMessagePayload(parsed.originalMessage)
    };
  } catch {
    return undefined;
  }
}

function parseApprovalMessagePayload(value: unknown): ManagedPythonCapabilityApprovalMessagePayload | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.channel !== "string" ||
    typeof record.text !== "string" ||
    typeof record.receivedAt !== "string"
  ) {
    return undefined;
  }
  const sessionKey = parseApprovalSessionKey(record.sessionKey);
  const sender = parseApprovalSender(record.sender);
  if (sessionKey === undefined || sender === undefined) {
    return undefined;
  }

  return {
    id: record.id,
    channel: record.channel,
    sessionKey,
    sender,
    text: record.text,
    receivedAt: record.receivedAt,
    attachments: Array.isArray(record.attachments)
      ? record.attachments.filter((item): item is ChannelAttachment => typeof item === "object" && item !== null)
      : undefined,
    metadata: typeof record.metadata === "object" && record.metadata !== null && !Array.isArray(record.metadata)
      ? record.metadata as Record<string, unknown>
      : undefined
  };
}

function parseApprovalSessionKey(value: unknown): ChannelSessionKey | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.platform !== "string" || typeof record.chatId !== "string") {
    return undefined;
  }
  return {
    platform: record.platform,
    chatId: record.chatId,
    accountId: typeof record.accountId === "string" ? record.accountId : undefined,
    userId: typeof record.userId === "string" ? record.userId : undefined,
    chatType: record.chatType === "dm" ||
      record.chatType === "group" ||
      record.chatType === "channel" ||
      record.chatType === "thread"
      ? record.chatType
      : undefined,
    threadId: typeof record.threadId === "string" ? record.threadId : undefined
  };
}

function parseApprovalSender(value: unknown): ManagedPythonCapabilityApprovalMessagePayload["sender"] | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") {
    return undefined;
  }
  return {
    id: record.id,
    displayName: typeof record.displayName === "string" ? record.displayName : undefined
  };
}

function requireScopeValue(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`Gateway approval ${name} is required.`);
  }
  return value;
}

function rowResolveError(row: PendingApprovalRow): Error {
  if (row.status !== "pending") {
    return new Error(`Pending approval is already ${row.status}.`);
  }

  return new Error("Pending approval has expired.");
}

function commandApprovalBinding(row: PendingApprovalRow): PendingActionApproval | undefined {
  if (row.approval_kind !== "command" || row.request_payload === null) return undefined;
  try {
    const value = JSON.parse(row.request_payload).executionApproval;
    return validPendingAction(value) ? value : undefined;
  } catch { return undefined; }
}


function taskApprovalLinkId(row: PendingApprovalRow): string | undefined {
  if (row.approval_kind !== "task" || row.request_payload === null) return undefined;
  try {
    const id = JSON.parse(row.request_payload).taskApprovalLinkId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch { return undefined; }
}

function desktopBinding(row: PendingApprovalRow): PendingApproval['desktopBinding'] {
  if (row.channel !== 'desktop' || !row.request_payload) return undefined;
  try { return JSON.parse(row.request_payload).desktopBinding; } catch { return undefined; }
}
