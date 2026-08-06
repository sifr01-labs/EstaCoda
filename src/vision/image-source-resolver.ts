import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  VisionImageMimeType,
  VisionImageSourceError,
  VisionImageSourceErrorCode,
  VisionImageSourceResolution
} from "../contracts/vision.js";

export type ResolveVisionImageSourceOptions = {
  workspaceRoot: string;
  allowedRoots?: readonly string[];
  path?: string;
  maxBytes: number;
};

type AllowedRoot = {
  canonicalPath: string;
};

type MimeDetection =
  | { kind: "supported"; mimeType: VisionImageMimeType }
  | { kind: "corrupt" }
  | { kind: "unsupported" };

const READ_CHUNK_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function resolveVisionImageSource(
  options: ResolveVisionImageSourceOptions
): Promise<VisionImageSourceResolution> {
  if (typeof options.path !== "string" || options.path.trim().length === 0) {
    return sourceError("invalid-path", "path must be a non-empty string");
  }

  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    return sourceError("invalid-limit", "The configured vision image size limit is invalid.");
  }

  const configuredRoots = dedupePaths([options.workspaceRoot, ...(options.allowedRoots ?? [])]);
  const allowedRoots = await resolveAllowedRoots(configuredRoots);
  const candidates = sourceCandidates(configuredRoots, options.path);
  const missingCandidateInsideRoot = candidates.some((candidate) =>
    configuredRoots.some((root) => isContainedPath(root, candidate)) ||
      allowedRoots.some((root) => isContainedPath(root.canonicalPath, candidate))
  );
  let sawUnreadableCandidate = false;
  let sawExistingOutsideCandidate = false;

  for (const candidate of candidates) {
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(candidate);
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      sawUnreadableCandidate = true;
      continue;
    }

    const containingRoot = allowedRoots.find((root) =>
      isContainedPath(root.canonicalPath, canonicalPath)
    );
    if (containingRoot === undefined) {
      sawExistingOutsideCandidate = true;
      continue;
    }

    const source = await readBoundedRegularFile(canonicalPath, options.maxBytes);
    if (!source.ok) {
      return source;
    }

    const detection = detectImageMimeType(source.bytes);
    if (detection.kind === "corrupt") {
      return sourceError(
        "source-corrupt",
        "This image appears to be corrupt or incomplete."
      );
    }
    if (detection.kind === "unsupported") {
      return sourceError(
        "source-unsupported-format",
        "This file does not look like a supported image for vision analysis."
      );
    }

    return {
      ok: true,
      displayPath: displayPath(containingRoot.canonicalPath, canonicalPath),
      bytes: source.bytes,
      byteLength: source.bytes.byteLength,
      mimeType: detection.mimeType
    };
  }

  if (sawExistingOutsideCandidate || (!missingCandidateInsideRoot && !sawUnreadableCandidate)) {
    return sourceError(
      "source-outside-allowed-roots",
      "path is outside the trusted workspace and channel-media roots"
    );
  }
  if (sawUnreadableCandidate) {
    return sourceError("source-unreadable", "The image source could not be read safely.");
  }
  return sourceError(
    "source-not-found",
    "The image source was not found in the trusted workspace or channel-media roots."
  );
}

async function resolveAllowedRoots(configuredRoots: readonly string[]): Promise<AllowedRoot[]> {
  const roots: AllowedRoot[] = [];
  const seen = new Set<string>();

  for (const configuredPath of configuredRoots) {
    try {
      const canonicalPath = await realpath(configuredPath);
      const rootStat = await stat(canonicalPath);
      if (!rootStat.isDirectory() || seen.has(canonicalPath)) {
        continue;
      }
      seen.add(canonicalPath);
      roots.push({ canonicalPath });
    } catch {
      // A missing optional media root is not an allowed fallback path.
    }
  }

  return roots;
}

