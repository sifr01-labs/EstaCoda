import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  ChannelAttachment,
  ChannelAttachmentKind,
  ChannelAttachmentStatus,
  ChannelMessage
} from "../contracts/channel.js";
import { normalizeProfileId } from "../config/profile-home.js";
import type { SQLiteDatabase } from "../storage/sqlite.js";

export type PendingTurnStatus = "pending" | "claimed" | "completed" | "uncertain";

export type PendingTurnRecord = {
  sequence: number;
  id: string;
  profileId: string;
  channel: string;
  platformMessageId: string;
  status: PendingTurnStatus;
  message: ChannelMessage;
  claimId?: string;
  claimedAt?: string;
  completedAt?: string;
  uncertainAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type PendingTurnStoreErrorCode =
  | "invalid_payload"
  | "capacity_exceeded"
  | "state_conflict"
  | "database_failure"
  | "corrupt_record";

export type PendingTurnStoreDiagnostic = {
  operation: PendingTurnStoreOperation;
  code: PendingTurnStoreErrorCode;
  retryable: boolean;
};

export type PendingTurnStoreOperation =
  | "enqueue"
  | "claim"
  | "release_claim"
  | "complete"
  | "coalesce"
  | "replace"
  | "mark_uncertain"
  | "recover"
  | "clear"
  | "counts"
  | "dedupe"
  | "list"
  | "retention"
  | "initialize";

export class PendingTurnStoreError extends Error {
  readonly code: PendingTurnStoreErrorCode;
  readonly operation: PendingTurnStoreOperation;
  readonly retryable: boolean;

  constructor(input: {
    code: PendingTurnStoreErrorCode;
    operation: PendingTurnStoreOperation;
    retryable?: boolean;
  }) {
    super(errorMessage(input.code));
    this.name = "PendingTurnStoreError";
    this.code = input.code;
    this.operation = input.operation;
    this.retryable = input.retryable ?? false;
  }
}

export type PendingTurnEnqueueResult = {
  inserted: boolean;
  turn: PendingTurnRecord;
};

export type PendingTurnCoalesceResult = {
  duplicate: boolean;
  turn: PendingTurnRecord;
};

export type PendingTurnCounts = Record<PendingTurnStatus, number>;

export type SQLitePendingTurnStoreOptions = {
  db: SQLiteDatabase;
  profileId: string;
  approvedMediaRoots?: string[];
  maxPendingPerProfile?: number;
  uncertainRetentionDays?: number;
  now?: () => Date;
  idFactory?: () => string;
  claimIdFactory?: () => string;
  onDiagnostic?: (diagnostic: PendingTurnStoreDiagnostic) => void;
};

type PendingTurnRow = {
  sequence: number;
  turn_id: string;
  profile_id: string;
  channel: string;
  platform_message_id: string;
  status: PendingTurnStatus;
  message_json: string;
  claim_id: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  uncertain_at: string | null;
  created_at: string;
  updated_at: string;
};

const MAX_MESSAGE_JSON_BYTES = 262_144;
const MAX_TEXT_CHARS = 100_000;
const MAX_METADATA_JSON_BYTES = 32_768;
const MAX_ATTACHMENTS_JSON_BYTES = 65_536;
const MAX_ATTACHMENTS = 16;
const MAX_IDENTIFIER_CHARS = 512;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 2_000;
const MAX_JSON_STRING_CHARS = 32_768;
const MAX_JSON_KEY_CHARS = 128;
const MAX_PENDING_PER_PROFILE = 10_000;
const MAX_DELIVERY_IDENTITIES_PER_TURN = 256;
const MAX_RETENTION_DAYS = 365;
const ALL_STATUSES = new Set<PendingTurnStatus>(["pending", "claimed", "completed", "uncertain"]);
const ATTACHMENT_KINDS = new Set<ChannelAttachmentKind>([
  "file", "image", "audio", "video", "voice", "document", "link", "unknown"
]);
const ATTACHMENT_STATUSES = new Set<ChannelAttachmentStatus>([
  "ready", "failed", "unsupported", "too-large", "download-failed", "missing-file"
]);
const SENSITIVE_KEY = /(?:^|[_-])(authorization|cookie|credential|password|secret|token|api[_-]?key)(?:$|[_-])/iu;
const SECRET_SHAPED_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{12,}|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\b\d{6,12}:[A-Za-z0-9_-]{20,})/u;

export class SQLitePendingTurnStore {
  readonly #db: SQLiteDatabase;
  readonly #profileId: string;
  readonly #approvedMediaRoots: string[];
  readonly #maxPendingPerProfile: number;
  readonly #uncertainRetentionDays: number;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #claimIdFactory: () => string;
  readonly #onDiagnostic?: (diagnostic: PendingTurnStoreDiagnostic) => void;

