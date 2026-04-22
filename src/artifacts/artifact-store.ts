import { randomUUID } from "node:crypto";
import type { ArtifactKind, ArtifactRecord } from "../contracts/artifact.js";

export type ArtifactStoreOptions = {
  id?: () => string;
  now?: () => Date;
};

export type RecordArtifactInput = {
  path: string;
  kind: ArtifactKind;
  bytes: number;
  summary?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
};

export class ArtifactStore {
  readonly #artifacts = new Map<string, ArtifactRecord>();
  readonly #id: () => string;
  readonly #now: () => Date;

  constructor(options: ArtifactStoreOptions = {}) {
    this.#id = options.id ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  record(input: RecordArtifactInput): ArtifactRecord {
    const artifact: ArtifactRecord = {
      id: this.#id(),
      path: input.path,
      kind: input.kind,
      bytes: input.bytes,
      createdAt: this.#now().toISOString(),
      summary: input.summary,
      mimeType: input.mimeType,
      metadata: input.metadata
    };

    this.#artifacts.set(artifact.id, artifact);
    return artifact;
  }

  list(): ArtifactRecord[] {
    return [...this.#artifacts.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}
