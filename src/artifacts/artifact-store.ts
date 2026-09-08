import { reviewedApiDescription } from "../contracts/artifact.js";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import {
  isArtifactKind,
  SESSION_ARTIFACT_VERSION,
  type ArtifactKind,
  type ArtifactRecord,
  type SessionArtifactRegistration,
  type SessionArtifactSource
} from "../contracts/artifact.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { inspectBrowserDownload } from "./browser-download-validation.js";

export type ArtifactStoreOptions = {
  id?: () => string;
  storageId?: () => string;
  now?: () => Date;
  /** Profile-local durable artifact root selected by the runtime, never by model input. */
  storageRoot?: string;
};

export type SessionArtifactScope = {
  sessionId: string;
  profileId: string;
};

export type RetainSessionArtifactInput = SessionArtifactScope & {
  capturePath: string;
  kind: ArtifactKind;
  bytes: number;
  mimeType: string;
  sha256: string;
  source: SessionArtifactSource;
  summary?: string;
  persist(registration: SessionArtifactRegistration): Promise<void>;
};

type StoredArtifact = {
  artifact: ArtifactRecord;
  owners?: SessionArtifactScope[];
};

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const SAFE_STORAGE_KEY = /^objects\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

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
  readonly #artifacts = new Map<string, StoredArtifact>();
  readonly #id: () => string;
  readonly #storageId: () => string;
  readonly #now: () => Date;
  readonly #storageRoot: string | undefined;

  constructor(options: ArtifactStoreOptions = {}) {
    this.#id = options.id ?? randomUUID;
    this.#storageId = options.storageId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#storageRoot = options.storageRoot === undefined ? undefined : resolve(options.storageRoot);
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

    this.#artifacts.set(artifact.id, { artifact });
    return cloneArtifact(artifact);
  }

  async retainSessionArtifact(input: RetainSessionArtifactInput): Promise<ArtifactRecord> {
    if (this.#storageRoot === undefined) throw new Error("Durable artifact storage is unavailable.");
    if (!isArtifactKind(input.kind) || !validScope(input) || !SHA256.test(input.sha256)) {
      throw new Error("Session artifact metadata is invalid.");
    }
    const source = validateSource(input.source);
    const capturePath = resolve(input.capturePath);
    const capture = await lstat(capturePath);
    if (!capture.isFile() || capture.isSymbolicLink() || capture.size !== input.bytes) {
      throw new Error("Session artifact capture is invalid.");
    }
    const content = await readFile(capturePath);
    const inspection = inspectBrowserDownload(source.filename, content);
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (
      inspection.allowed === false ||
      inspection.kind !== input.kind ||
      inspection.mimeType !== input.mimeType ||
      actualHash !== input.sha256
    ) {
      throw new Error("Session artifact content does not match its metadata.");
    }

    const id = validArtifactId(this.#id());
    const storageKey = validStorageKey(`objects/${this.#storageId()}`);
    const finalPath = await this.#resolveStorageKey(storageKey, true);
    await link(capturePath, finalPath);
    await unlink(capturePath);
    await chmod(finalPath, 0o600);

    const registration: SessionArtifactRegistration = {
      version: SESSION_ARTIFACT_VERSION,
      id,
      sessionId: input.sessionId,
      profileId: input.profileId,
      storageKey,
      kind: input.kind,
      bytes: input.bytes,
      mimeType: input.mimeType,
      sha256: input.sha256,
      createdAt: this.#now().toISOString(),
      source,
      ...(reviewedApiDescription(inspection.apiDescription) === undefined ? {} : { apiDescription: reviewedApiDescription(inspection.apiDescription) })
    };

    // The file is authoritative first. If persistence fails it remains an inert,
    // unreferenced orphan rather than creating an event that points at no file.
    await input.persist(structuredClone(registration));
    const artifact = artifactFromRegistration(registration, finalPath, input.summary);
    this.#artifacts.set(id, { artifact, owners: [{ sessionId: input.sessionId, profileId: input.profileId }] });
    return cloneArtifact(artifact);
  }

  async hydrateSessionArtifacts(input: {
    events: readonly unknown[];
    sessionId: string;
    profileId: string;
  }): Promise<ArtifactRecord[]> {
    if (this.#storageRoot === undefined || !validScope(input)) return [];
    const hydrated: ArtifactRecord[] = [];
    for (const event of input.events) {
      if (!isRecord(event) || event.kind !== "session-artifact-registered") continue;
      const registration = parseRegistration(event.artifact);
      if (
        registration === undefined ||
        registration.sessionId !== input.sessionId ||
        registration.profileId !== input.profileId
      ) continue;
      let localPath: string;
      try {
        localPath = await this.#resolveStorageKey(registration.storageKey, false);
        const file = await lstat(localPath);
        if (!file.isFile() || file.isSymbolicLink() || file.size !== registration.bytes) continue;
        const content = await readFile(localPath);
        const inspection = inspectBrowserDownload(registration.source.filename, content);
        if (
          inspection.allowed === false ||
          inspection.kind !== registration.kind ||
          inspection.mimeType !== registration.mimeType ||
          createHash("sha256").update(content).digest("hex") !== registration.sha256
        ) continue;
        // Recompute from hash-verified bytes, including registrations from older versions.
        registration.apiDescription = reviewedApiDescription(inspection.apiDescription);
      } catch {
        continue;
      }
      const artifact = artifactFromRegistration(registration, localPath);
      const existing = this.#artifacts.get(registration.id);
      if (existing !== undefined && !sameStoredArtifact(existing.artifact, artifact)) continue;
      const owner = { sessionId: registration.sessionId, profileId: registration.profileId };
      this.#artifacts.set(registration.id, existing === undefined
        ? { artifact, owners: [owner] }
        : { artifact: existing.artifact, owners: appendOwner(existing.owners, owner) });
      hydrated.push(cloneArtifact(artifact));
    }
    return hydrated;
  }

  list(scope?: SessionArtifactScope): ArtifactRecord[] {
    return [...this.#artifacts.values()]
      .filter((stored) => ownedByScope(stored.owners, scope))
      .map(({ artifact }) => cloneArtifact(artifact))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  get(reference: string, scope?: SessionArtifactScope): ArtifactRecord | undefined {
    const id = reference.startsWith("artifact://") ? reference.slice("artifact://".length) : reference;
    if (id.length === 0 || id.includes("/") || id.includes("\\")) return undefined;
    const stored = this.#artifacts.get(id);
    if (stored === undefined || !ownedByScope(stored.owners, scope)) return undefined;
    return cloneArtifact(stored.artifact);
  }

  async #resolveStorageKey(storageKey: string, createRoot: boolean): Promise<string> {
    if (this.#storageRoot === undefined) throw new Error("Durable artifact storage is unavailable.");
    validStorageKey(storageKey);
    const configuredObjectsRoot = resolve(this.#storageRoot, "objects");
    if (createRoot) {
      await mkdir(configuredObjectsRoot, { recursive: true, mode: 0o700 });
    }
    const resolvedRoot = await realpath(this.#storageRoot);
    const resolvedObjectsRoot = await realpath(configuredObjectsRoot);
    if (resolvedObjectsRoot !== resolve(resolvedRoot, "objects")) {
      throw new Error("Artifact object storage escaped its root.");
    }
    const path = resolve(resolvedObjectsRoot, storageKey.slice("objects/".length));
    if (!path.startsWith(`${resolvedObjectsRoot}${sep}`)) throw new Error("Artifact storage key escaped its root.");
    return path;
  }
}

function artifactFromRegistration(
  registration: SessionArtifactRegistration,
  localPath: string,
  summary = registration.source.description
): ArtifactRecord {
  return {
    id: registration.id,
    path: `artifact://${registration.id}`,
    localPath,
    kind: registration.kind,
    bytes: registration.bytes,
    createdAt: registration.createdAt,
    summary,
    mimeType: registration.mimeType,
    metadata: {
      filename: registration.source.filename,
      sha256: registration.sha256,
      sourceOrigin: registration.source.origin,
      source: registration.source.kind,
      ...(registration.apiDescription === undefined ? {} : { apiDescription: registration.apiDescription }),
      outcome: "download-completed"
    }
  };
}

function parseRegistration(value: unknown): SessionArtifactRegistration | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "version", "id", "sessionId", "profileId", "storageKey", "kind", "bytes", "mimeType", "sha256", "createdAt", "source", "apiDescription"
  ].includes(key))) return undefined;
  if (
    value.version !== SESSION_ARTIFACT_VERSION ||
    typeof value.id !== "string" || !SAFE_TOKEN.test(value.id) || value.id.length > 200 ||
    typeof value.sessionId !== "string" || !SAFE_TOKEN.test(value.sessionId) ||
    typeof value.profileId !== "string" || !SAFE_TOKEN.test(value.profileId) ||
    typeof value.storageKey !== "string" || !SAFE_STORAGE_KEY.test(value.storageKey) ||
    !isArtifactKind(value.kind) || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0 ||
    typeof value.mimeType !== "string" || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u.test(value.mimeType) ||
    typeof value.sha256 !== "string" || !SHA256.test(value.sha256) ||
    typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
  ) return undefined;
  let source: SessionArtifactSource;
  try {
    source = validateSource(value.source);
  } catch {
    return undefined;
  }
  return {
    version: SESSION_ARTIFACT_VERSION,
    id: value.id,
    sessionId: value.sessionId,
    profileId: value.profileId,
    storageKey: value.storageKey,
    kind: value.kind,
    bytes: value.bytes as number,
    mimeType: value.mimeType,
    sha256: value.sha256,
    createdAt: value.createdAt,
    source,
    ...(reviewedApiDescription(value.apiDescription) === undefined ? {} : { apiDescription: reviewedApiDescription(value.apiDescription) })
  };
}

function validateSource(value: unknown): SessionArtifactSource {
  if (!isRecord(value) || Object.keys(value).some((key) => !["kind", "description", "filename", "origin"].includes(key)) ||
    value.kind !== "browser.download" ||
    typeof value.description !== "string" || value.description.length === 0 || value.description.length > 320 ||
    redactSensitiveText(value.description) !== value.description ||
    typeof value.filename !== "string" || value.filename.length === 0 || value.filename.length > 160 ||
    /[\\/\u0000-\u001f\u007f]/u.test(value.filename) || redactSensitiveText(value.filename) !== value.filename ||
    typeof value.origin !== "string" || value.origin.length > 512) {
    throw new Error("Artifact source metadata is invalid.");
  }
  const origin = new URL(value.origin);
  if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.origin !== value.origin || origin.username || origin.password) {
    throw new Error("Artifact source origin is invalid.");
  }
  return {
    kind: "browser.download",
    description: value.description,
    filename: value.filename,
    origin: value.origin
  };
}

