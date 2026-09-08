export type ArtifactKind =
  | "video"
  | "image"
  | "audio"
  | "document"
  | "data"
  | "other";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "video",
  "image",
  "audio",
  "document",
  "data",
  "other"
];

export type ArtifactRecord = {
  id: string;
  /** Prompt-safe reference or display path. Use localPath for filesystem access. */
  path: string;
  localPath?: string;
  kind: ArtifactKind;
  bytes: number;
  createdAt: string;
  summary?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
};

export const SESSION_ARTIFACT_VERSION = 1 as const;

export type SessionArtifactSource = {
  kind: "browser.download";
  description: string;
  filename: string;
  origin: string;
};

/** Prompt-safe durable metadata. The filesystem location is resolved only by ArtifactStore. */
export type SessionArtifactRegistration = {
  version: typeof SESSION_ARTIFACT_VERSION;
  id: string;
  sessionId: string;
  profileId: string;
  storageKey: string;
  kind: ArtifactKind;
  bytes: number;
  mimeType: string;
  sha256: string;
  createdAt: string;
  source: SessionArtifactSource;
  apiDescription?: ApiDescriptionMetadata;
};

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && ARTIFACT_KINDS.includes(value as ArtifactKind);
}

/** Bounded format metadata derived from inspected artifact bytes, never instructions. */
export type ApiDescriptionMetadata = { format: string; version?: string };

export function reviewedApiDescription(value: unknown): ApiDescriptionMetadata | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.format !== "string" || ![
    "Swagger", "OpenAPI", "AsyncAPI", "RAML", "GraphQL", "GraphQL introspection", "Protocol Buffers", "Smithy"
  ].includes(record.format)) return undefined;
  if (record.version !== undefined && (typeof record.version !== "string" ||
    !/^\d{1,3}(?:\.\d{1,3}){0,2}$/u.test(record.version))) return undefined;
  return { format: record.format, ...(record.version === undefined ? {} : { version: record.version as string }) };
}
