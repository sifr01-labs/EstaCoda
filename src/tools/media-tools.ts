import { spawn } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { ArtifactKind } from "../contracts/artifact.js";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import { explainPathBlock } from "../context/context-security.js";

export type MediaToolOptions = {
  workspaceRoot: string;
  artifactStore: ArtifactStore;
  allowedRoots?: string[];
  commandTimeoutMs?: number;
};

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

type ResolvedPath =
  | { ok: true; content: ""; path: string }
  | { ok: false; content: string; metadata?: Record<string, unknown> };

export function createMediaTools(options: MediaToolOptions): readonly RegisteredTool[] {
  const root = resolve(options.workspaceRoot);
  const allowedRoots = dedupeRoots([root, ...(options.allowedRoots ?? [])]);
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  return [
    {
      name: "media.probe-ffmpeg",
      description: "Check whether ffmpeg and ffprobe are available for media workflows.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      riskClass: "read-only-local",
      toolsets: ["media", "core"],
      progressLabel: "checking media tools",
      maxResultSizeChars: 2000,
      isAvailable: () => true,
      run: async () => {
        const [ffmpeg, ffprobe] = await Promise.all([
          probeCommand("ffmpeg", ["-version"], commandTimeoutMs),
          probeCommand("ffprobe", ["-version"], commandTimeoutMs)
        ]);

        return {
          ok: ffmpeg.available || ffprobe.available,
          content: [
            `ffmpeg: ${ffmpeg.available ? "available" : "missing"}`,
            ffmpeg.version === undefined ? undefined : `ffmpeg version: ${ffmpeg.version}`,
            `ffprobe: ${ffprobe.available ? "available" : "missing"}`,
            ffprobe.version === undefined ? undefined : `ffprobe version: ${ffprobe.version}`
          ].filter((line) => line !== undefined).join("\n"),
          metadata: {
            ffmpeg,
            ffprobe
          }
        };
      }
    },
    {
      name: "media.inspect",
      description: "Inspect a workspace media artifact and return file metadata plus optional ffprobe output.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" }
        },
        required: ["path"]
      },
      riskClass: "read-only-local",
      toolsets: ["media", "files", "research"],
      progressLabel: "inspecting media",
      maxResultSizeChars: 8000,
      isAvailable: () => true,
      run: async (input: { path?: string }) => {
        const path = await resolveAllowedPath(allowedRoots, input.path);
        if (!path.ok) {
          return path;
        }

        const fileStat = await stat(path.path);
        const displayRoot = path.root ?? root;
        const relPath = relative(displayRoot, path.path);
        const ffprobe = await runCommand("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,avg_frame_rate",
          "-of",
          "json",
          path.path
        ], commandTimeoutMs);

        return {
          ok: true,
          content: [
            `Media: ${relPath}`,
            `Kind: ${inferArtifactKind(path.path)}`,
            `Size: ${fileStat.size} bytes`,
            `MIME: ${inferMimeType(path.path)}`,
            ffprobe.ok ? `ffprobe:\n${ffprobe.content}` : `ffprobe unavailable: ${ffprobe.content}`
          ].join("\n"),
          metadata: {
            path: relPath,
            bytes: fileStat.size,
            kind: inferArtifactKind(path.path),
            mimeType: inferMimeType(path.path),
            ffprobe: ffprobe.ok ? tryJson(ffprobe.content) : undefined,
            ffprobeError: ffprobe.ok ? undefined : ffprobe.content
          }
        };
      }
    },
    {
      name: "media.extract-frame",
      description: "Extract a preview frame from a workspace video file into the artifact directory.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          atSeconds: { type: "number" },
          outputPath: { type: "string" }
        },
        required: ["path"]
      },
      riskClass: "workspace-write",
      toolsets: ["media", "files"],
      progressLabel: "extracting preview frame",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: { path?: string; atSeconds?: number; outputPath?: string }) => {
        const canonicalRoot = await realpath(root);
        const source = await resolveAllowedPath(allowedRoots, input.path);
        if (!source.ok) {
          return source;
        }

        const output = await resolveAllowedPath([canonicalRoot], input.outputPath ?? defaultFramePath(source.path), {
          allowMissingLeaf: true
        });
        if (!output.ok) {
          return output;
        }

        await mkdir(dirname(output.path), { recursive: true });
        const result = await runCommand("ffmpeg", [
          "-y",
          "-ss",
          String(Math.max(0, input.atSeconds ?? 1)),
          "-i",
          source.path,
          "-frames:v",
          "1",
          output.path
        ], commandTimeoutMs);
        if (!result.ok) {
          return result;
        }

        const fileStat = await stat(output.path);
        const relPath = relative(canonicalRoot, output.path);
        const artifact = options.artifactStore.record({
          path: relPath,
          kind: "image",
          bytes: fileStat.size,
          mimeType: inferMimeType(output.path),
          summary: `Preview frame extracted from ${relative(canonicalRoot, source.path)}.`,
          metadata: {
            source: relative(canonicalRoot, source.path),
            atSeconds: input.atSeconds ?? 1
          }
        });

        return {
          ok: true,
          content: `Extracted preview frame: ${relPath} (${fileStat.size} bytes).\nArtifact: ${artifact.id}`,
          metadata: artifact
        };
      }
    },
    {
      name: "artifact.record",
      description: "Record an existing workspace file as a generated artifact for final responses and channels.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          kind: { type: "string" },
          summary: { type: "string" }
        },
        required: ["path"]
      },
      riskClass: "shared-state-mutation",
      toolsets: ["media", "files", "research"],
      progressLabel: "recording artifact",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: { path?: string; kind?: ArtifactKind; summary?: string }) => {
        const canonicalRoot = await realpath(root);
        const path = await resolveAllowedPath([canonicalRoot], input.path);
        if (!path.ok) {
          return path;
        }

        const fileStat = await stat(path.path);
        const artifact = options.artifactStore.record({
          path: relative(canonicalRoot, path.path),
          kind: normalizeArtifactKind(input.kind) ?? inferArtifactKind(path.path),
          bytes: fileStat.size,
          mimeType: inferMimeType(path.path),
          summary: input.summary
        });

        return {
          ok: true,
          content: [
            `Artifact recorded: ${artifact.path}`,
            `Kind: ${artifact.kind}`,
            `Size: ${artifact.bytes} bytes`,
            `ID: ${artifact.id}`
          ].join("\n"),
          metadata: artifact
        };
      }
    }
  ];
}

