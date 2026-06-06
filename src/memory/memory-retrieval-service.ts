import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "../config/memory-config.js";
import { resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import type {
  MemoryAuthority,
  MemoryFileKind,
  MemoryIndexedSourceType,
  MemoryLineRange,
  MemoryProtectedClass,
  MemoryRetrievalDiagnostic,
  MemoryRetrievalMode,
  MemoryRetrievalResult
} from "../contracts/memory.js";
import { redactSensitiveText } from "../utils/redaction.js";
import type { MemoryIndex } from "./memory-index.js";
import { listSharedMemory } from "./shared-memory.js";

const MEMORY_RETRIEVAL_MAX_RESULTS = 50;
const MEMORY_RETRIEVAL_MAX_CHARS = 20_000;
const MEMORY_RETRIEVAL_EXCERPT_CHARS = 600;

type ProfileMemoryFileKind = Extract<MemoryFileKind, "USER.md" | "MEMORY.md" | "SOUL.md">;

const PROFILE_MEMORY_FILE_KINDS: readonly ProfileMemoryFileKind[] = [
  "USER.md",
  "MEMORY.md",
  "SOUL.md"
];

export type MemoryRetrievalSourceInput = {
  sourceType: MemoryIndexedSourceType;
  sourceId: string;
};

export type MemoryRetrievalReadInput = MemoryRetrievalSourceInput & {
  profileId: string;
  includeProtected?: boolean;
  maxChars?: number;
};

export type MemoryRetrievalSearchInput = {
  profileId: string;
  query: string;
  includeProtected?: boolean;
  maxResults?: number;
  maxChars?: number;
};

export type LocalMemoryRetrievalResult = MemoryRetrievalResult & {
  contextLabel: "local-memory-context";
  instructionBoundary: "context-not-instruction";
  trusted: false;
};

export type LocalMemoryRetrievalDiagnostics = {
  mode: MemoryRetrievalMode;
  profileId: string;
  indexEnabled: boolean;
  indexAvailable: boolean;
  fallbackUsed: boolean;
  includeProtected: boolean;
  resultCount: number;
  truncated: boolean;
  redactionApplied: boolean;
  diagnostics: MemoryRetrievalDiagnostic[];
};

export type LocalMemoryReadResult = {
  result: LocalMemoryRetrievalResult | null;
  diagnostics: LocalMemoryRetrievalDiagnostics;
};

export type LocalMemorySearchResult = {
  results: LocalMemoryRetrievalResult[];
  diagnostics: LocalMemoryRetrievalDiagnostics;
};

export type MemoryRetrievalServiceOptions = {
  index?: MemoryIndex;
  config?: MemoryConfig;
  homeDir?: string;
};

type FallbackSource = {
  profileId: string;
  sourceType: MemoryIndexedSourceType;
  sourceId: string;
  sourcePath?: string;
  sourceKey?: string;
  memoryFileKind?: MemoryFileKind;
  authority: MemoryAuthority;
  protectedClass: MemoryProtectedClass;
  content: string;
  updatedAt: string;
  lineRanges?: MemoryLineRange[];
};

export class LocalMemoryRetrievalService {
  readonly #index: MemoryIndex | undefined;
  readonly #config: MemoryConfig;
  readonly #homeDir: string | undefined;

  constructor(options: MemoryRetrievalServiceOptions = {}) {
    this.#index = options.index;
    this.#config = options.config ?? DEFAULT_MEMORY_CONFIG;
    this.#homeDir = options.homeDir;
  }

  async read(input: MemoryRetrievalReadInput): Promise<LocalMemoryReadResult> {
    const includeProtected = input.includeProtected === true;
    const maxChars = clampInteger(input.maxChars, this.#config.retrieval.maxChars, 1, MEMORY_RETRIEVAL_MAX_CHARS);
    const indexState = this.#indexState(input.profileId);
    const diagnostics: MemoryRetrievalDiagnostic[] = [];

    if (isProtectedSource(input) && !includeProtected) {
      diagnostics.push({
        code: "memory-protected-filtered",
        message: "Protected local memory source was denied. Set includeProtected to read it.",
        sourceType: input.sourceType,
        source: input.sourceId,
        memoryFileKind: input.sourceId === "SOUL.md" ? "SOUL.md" : undefined,
        protectedClass: "identity"
      });
      return {
        result: null,
        diagnostics: this.#diagnostics({
          profileId: input.profileId,
          includeProtected,
          indexState,
          fallbackUsed: false,
          resultCount: 0,
          truncated: false,
          redactionApplied: false,
          diagnostics
        })
      };
    }

    if (indexState.enabled && indexState.available && this.#index !== undefined) {
      const indexed = this.#index.readSource({
        profileId: input.profileId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        includeProtected,
        maxChars: MEMORY_RETRIEVAL_MAX_CHARS
      });
      if (indexed !== null) {
        const redacted = redactResult(indexed, maxChars);
        diagnostics.push(...redacted.diagnostics);
        return {
          result: redacted.result,
          diagnostics: this.#diagnostics({
            profileId: input.profileId,
            includeProtected,
            indexState,
            fallbackUsed: false,
            resultCount: 1,
            truncated: redacted.truncated,
            redactionApplied: redacted.redactionApplied,
            diagnostics
          })
        };
      }
      diagnostics.push({
        code: "memory-index-unavailable",
        message: "Requested local memory source was not found in the lexical index.",
        sourceType: input.sourceType,
        source: input.sourceId
      });
      return {
        result: null,
        diagnostics: this.#diagnostics({
          profileId: input.profileId,
          includeProtected,
          indexState,
          fallbackUsed: false,
          resultCount: 0,
          truncated: false,
          redactionApplied: false,
          diagnostics
        })
      };
    }

    diagnostics.push(...fallbackDiagnostics(indexState));
    const source = await this.#readFallbackSource(input);
    if (source === null) {
      diagnostics.push({
        code: "memory-index-unavailable",
        message: "Requested local memory source was not found by fallback read.",
        sourceType: input.sourceType,
        source: input.sourceId
      });
      return {
        result: null,
        diagnostics: this.#diagnostics({
          profileId: input.profileId,
          includeProtected,
          indexState,
          fallbackUsed: true,
          resultCount: 0,
          truncated: false,
          redactionApplied: false,
          diagnostics
        })
      };
    }

    const converted = fallbackSourceToResult(source, maxChars, 1);
    diagnostics.push(...converted.diagnostics);
    return {
      result: converted.result,
      diagnostics: this.#diagnostics({
        profileId: input.profileId,
        includeProtected,
        indexState,
        fallbackUsed: true,
        resultCount: 1,
        truncated: converted.truncated,
        redactionApplied: converted.redactionApplied,
        diagnostics
      })
    };
  }

  async search(input: MemoryRetrievalSearchInput): Promise<LocalMemorySearchResult> {
    const includeProtected = input.includeProtected === true;
    const maxResults = clampInteger(input.maxResults, this.#config.retrieval.maxResults, 1, MEMORY_RETRIEVAL_MAX_RESULTS);
    const maxChars = clampInteger(input.maxChars, this.#config.retrieval.maxChars, 1, MEMORY_RETRIEVAL_MAX_CHARS);
    const indexState = this.#indexState(input.profileId);
    const diagnostics: MemoryRetrievalDiagnostic[] = [];

    if (indexState.enabled && indexState.available && this.#index !== undefined) {
      const indexed = this.#index.searchLexical({
        profileId: input.profileId,
        query: input.query,
        includeProtected,
        limit: maxResults,
        maxChars: MEMORY_RETRIEVAL_MAX_CHARS
      });
      diagnostics.push(...indexed.diagnostics.diagnostics);
      const converted = indexed.results.map((result) => redactResult(result, maxChars));
      const results = converted.map((item) => item.result);
      for (const item of converted) {
        diagnostics.push(...item.diagnostics);
      }
      return {
        results,
        diagnostics: this.#diagnostics({
          profileId: input.profileId,
          includeProtected,
          indexState,
          fallbackUsed: false,
          resultCount: results.length,
          truncated: indexed.diagnostics.truncated || converted.some((item) => item.truncated),
          redactionApplied: converted.some((item) => item.redactionApplied),
          diagnostics
        })
      };
    }

    diagnostics.push(...fallbackDiagnostics(indexState));
    const fallback = await this.#searchFallback(input.profileId, input.query, {
      includeProtected,
      maxResults,
      maxChars
    });
    diagnostics.push(...fallback.diagnostics);
    return {
      results: fallback.results,
      diagnostics: this.#diagnostics({
        profileId: input.profileId,
        includeProtected,
        indexState,
        fallbackUsed: true,
        resultCount: fallback.results.length,
        truncated: fallback.truncated,
        redactionApplied: fallback.redactionApplied,
        diagnostics
      })
    };
  }

  #indexState(profileId: string): { enabled: boolean; available: boolean; empty: boolean } {
    if (!this.#config.index.enabled) {
      return { enabled: false, available: false, empty: true };
    }
    if (this.#index === undefined) {
      return { enabled: true, available: false, empty: true };
    }
    try {
      const status = this.#index.status({ profileId, enabled: this.#config.index.enabled });
      return {
        enabled: this.#config.index.enabled,
        available: status.available,
        empty: status.empty
      };
    } catch {
      return { enabled: this.#config.index.enabled, available: false, empty: true };
    }
  }

  async #readFallbackSource(input: MemoryRetrievalReadInput): Promise<FallbackSource | null> {
    if (input.sourceType === "memory_file") {
      if (!isProfileMemoryFileKind(input.sourceId)) {
        return null;
      }
      const path = profileMemoryPath(this.#homeDir, input.profileId, input.sourceId);
      const content = await readOptionalFile(path);
      if (content === undefined) {
        return null;
      }
      return {
        profileId: input.profileId,
        sourceType: "memory_file",
        sourceId: input.sourceId,
        sourcePath: path,
        memoryFileKind: input.sourceId,
        authority: "canonical",
        protectedClass: protectedClassForMemoryFile(input.sourceId),
        content,
        updatedAt: new Date(0).toISOString(),
        lineRanges: [lineRangeForContent(content)]
      };
    }

    const content = await readOptionalFile(sharedMemoryPath(this.#homeDir, input.sourceId));
    if (content === undefined) {
      return null;
    }
    return {
      profileId: input.profileId,
      sourceType: "shared_memory",
      sourceId: input.sourceId,
      sourceKey: input.sourceId,
      sourcePath: sharedMemoryPath(this.#homeDir, input.sourceId),
      authority: "canonical",
      protectedClass: "none",
      content,
      updatedAt: new Date(0).toISOString(),
      lineRanges: [lineRangeForContent(content)]
    };
  }

  async #searchFallback(
    profileId: string,
    query: string,
    options: { includeProtected: boolean; maxResults: number; maxChars: number }
  ): Promise<{
    results: LocalMemoryRetrievalResult[];
    truncated: boolean;
    redactionApplied: boolean;
    diagnostics: MemoryRetrievalDiagnostic[];
  }> {
    const needle = query.trim().toLowerCase();
    const diagnostics: MemoryRetrievalDiagnostic[] = [];
    if (needle.length === 0) {
      return { results: [], truncated: false, redactionApplied: false, diagnostics };
    }

    const sources = await this.#listFallbackSources(profileId);
    let protectedFilteredCount = 0;
    const converted = [];
    for (const source of sources) {
      if (source.protectedClass !== "none" && !options.includeProtected) {
        if (source.content.toLowerCase().includes(needle)) {
          protectedFilteredCount++;
        }
        continue;
      }
      const matchIndex = source.content.toLowerCase().indexOf(needle);
      if (matchIndex === -1) {
        continue;
      }
      converted.push(fallbackSourceToResult(source, options.maxChars, 1));
      if (converted.length >= options.maxResults) {
        break;
      }
    }

    if (protectedFilteredCount > 0) {
      diagnostics.push({
        code: "memory-protected-filtered",
        message: "Protected local memory entries were filtered from fallback lexical search."
      });
    }
    for (const item of converted) {
      diagnostics.push(...item.diagnostics);
    }

    return {
      results: converted.map((item) => item.result),
      truncated: converted.some((item) => item.truncated),
      redactionApplied: converted.some((item) => item.redactionApplied),
      diagnostics
    };
  }

  async #listFallbackSources(profileId: string): Promise<FallbackSource[]> {
    const sources: FallbackSource[] = [];
    for (const kind of PROFILE_MEMORY_FILE_KINDS) {
      const source = await this.#readFallbackSource({
        profileId,
        sourceType: "memory_file",
        sourceId: kind,
        includeProtected: true
      });
      if (source !== null) {
        sources.push(source);
      }
    }

    for (const entry of await listSharedMemory({ homeDir: this.#homeDir })) {
      sources.push({
        profileId,
        sourceType: "shared_memory",
        sourceId: entry.key,
        sourceKey: entry.key,
        sourcePath: sharedMemoryPath(this.#homeDir, entry.key),
        authority: "canonical",
        protectedClass: "none",
        content: entry.content,
        updatedAt: entry.updatedAt.toISOString(),
        lineRanges: [lineRangeForContent(entry.content)]
      });
    }
    return sources;
  }

  #diagnostics(input: {
    profileId: string;
    includeProtected: boolean;
    indexState: { enabled: boolean; available: boolean; empty: boolean };
    fallbackUsed: boolean;
    resultCount: number;
    truncated: boolean;
    redactionApplied: boolean;
    diagnostics: MemoryRetrievalDiagnostic[];
  }): LocalMemoryRetrievalDiagnostics {
    const diagnostics = [...input.diagnostics];
    if (input.indexState.empty && input.indexState.enabled && input.indexState.available) {
      diagnostics.push({
        code: "memory-index-pending-rebuild",
        message: "The local memory index is empty."
      });
    }
    return {
      mode: "lexical",
      profileId: input.profileId,
      indexEnabled: input.indexState.enabled,
      indexAvailable: input.indexState.available,
      fallbackUsed: input.fallbackUsed,
      includeProtected: input.includeProtected,
      resultCount: input.resultCount,
      truncated: input.truncated,
      redactionApplied: input.redactionApplied,
      diagnostics
    };
  }
}

