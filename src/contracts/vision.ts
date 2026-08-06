export type VisionImageMimeType =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export type VisionDispatchPhase = "initial-attachment" | "post-tool";

export type VisionAnalysisMode =
  | "describe"
  | "ocr"
  | "document"
  | "chart"
  | "screenshot";

export type VisionAnalysisDetail = "low" | "standard" | "high";

export type VisionAnalysisOutput = "concise" | "standard" | "detailed";

/** Backward-compatible input for vision.analyze. New controls are optional. */
export type VisionAnalysisInput = {
  path?: string;
  prompt?: string;
  mode?: VisionAnalysisMode;
  detail?: VisionAnalysisDetail;
  output?: VisionAnalysisOutput;
};

export type VisionAnalysisErrorCode =
  | VisionImageSourceErrorCode
  | VisionImageNormalizationErrorCode
  | "vision-invalid-analysis-option"
  | "vision-route-unavailable"
  | "vision-executor-unavailable"
  | "vision-empty-response"
  | "vision-spend-denied"
  | "vision-timeout"
  | "vision-cancelled"
  | "vision-provider-failed";

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
  /** Canonical runtime-only identity. Never render or persist this path. */
  canonicalPath: string;
  displayPath: string;
  bytes: Uint8Array;
  byteLength: number;
  mimeType: VisionImageMimeType;
};

/** Current-turn sources derived by the runtime, never accepted from model tool input. */
export type VisionInputProvenanceContext = {
  attachmentPaths: readonly string[];
  explicitReferencePaths: readonly string[];
  browserArtifactPaths?: readonly string[];
  generatedArtifactPaths?: readonly string[];
};

export type VisionImageSourceResolution =
  | ResolvedVisionImageSource
  | VisionImageSourceError;

export type VisionImageNormalizationLimits = {
  maxInputBytes: number;
  maxInputDimension: number;
  maxInputPixels: number;
  maxDecodedBytes: number;
  maxAnimationFrames: number;
  maxOutputDimension: number;
  maxOutputBytes: number;
  maxConcurrency: number;
};

export type VisionImageNormalizationErrorCode =
  | "normalization-animation-limit"
  | "normalization-cancelled"
  | "normalization-decoded-memory-limit"
  | "normalization-dimension-limit"
  | "normalization-input-byte-limit"
  | "normalization-invalid-image"
  | "normalization-output-byte-limit"
  | "normalization-pixel-limit"
  | "normalization-unavailable";

export type VisionImageNormalizationError = {
  ok: false;
  code: VisionImageNormalizationErrorCode;
  message: string;
  details?: {
    actual?: number;
    limit?: number;
    unit?: "bytes" | "frames" | "pixels";
  };
};

export type NormalizedVisionImage = {
  ok: true;
  bytes: Uint8Array;
  byteLength: number;
  mimeType: Exclude<VisionImageMimeType, "image/gif">;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  sourceFrames: number;
  resized: boolean;
  orientationApplied: boolean;
  metadataStripped: true;
};

export type VisionImageNormalizationResult =
  | NormalizedVisionImage
  | VisionImageNormalizationError;