async function resolveAllowedPath(
  roots: string[],
  path: string | undefined,
  options: { allowMissingLeaf?: boolean } = {}
): Promise<ResolvedPath & { root?: string }> {
  if (typeof path !== "string" || path.length === 0) {
    return errorResult("path must be a non-empty string");
  }

  let lastError = "path is outside the trusted workspace";

  for (const root of roots) {
    const candidate = resolve(root, path);
    let canonicalRoot = root;
    let canonical = candidate;

    try {
      canonicalRoot = await realpath(root);
    } catch {
      canonicalRoot = root;
    }

    try {
      canonical = await realpath(candidate);
    } catch (error) {
      if (options.allowMissingLeaf !== true) {
        lastError = error instanceof Error ? error.message : "path does not exist";
        continue;
      }

      const parent = await realpath(dirname(candidate));
      canonical = join(parent, basename(candidate));
    }

    const blockedReason = explainPathBlock(canonicalRoot, canonical);
    if (blockedReason === undefined) {
      return {
        ok: true,
        content: "",
        path: canonical,
        root: canonicalRoot
      };
    }

    lastError = blockedReason;
  }

  return errorResult(lastError);
}

function dedupeRoots(roots: string[]): string[] {
  return [...new Set(
    roots
      .filter((root) => root.length > 0)
      .map((root) => resolve(root))
  )];
}

async function probeCommand(command: string, args: string[], timeoutMs: number): Promise<{
  available: boolean;
  version?: string;
}> {
  const result = await runCommand(command, args, timeoutMs);
  const firstLine = result.content.split("\n")[0];

  return {
    available: result.ok,
    version: result.ok ? firstLine : undefined
  };
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<ToolResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errorChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolveResult({
        ok: false,
        content: error.message
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(chunks).toString("utf8").trimEnd();
      const stderr = Buffer.concat(errorChunks).toString("utf8").trimEnd();
      const content = [stdout, stderr.length === 0 ? undefined : stderr]
        .filter((line) => line !== undefined && line.length > 0)
        .join("\n");

      resolveResult({
        ok: code === 0 && signal === null,
        content: content.length === 0 ? "(no output)" : content.slice(0, 16_000),
        metadata: {
          command,
          args,
          code,
          signal,
          timeoutMs
        }
      });
    });
  });
}

function defaultFramePath(sourcePath: string): string {
  const base = basename(sourcePath, extname(sourcePath));
  return `.estacoda/artifacts/${base}-preview.png`;
}

function inferArtifactKind(path: string): ArtifactKind {
  const ext = extname(path).toLowerCase();
  if ([".mp4", ".mov", ".webm", ".mkv", ".avi"].includes(ext)) return "video";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".m4a", ".flac", ".ogg"].includes(ext)) return "audio";
  if ([".pdf", ".md", ".txt", ".html"].includes(ext)) return "document";
  if ([".json", ".csv", ".parquet"].includes(ext)) return "data";
  return "other";
}

export function inferMimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".md": "text/markdown",
    ".txt": "text/plain"
  };

  return mimeTypes[ext] ?? "application/octet-stream";
}

function normalizeArtifactKind(kind: ArtifactKind | undefined): ArtifactKind | undefined {
  if (kind === undefined) {
    return undefined;
  }

  return ["video", "image", "audio", "document", "data", "other"].includes(kind) ? kind : undefined;
}

function tryJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function errorResult(content: string): ResolvedPath {
  return {
    ok: false,
    content
  };
}