function sourceCandidates(roots: readonly string[], sourcePath: string): string[] {
  if (isAbsolute(sourcePath)) {
    return [resolve(sourcePath)];
  }
  return dedupePaths(roots.map((root) => resolve(root, sourcePath)));
}

async function readBoundedRegularFile(
  canonicalPath: string,
  maxBytes: number
): Promise<{ ok: true; bytes: Buffer } | VisionImageSourceError> {
  let handle;
  try {
    handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return sourceError("source-unreadable", "The image source could not be read safely.");
  }

  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      return sourceError(
        "source-not-regular-file",
        "The image source must be a regular file."
      );
    }
    if (fileStat.size > maxBytes) {
      return tooLargeError(fileStat.size, maxBytes);
    }

    const chunks: Buffer[] = [];
    let byteLength = 0;
    while (byteLength <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes - byteLength + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      byteLength += bytesRead;
      if (byteLength > maxBytes) {
        return tooLargeError(byteLength, maxBytes);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }

    return { ok: true, bytes: Buffer.concat(chunks, byteLength) };
  } catch {
    return sourceError("source-unreadable", "The image source could not be read safely.");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function detectImageMimeType(bytes: Buffer): MimeDetection {
  if (hasPngPrefix(bytes)) {
    return hasValidPngHeader(bytes)
      ? { kind: "supported", mimeType: "image/png" }
      : { kind: "corrupt" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return hasValidJpegHeader(bytes)
      ? { kind: "supported", mimeType: "image/jpeg" }
      : { kind: "corrupt" };
  }
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") {
    return hasValidGifHeader(bytes)
      ? { kind: "supported", mimeType: "image/gif" }
      : { kind: "corrupt" };
  }
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return hasValidWebpHeader(bytes)
      ? { kind: "supported", mimeType: "image/webp" }
      : { kind: "corrupt" };
  }
  return { kind: "unsupported" };
}

function hasPngPrefix(bytes: Buffer): boolean {
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return true;
  }
  return bytes.length >= 4 && bytes.subarray(0, 4).equals(PNG_SIGNATURE.subarray(0, 4));
}

function hasValidPngHeader(bytes: Buffer): boolean {
  return bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(PNG_SIGNATURE) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.subarray(12, 16).toString("ascii") === "IHDR" &&
    bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(20) > 0;
}

function hasValidJpegHeader(bytes: Buffer): boolean {
  return bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[3] !== 0x00 &&
    bytes[3] !== 0xff;
}

function hasValidGifHeader(bytes: Buffer): boolean {
  const signature = bytes.subarray(0, 6).toString("ascii");
  return (
    (signature === "GIF87a" || signature === "GIF89a") &&
    bytes.length >= 13 &&
    bytes.readUInt16LE(6) > 0 &&
    bytes.readUInt16LE(8) > 0
  );
}

function hasValidWebpHeader(bytes: Buffer): boolean {
  if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 < 20) {
    return false;
  }
  const chunkType = bytes.subarray(12, 16).toString("ascii");
  if (chunkType !== "VP8 " && chunkType !== "VP8L" && chunkType !== "VP8X") {
    return false;
  }
  const chunkLength = bytes.readUInt32LE(16);
  return 20 + chunkLength + (chunkLength % 2) <= bytes.length;
}

function displayPath(root: string, sourcePath: string): string {
  const path = relative(root, sourcePath);
  return path.length > 0 ? path : ".";
}

function isContainedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function dedupePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function tooLargeError(bytes: number, limitBytes: number): VisionImageSourceError {
  return sourceError(
    "source-too-large",
    `This image is too large for the current vision workflow. The limit is ${formatBytes(limitBytes)}.`,
    { bytes, limitBytes }
  );
}

function sourceError(
  code: VisionImageSourceErrorCode,
  message: string,
  details?: VisionImageSourceError["details"]
): VisionImageSourceError {
  return {
    ok: false,
    code,
    message,
    ...(details === undefined ? {} : { details })
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}