function fallbackDiagnostics(indexState: { enabled: boolean; available: boolean }): MemoryRetrievalDiagnostic[] {
  if (!indexState.enabled) {
    return [{
      code: "memory-index-disabled",
      message: "Local memory index is disabled; using bounded substring fallback."
    }];
  }
  if (!indexState.available) {
    return [{
      code: "memory-index-unavailable",
      message: "Local memory index is unavailable; using bounded substring fallback."
    }];
  }
  return [];
}

function redactResult(result: MemoryRetrievalResult, maxChars: number): {
  result: LocalMemoryRetrievalResult;
  truncated: boolean;
  redactionApplied: boolean;
  diagnostics: MemoryRetrievalDiagnostic[];
} {
  const boundedContent = truncateContent(result.content, maxChars);
  const redactedContent = redactSensitiveText(boundedContent);
  const redactionApplied = redactedContent !== boundedContent;
  const truncated = boundedContent.length < result.content.length;
  const diagnostics: MemoryRetrievalDiagnostic[] = [];
  if (truncated) {
    diagnostics.push({
      code: "memory-result-truncated",
      message: "Local memory retrieval content was truncated."
    });
  }
  if (redactionApplied) {
    diagnostics.push({
      code: "memory-retrieval-fallback",
      message: "Sensitive-looking local memory content was redacted in retrieval output.",
      sourceType: result.sourceType,
      source: result.source,
      memoryFileKind: result.memoryFileKind,
      protectedClass: result.protectedClass
    });
  }
  return {
    result: {
      ...result,
      content: redactedContent,
      excerpt: truncateContent(redactedContent, MEMORY_RETRIEVAL_EXCERPT_CHARS),
      contextLabel: "local-memory-context",
      instructionBoundary: "context-not-instruction",
      trusted: false
    },
    truncated,
    redactionApplied,
    diagnostics
  };
}

