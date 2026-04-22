import type {
  AppendMessageInput,
  CreateSessionInput,
  SessionDB,
  SessionEvent,
  SessionMessage,
  SessionRecord,
  SessionSearchResult
} from "../contracts/session.js";

export class InMemorySessionDB implements SessionDB {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #messages = new Map<string, SessionMessage[]>();
  readonly #events = new Map<string, SessionEvent[]>();
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
      metadata: input.metadata
    };

    this.#sessions.set(id, session);
    this.#messages.set(id, []);
    this.#events.set(id, []);

    return { ...session };
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const session = this.#sessions.get(id);
    return session === undefined ? undefined : { ...session };
  }

  async listSessions(profileId?: string): Promise<SessionRecord[]> {
    return [...this.#sessions.values()]
      .filter((session) => profileId === undefined || session.profileId === profileId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((session) => ({ ...session }));
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

  async appendEvent(sessionId: string, event: SessionEvent): Promise<void> {
    if (!this.#sessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.#events.get(sessionId)?.push(structuredClone(event));
    this.#touch(sessionId);
  }

  async listMessages(sessionId: string): Promise<SessionMessage[]> {
    return (this.#messages.get(sessionId) ?? []).map(cloneMessage);
  }

  async listEvents(sessionId: string): Promise<SessionEvent[]> {
    return (this.#events.get(sessionId) ?? []).map((event) => structuredClone(event));
  }

  async search(query: string, options: { profileId?: string; limit?: number } = {}): Promise<SessionSearchResult[]> {
    const terms = tokenize(query);

    if (terms.length === 0) {
      return [];
    }

    const results: SessionSearchResult[] = [];

    for (const session of this.#sessions.values()) {
      if (options.profileId !== undefined && session.profileId !== options.profileId) {
        continue;
      }

      for (const message of this.#messages.get(session.id) ?? []) {
        const score = scoreMessage(message.content, terms);

        if (score > 0) {
          results.push({
            session: { ...session },
            message: cloneMessage(message),
            score
          });
        }
      }
    }

    return results.sort((left, right) => right.score - left.score).slice(0, options.limit ?? 10);
  }

  #touch(sessionId: string): void {
    const session = this.#sessions.get(sessionId);

    if (session !== undefined) {
      session.updatedAt = this.#now().toISOString();
    }
  }
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9\u0600-\u06ff]+/u)
    .filter((term) => term.length > 1);
}

function scoreMessage(content: string, terms: string[]): number {
  const normalized = content.toLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}

function cloneMessage(message: SessionMessage): SessionMessage {
  return {
    ...message,
    metadata: message.metadata === undefined ? undefined : { ...message.metadata }
  };
}

