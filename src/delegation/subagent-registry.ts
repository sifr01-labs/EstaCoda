import type { DelegateRole } from "../contracts/delegation.js";

export type ActiveSubagentStatus =
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "timeout";

export type ActiveSubagentRecord = {
  subagentId: string;
  childSessionId: string;
  parentSessionId: string;
  batchId?: string;
  taskIndex?: number;
  depth: number;
  role: DelegateRole;
  goal: string;
  model: string;
  provider: string;
  startedAt: string;
  status: ActiveSubagentStatus;
  toolCount: number;
  lastActivityAt?: string;
  abortController: AbortController;
};

export type ActiveSubagentSnapshot = Omit<ActiveSubagentRecord, "abortController"> & {
  signalAborted: boolean;
};

export type RegisterSubagentInput = Omit<ActiveSubagentRecord, "goal" | "startedAt" | "status" | "lastActivityAt"> & {
  goal: string;
  startedAt?: string;
  status?: ActiveSubagentStatus;
  lastActivityAt?: string;
};

export type SubagentRegistryUpdate = Partial<Omit<ActiveSubagentRecord, "subagentId" | "abortController">>;

const MAX_GOAL_CHARS = 240;
const SECRET_VALUE_RE = /(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?[^"',\s]+/giu;
const TOKEN_PREFIX_RE = /\b(?:sk-ant-|sk-proj-|sk-|ghp_|github_pat_)[A-Za-z0-9_\-]+/gu;

export class SubagentRegistry {
  readonly #active = new Map<string, ActiveSubagentRecord>();
  #spawnPausedReason: string | undefined;

  registerSubagent(input: RegisterSubagentInput): ActiveSubagentSnapshot {
    const record: ActiveSubagentRecord = {
      ...input,
      goal: sanitizeGoal(input.goal),
      startedAt: input.startedAt ?? new Date().toISOString(),
      status: input.status ?? "starting",
      lastActivityAt: input.lastActivityAt
    };
    this.#active.set(record.subagentId, record);
    return snapshot(record);
  }

  updateSubagent(id: string, patch: SubagentRegistryUpdate): ActiveSubagentSnapshot | undefined {
    const record = this.#active.get(id);
    if (record === undefined) {
      return undefined;
    }
    if (patch.goal !== undefined) {
      record.goal = sanitizeGoal(patch.goal);
    }
    if (patch.childSessionId !== undefined) {
      record.childSessionId = patch.childSessionId;
    }
    if (patch.parentSessionId !== undefined) {
      record.parentSessionId = patch.parentSessionId;
    }
    if (patch.batchId !== undefined) {
      record.batchId = patch.batchId;
    }
    if (patch.taskIndex !== undefined) {
      record.taskIndex = patch.taskIndex;
    }
    if (patch.depth !== undefined) {
      record.depth = patch.depth;
    }
    if (patch.role !== undefined) {
      record.role = patch.role;
    }
    if (patch.model !== undefined) {
      record.model = patch.model;
    }
    if (patch.provider !== undefined) {
      record.provider = patch.provider;
    }
    if (patch.startedAt !== undefined) {
      record.startedAt = patch.startedAt;
    }
    if (patch.status !== undefined) {
      record.status = patch.status;
    }
    if (patch.toolCount !== undefined) {
      record.toolCount = patch.toolCount;
    }
    if (patch.lastActivityAt !== undefined) {
      record.lastActivityAt = patch.lastActivityAt;
    }
    return snapshot(record);
  }

  unregisterSubagent(id: string): boolean {
    return this.#active.delete(id);
  }

  listActiveSubagents(parentSessionId?: string): ActiveSubagentSnapshot[] {
    const records = [...this.#active.values()]
      .filter((record) => parentSessionId === undefined || record.parentSessionId === parentSessionId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.subagentId.localeCompare(b.subagentId));
    return records.map(snapshot);
  }

  hasActiveSubagents(parentSessionId: string): boolean {
    for (const record of this.#active.values()) {
      if (record.parentSessionId === parentSessionId) {
        return true;
      }
    }
    return false;
  }

  interruptSubagent(id: string, reason: string): boolean {
    const record = this.#active.get(id);
    if (record === undefined) {
      return false;
    }
    record.status = "cancelling";
    record.lastActivityAt = new Date().toISOString();
    abort(record.abortController, boundedReason(reason));
    return true;
  }

  interruptChildrenForParent(parentSessionId: string, reason: string): number {
    let interrupted = 0;
    for (const record of this.#active.values()) {
      if (record.parentSessionId === parentSessionId) {
        record.status = "cancelling";
        record.lastActivityAt = new Date().toISOString();
        abort(record.abortController, boundedReason(reason));
        interrupted += 1;
      }
    }
    return interrupted;
  }

  pauseSpawns(reason: string): void {
    this.#spawnPausedReason = boundedReason(reason);
  }

  resumeSpawns(): void {
    this.#spawnPausedReason = undefined;
  }

  isSpawnPaused(): boolean {
    return this.#spawnPausedReason !== undefined;
  }

  spawnPausedReason(): string | undefined {
    return this.#spawnPausedReason;
  }
}

function snapshot(record: ActiveSubagentRecord): ActiveSubagentSnapshot {
  const { abortController: _abortController, ...rest } = record;
  return {
    ...rest,
    signalAborted: record.abortController.signal.aborted
  };
}

function sanitizeGoal(goal: string): string {
  return boundedReason(goal
    .replace(SECRET_VALUE_RE, "[REDACTED]")
    .replace(TOKEN_PREFIX_RE, "[REDACTED]")
    .replace(/\s+/gu, " ")
    .trim());
}

function boundedReason(reason: string): string {
  const normalized = reason.replace(/[\r\n\t]+/gu, " ").trim();
  if (normalized.length <= MAX_GOAL_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_GOAL_CHARS - 3)}...`;
}

function abort(controller: AbortController, reason: string): void {
  if (controller.signal.aborted) {
    return;
  }
  controller.abort(reason);
}