function fallbackSourceToResult(source: FallbackSource, maxChars: number, score: number): {
  result: LocalMemoryRetrievalResult;
  truncated: boolean;
  redactionApplied: boolean;
  diagnostics: MemoryRetrievalDiagnostic[];
} {
  return redactResult({
    id: fallbackId(source),
    profileId: source.profileId,
    mode: "lexical",
    sourceType: source.sourceType,
    source: source.memoryFileKind ?? source.sourceId,
    sourcePath: source.sourcePath,
    sourceKey: source.sourceKey,
    memoryFileKind: source.memoryFileKind,
    authority: source.authority,
    protectedClass: source.protectedClass,
    contentHash: hashContent(source.content),
    content: source.content,
    excerpt: truncateContent(source.content, MEMORY_RETRIEVAL_EXCERPT_CHARS),
    score,
    lineRanges: source.lineRanges,
    updatedAt: source.updatedAt
  }, maxChars);
}

function isProtectedSource(source: MemoryRetrievalSourceInput): boolean {
  return source.sourceType === "memory_file" && source.sourceId === "SOUL.md";
}

function isProfileMemoryFileKind(value: string): value is ProfileMemoryFileKind {
  return value === "USER.md" || value === "MEMORY.md" || value === "SOUL.md";
}

function protectedClassForMemoryFile(kind: MemoryFileKind): MemoryProtectedClass {
  return kind === "SOUL.md" ? "identity" : "none";
}

function profileMemoryPath(homeDir: string | undefined, profileId: string, kind: ProfileMemoryFileKind): string {
  const paths = resolveProfileStateHome({ homeDir, profileId });
  if (kind === "USER.md") {
    return paths.userMdPath;
  }
  if (kind === "MEMORY.md") {
    return paths.memoryMdPath;
  }
  return paths.soulMdPath;
}

function sharedMemoryPath(homeDir: string | undefined, sourceId: string): string {
  const globalPaths = resolveGlobalStateHome({ homeDir });
  const filename = sourceId.endsWith(".md") ? sourceId : `${sourceId}.md`;
  return join(globalPaths.sharedMemoryPath, filename);
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function lineRangeForContent(content: string): MemoryLineRange {
  if (content.length === 0) {
    return { startLine: 1, endLine: 1 };
  }
  return {
    startLine: 1,
    endLine: content.split("\n").length
  };
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return Math.max(min, Math.min(max, fallback));
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return content.slice(0, maxChars);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fallbackId(source: FallbackSource): string {
  return hashContent([
    source.profileId,
    source.sourceType,
    source.sourceId,
    hashContent(source.content)
  ].join("\0"));
}
