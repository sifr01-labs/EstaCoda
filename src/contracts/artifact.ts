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
};

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && ARTIFACT_KINDS.includes(value as ArtifactKind);
}
