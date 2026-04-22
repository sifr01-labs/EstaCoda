import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export type WorkspaceTrustGrant = {
  root: string;
  profileId: string;
  grantedAt: string;
  label?: string;
};

export type WorkspaceTrustFile = {
  version: 1;
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

  async isTrusted(workspaceRoot: string, options: { profileId?: string } = {}): Promise<boolean> {
    const canonicalRoot = await canonicalizeExistingPath(workspaceRoot);
    const trustFile = await this.#read();

    return trustFile.grants.some((grant) => {
      if (options.profileId !== undefined && grant.profileId !== "global" && grant.profileId !== options.profileId) {
        return false;
      }

      return isSameOrChildPath(grant.root, canonicalRoot);
    });
  }

  async grant(workspaceRoot: string, options: { profileId?: string; label?: string } = {}): Promise<WorkspaceTrustGrant> {
    const canonicalRoot = await canonicalizeExistingPath(workspaceRoot);
    const profileId = options.profileId ?? "global";
    const trustFile = await this.#read();
    const existing = trustFile.grants.find((grant) => grant.root === canonicalRoot && grant.profileId === profileId);

    if (existing !== undefined) {
      return existing;
    }

    const grant: WorkspaceTrustGrant = {
      root: canonicalRoot,
      profileId,
      grantedAt: this.#now().toISOString(),
      label: options.label
    };

    trustFile.grants.push(grant);
    trustFile.grants.sort((left, right) => left.root.localeCompare(right.root) || left.profileId.localeCompare(right.profileId));
    await this.#write(trustFile);

    return grant;
  }

  async revoke(workspaceRoot: string, options: { profileId?: string } = {}): Promise<boolean> {
    const canonicalRoot = await canonicalizeExistingPath(workspaceRoot);
    const profileId = options.profileId;
    const trustFile = await this.#read();
    const before = trustFile.grants.length;

    trustFile.grants = trustFile.grants.filter((grant) => {
      if (grant.root !== canonicalRoot) {
        return true;
      }

      return profileId !== undefined && grant.profileId !== profileId;
    });

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
        version: 1,
        grants: Array.isArray(parsed.grants) ? parsed.grants.filter(isGrant) : []
      };
    } catch {
      return {
        version: 1,
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
    typeof candidate.profileId === "string" &&
    typeof candidate.grantedAt === "string";
}
