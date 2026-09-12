import { mkdir, readFile, realpath, open, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {randomUUID} from "node:crypto";
import {withProfileWriteLock} from "../config/profile-write-lock.js";
import { resolveHomeDir } from "../config/home-dir.js";

export type WorkspaceTrustGrant = {
  root: string;
  grantedAt: string;
  label?: string;
};

export type WorkspaceTrustFile = {
  version: 2;
  grants: WorkspaceTrustGrant[];
};

export type WorkspaceTrustStoreOptions = {
  path?: string;
  homeDir?: string;
  now?: () => Date;
};

export class WorkspaceTrustStore {
  readonly #path: string;
  readonly #now: () => Date;

  constructor(options: WorkspaceTrustStoreOptions = {}) {
    this.#path = options.path ?? join(resolveHomeDir(options.homeDir), ".estacoda", "trust.json");
    this.#now = options.now ?? (() => new Date());
  }

  get path(): string {
    return this.#path;
  }

  async isTrusted(workspaceRoot: string): Promise<boolean> {
    const canonicalRoot = await canonicalizeExistingPath(workspaceRoot);
    const trustFile = await this.#read();

    return trustFile.grants.some((grant) => isSameOrChildPath(grant.root, canonicalRoot));
  }

  async grant(workspaceRoot: string, options: { label?: string } = {}): Promise<WorkspaceTrustGrant> {
    return withProfileWriteLock(dirname(this.#path), () => this.#grant(workspaceRoot, options));
  }

  async #grant(workspaceRoot: string, options: { label?: string }): Promise<WorkspaceTrustGrant> {
    const canonicalRoot = await canonicalizeExistingPath(workspaceRoot);
    const trustFile = await this.#read();
    const existing = trustFile.grants.find((grant) => grant.root === canonicalRoot);

    if (existing !== undefined) {
      return existing;
    }

    const grant: WorkspaceTrustGrant = {
      root: canonicalRoot,
      grantedAt: this.#now().toISOString(),
      label: options.label
    };

    trustFile.grants.push(grant);
    trustFile.grants.sort((left, right) => left.root.localeCompare(right.root));
    await this.#write(trustFile);

    return grant;
  }

  async revoke(workspaceRoot: string): Promise<boolean> {
    return withProfileWriteLock(dirname(this.#path), () => this.#revoke(workspaceRoot));
  }

  async #revoke(workspaceRoot: string): Promise<boolean> {
    const canonicalRoot = await canonicalizeExistingPath(workspaceRoot);
    const trustFile = await this.#read();
    const before = trustFile.grants.length;

    trustFile.grants = trustFile.grants.filter((grant) => grant.root !== canonicalRoot);

    if (trustFile.grants.length === before) {
      return false;
    }

    await this.#write(trustFile);
    return true;
  }

  async list(): Promise<WorkspaceTrustGrant[]> {
    return [...(await this.#read()).grants];
  }

  async #read(): Promise<WorkspaceTrustFile> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Partial<WorkspaceTrustFile>;

      return {
        version: 2,
        grants: parsed.version === 2 && Array.isArray(parsed.grants)
          ? parsed.grants.filter(isGrant)
          : []
      };
    } catch {
      return {
        version: 2,
        grants: []
      };
    }
  }

  async #write(file: WorkspaceTrustFile): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary=this.#path+"."+randomUUID()+".tmp";
    try {
      const handle=await open(temporary,"wx",0o600);
      try { await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`,"utf8");await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary,this.#path);
    } finally { await rm(temporary,{force:true}); }
  }
}

async function canonicalizeExistingPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

function isSameOrChildPath(trustedRoot: string, target: string): boolean {
  const diff = relative(trustedRoot, target);
  return diff === "" || (!diff.startsWith("..") && !diff.startsWith("/"));
}

function isGrant(value: unknown): value is WorkspaceTrustGrant {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<WorkspaceTrustGrant>;

  return typeof candidate.root === "string" &&
    typeof candidate.grantedAt === "string";
}
