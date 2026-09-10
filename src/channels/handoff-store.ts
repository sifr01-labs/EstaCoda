/**
 * Handoff code store for cross-surface session attachment.
 *
 * Security notes (v0.9):
 * - Codes use cryptographically secure randomness (crypto.randomInt).
 * - Codes are short-lived (TTL configurable, default 10 minutes) and single-use.
 * - There is no built-in rate limiter on redemption. Brute-force mitigation
 *   relies on: (1) short TTL, (2) single-use, (3) 32^6 keyspace, and
 *   (4) Telegram gateway allowlist / local trust context.
 * - Failed redemption attempts do not reveal session IDs or other internals.
 * - Files are written atomically (temp + rename) with restrictive permissions
 *   (0o600), with serialized updates across processes.
 */
import { readJsonState, updateJsonState } from "../storage/json-state.js";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import { resolveHomeDir } from "../config/home-dir.js";

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
    result += chars[randomInt(chars.length)];
  }
  return result;
}

export class FileHandoffStore implements HandoffStore {
  readonly #path: string;
  constructor(options: { path?: string; homeDir?: string } = {}) {
    this.#path = options.path ?? join(resolveHomeDir(options.homeDir), ".estacoda", "handoff-codes.json");
  }
  get path(): string { return this.#path; }
  #read(): HandoffCodeFile {
    return readJsonState(this.#path, () => ({ version: 1, codes: [] }), (value) => {
      const file = value as HandoffCodeFile;
      if (file?.version !== 1 || !Array.isArray(file.codes) || file.codes.some((entry) =>
        !entry || typeof entry.code !== "string" || typeof entry.sessionId !== "string" || typeof entry.surfaceType !== "string" ||
        typeof entry.redeemed !== "boolean" || !Number.isFinite(Date.parse(entry.expiresAt)))) throw new Error("Unsupported or corrupt handoff state. Create a fresh authorized handoff.");
      return file;
    });
  }
  async create(input: { sessionId: string; surfaceType: string; ttlMinutes: number }): Promise<HandoffCode> {
    if (!Number.isFinite(input.ttlMinutes) || input.ttlMinutes <= 0) throw new Error("Handoff expiry must be positive.");
    return updateJsonState(this.#path, () => this.#read(), (file) => {
      let code = generateCode();
      for (let i = 0; file.codes.some((entry) => entry.code === code); i++) {
        if (i >= 100) throw new Error("Could not allocate a handoff code.");
        code = generateCode();
      }
      const now = new Date();
      const handoff: HandoffCode = { code, sessionId: input.sessionId, surfaceType: input.surfaceType,
        createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + input.ttlMinutes * 60_000).toISOString(), redeemed: false };
      file.codes.push(handoff); return handoff;
    });
  }
  async redeem(input: { code: string; surfaceType: string; surfaceId: string }): Promise<{ ok: true; handoff: HandoffCode } | { ok: false; reason: string }> {
    return updateJsonState(this.#path, () => this.#read(), (file) => {
      const handoff = file.codes.find((entry) => entry.code === input.code.toUpperCase());
      if (!handoff) return { ok: false, reason: "Invalid handoff code." };
      if (handoff.redeemed) return { ok: false, reason: "Handoff code already used." };
      if (Date.parse(handoff.expiresAt) <= Date.now()) return { ok: false, reason: "Handoff code expired." };
      if (handoff.surfaceType !== input.surfaceType) return { ok: false, reason: "Handoff code is for another surface type." };
      handoff.redeemed = true; handoff.redeemedAt = new Date().toISOString(); handoff.redeemedBySurfaceId = input.surfaceId;
      return { ok: true, handoff };
    });
  }
  async get(code: string): Promise<HandoffCode | undefined> { return this.#read().codes.find((entry) => entry.code === code.toUpperCase()); }
  async list(): Promise<HandoffCode[]> { return this.#read().codes; }
  async purgeExpired(now = new Date()): Promise<number> {
    return updateJsonState(this.#path, () => this.#read(), (file) => {
      const before = file.codes.length; file.codes = file.codes.filter((entry) => Date.parse(entry.expiresAt) > now.getTime());
      return before - file.codes.length;
    });
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
