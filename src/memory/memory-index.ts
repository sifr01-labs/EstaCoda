import { createHash } from "node:crypto";
import type {
  MemoryAuthority,
  MemoryFileKind,
  MemoryIndexEntry,
  MemoryIndexedSourceType,
  MemoryLineRange,
  MemoryProtectedClass,
  MemoryRetrievalDiagnostic,
  MemoryRetrievalDiagnostics,
  MemoryRetrievalMode,
  MemoryRetrievalResult
} from "../contracts/memory.js";
import { toFtsQuery } from "../search/fts-query.js";
import type { MemoryIndexStore } from "./memory-index-store.js";

const MEMORY_INDEX_DEFAULT_LIMIT = 10;
const MEMORY_INDEX_MAX_LIMIT = 20;
const MEMORY_INDEX_DEFAULT_MAX_CHARS = 4_000;
const MEMORY_INDEX_MAX_CHARS = 20_000;
const MEMORY_INDEX_ENTRY_EXCERPT_CHARS = 600;

type MemoryIndexRow = {
  id: string;
  profile_id: string;
  source_type: MemoryIndexedSourceType;
  source_id: string;
  source_path: string | null;
  memory_file_kind: MemoryFileKind | null;
  authority: MemoryAuthority;
  protected_class: MemoryProtectedClass;
  content: string;
  content_hash: string;
  line_start: number | null;
  line_end: number | null;
  created_at: string;
  updated_at: string;
  indexed_at: string;
  metadata_json: string | null;
};

type SearchRow = MemoryIndexRow & {
  score: number;
};

type CountRow = {
  count: number;
};

type ProtectedCountRow = {
  count: number;
};

export type MemoryIndexSourceIdentity = {
  profileId: string;
  sourceType: MemoryIndexedSourceType;
  sourceId: string;
};

export type IndexMemoryFileInput = {
  profileId: string;
  memoryFileKind: Extract<MemoryFileKind, "USER.md" | "MEMORY.md" | "SOUL.md">;
  content: string;
  sourcePath?: string;
  updatedAt?: string;
  indexedAt?: string;
  protectedClass?: MemoryProtectedClass;
  metadata?: Record<string, unknown>;
};

export type IndexSharedMemoryInput = {
  profileId: string;
  sourceKey: string;
  content: string;
  sourcePath?: string;
  updatedAt?: string;
  indexedAt?: string;
  protectedClass?: MemoryProtectedClass;
  metadata?: Record<string, unknown>;
};

export type ReindexProfileInput = {
  profileId: string;
  memoryFiles?: IndexMemoryFileInput[];
  sharedMemory?: IndexSharedMemoryInput[];
};

export type MemoryIndexReadOptions = {
  profileId: string;
  sourceType: MemoryIndexedSourceType;
  sourceId: string;
  includeProtected?: boolean;
  maxChars?: number;
  retrievalAudience?: "operator" | "semantic";
};

export type MemoryIndexSearchOptions = {
  profileId: string;
  query: string;
  includeProtected?: boolean;
  limit?: number;
  maxChars?: number;
  retrievalAudience?: "operator" | "semantic";
};

export type MemoryIndexStatusOptions = {
  profileId?: string;
  enabled?: boolean;
};

export type MemoryIndexStatus = {
  path: string;
  enabled: boolean;
  available: boolean;
  indexedEntries: number;
  protectedEntries: number;
  staleEntries: number;
  ftsHealthy: boolean;
  schemaVersion: number;
  empty: boolean;
  diagnostics: MemoryRetrievalDiagnostic[];
  lastVacuumAt?: string;
};

export type MemoryIndexVacuumResult = {
  path: string;
  vacuumedAt: string;
};

export class MemoryIndex {
  readonly #store: MemoryIndexStore;
  readonly #now: () => Date;
  #lastVacuumAt: string | undefined;

