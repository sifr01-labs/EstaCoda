import { mkdir, chmod, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { resolveStateHome } from "../config/state-home.js";
import { SQLiteSessionDB } from "./sqlite-session-db.js";

export async function prepareSessionDbFile(path: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  if (!existsSync(path)) {
    await writeFile(path, "", { mode: 0o600 });
  } else {
    await chmod(path, 0o600).catch(() => undefined);
  }
}

export async function createSQLiteSessionDB(options?: { path?: string }): Promise<SQLiteSessionDB> {
  const stateHome = resolveStateHome();
  const sessionDbPath = options?.path ?? stateHome.sessionsSqlitePath;
  await prepareSessionDbFile(sessionDbPath);
  return new SQLiteSessionDB({ path: sessionDbPath });
}
