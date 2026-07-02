import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type AdvisoryAcknowledgement = {
  readonly id: string;
  readonly acknowledgedAt: string;
};

export type AdvisoryAcknowledgementFile = {
  readonly version: 1;
  readonly acknowledgements: readonly AdvisoryAcknowledgement[];
};

export type AdvisoryAckResult = {
  readonly id: string;
  readonly acknowledgedAt: string;
  readonly created: boolean;
};

export class AdvisoryAckStore {
  readonly #path: string;

  constructor(options: { readonly path: string }) {
    this.#path = options.path;
  }

  async list(): Promise<readonly AdvisoryAcknowledgement[]> {
    return (await this.#read()).acknowledgements;
  }

  async isAcknowledged(id: string): Promise<boolean> {
    const normalized = normalizeAdvisoryId(id);
    return (await this.list()).some((ack) => ack.id === normalized);
  }

  async acknowledge(id: string, options: { readonly now?: () => Date } = {}): Promise<AdvisoryAckResult> {
    const normalized = normalizeAdvisoryId(id);
    const current = await this.#read();
    const existing = current.acknowledgements.find((ack) => ack.id === normalized);
    if (existing !== undefined) {
      return {
        id: normalized,
        acknowledgedAt: existing.acknowledgedAt,
        created: false
      };
    }

    const acknowledgement: AdvisoryAcknowledgement = {
      id: normalized,
      acknowledgedAt: (options.now?.() ?? new Date()).toISOString()
    };
    const next: AdvisoryAcknowledgementFile = {
      version: 1,
      acknowledgements: [...current.acknowledgements, acknowledgement].sort((a, b) => a.id.localeCompare(b.id))
    };
    await this.#write(next);

    return {
      ...acknowledgement,
      created: true
    };
  }

  async #read(): Promise<AdvisoryAcknowledgementFile> {
    let content: string;
    try {
      content = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        return {
          version: 1,
          acknowledgements: []
        };
      }
      throw error;
    }

    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.acknowledgements)) {
      throw new Error(`Invalid advisory acknowledgement store: ${this.#path}`);
    }

    return {
      version: 1,
      acknowledgements: parsed.acknowledgements.map((entry) => parseAcknowledgement(entry, this.#path))
    };
  }

  async #write(file: AdvisoryAcknowledgementFile): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const tempPath = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      await rename(tempPath, this.#path);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}

export function normalizeAdvisoryId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(id)) {
    throw new Error(`Invalid advisory id: ${value}`);
  }
  return id;
}

function parseAcknowledgement(value: unknown, path: string): AdvisoryAcknowledgement {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.acknowledgedAt !== "string") {
    throw new Error(`Invalid advisory acknowledgement store: ${path}`);
  }
  return {
    id: normalizeAdvisoryId(value.id),
    acknowledgedAt: value.acknowledgedAt
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
