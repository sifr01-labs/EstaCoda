import type {
  AppendMessageInput,
  CreateSessionInput,
  RewriteSessionTranscriptInput,
  SessionDB,
  SessionEvent,
  SessionMessage,
  SessionModelOverride,
  SessionRecord,
  SessionSearchOptions,
  SessionSearchResult
} from "../contracts/session.js";
import type { FailureRecord } from "../contracts/failure.js";
import type { ProviderUsageEntry, ProviderUsageQuery } from "../contracts/provider-usage.js";
import { verifiedCompressionLineage } from "./session-lineage.js";
import { tokenizeSearchTerms } from "../search/fts-query.js";
import { providerUsageMatches } from "../providers/provider-usage-ledger.js";

const SESSION_MODEL_OVERRIDE_METADATA_KEY = "sessionModelOverride";

export class InMemorySessionDB implements SessionDB {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #messages = new Map<string, SessionMessage[]>();
  readonly #events = new Map<string, SessionEvent[]>();
  readonly #providerUsage = new Map<string, ProviderUsageEntry>();
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(options: { now?: () => Date; id?: () => string } = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? (() => crypto.randomUUID());
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const now = this.#now().toISOString();
    const id = input.id ?? this.#id();

    if (this.#sessions.has(id)) {
      throw new Error(`Session already exists: ${id}`);
    }

    const session: SessionRecord = {
      id,
      profileId: input.profileId,
      title: input.title,
      createdAt: now,
      updatedAt: now,
      parentSessionId: input.parentSessionId,
      endedAt: input.endedAt,
      endReason: input.endReason,
      metadata: input.metadata
    };

    this.#sessions.set(id, session);
    this.#messages.set(id, []);
    this.#events.set(id, []);

    return cloneSession(session);
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const session = this.#sessions.get(id);
    return session === undefined ? undefined : cloneSession(session);
  }

  async listSessions(profileId?: string): Promise<SessionRecord[]> {
    return [...this.#sessions.values()]
      .filter((session) => profileId === undefined || session.profileId === profileId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneSession);
  }

  async appendMessage(input: AppendMessageInput): Promise<SessionMessage> {
    const session = this.#sessions.get(input.sessionId);

    if (session === undefined) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }

    const message: SessionMessage = {
      id: input.id ?? this.#id(),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: this.#now().toISOString(),
      channel: input.channel,
      metadata: input.metadata
    };

    this.#messages.get(input.sessionId)?.push(message);
    this.#touch(input.sessionId);

    return cloneMessage(message);
  }

  async endSession(sessionId: string, reason: string): Promise<void> {
    const session = this.#sessions.get(sessionId);

    if (session === undefined) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.endedAt !== undefined) {
      return;
    }

