import type { SQLiteDatabase } from "../storage/sqlite.js";

export const EXECUTION_TARGET_SCHEMA_VERSION = 33;

/** Additive ownership migration; existing unbound rows remain explicitly legacy. */
export function migrateExecutionTargetSchemaV33(db: SQLiteDatabase): void {
  db.exec(`alter table sessions add column execution_target_json text;
    alter table tasks add column execution_target_json text;
    create trigger immutable_session_target before update of execution_target_json on sessions
      when old.execution_target_json is not null and new.execution_target_json is not old.execution_target_json
      begin select raise(abort, 'Session execution target is immutable'); end;
    create trigger immutable_task_target before update of execution_target_json on tasks
      when new.execution_target_json is not old.execution_target_json
      begin select raise(abort, 'Task execution target is immutable'); end;
    create trigger bound_session_workspace before update of metadata_json on sessions
      when old.execution_target_json is not null and
        json_extract(new.metadata_json, '$.workspaceRoot') is not json_extract(old.execution_target_json, '$.workspace.canonicalPath')
      begin select raise(abort, 'Session workspace is immutable'); end;`);
}
