export type VisionImageMimeType =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export type VisionImageSourceErrorCode =
  | "invalid-limit"
  | "invalid-path"
  | "source-corrupt"
  | "source-not-found"
  | "source-not-regular-file"
  | "source-outside-allowed-roots"
  | "source-too-large"
  | "source-unreadable"
  | "source-unsupported-format";

export type VisionImageSourceError = {
  ok: false;
  code: VisionImageSourceErrorCode;
  message: string;
  details?: {
    bytes?: number;
    limitBytes?: number;
  };
};

export type ResolvedVisionImageSource = {
  ok: true;
  displayPath: string;
  bytes: Uint8Array;
  byteLength: number;
  mimeType: VisionImageMimeType;
};

export type VisionImageSourceResolution =
  | ResolvedVisionImageSource
  | VisionImageSourceError;
