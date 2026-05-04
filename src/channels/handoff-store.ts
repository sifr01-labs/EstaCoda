import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type HandoffCode = {
  code: string;
  sessionId: string;
  surfaceType: string;
  createdAt: string;
  expiresAt: string;
  redeemed: boolean;
  redeemedAt?: string;
  redeemedBySurfaceId?: string;
};

type HandoffCodeFile = {
  version: 1;
  codes: HandoffCode[];
};

export interface HandoffStore {
  create(input: {
    sessionId: string;
    surfaceType: string;
    ttlMinutes: number;
  }): Promise<HandoffCode>;

  redeem(input: {
    code: string;
    surfaceType: string;
    surfaceId: string;
  }): Promise<{ ok: true; handoff: HandoffCode } | { ok: false; reason: string }>;

  get(code: string): Promise<HandoffCode | undefined>;
  list(): Promise<HandoffCode[]>;
  purgeExpired(now?: Date): Promise<number>;
}

function generateCode(length = 6): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export class FileHandoffStore implements HandoffStore {
  readonly #path: string;
  readonly #codes = new Map<string, HandoffCode>();
  #loaded = false;

  constructor(options: { path?: string } = {}) {
    this.#path = options.path ?? join(homedir(), ".estacoda", "handoff-codes.json");
  }

  get path(): string {
    return this.#path;
  }

  async create(input: {
    sessionId: string;
    surfaceType: string;
    ttlMinutes: number;
  }): Promise<HandoffCode> {
    await this.#ensureLoaded();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlMinutes * 60 * 1000);

    // Ensure uniqueness
    let code: string;
    let attempts = 0;
    do {
      code = generateCode();
      attempts++;
    } while (this.#codes.has(code) && attempts < 100);

    const handoff: HandoffCode = {
      code,
      sessionId: input.sessionId,
      surfaceType: input.surfaceType,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      redeemed: false
    };

    this.#codes.set(code, handoff);
    await this.#flush();
    return handoff;
  }

  async redeem(input: {
    code: string;
    surfaceType: string;
    surfaceId: string;
  }): Promise<{ ok: true; handoff: HandoffCode } | { ok: false; reason: string }> {
    await this.#ensureLoaded();
    const handoff = this.#codes.get(input.code.toUpperCase());

    if (handoff === undefined) {
      return { ok: false, reason: "Invalid handoff code." };
    }

    if (handoff.redeemed) {
      return { ok: false, reason: "Handoff code already used." };
    }

    const now = new Date();
    if (new Date(handoff.expiresAt).getTime() < now.getTime()) {
      return { ok: false, reason: "Handoff code expired." };
    }

    if (handoff.surfaceType !== input.surfaceType) {
      return { ok: false, reason: `Handoff code is for ${handoff.surfaceType}, not ${input.surfaceType}.` };
    }

    handoff.redeemed = true;
    handoff.redeemedAt = now.toISOString();
    handoff.redeemedBySurfaceId = input.surfaceId;
    await this.#flush();

    return { ok: true, handoff };
  }

  async get(code: string): Promise<HandoffCode | undefined> {
    await this.#ensureLoaded();
    return this.#codes.get(code.toUpperCase());
  }

  async list(): Promise<HandoffCode[]> {
    await this.#ensureLoaded();
    return [...this.#codes.values()];
  }

  async purgeExpired(now: Date = new Date()): Promise<number> {
    await this.#ensureLoaded();
    let count = 0;
    for (const [key, handoff] of this.#codes) {
      if (new Date(handoff.expiresAt).getTime() < now.getTime()) {
        this.#codes.delete(key);
        count++;
      }
    }
    if (count > 0) {
      await this.#flush();
    }
    return count;
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Partial<HandoffCodeFile>;
      if (parsed.version === 1 && Array.isArray(parsed.codes)) {
        for (const entry of parsed.codes) {
          if (typeof entry.code === "string" && typeof entry.sessionId === "string") {
            this.#codes.set(entry.code, {
              code: entry.code,
              sessionId: entry.sessionId,
              surfaceType: entry.surfaceType ?? "telegram",
              createdAt: entry.createdAt,
              expiresAt: entry.expiresAt,
              redeemed: entry.redeemed ?? false,
              redeemedAt: entry.redeemedAt,
              redeemedBySurfaceId: entry.redeemedBySurfaceId
            });
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async #flush(): Promise<void> {
    const file: HandoffCodeFile = {
      version: 1,
      codes: [...this.#codes.values()]
    };
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }
}

export class InMemoryHandoffStore implements HandoffStore {
  readonly #codes = new Map<string, HandoffCode>();

  async create(input: {
    sessionId: string;
    surfaceType: string;
    ttlMinutes: number;
  }): Promise<HandoffCode> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlMinutes * 60 * 1000);
    let code: string;
    let attempts = 0;
    do {
      code = generateCode();
      attempts++;
    } while (this.#codes.has(code) && attempts < 100);

    const handoff: HandoffCode = {
      code,
      sessionId: input.sessionId,
      surfaceType: input.surfaceType,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      redeemed: false
    };
    this.#codes.set(code, handoff);
    return handoff;
  }

  async redeem(input: {
    code: string;
    surfaceType: string;
    surfaceId: string;
  }): Promise<{ ok: true; handoff: HandoffCode } | { ok: false; reason: string }> {
    const handoff = this.#codes.get(input.code.toUpperCase());
    if (handoff === undefined) {
      return { ok: false, reason: "Invalid handoff code." };
    }
    if (handoff.redeemed) {
      return { ok: false, reason: "Handoff code already used." };
    }
    const now = new Date();
    if (new Date(handoff.expiresAt).getTime() < now.getTime()) {
      return { ok: false, reason: "Handoff code expired." };
    }
    if (handoff.surfaceType !== input.surfaceType) {
      return { ok: false, reason: `Handoff code is for ${handoff.surfaceType}, not ${input.surfaceType}.` };
    }
    handoff.redeemed = true;
    handoff.redeemedAt = now.toISOString();
    handoff.redeemedBySurfaceId = input.surfaceId;
    return { ok: true, handoff };
  }

  async get(code: string): Promise<HandoffCode | undefined> {
    return this.#codes.get(code.toUpperCase());
  }

  async list(): Promise<HandoffCode[]> {
    return [...this.#codes.values()];
  }

  async purgeExpired(now: Date = new Date()): Promise<number> {
    let count = 0;
    for (const [key, handoff] of this.#codes) {
      if (new Date(handoff.expiresAt).getTime() < now.getTime()) {
        this.#codes.delete(key);
        count++;
      }
    }
    return count;
  }
}