function ownedByScope(owners: SessionArtifactScope[] | undefined, scope: SessionArtifactScope | undefined): boolean {
  if (owners === undefined) return true;
  return scope !== undefined && owners.some((owner) => owner.sessionId === scope.sessionId && owner.profileId === scope.profileId);
}

function appendOwner(owners: SessionArtifactScope[] | undefined, owner: SessionArtifactScope): SessionArtifactScope[] {
  if (owners === undefined || owners.some((candidate) => candidate.sessionId === owner.sessionId && candidate.profileId === owner.profileId)) {
    return owners ?? [owner];
  }
  return [...owners, owner];
}

function sameStoredArtifact(left: ArtifactRecord, right: ArtifactRecord): boolean {
  return left.id === right.id && left.localPath === right.localPath && left.kind === right.kind &&
    left.bytes === right.bytes && left.mimeType === right.mimeType && left.createdAt === right.createdAt &&
    left.metadata?.sha256 === right.metadata?.sha256;
}

function validScope(value: SessionArtifactScope): boolean {
  return SAFE_TOKEN.test(value.sessionId) && SAFE_TOKEN.test(value.profileId);
}

function validArtifactId(value: string): string {
  if (!SAFE_TOKEN.test(value) || value.length > 200) throw new Error("Artifact ID is invalid.");
  return value;
}

function validStorageKey(value: string): string {
  if (!SAFE_STORAGE_KEY.test(value)) throw new Error("Artifact storage key is invalid.");
  return value;
}

function cloneArtifact(artifact: ArtifactRecord): ArtifactRecord {
  return {
    ...artifact,
    ...(artifact.metadata === undefined ? {} : { metadata: structuredClone(artifact.metadata) })
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
