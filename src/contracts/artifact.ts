export type ArtifactKind =
  | "video"
  | "image"
  | "audio"
  | "document"
  | "data"
  | "other";

export type ArtifactRecord = {
  id: string;
  path: string;
  kind: ArtifactKind;
  bytes: number;
  createdAt: string;
  summary?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
};