    session.endedAt = this.#now().toISOString();
    session.endReason = reason;
    this.#touch(sessionId);
  }

  async setSessionModelOverride(sessionId: string, override: SessionModelOverride): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.metadata = {
      ...(session.metadata ?? {}),
      [SESSION_MODEL_OVERRIDE_METADATA_KEY]: structuredClone(override)
    };
    this.#events.get(sessionId)?.push({
      kind: "context-window-usage-invalidated",
      reason: "model-change"
    });
    this.#touch(sessionId);
  }

  async clearSessionModelOverride(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.metadata === undefined || !(SESSION_MODEL_OVERRIDE_METADATA_KEY in session.metadata)) {
      this.#events.get(sessionId)?.push({
        kind: "context-window-usage-invalidated",
        reason: "model-change"
      });
      this.#touch(sessionId);
      return;
    }

    const { [SESSION_MODEL_OVERRIDE_METADATA_KEY]: _removed, ...rest } = session.metadata;
    session.metadata = Object.keys(rest).length === 0 ? undefined : rest;
    this.#events.get(sessionId)?.push({
      kind: "context-window-usage-invalidated",
      reason: "model-change"
    });
    this.#touch(sessionId);
  }

  async getSessionModelOverride(sessionId: string): Promise<SessionModelOverride | undefined> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return readSessionModelOverride(session.metadata);
  }

  async replaceMessages(input: RewriteSessionTranscriptInput): Promise<SessionMessage[]> {
    return this.rewriteTranscript(input);
  }

  async rewriteTranscript(input: RewriteSessionTranscriptInput): Promise<SessionMessage[]> {
    const session = this.#sessions.get(input.sessionId);

    if (session === undefined) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }

    const replacement = buildReplacementMessages({
      sessionId: input.sessionId,
      messages: input.messages,
      now: this.#now,
      id: this.#id
    });
    const events = (input.events ?? []).map((event) => structuredClone(event));
    this.#messages.set(input.sessionId, replacement);
    this.#events.get(input.sessionId)?.push(...events);
    this.#touch(input.sessionId);

    return replacement.map(cloneMessage);
  }

  async appendEvent(sessionId: string, event: SessionEvent): Promise<void> {
    if (!this.#sessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.#events.get(sessionId)?.push(structuredClone(event));
    this.#touch(sessionId);
  }

  async recordProviderUsageEntries(entries: readonly ProviderUsageEntry[]): Promise<void> {
    for (const entry of entries) {
      for (const sessionId of [entry.sessionId, entry.sessionBudgetScopeId]) {
        if (sessionId !== undefined && this.#sessions.get(sessionId)?.profileId !== entry.profileId) {
          throw new Error("Provider usage Session attribution is invalid.");
        }
      }
      if (entry.visibleTurnId !== undefined) {
        const lineageRoot = entry.sessionBudgetScopeId ?? entry.sessionId;
        const lineage = lineageRoot === undefined
          ? undefined
          : await verifiedCompressionLineage(this, lineageRoot, entry.profileId);
        const visibleTurnOwned = lineage?.some((session) =>
          this.#messages.get(session.id)?.some((message) =>
            message.id === entry.visibleTurnId && message.role === "user"
          ) === true
        ) === true;
        if (!visibleTurnOwned) {
          throw new Error("Provider usage visible turn does not belong to its attributed Session compression lineage.");
        }
      }
      const key = `${entry.profileId}\0${entry.requestKey}`;
      const existing = this.#providerUsage.get(key);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(entry)) {
        throw new Error(`Provider usage request key ${entry.requestKey} conflicts with another entry.`);
      }
      this.#providerUsage.set(key, structuredClone(entry));
    }
  }

  async listProviderUsageEntries(profileId: string, query: ProviderUsageQuery = {}): Promise<ProviderUsageEntry[]> {
    return [...this.#providerUsage.values()]
      .filter((entry) => entry.profileId === profileId && providerUsageMatches(entry, query))
      .sort((left, right) => left.dispatchedAt.localeCompare(right.dispatchedAt) ||
        left.providerAttemptIndex - right.providerAttemptIndex || left.id.localeCompare(right.id))
      .map((entry) => structuredClone(entry));
  }

  async listMessages(sessionId: string): Promise<SessionMessage[]> {
    return (this.#messages.get(sessionId) ?? []).map(cloneMessage);
  }

  async listEvents(sessionId: string): Promise<SessionEvent[]> {
    return (this.#events.get(sessionId) ?? []).map((event) => structuredClone(event));
  }

  async search(query: string, options: SessionSearchOptions = {}): Promise<SessionSearchResult[]> {
    const terms = tokenizeSearchTerms(query);

    if (terms.length === 0) {
      return [];
    }

    const results: SessionSearchResult[] = [];

    for (const session of this.#sessions.values()) {
      if (options.profileId !== undefined && session.profileId !== options.profileId) {
        continue;
      }
      if (options.rootSessionsOnly === true && session.parentSessionId !== undefined) {
        continue;
      }

      for (const message of this.#messages.get(session.id) ?? []) {
        const score = scoreMessage(message.content, terms);

        if (score > 0) {
          results.push({
            session: cloneSession(session),
            message: cloneMessage(message),
            score
          });
        }
      }
    }

    return results.sort((left, right) => right.score - left.score).slice(0, options.limit ?? 10);
  }

  async saveFailure(_record: FailureRecord): Promise<void> {
    // In-memory store does not persist failures
  }

  #touch(sessionId: string): void {
    const session = this.#sessions.get(sessionId);

    if (session !== undefined) {
      session.updatedAt = this.#now().toISOString();
    }
  }
}

function scoreMessage(content: string, terms: string[]): number {
  const normalized = content.toLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}

function cloneSession(session: SessionRecord): SessionRecord {
  return {
    ...session,
    metadata: session.metadata === undefined ? undefined : structuredClone(session.metadata)
  };
}

function cloneMessage(message: SessionMessage): SessionMessage {
  return {
    ...message,
    metadata: message.metadata === undefined ? undefined : structuredClone(message.metadata)
  };
}

function readSessionModelOverride(metadata: Record<string, unknown> | undefined): SessionModelOverride | undefined {
  const value = metadata?.[SESSION_MODEL_OVERRIDE_METADATA_KEY];
  return isSessionModelOverride(value) ? structuredClone(value) : undefined;
}

function isSessionModelOverride(value: unknown): value is SessionModelOverride {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SessionModelOverride>;
  return (
    typeof candidate.setAt === "string" &&
    (candidate.source === "cli" || candidate.source === "gateway") &&
    typeof candidate.route === "object" &&
    candidate.route !== null &&
    typeof candidate.route.provider === "string" &&
    typeof candidate.route.id === "string" &&
    typeof candidate.modelProfile === "object" &&
    candidate.modelProfile !== null &&
    typeof candidate.modelProfile.id === "string" &&
    typeof candidate.modelProfile.provider === "string"
  );
}

function buildReplacementMessages(input: {
  sessionId: string;
  messages: RewriteSessionTranscriptInput["messages"];
  now: () => Date;
  id: () => string;
}): SessionMessage[] {
  const baseTime = input.now().getTime();
  let generated = 0;

  return input.messages.map((message) => ({
    id: message.id ?? input.id(),
    sessionId: input.sessionId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt ?? new Date(baseTime + generated++).toISOString(),
    channel: message.channel,
    metadata: message.metadata
  }));
}
