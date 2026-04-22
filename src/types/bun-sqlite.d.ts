declare module "bun:sqlite" {
  export class Database {
    constructor(filename?: string, options?: { create?: boolean; readwrite?: boolean; strict?: boolean });
    exec(sql: string): void;
    query<T = unknown>(sql: string): Statement<T>;
    close(): void;
  }

  export class Statement<T = unknown> {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): T | null;
    all(...params: unknown[]): T[];
  }
}

