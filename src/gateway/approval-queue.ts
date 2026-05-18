import { createHash, randomUUID } from "node:crypto";
import type { SQLiteDatabase } from "../storage/sqlite.js";
import type { WorkspaceApprovalController } from "../security/workspace-approval-controller.js";
import { assessHardlineFloor } from "../security/command-safety.js";

export type PendingApprovalStatus = "pending" | "approved" | "denied" | "expired";
export type PendingApprovalChannel = "telegram" | "discord" | "email" | "cli";

export type PendingApproval = {
  id: string;
  sessionId: string;
  profileId: string;
  commandPreview: string;
  commandHash: string;
  commandPayload?: string;
  toolName: string;
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

type PendingApprovalRow = {
  id: string;
  session_id: string;
  profile_id: string;
  command_preview: string;
  command_hash: string;
  command_payload: string | null;
  tool_name: string;
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
    approval: Omit<PendingApproval, "id" | "status">
  ): Promise<PendingApproval> {
    const profileId = requireScopeValue(approval.profileId, "profileId");
    const sessionId = requireScopeValue(approval.sessionId, "sessionId");
    const command = approval.commandPayload ?? approval.commandPreview;
    const hardline = assessHardlineFloor(command);
    if (hardline !== undefined) {
      return {
        ...approval,
        id: this.#idFactory(),
        profileId,
        sessionId,
        commandPayload: undefined,
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
        id: this.#idFactory(),
        profileId,
        sessionId,
        commandPayload: undefined,
        status: "denied",
        resolvedAt: this.#now(),
        resolvedBy: "security-policy"
      };
    }

    const id = this.#idFactory();
    this.#db
      .query(
        `insert into pending_approvals (
          id,
          session_id,
          profile_id,
          command_preview,
          command_hash,
          command_payload,
          tool_name,
          requested_at,
          expires_at,
          status,
          resolved_at,
          resolved_by,
          channel,
          chat_id
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', null, null, ?, ?)`
      )
      .run(
        id,
        sessionId,
        profileId,
        approval.commandPreview,
        approval.commandHash,
        approval.commandPayload ?? null,
        approval.toolName,
        approval.requestedAt.toISOString(),
        approval.expiresAt.toISOString(),
        approval.channel,
        approval.chatId ?? null
      );

    const row = this.#getScopedRow(id, { profileId, sessionId });
    if (row === null) {
      throw new Error("Pending approval disappeared before creation completed.");
    }
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

  async resolveApproval(
    id: string,
    decision: "approved" | "denied",
    resolvedBy: string,
    scope: { profileId: string; sessionId?: string }
  ): Promise<void> {
    const profileId = requireScopeValue(scope.profileId, "profileId");
    const now = this.#now().toISOString();
    const result = scope.sessionId === undefined
      ? this.#db
          .query(
            `update pending_approvals
            set status = ?,
                resolved_at = ?,
                resolved_by = ?,
                command_payload = null
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
                command_payload = null
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
            command_payload = null
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
            command_payload = null
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
  options: { includePayload: boolean }
): PendingApproval {
  return {
    id: row.id,
    sessionId: row.session_id,
    profileId: row.profile_id,
    commandPreview: row.command_preview,
    commandHash: row.command_hash,
    commandPayload: options.includePayload ? row.command_payload ?? undefined : undefined,
    toolName: row.tool_name,
    requestedAt: new Date(row.requested_at),
    expiresAt: new Date(row.expires_at),
    status: row.status,
    resolvedAt: row.resolved_at === null ? undefined : new Date(row.resolved_at),
    resolvedBy: row.resolved_by ?? undefined,
    channel: row.channel,
    chatId: row.chat_id ?? undefined
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