  constructor(options: { store: MemoryIndexStore; now?: () => Date }) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
  }

  indexMemoryFile(input: IndexMemoryFileInput): MemoryIndexEntry {
    const protectedClass = input.protectedClass ?? protectedClassForMemoryFile(input.memoryFileKind);
    return this.#upsertSource({
      profileId: input.profileId,
      sourceType: "memory_file",
      sourceId: input.memoryFileKind,
      sourcePath: input.sourcePath,
      memoryFileKind: input.memoryFileKind,
      authority: "canonical",
      protectedClass,
      content: input.content,
      updatedAt: input.updatedAt,
      indexedAt: input.indexedAt,
      metadata: input.metadata
    });
  }

  indexSharedMemory(input: IndexSharedMemoryInput): MemoryIndexEntry {
    return this.#upsertSource({
      profileId: input.profileId,
      sourceType: "shared_memory",
      sourceId: input.sourceKey,
      sourcePath: input.sourcePath,
      authority: "canonical",
      protectedClass: input.protectedClass ?? "none",
      content: input.content,
      updatedAt: input.updatedAt,
      indexedAt: input.indexedAt,
      metadata: input.metadata
    });
  }

  removeBySource(input: MemoryIndexSourceIdentity): number {
    return this.#store.db
      .query(
        `delete from memory_index
         where profile_id = ? and source_type = ? and source_id = ?`
      )
      .run(input.profileId, input.sourceType, input.sourceId).changes;
  }

  removeProfile(profileId: string): number {
    return this.#store.db.query("delete from memory_index where profile_id = ?").run(profileId).changes;
  }

  reindexProfile(input: ReindexProfileInput): MemoryIndexEntry[] {
    this.removeProfile(input.profileId);
    const entries: MemoryIndexEntry[] = [];
    for (const memoryFile of input.memoryFiles ?? []) {
      entries.push(this.indexMemoryFile({ ...memoryFile, profileId: input.profileId }));
    }
    for (const sharedMemory of input.sharedMemory ?? []) {
      entries.push(this.indexSharedMemory({ ...sharedMemory, profileId: input.profileId }));
    }
    return entries;
  }

  searchLexical(options: MemoryIndexSearchOptions): {
    results: MemoryRetrievalResult[];
    diagnostics: MemoryRetrievalDiagnostics;
  } {
    const includeProtected = shouldIncludeProtected(options);
    const limit = clampInteger(options.limit, MEMORY_INDEX_DEFAULT_LIMIT, 1, MEMORY_INDEX_MAX_LIMIT);
    const maxChars = clampInteger(options.maxChars, MEMORY_INDEX_DEFAULT_MAX_CHARS, 1, MEMORY_INDEX_MAX_CHARS);
    const ftsQuery = toFtsQuery(options.query);
    const diagnostics: MemoryRetrievalDiagnostic[] = [];
    let protectedFilteredCount = 0;

    if (ftsQuery.length === 0) {
      return {
        results: [],
        diagnostics: this.#diagnostics({
          profileId: options.profileId,
          includeProtected,
          protectedFilteredCount,
          resultCount: 0,
          truncated: false,
          diagnostics
        })
      };
    }

    if (!includeProtected) {
      protectedFilteredCount = this.#countProtectedMatches(options.profileId, ftsQuery);
      if (protectedFilteredCount > 0) {
        diagnostics.push({
          code: "memory-protected-filtered",
          message: "Protected memory index entries were filtered from lexical results."
        });
      }
    }

    const rows = this.#store.db
      .query<SearchRow>(
        `select memory_index.*, bm25(memory_index_fts) as score
         from memory_index_fts
         join memory_index on memory_index.rowid = memory_index_fts.rowid
         where memory_index_fts match ?
           and memory_index.profile_id = ?
           and (? = 1 or memory_index.protected_class = 'none')
         order by score asc, memory_index.updated_at desc, memory_index.id asc
         limit ?`
      )
      .all(ftsQuery, options.profileId, includeProtected ? 1 : 0, limit);

    let truncated = false;
    const results = rows.map((row) => {
      const result = rowToRetrievalResult(row, {
        mode: "lexical",
        maxChars,
        score: row.score
      });
      truncated ||= result.content.length < row.content.length;
      return result;
    });

    if (truncated) {
      diagnostics.push({
        code: "memory-result-truncated",
        message: "One or more memory index results were truncated to the requested character budget."
      });
    }

    return {
      results,
      diagnostics: this.#diagnostics({
        profileId: options.profileId,
        includeProtected,
        protectedFilteredCount,
        resultCount: results.length,
        truncated,
        diagnostics
      })
    };
  }

  readSource(options: MemoryIndexReadOptions): MemoryRetrievalResult | null {
    const includeProtected = shouldIncludeProtected(options);
    const maxChars = clampInteger(options.maxChars, MEMORY_INDEX_DEFAULT_MAX_CHARS, 1, MEMORY_INDEX_MAX_CHARS);
    const row = this.#store.db
      .query<MemoryIndexRow>(
        `select *
         from memory_index
         where profile_id = ? and source_type = ? and source_id = ?
         order by updated_at desc, id asc
         limit 1`
      )
      .get(options.profileId, options.sourceType, options.sourceId);

    if (row === null) {
      return null;
    }
    if (row.protected_class !== "none" && !includeProtected) {
      return null;
    }

    return rowToRetrievalResult(row, {
      mode: "lexical",
      maxChars,
      score: 1
    });
  }

  status(options: MemoryIndexStatusOptions = {}): MemoryIndexStatus {
    const schema = this.#store.inspectSchema();
    const whereProfile = options.profileId === undefined ? "" : " where profile_id = ?";
    const profileParams = options.profileId === undefined ? [] : [options.profileId];
    const indexedEntries = this.#store.db
      .query<CountRow>(`select count(*) as count from memory_index${whereProfile}`)
      .get(...profileParams)?.count ?? 0;
    const protectedEntries = this.#store.db
      .query<ProtectedCountRow>(
        `select count(*) as count from memory_index${whereProfile}${
          whereProfile.length === 0 ? " where" : " and"
        } protected_class != 'none'`
      )
      .get(...profileParams)?.count ?? 0;
    const ftsHealthy = hasRequiredSchema(schema);
    const diagnostics: MemoryRetrievalDiagnostic[] = [];

    if (indexedEntries === 0) {
      diagnostics.push({
        code: "memory-index-pending-rebuild",
        message: "The local memory index is empty."
      });
    }
    if (!ftsHealthy) {
      diagnostics.push({
        code: "memory-index-unhealthy",
        message: "The local memory index schema or FTS table is unhealthy."
      });
    }

    return {
      path: schema.path,
      enabled: options.enabled ?? true,
      available: ftsHealthy,
      indexedEntries,
      protectedEntries,
      staleEntries: 0,
      ftsHealthy,
      schemaVersion: schema.schemaVersion,
      empty: indexedEntries === 0,
      diagnostics,
      lastVacuumAt: this.#lastVacuumAt
    };
  }

  vacuum(): MemoryIndexVacuumResult {
    this.#store.db.exec("pragma optimize;");
    const vacuumedAt = this.#now().toISOString();
    this.#lastVacuumAt = vacuumedAt;
    return {
      path: this.#store.path,
      vacuumedAt
    };
  }

  #upsertSource(input: {
    profileId: string;
    sourceType: MemoryIndexedSourceType;
    sourceId: string;
    sourcePath?: string;
    memoryFileKind?: MemoryFileKind;
    authority: MemoryAuthority;
    protectedClass: MemoryProtectedClass;
    content: string;
    updatedAt?: string;
    indexedAt?: string;
    metadata?: Record<string, unknown>;
  }): MemoryIndexEntry {
    const contentHash = hashContent(input.content);
    const id = hashContent([
      input.profileId,
      input.sourceType,
      input.sourceId,
      contentHash
    ].join("\0"));
    const existing = this.#store.db
      .query<MemoryIndexRow>(
        `select *
         from memory_index
         where profile_id = ? and source_type = ? and source_id = ? and content_hash = ?
         order by updated_at desc, id asc
         limit 1`
      )
      .get(input.profileId, input.sourceType, input.sourceId, contentHash);

    if (existing !== null) {
      this.#store.db
        .query(
          `delete from memory_index
           where profile_id = ? and source_type = ? and source_id = ? and id != ?`
        )
        .run(input.profileId, input.sourceType, input.sourceId, existing.id);
      return rowToIndexEntry(existing);
    }

    this.removeBySource({
      profileId: input.profileId,
      sourceType: input.sourceType,
      sourceId: input.sourceId
    });

    const indexedAt = input.indexedAt ?? this.#now().toISOString();
    const updatedAt = input.updatedAt ?? indexedAt;
    const lineRange = lineRangeForContent(input.content);
    this.#store.db
      .query(
        `insert into memory_index (
          id,
          profile_id,
          source_type,
          source_id,
          source_path,
          memory_file_kind,
          authority,
          protected_class,
          content,
          content_hash,
          line_start,
          line_end,
          created_at,
          updated_at,
          indexed_at,
          metadata_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.profileId,
        input.sourceType,
        input.sourceId,
        input.sourcePath ?? null,
        input.memoryFileKind ?? null,
        input.authority,
        input.protectedClass,
        input.content,
        contentHash,
        lineRange.startLine,
        lineRange.endLine,
        indexedAt,
        updatedAt,
        indexedAt,
        input.metadata === undefined ? null : JSON.stringify(input.metadata)
      );

    const row = this.#store.db.query<MemoryIndexRow>("select * from memory_index where id = ?").get(id);
    if (row === null) {
      throw new Error("Memory index entry was not readable after insert.");
    }
    return rowToIndexEntry(row);
  }

  #countProtectedMatches(profileId: string, ftsQuery: string): number {
    return this.#store.db
      .query<CountRow>(
        `select count(*) as count
         from memory_index_fts
         join memory_index on memory_index.rowid = memory_index_fts.rowid
         where memory_index_fts match ?
           and memory_index.profile_id = ?
           and memory_index.protected_class != 'none'`
      )
      .get(ftsQuery, profileId)?.count ?? 0;
  }

  #diagnostics(input: {
    profileId: string;
    includeProtected: boolean;
    protectedFilteredCount: number;
    resultCount: number;
    truncated: boolean;
    diagnostics: MemoryRetrievalDiagnostic[];
  }): MemoryRetrievalDiagnostics {
    return {
      mode: "lexical",
      profileId: input.profileId,
      indexEnabled: true,
      indexAvailable: true,
      indexStale: false,
      fallbackUsed: false,
      includeProtected: input.includeProtected,
      protectedFilteredCount: input.protectedFilteredCount,
      resultCount: input.resultCount,
      truncated: input.truncated,
      diagnostics: input.diagnostics
    };
  }
}

function shouldIncludeProtected(options: {
  includeProtected?: boolean;
  retrievalAudience?: "operator" | "semantic";
}): boolean {
  return options.retrievalAudience === "semantic" ? false : options.includeProtected === true;
}

function protectedClassForMemoryFile(kind: MemoryFileKind): MemoryProtectedClass {
  return kind === "SOUL.md" ? "identity" : "none";
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return content.slice(0, maxChars);
}

function rowToIndexEntry(row: MemoryIndexRow): MemoryIndexEntry {
  return {
    id: row.id,
    profileId: row.profile_id,
    sourceType: row.source_type,
    source: sourceLabel(row),
    sourcePath: row.source_path ?? undefined,
    sourceKey: row.source_type === "shared_memory" ? row.source_id : undefined,
    memoryFileKind: row.memory_file_kind ?? undefined,
    authority: row.authority,
    protectedClass: row.protected_class,
    contentHash: row.content_hash,
    excerpt: truncateContent(row.content, MEMORY_INDEX_ENTRY_EXCERPT_CHARS),
    lineRanges: lineRangesFromRow(row),
    updatedAt: row.updated_at
  };
}

function rowToRetrievalResult(
  row: MemoryIndexRow,
  options: { mode: MemoryRetrievalMode; maxChars: number; score: number }
): MemoryRetrievalResult {
  const content = truncateContent(row.content, options.maxChars);
  return {
    id: row.id,
    profileId: row.profile_id,
    mode: options.mode,
    sourceType: row.source_type,
    source: sourceLabel(row),
    sourcePath: row.source_path ?? undefined,
    sourceKey: row.source_type === "shared_memory" ? row.source_id : undefined,
    memoryFileKind: row.memory_file_kind ?? undefined,
    authority: row.authority,
    protectedClass: row.protected_class,
    contentHash: row.content_hash,
    content,
    excerpt: truncateContent(content, MEMORY_INDEX_ENTRY_EXCERPT_CHARS),
    score: options.score,
    lineRanges: lineRangesFromRow(row),
    updatedAt: row.updated_at
  };
}

function sourceLabel(row: MemoryIndexRow): string {
  return row.memory_file_kind ?? row.source_id;
}

function lineRangesFromRow(row: MemoryIndexRow): MemoryLineRange[] | undefined {
  if (row.line_start === null || row.line_end === null) {
    return undefined;
  }
  return [{ startLine: row.line_start, endLine: row.line_end }];
}

function hasRequiredSchema(schema: {
  tables: string[];
  triggers: string[];
  memoryIndexColumns: string[];
}): boolean {
  return schema.tables.includes("memory_index")
    && schema.tables.includes("memory_index_fts")
    && schema.triggers.includes("memory_index_ai")
    && schema.triggers.includes("memory_index_ad")
    && schema.triggers.includes("memory_index_au")
    && schema.memoryIndexColumns.includes("protected_class");
}
