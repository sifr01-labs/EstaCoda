import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

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
  now?: () => Date;
};

export class WorkspaceTrustStore {
  readonly #path: string;
  readonly #now: () => Date;

  constructor(options: WorkspaceTrustStoreOptions = {}) {
    this.#path = options.path ?? join(homedir(), ".estacoda", "trust.json");
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
    await writeFile(this.#path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
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
