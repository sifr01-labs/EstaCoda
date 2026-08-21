import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { isArtifactKind, type ArtifactKind, type ArtifactRecord } from "../contracts/artifact.js";

export type ArtifactStoreOptions = {
  id?: () => string;
  now?: () => Date;
};

export type RecordArtifactInput = {
  path: string;
  displayPath?: string;
  localPath?: string;
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
    if (!isArtifactKind(input.kind)) {
      throw new Error(`Invalid artifact kind: ${String(input.kind)}`);
    }
    const id = this.#id();
    const localPath = input.localPath ?? (isAbsolute(input.path) ? input.path : undefined);
    const artifact: ArtifactRecord = {
      id,
      path: input.displayPath ?? (isAbsolute(input.path) ? `artifact://${id}` : input.path),
      localPath,
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

  get(reference: string): ArtifactRecord | undefined {
    const id = reference.startsWith("artifact://") ? reference.slice("artifact://".length) : reference;
    if (id.length === 0 || id.includes("/") || id.includes("\\")) return undefined;
    return this.#artifacts.get(id);
  }
}