  constructor(options: SQLitePendingTurnStoreOptions) {
    this.#db = options.db;
    try {
      this.#profileId = normalizeProfileId(options.profileId);
      this.#approvedMediaRoots = (options.approvedMediaRoots ?? []).map(canonicalDirectory);
    } catch {
      throw new PendingTurnStoreError({ code: "invalid_payload", operation: "initialize" });
    }
    this.#maxPendingPerProfile = boundedInteger(
      options.maxPendingPerProfile,
      1_000,
      1,
      MAX_PENDING_PER_PROFILE,
      "initialize"
    );
    this.#uncertainRetentionDays = boundedInteger(
      options.uncertainRetentionDays,
      7,
      0,
      MAX_RETENTION_DAYS,
      "initialize"
    );
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => randomUUID());
    this.#claimIdFactory = options.claimIdFactory ?? (() => randomUUID());
    this.#onDiagnostic = options.onDiagnostic;
  }

  enqueue(message: ChannelMessage): PendingTurnEnqueueResult {
    return this.#run("enqueue", () => {
      const safeMessage = validateAndSanitizeMessage(message, this.#approvedMediaRoots, "enqueue");
      const messageJson = JSON.stringify(safeMessage);
      if (utf8Size(messageJson) > MAX_MESSAGE_JSON_BYTES) {
        throw storeError("invalid_payload", "enqueue");
      }
      return this.#transaction("enqueue", () => {
        const deliveryIds = deliveryIdentityIds(safeMessage, "enqueue");
        const existing = this.#rowByAnyDeliveryIdentity(safeMessage.channel, deliveryIds, "enqueue");
        if (existing !== null) {
          if (existing.platform_message_id === safeMessage.id && existing.message_json !== messageJson) {
            throw storeError("state_conflict", "enqueue");
          }
          return { inserted: false, turn: rowToRecord(existing, "enqueue", this.#approvedMediaRoots) };
        }

        const activeCount = this.#db.query<{ count: number }>(`
          select count(*) as count from pending_channel_turns
          where profile_id = ? and status <> 'completed'
        `).get(this.#profileId)?.count ?? 0;
        if (activeCount >= this.#maxPendingPerProfile) {
          throw storeError("capacity_exceeded", "enqueue");
        }

        const inserted = this.#insertPending(safeMessage, messageJson, "enqueue");
        return { inserted: true, turn: rowToRecord(inserted, "enqueue", this.#approvedMediaRoots) };
      });
    });
  }

  hasDeliveryIdentity(channel: string, platformMessageId: string): boolean {
    return this.#run("dedupe", () => {
      const safeChannel = requireIdentifier(channel, "dedupe", 64);
      const safeMessageId = requireIdentifier(platformMessageId, "dedupe", MAX_IDENTIFIER_CHARS);
      return this.#db.query<{ present: number }>(`
        select 1 as present from pending_channel_turn_delivery_ids
        where profile_id = ? and channel = ? and platform_message_id = ?
        limit 1
      `).get(this.#profileId, safeChannel, safeMessageId) !== null;
    });
  }

  coalescePending(input: {
    turnId: string;
    previousMessage: ChannelMessage;
    incomingMessage: ChannelMessage;
    combinedMessage: ChannelMessage;
  }): PendingTurnCoalesceResult {
    return this.#run("coalesce", () => {
      requireIdentifier(input.turnId, "coalesce", 128);
      const previous = this.#validatedMessageJson(input.previousMessage, "coalesce");
      const incoming = this.#validatedMessageJson(input.incomingMessage, "coalesce");
      const combined = this.#validatedMessageJson(input.combinedMessage, "coalesce");
      if (combined.message.id !== previous.message.id || combined.message.channel !== previous.message.channel) {
        throw storeError("invalid_payload", "coalesce");
      }
      return this.#transaction("coalesce", () => {
        const existingIncoming = this.#rowByAnyDeliveryIdentity(
          incoming.message.channel,
          deliveryIdentityIds(incoming.message, "coalesce"),
          "coalesce"
        );
        if (existingIncoming !== null) {
          if (existingIncoming.platform_message_id === incoming.message.id && existingIncoming.message_json !== incoming.json) {
            throw storeError("state_conflict", "coalesce");
          }
          const target = this.#rowById(input.turnId);
          if (target === null || target.status !== "pending" || target.message_json !== previous.json) {
            throw storeError("state_conflict", "coalesce");
          }
          return {
            duplicate: true,
            turn: rowToRecord(target, "coalesce", this.#approvedMediaRoots)
          };
        }

        const target = this.#rowById(input.turnId);
        if (target === null || target.status !== "pending" || target.message_json !== previous.json) {
          throw storeError("state_conflict", "coalesce");
        }
        const now = checkedNow(this.#now, "coalesce");
        const updated = this.#db.query(`
          update pending_channel_turns set message_json = ?, updated_at = ?
          where profile_id = ? and turn_id = ? and status = 'pending' and message_json = ?
        `).run(combined.json, now, this.#profileId, input.turnId, previous.json).changes;
        if (updated !== 1) {
          throw storeError("state_conflict", "coalesce");
        }
        this.#insertTerminalDedupe(incoming.message, incoming.json, now);
        this.#trimCompletedRows();
        const coalesced = this.#rowById(input.turnId);
        if (coalesced === null) {
          throw storeError("database_failure", "coalesce", true);
        }
        return {
          duplicate: false,
          turn: rowToRecord(coalesced, "coalesce", this.#approvedMediaRoots)
        };
      });
    });
  }

  replacePending(turnIds: string[], message: ChannelMessage): PendingTurnEnqueueResult {
    return this.#run("replace", () => {
      const ids = validateTurnIds(turnIds, "replace");
      const safe = this.#validatedMessageJson(message, "replace");
      return this.#transaction("replace", () => {
        const existing = this.#rowByAnyDeliveryIdentity(
          safe.message.channel,
          deliveryIdentityIds(safe.message, "replace"),
          "replace"
        );
        if (existing !== null) {
          if (existing.platform_message_id === safe.message.id && existing.message_json !== safe.json) {
            throw storeError("state_conflict", "replace");
          }
          return {
            inserted: false,
            turn: rowToRecord(existing, "replace", this.#approvedMediaRoots)
          };
        }
        this.#deleteExactPending(ids, "replace");
        this.#assertCapacity("replace");
        const inserted = this.#insertPending(safe.message, safe.json, "replace");
        return {
          inserted: true,
          turn: rowToRecord(inserted, "replace", this.#approvedMediaRoots)
        };
      });
    });
  }

  clearPendingTurns(turnIds: string[]): number {
    return this.#run("clear", () => {
      const ids = validateTurnIds(turnIds, "clear");
      return this.#transaction("clear", () => this.#deleteExactPending(ids, "clear"));
    });
  }

  claimNext(): PendingTurnRecord | undefined {
    return this.#run("claim", () => this.#transaction("claim", () => {
      const row = this.#db.query<PendingTurnRow>(`
        select * from pending_channel_turns
        where profile_id = ? and status = 'pending'
        order by sequence asc
        limit 1
      `).get(this.#profileId);
      if (row === null) {
        return undefined;
      }
      const claimId = checkedGeneratedId(this.#claimIdFactory, "claim");
      const now = checkedNow(this.#now, "claim");
      const changed = this.#db.query(`
        update pending_channel_turns
        set status = 'claimed', claim_id = ?, claimed_at = ?, updated_at = ?
        where profile_id = ? and turn_id = ? and status = 'pending'
      `).run(claimId, now, now, this.#profileId, row.turn_id).changes;
      if (changed !== 1) {
        throw storeError("state_conflict", "claim", true);
      }
      const claimed = this.#rowById(row.turn_id);
      if (claimed === null) {
        throw storeError("database_failure", "claim", true);
      }
      return rowToRecord(claimed, "claim", this.#approvedMediaRoots);
    }));
  }

  claim(turnId: string): PendingTurnRecord {
    return this.#run("claim", () => {
      requireIdentifier(turnId, "claim", 128);
      return this.#transaction("claim", () => this.#claimRow(turnId));
    });
  }

  releaseClaim(turnId: string, claimId: string): PendingTurnRecord {
    return this.#run("release_claim", () => {
      requireIdentifier(turnId, "release_claim", 128);
      requireIdentifier(claimId, "release_claim", 128);
      return this.#transaction("release_claim", () => {
        const now = checkedNow(this.#now, "release_claim");
        const changed = this.#db.query(`
          update pending_channel_turns
          set status = 'pending', claim_id = null, claimed_at = null, updated_at = ?
          where profile_id = ? and turn_id = ? and status = 'claimed' and claim_id = ?
        `).run(now, this.#profileId, turnId, claimId).changes;
        if (changed !== 1) {
          throw storeError("state_conflict", "release_claim");
        }
        const released = this.#rowById(turnId);
        if (released === null) {
          throw storeError("database_failure", "release_claim", true);
        }
        return rowToRecord(released, "release_claim", this.#approvedMediaRoots);
      });
    });
  }

  complete(turnId: string, claimId: string): PendingTurnRecord {
    return this.#run("complete", () => {
      requireIdentifier(turnId, "complete", 128);
      requireIdentifier(claimId, "complete", 128);
      return this.#transaction("complete", () => {
        const now = checkedNow(this.#now, "complete");
        const changed = this.#db.query(`
          update pending_channel_turns
          set status = 'completed', completed_at = ?, updated_at = ?
          where profile_id = ? and turn_id = ? and status = 'claimed' and claim_id = ?
        `).run(now, now, this.#profileId, turnId, claimId).changes;
        if (changed !== 1) {
          throw storeError("state_conflict", "complete");
        }
        this.#trimCompletedRows();
        const completed = this.#rowById(turnId);
        if (completed === null) {
          throw storeError("database_failure", "complete", true);
        }
        return rowToRecord(completed, "complete", this.#approvedMediaRoots);
      });
    });
  }

  markClaimedAsUncertain(turnId?: string): number {
    return this.#run("mark_uncertain", () => {
      if (turnId !== undefined) {
        requireIdentifier(turnId, "mark_uncertain", 128);
      }
      return this.#transaction("mark_uncertain", () => {
        const now = checkedNow(this.#now, "mark_uncertain");
        const sql = turnId === undefined
          ? `update pending_channel_turns set status = 'uncertain', uncertain_at = ?, updated_at = ?
             where profile_id = ? and status = 'claimed'`
          : `update pending_channel_turns set status = 'uncertain', uncertain_at = ?, updated_at = ?
             where profile_id = ? and turn_id = ? and status = 'claimed'`;
        const params = turnId === undefined
          ? [now, now, this.#profileId] as const
          : [now, now, this.#profileId, turnId] as const;
        return this.#db.query(sql).run(...params).changes;
      });
    });
  }

  markPendingAsUncertain(turnId: string): number {
    return this.#run("recover", () => {
      requireIdentifier(turnId, "recover", 128);
      return this.#transaction("recover", () => {
        const now = checkedNow(this.#now, "recover");
        const changed = this.#db.query(`
          update pending_channel_turns
          set status = 'uncertain', uncertain_at = ?, updated_at = ?
          where profile_id = ? and turn_id = ? and status = 'pending'
        `).run(now, now, this.#profileId, turnId).changes;
        if (changed !== 1) {
          throw storeError("state_conflict", "recover");
        }
        return changed;
      });
    });
  }

  validateForRecovery(message: ChannelMessage): void {
    this.#run("recover", () => {
      validateAndSanitizeMessage(message, this.#approvedMediaRoots, "recover", false);
    });
  }

  counts(): PendingTurnCounts {
    return this.#run("counts", () => {
      const rows = this.#db.query<{ status: PendingTurnStatus; count: number }>(`
        select status, count(*) as count from pending_channel_turns
        where profile_id = ? group by status
      `).all(this.#profileId);
      const counts: PendingTurnCounts = { pending: 0, claimed: 0, completed: 0, uncertain: 0 };
      for (const row of rows) {
        if (!ALL_STATUSES.has(row.status) || !Number.isSafeInteger(row.count) || row.count < 0) {
          throw storeError("corrupt_record", "counts");
        }
        counts[row.status] = row.count;
      }
      return counts;
    });
  }

  list(options: { statuses?: PendingTurnStatus[]; limit?: number } = {}): PendingTurnRecord[] {
    return this.#run("list", () => {
      const statuses = validateStatuses(options.statuses ?? ["pending", "claimed", "uncertain", "completed"], "list");
      const limit = boundedInteger(
        options.limit,
        this.#maxPendingPerProfile * 2,
        1,
        this.#maxPendingPerProfile * 2,
        "list"
      );
      const placeholders = statuses.map(() => "?").join(", ");
      const rows = this.#db.query<PendingTurnRow>(`
        select * from pending_channel_turns
        where profile_id = ? and status in (${placeholders})
        order by sequence asc
        limit ?
      `).all(this.#profileId, ...statuses, limit);
      return rows.map((row) => rowToRecord(row, "list", this.#approvedMediaRoots));
    });
  }

  listPendingForRecovery(): PendingTurnRecord[] {
    return this.#run("recover", () => this.#transaction("recover", () => {
      const rows = this.#db.query<PendingTurnRow>(`
        select * from pending_channel_turns
        where profile_id = ? and status = 'pending'
        order by sequence asc
        limit ?
      `).all(this.#profileId, this.#maxPendingPerProfile);
      const recoverable: PendingTurnRecord[] = [];
      let now: string | undefined;
      for (const row of rows) {
        try {
          recoverable.push(rowToRecord(row, "list", this.#approvedMediaRoots));
        } catch {
          now ??= checkedNow(this.#now, "recover");
          const changed = this.#db.query(`
            update pending_channel_turns
            set status = 'uncertain', uncertain_at = ?, updated_at = ?
            where profile_id = ? and sequence = ? and status = 'pending'
          `).run(now, now, this.#profileId, row.sequence).changes;
          if (changed !== 1) {
            throw storeError("state_conflict", "recover");
          }
        }
      }
      return recoverable;
    }));
  }

  clear(options: { statuses?: PendingTurnStatus[] } = {}): number {
    return this.#run("clear", () => {
      const statuses = validateStatuses(options.statuses ?? ["pending"], "clear");
      const placeholders = statuses.map(() => "?").join(", ");
      return this.#db.query(`
        delete from pending_channel_turns
        where profile_id = ? and status in (${placeholders})
      `).run(this.#profileId, ...statuses).changes;
    });
  }

  pruneRetention(): number {
    return this.#run("retention", () => this.#transaction("retention", () => {
      const now = this.#now();
      if (!Number.isFinite(now.getTime())) {
        throw storeError("invalid_payload", "retention");
      }
      const cutoff = new Date(now.getTime() - this.#uncertainRetentionDays * 86_400_000).toISOString();
      const deleted = this.#db.query(`
        delete from pending_channel_turns
        where profile_id = ? and status in ('completed', 'uncertain') and updated_at <= ?
      `).run(this.#profileId, cutoff).changes;
      return deleted + this.#trimCompletedRows();
    }));
  }

  #rowById(turnId: string): PendingTurnRow | null {
    return this.#db.query<PendingTurnRow>(`
      select * from pending_channel_turns where profile_id = ? and turn_id = ?
    `).get(this.#profileId, turnId);
  }

  #rowByAnyDeliveryIdentity(
    channel: string,
    platformMessageIds: string[],
    operation: PendingTurnStoreOperation
  ): PendingTurnRow | null {
    const placeholders = platformMessageIds.map(() => "?").join(", ");
    const rows = this.#db.query<PendingTurnRow>(`
      select turns.*
      from pending_channel_turn_delivery_ids identities
      join pending_channel_turns turns
        on turns.profile_id = identities.profile_id and turns.turn_id = identities.turn_id
      where identities.profile_id = ? and identities.channel = ?
        and identities.platform_message_id in (${placeholders})
      order by case when identities.platform_message_id = turns.platform_message_id then 0 else 1 end,
        turns.sequence asc
    `).all(this.#profileId, channel, ...platformMessageIds);
    if (rows.length === 0) {
      return null;
    }
    if (new Set(rows.map((row) => row.turn_id)).size !== 1) {
      const primary = rows.find((row) => row.platform_message_id === platformMessageIds[0]);
      if (primary !== undefined) {
        return primary;
      }
      throw storeError("state_conflict", operation);
    }
    return rows[0]!;
  }

  #validatedMessageJson(
    message: ChannelMessage,
    operation: PendingTurnStoreOperation
  ): { message: ChannelMessage; json: string } {
    const safeMessage = validateAndSanitizeMessage(message, this.#approvedMediaRoots, operation, false);
    const json = JSON.stringify(safeMessage);
    if (utf8Size(json) > MAX_MESSAGE_JSON_BYTES) {
      throw storeError("invalid_payload", operation);
    }
    return { message: safeMessage, json };
  }

  #assertCapacity(operation: PendingTurnStoreOperation): void {
    const activeCount = this.#db.query<{ count: number }>(`
      select count(*) as count from pending_channel_turns
      where profile_id = ? and status <> 'completed'
    `).get(this.#profileId)?.count ?? 0;
    if (activeCount >= this.#maxPendingPerProfile) {
      throw storeError("capacity_exceeded", operation);
    }
  }

  #insertPending(
    message: ChannelMessage,
    messageJson: string,
    operation: PendingTurnStoreOperation
  ): PendingTurnRow {
    const now = checkedNow(this.#now, operation);
    const turnId = checkedGeneratedId(this.#idFactory, operation);
    this.#db.query(`
      insert into pending_channel_turns (
        turn_id, profile_id, channel, platform_message_id, status, message_json,
        claim_id, claimed_at, completed_at, uncertain_at, created_at, updated_at
      ) values (?, ?, ?, ?, 'pending', ?, null, null, null, null, ?, ?)
    `).run(turnId, this.#profileId, message.channel, message.id, messageJson, now, now);
    this.#insertDeliveryIdentities(turnId, message, now, operation);
    const inserted = this.#rowById(turnId);
    if (inserted === null) {
      throw storeError("database_failure", operation, true);
    }
    return inserted;
  }

  #insertTerminalDedupe(message: ChannelMessage, messageJson: string, now: string): void {
    const turnId = checkedGeneratedId(this.#idFactory, "coalesce");
    this.#db.query(`
      insert into pending_channel_turns (
        turn_id, profile_id, channel, platform_message_id, status, message_json,
        claim_id, claimed_at, completed_at, uncertain_at, created_at, updated_at
      ) values (?, ?, ?, ?, 'completed', ?, null, null, ?, null, ?, ?)
    `).run(turnId, this.#profileId, message.channel, message.id, messageJson, now, now, now);
    this.#insertDeliveryIdentities(turnId, message, now, "coalesce");
  }

  #insertDeliveryIdentities(
    turnId: string,
    message: ChannelMessage,
    now: string,
    operation: PendingTurnStoreOperation
  ): void {
    for (const platformMessageId of deliveryIdentityIds(message, operation)) {
      this.#db.query(`
        insert into pending_channel_turn_delivery_ids (
          profile_id, channel, platform_message_id, turn_id, created_at
        ) values (?, ?, ?, ?, ?)
      `).run(this.#profileId, message.channel, platformMessageId, turnId, now);
    }
  }

  #deleteExactPending(turnIds: string[], operation: PendingTurnStoreOperation): number {
    if (turnIds.length === 0) {
      return 0;
    }
    const placeholders = turnIds.map(() => "?").join(", ");
    const changed = this.#db.query(`
      delete from pending_channel_turns
      where profile_id = ? and status = 'pending' and turn_id in (${placeholders})
    `).run(this.#profileId, ...turnIds).changes;
    if (changed !== turnIds.length) {
      throw storeError("state_conflict", operation);
    }
    return changed;
  }

  #claimRow(turnId: string): PendingTurnRecord {
    const claimId = checkedGeneratedId(this.#claimIdFactory, "claim");
    const now = checkedNow(this.#now, "claim");
    const changed = this.#db.query(`
      update pending_channel_turns
      set status = 'claimed', claim_id = ?, claimed_at = ?, updated_at = ?
      where profile_id = ? and turn_id = ? and status = 'pending'
    `).run(claimId, now, now, this.#profileId, turnId).changes;
    if (changed !== 1) {
      throw storeError("state_conflict", "claim", true);
    }
    const claimed = this.#rowById(turnId);
    if (claimed === null) {
      throw storeError("database_failure", "claim", true);
    }
    return rowToRecord(claimed, "claim", this.#approvedMediaRoots);
  }

  #trimCompletedRows(): number {
    return this.#db.query(`
      delete from pending_channel_turns
      where profile_id = ? and status = 'completed' and sequence not in (
        select sequence from pending_channel_turns
        where profile_id = ? and status = 'completed'
        order by sequence desc limit ?
      )
    `).run(this.#profileId, this.#profileId, this.#maxPendingPerProfile).changes;
  }

  #transaction<T>(operation: PendingTurnStoreOperation, body: () => T): T {
    this.#db.exec("begin immediate");
    try {
      const result = body();
      this.#db.exec("commit");
      return result;
    } catch (error) {
      try {
        this.#db.exec("rollback");
      } catch {
        // Preserve the original bounded store error.
      }
      if (error instanceof PendingTurnStoreError) {
        throw error;
      }
      throw storeError("database_failure", operation, true);
    }
  }

  #run<T>(operation: PendingTurnStoreOperation, body: () => T): T {
    try {
      return body();
    } catch (error) {
      const safeError = error instanceof PendingTurnStoreError
        ? error
        : storeError("database_failure", operation, true);
      try {
        this.#onDiagnostic?.({ operation, code: safeError.code, retryable: safeError.retryable });
      } catch {
        // Diagnostics must never interfere with queue state.
      }
      throw safeError;
    }
  }
}

function validateAndSanitizeMessage(
  value: ChannelMessage,
  approvedMediaRoots: string[],
  operation: PendingTurnStoreOperation,
  allowMissingFiles = operation !== "enqueue" && operation !== "recover"
): ChannelMessage {
  if (!isPlainObject(value)) {
    throw storeError("invalid_payload", operation);
  }
  const id = requireIdentifier(value.id, operation, MAX_IDENTIFIER_CHARS);
  const channel = requireIdentifier(value.channel, operation, 64);
  if (!isPlainObject(value.sessionKey) || value.sessionKey.platform !== channel) {
    throw storeError("invalid_payload", operation);
  }
  const text = requireString(value.text, operation, MAX_TEXT_CHARS, true);
  const receivedAt = requireIsoDate(value.receivedAt, operation);
  if (!isPlainObject(value.sender)) {
    throw storeError("invalid_payload", operation);
  }

  const sessionKey = {
    platform: channel,
    chatId: requireIdentifier(value.sessionKey.chatId, operation, MAX_IDENTIFIER_CHARS),
    ...(value.sessionKey.accountId === undefined ? {} : {
      accountId: requireIdentifier(value.sessionKey.accountId, operation, MAX_IDENTIFIER_CHARS)
    }),
    ...(value.sessionKey.chatType === undefined ? {} : {
      chatType: requireEnum(value.sessionKey.chatType, ["dm", "group", "channel", "thread"] as const, operation)
    }),
    ...(value.sessionKey.threadId === undefined ? {} : {
      threadId: requireIdentifier(value.sessionKey.threadId, operation, MAX_IDENTIFIER_CHARS)
    }),
    ...(value.sessionKey.userId === undefined ? {} : {
      userId: requireIdentifier(value.sessionKey.userId, operation, MAX_IDENTIFIER_CHARS)
    })
  };
  const sender = {
    id: requireIdentifier(value.sender.id, operation, MAX_IDENTIFIER_CHARS),
    ...(value.sender.displayName === undefined ? {} : {
      displayName: requireString(value.sender.displayName, operation, 512, true)
    }),
    ...(value.sender.username === undefined ? {} : {
      username: requireString(value.sender.username, operation, 512, true)
    })
  };
  const metadata = value.metadata === undefined
    ? undefined
    : sanitizeMetadata(value.metadata, operation, MAX_METADATA_JSON_BYTES);
  const attachments = (value.attachments ?? []).map((attachment) =>
    sanitizeAttachment(attachment, approvedMediaRoots, operation, allowMissingFiles));
  if (attachments.length > MAX_ATTACHMENTS ||
      utf8Size(JSON.stringify(attachments)) > MAX_ATTACHMENTS_JSON_BYTES) {
    throw storeError("invalid_payload", operation);
  }

  const safeMessage: ChannelMessage = {
    id,
    channel,
    sessionKey,
    text,
    sender,
    attachments,
    receivedAt,
    ...(metadata === undefined ? {} : { metadata })
  };
  assertNoSecretShapedValue(safeMessage, operation);
  return safeMessage;
}

function sanitizeAttachment(
  value: ChannelAttachment,
  approvedMediaRoots: string[],
  operation: PendingTurnStoreOperation,
  allowMissingFile: boolean
): ChannelAttachment {
  if (!isPlainObject(value) || !ATTACHMENT_KINDS.has(value.kind)) {
    throw storeError("invalid_payload", operation);
  }
  if (value.status !== undefined && !ATTACHMENT_STATUSES.has(value.status)) {
    throw storeError("invalid_payload", operation);
  }
  if (value.failureMessage !== undefined || value.remoteUrl !== undefined || value.url !== undefined) {
    throw storeError("invalid_payload", operation);
  }
  if (value.localPath !== undefined && value.path !== undefined && value.localPath !== value.path) {
    throw storeError("invalid_payload", operation);
  }
  const requestedPath = value.localPath ?? value.path;
  let localPath: string | undefined;
  if (requestedPath !== undefined) {
    if (!isAbsolute(requestedPath)) {
      throw storeError("invalid_payload", operation);
    }
    const resolvedPath = resolve(requestedPath);
    try {
      localPath = realpathSync(resolvedPath);
      if (!statSync(localPath).isFile() || !approvedMediaRoots.some((root) => pathIsWithin(root, localPath!))) {
        throw storeError("invalid_payload", operation);
      }
    } catch (error) {
      if (error instanceof PendingTurnStoreError) {
        throw error;
      }
      if (!allowMissingFile || !isNodeErrorCode(error, "ENOENT") ||
          !approvedMediaRoots.some((root) => pathIsWithin(root, resolvedPath))) {
        throw storeError("invalid_payload", operation);
      }
      localPath = resolvedPath;
    }
  }
  const metadata = value.metadata === undefined
    ? undefined
    : sanitizeMetadata(value.metadata, operation, 8_192);
  const bytes = value.bytes;
  if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 1_073_741_824)) {
    throw storeError("invalid_payload", operation);
  }
  return {
    id: requireIdentifier(value.id, operation, MAX_IDENTIFIER_CHARS),
    kind: value.kind,
    ...(value.status === undefined ? {} : { status: value.status }),
    ...(value.failureCode === undefined ? {} : {
      failureCode: requireString(value.failureCode, operation, 128, false)
    }),
    ...(value.mimeType === undefined ? {} : { mimeType: requireString(value.mimeType, operation, 256, false) }),
    ...(value.originalName === undefined ? {} : {
      originalName: requireString(value.originalName, operation, 512, true)
    }),
    ...(value.name === undefined ? {} : { name: requireString(value.name, operation, 512, true) }),
    ...(localPath === undefined ? {} : { localPath }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(metadata === undefined ? {} : { metadata })
  };
}

function sanitizeMetadata(
  value: Record<string, unknown>,
  operation: PendingTurnStoreOperation,
  maxJsonBytes: number
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw storeError("invalid_payload", operation);
  }
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (input: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw storeError("invalid_payload", operation);
    }
    if (input === null || typeof input === "boolean") {
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw storeError("invalid_payload", operation);
      }
      return input;
    }
    if (typeof input === "string") {
      if (input.length > MAX_JSON_STRING_CHARS || SECRET_SHAPED_VALUE.test(input)) {
        throw storeError("invalid_payload", operation);
      }
      return input;
    }
    if (typeof input !== "object" || input === undefined || seen.has(input)) {
      throw storeError("invalid_payload", operation);
    }
    seen.add(input);
    if (Array.isArray(input)) {
      const result = input.map((entry) => visit(entry, depth + 1));
      seen.delete(input);
      return result;
    }
    if (!isPlainObject(input)) {
      throw storeError("invalid_payload", operation);
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input)) {
      if (key.length === 0 || key.length > MAX_JSON_KEY_CHARS || SENSITIVE_KEY.test(key)) {
        throw storeError("invalid_payload", operation);
      }
      result[key] = visit(entry, depth + 1);
    }
    seen.delete(input);
    return result;
  };
  const sanitized = visit(value, 0) as Record<string, unknown>;
  if (utf8Size(JSON.stringify(sanitized)) > maxJsonBytes) {
    throw storeError("invalid_payload", operation);
  }
  return sanitized;
}

function rowToRecord(
  row: PendingTurnRow,
  operation: PendingTurnStoreOperation,
  approvedMediaRoots: string[]
): PendingTurnRecord {
  try {
    if (!ALL_STATUSES.has(row.status) || row.profile_id.length === 0 || row.turn_id.length === 0) {
      throw new Error("invalid row");
    }
    if (utf8Size(row.message_json) > MAX_MESSAGE_JSON_BYTES) {
      throw new Error("invalid row");
    }
    const parsed = JSON.parse(row.message_json) as ChannelMessage;
    const message = validateAndSanitizeMessage(parsed, approvedMediaRoots, operation);
    if (message.id !== row.platform_message_id || message.channel !== row.channel ||
        JSON.stringify(message) !== row.message_json) {
      throw new Error("invalid row");
    }
    return {
      sequence: row.sequence,
      id: row.turn_id,
      profileId: row.profile_id,
      channel: row.channel,
      platformMessageId: row.platform_message_id,
      status: row.status,
      message,
      ...(row.claim_id === null ? {} : { claimId: row.claim_id }),
      ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
      ...(row.uncertain_at === null ? {} : { uncertainAt: row.uncertain_at }),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  } catch {
    throw storeError("corrupt_record", operation);
  }
}

function deliveryIdentityIds(
  message: ChannelMessage,
  operation: PendingTurnStoreOperation
): string[] {
  const ids = [requireIdentifier(message.id, operation, MAX_IDENTIFIER_CHARS)];
  for (const key of ["debouncedMessageIds", "busyTextCoalescedMessageIds"] as const) {
    const value = message.metadata?.[key];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value) || value.length > MAX_DELIVERY_IDENTITIES_PER_TURN) {
      throw storeError("invalid_payload", operation);
    }
    for (const id of value) {
      ids.push(requireIdentifier(id, operation, MAX_IDENTIFIER_CHARS));
    }
  }
  const unique = [...new Set(ids)];
  if (unique.length > MAX_DELIVERY_IDENTITIES_PER_TURN) {
    throw storeError("invalid_payload", operation);
  }
  return unique;
}

function validateStatuses(
  values: PendingTurnStatus[],
  operation: PendingTurnStoreOperation
): PendingTurnStatus[] {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !ALL_STATUSES.has(value))) {
    throw storeError("invalid_payload", operation);
  }
  return [...new Set(values)];
}

function validateTurnIds(
  values: string[],
  operation: PendingTurnStoreOperation
): string[] {
  if (!Array.isArray(values)) {
    throw storeError("invalid_payload", operation);
  }
  const ids = values.map((value) => requireIdentifier(value, operation, 128));
  if (new Set(ids).size !== ids.length) {
    throw storeError("invalid_payload", operation);
  }
  return ids;
}

function requireIdentifier(
  value: unknown,
  operation: PendingTurnStoreOperation,
  maxChars: number
): string {
  const identifier = requireString(value, operation, maxChars, false);
  if (/\p{Cc}/u.test(identifier) || SECRET_SHAPED_VALUE.test(identifier)) {
    throw storeError("invalid_payload", operation);
  }
  return identifier;
}

function requireString(
  value: unknown,
  operation: PendingTurnStoreOperation,
  maxChars: number,
  allowEmpty: boolean
): string {
  if (typeof value !== "string" || value.length > maxChars || (!allowEmpty && value.length === 0)) {
    throw storeError("invalid_payload", operation);
  }
  return value;
}

function requireIsoDate(value: unknown, operation: PendingTurnStoreOperation): string {
  const text = requireString(value, operation, 64, false);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) {
    throw storeError("invalid_payload", operation);
  }
  return text;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  operation: PendingTurnStoreOperation
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw storeError("invalid_payload", operation);
  }
  return value as T;
}

function assertNoSecretShapedValue(value: unknown, operation: PendingTurnStoreOperation): void {
  const visit = (input: unknown): void => {
    if (typeof input === "string" && SECRET_SHAPED_VALUE.test(input)) {
      throw storeError("invalid_payload", operation);
    }
    if (Array.isArray(input)) {
      input.forEach(visit);
    } else if (isPlainObject(input)) {
      Object.values(input).forEach(visit);
    }
  };
  visit(value);
}

function canonicalDirectory(path: string): string {
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) {
    throw new Error("not a directory");
  }
  return canonical;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function checkedNow(now: () => Date, operation: PendingTurnStoreOperation): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) {
    throw storeError("invalid_payload", operation);
  }
  return value.toISOString();
}

function checkedGeneratedId(factory: () => string, operation: PendingTurnStoreOperation): string {
  return requireIdentifier(factory(), operation, 128);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  operation: PendingTurnStoreOperation
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new PendingTurnStoreError({ code: "invalid_payload", operation });
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function utf8Size(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function storeError(
  code: PendingTurnStoreErrorCode,
  operation: PendingTurnStoreOperation,
  retryable = false
): PendingTurnStoreError {
  return new PendingTurnStoreError({ code, operation, retryable });
}

function errorMessage(code: PendingTurnStoreErrorCode): string {
  switch (code) {
    case "invalid_payload":
      return "Pending turn payload is not safe to persist.";
    case "capacity_exceeded":
      return "Pending turn capacity has been reached.";
    case "state_conflict":
      return "Pending turn state changed before the operation completed.";
    case "database_failure":
      return "Pending turn storage is temporarily unavailable.";
    case "corrupt_record":
      return "A pending turn record failed integrity validation.";
  }
}
