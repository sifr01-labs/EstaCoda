import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SQLiteDatabase } from "../storage/sqlite.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";
import { resolveProfileStateHome } from "../config/profile-home.js";

export const MEMORY_INDEX_SQLITE_FILENAME = "memory-index.sqlite";
export const MEMORY_INDEX_SCHEMA_VERSION = 1;

export type MemoryIndexStoreOptions = {
  path?: string;
  profileStateDir?: string;
  homeDir?: string;
  profileId?: string;
  db?: SQLiteDatabase;
};

export type MemoryIndexSchemaInspection = {
  path: string;
  schemaVersion: number;
  tables: string[];
  indexes: string[];
  triggers: string[];
  memoryIndexColumns: string[];
  entryCount: number;
};

type SchemaVersionRow = {
  version: number | null;
};

type NameRow = {
  name: string;
};

type ColumnInfoRow = {
  name: string;
};

type CountRow = {
  count: number;
};

function isFileAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

export function resolveMemoryIndexStorePath(options: Omit<MemoryIndexStoreOptions, "db">): string {
  if (options.path !== undefined) {
    return options.path;
  }

  if (options.profileStateDir !== undefined) {
    return join(options.profileStateDir, MEMORY_INDEX_SQLITE_FILENAME);
  }

  const profileState = resolveProfileStateHome({
    homeDir: options.homeDir,
    profileId: options.profileId ?? "default"
  });
  return join(profileState.profileRoot, MEMORY_INDEX_SQLITE_FILENAME);
}

export class MemoryIndexStore {
  readonly #db: SQLiteDatabase;
  readonly #path: string;
  #closed = false;

  constructor(options: MemoryIndexStoreOptions = {}) {
    this.#path = resolveMemoryIndexStorePath(options);
    if (options.db === undefined) {
      prepareMemoryIndexDbFile(this.#path);
    }
    this.#db = options.db ?? openDefaultSQLiteDatabase({ path: this.#path });
    this.#migrate();
  }

  get path(): string {
    return this.#path;
  }

  get db(): SQLiteDatabase {
    return this.#db;
  }

  dispose(): void {
    this.close();
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#db.close();
    this.#closed = true;
  }

  inspectSchema(): MemoryIndexSchemaInspection {
    return {
      path: this.#path,
      schemaVersion: this.#readSchemaVersion(),
      tables: this.#listSqliteObjects("table"),
      indexes: this.#listSqliteObjects("index"),
      triggers: this.#listSqliteObjects("trigger"),
      memoryIndexColumns: this.#listMemoryIndexColumns(),
      entryCount: this.#readEntryCount()
    };
  }

  #migrate(): void {
    this.#db.exec(`
      pragma journal_mode = wal;

      create table if not exists schema_version (
        version integer primary key
      );
    `);

    if (this.#readSchemaVersion() >= MEMORY_INDEX_SCHEMA_VERSION) {
      return;
    }

    this.#db.exec("begin immediate");
    try {
      if (this.#readSchemaVersion() < MEMORY_INDEX_SCHEMA_VERSION) {
        this.#migrateV1();
        this.#db
          .query("insert into schema_version (version) values (?) on conflict(version) do update set version = ?")
          .run(MEMORY_INDEX_SCHEMA_VERSION, MEMORY_INDEX_SCHEMA_VERSION);
      }
      this.#db.exec("commit");
    } catch (error) {
      try {
        this.#db.exec("rollback");
      } catch {
        // Preserve the original migration failure.
      }
      throw error;
    }
  }

  #migrateV1(): void {
    this.#db.exec(`
      create table if not exists memory_index (
        id text primary key,
        profile_id text not null,
        source_type text not null check(source_type in ('memory_file', 'shared_memory')),
        source_id text not null,
        source_path text,
        memory_file_kind text,
        authority text not null check(authority in ('canonical', 'derived', 'historical', 'external', 'plugin')),
        protected_class text not null default 'none' check(protected_class in ('none', 'identity', 'safety')),
        content text not null,
        content_hash text not null,
        line_start integer,
        line_end integer,
        created_at text not null,
        updated_at text not null,
        indexed_at text not null,
        metadata_json text
      );

      create virtual table if not exists memory_index_fts using fts5(
        content,
        content = 'memory_index',
        content_rowid = 'rowid',
        tokenize = 'unicode61'
      );

      create trigger if not exists memory_index_ai after insert on memory_index begin
        insert into memory_index_fts(rowid, content) values (new.rowid, new.content);
      end;

      create trigger if not exists memory_index_ad after delete on memory_index begin
        insert into memory_index_fts(memory_index_fts, rowid, content)
        values('delete', old.rowid, old.content);
      end;

      create trigger if not exists memory_index_au after update on memory_index begin
        insert into memory_index_fts(memory_index_fts, rowid, content)
        values('delete', old.rowid, old.content);
        insert into memory_index_fts(rowid, content) values (new.rowid, new.content);
      end;

      create index if not exists idx_memory_index_profile on memory_index(profile_id);
      create index if not exists idx_memory_index_source on memory_index(source_type, source_id);
      create index if not exists idx_memory_index_content_hash on memory_index(content_hash);
      create index if not exists idx_memory_index_protected_class on memory_index(protected_class);
    `);
  }

  #readSchemaVersion(): number {
    const row = this.#db
      .query<SchemaVersionRow>("select max(version) as version from schema_version")
      .get();
    return row?.version ?? 0;
  }

  #listSqliteObjects(type: "table" | "index" | "trigger"): string[] {
    return this.#db
      .query<NameRow>(
        "select name from sqlite_master where type = ? and name not like 'sqlite_%' order by name"
      )
      .all(type)
      .map((row) => row.name);
  }

  #listMemoryIndexColumns(): string[] {
    return this.#db
      .query<ColumnInfoRow>("pragma table_info(memory_index)")
      .all()
      .map((row) => row.name);
  }

  #readEntryCount(): number {
    const row = this.#db.query<CountRow>("select count(*) as count from memory_index").get();
    return row?.count ?? 0;
  }
}

function prepareMemoryIndexDbFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  try {
    writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!isFileAlreadyExistsError(error)) {
      throw error;
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best-effort permission repair only; opening the database will surface real failures.
    }
  }
}
