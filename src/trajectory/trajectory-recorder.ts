import type {
  CompressedTrajectory,
  Trajectory,
  TrajectoryEvent,
  TrajectoryEventKind
} from "../contracts/trajectory.js";

export type TrajectoryRecorderOptions = {
  profileId: string;
  sessionId: string;
  modelId: string;
  now?: () => Date;
  id?: () => string;
};

export class TrajectoryRecorder {
  readonly #trajectory: Trajectory;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(options: TrajectoryRecorderOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomId;
    this.#trajectory = {
      id: this.#id(),
      profileId: options.profileId,
      sessionId: options.sessionId,
      modelId: options.modelId,
      events: []
    };
  }

  record(kind: TrajectoryEventKind, data: Record<string, unknown>): TrajectoryEvent {
    const event: TrajectoryEvent = {
      id: this.#id(),
      kind,
      timestamp: this.#now().toISOString(),
      data
    };

    this.#trajectory.events.push(event);
    return event;
  }

  complete(outcome: Trajectory["outcome"]): Trajectory {
    this.#trajectory.outcome = outcome;
    this.record("session-end", { outcome });
    return this.snapshot();
  }

  snapshot(): Trajectory {
    return {
      ...this.#trajectory,
      events: this.#trajectory.events.map((event) => ({ ...event, data: { ...event.data } })),
      outcome:
        this.#trajectory.outcome === undefined ? undefined : { ...this.#trajectory.outcome }
    };
  }

  compress(): CompressedTrajectory {
    const trajectory = this.snapshot();
    const preservedEventIds = trajectory.events
      .filter((event) => event.kind === "user-input" || event.kind === "skill-selected" || event.kind === "assistant-output")
      .map((event) => event.id);

    return {
      id: this.#id(),
      sourceTrajectoryId: trajectory.id,
      summary: summarize(trajectory),
      preservedEventIds,
      evaluationSignals: {
        eventCount: trajectory.events.length,
        success: trajectory.outcome?.success ?? null,
        userAccepted: trajectory.outcome?.userAccepted ?? null
      }
    };
  }
}

function summarize(trajectory: Trajectory): string {
  const kinds = new Map<TrajectoryEventKind, number>();

  for (const event of trajectory.events) {
    kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
  }

  const eventSummary = [...kinds.entries()]
    .map(([kind, count]) => `${kind}:${count}`)
    .join(", ");

  return `Trajectory ${trajectory.id} for ${trajectory.profileId}/${trajectory.sessionId}. Events: ${eventSummary}. Outcome: ${trajectory.outcome?.summary ?? "pending"}.`;
}

function randomId(): string {
  return crypto.randomUUID();
}

