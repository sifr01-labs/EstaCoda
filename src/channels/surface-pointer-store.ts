import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { SurfacePointerRecord, SurfaceType } from "./surface-pointer.js";
import { surfacePointerKey } from "./surface-pointer.js";

export interface SurfacePointerStore {
  getPointer(surfaceType: SurfaceType, surfaceId: string): Promise<SurfacePointerRecord | undefined>;
  setPointer(surfaceType: SurfaceType, surfaceId: string, record: SurfacePointerRecord): Promise<void>;
  removePointer(surfaceType: SurfaceType, surfaceId: string): Promise<void>;
  listPointers(): Promise<Array<{ surfaceType: SurfaceType; surfaceId: string; record: SurfacePointerRecord }>>;
}

type SurfacePointerFile = {
  version: 1;
  pointers: Record<string, SurfacePointerRecord>;
};

export class FileSurfacePointerStore implements SurfacePointerStore {
  readonly #path: string;
  readonly #pointers = new Map<string, SurfacePointerRecord>();
  #loaded = false;

  constructor(options: { path?: string } = {}) {
    this.#path = options.path ?? join(homedir(), ".estacoda", "surface-pointers.json");
  }

  get path(): string {
    return this.#path;
  }

  async getPointer(surfaceType: SurfaceType, surfaceId: string): Promise<SurfacePointerRecord | undefined> {
    await this.#ensureLoaded();
    return this.#pointers.get(surfacePointerKey(surfaceType, surfaceId));
  }

  async setPointer(surfaceType: SurfaceType, surfaceId: string, record: SurfacePointerRecord): Promise<void> {
    await this.#ensureLoaded();
    this.#pointers.set(surfacePointerKey(surfaceType, surfaceId), record);
    await this.#flush();
  }

  async removePointer(surfaceType: SurfaceType, surfaceId: string): Promise<void> {
    await this.#ensureLoaded();
    if (this.#pointers.delete(surfacePointerKey(surfaceType, surfaceId))) {
      await this.#flush();
    }
  }

  async listPointers(): Promise<Array<{ surfaceType: SurfaceType; surfaceId: string; record: SurfacePointerRecord }>> {
    await this.#ensureLoaded();
    const result: Array<{ surfaceType: SurfaceType; surfaceId: string; record: SurfacePointerRecord }> = [];
    for (const [key, record] of this.#pointers) {
      const separatorIndex = key.indexOf(":");
      if (separatorIndex === -1) continue;
      const surfaceType = key.slice(0, separatorIndex) as SurfaceType;
      const surfaceId = key.slice(separatorIndex + 1);
      result.push({ surfaceType, surfaceId, record });
    }
    return result;
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Partial<SurfacePointerFile>;
      if (parsed.version === 1 && typeof parsed.pointers === "object" && parsed.pointers !== null) {
        for (const [key, value] of Object.entries(parsed.pointers)) {
          if (value !== null && typeof value === "object" &&
              typeof value.sessionId === "string" && typeof value.attachedAt === "string") {
            this.#pointers.set(key, { sessionId: value.sessionId, attachedAt: value.attachedAt });
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
    const file: SurfacePointerFile = {
      version: 1,
      pointers: Object.fromEntries(this.#pointers)
    };
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }
}

export class InMemorySurfacePointerStore implements SurfacePointerStore {
  readonly #pointers = new Map<string, SurfacePointerRecord>();

  async getPointer(surfaceType: SurfaceType, surfaceId: string): Promise<SurfacePointerRecord | undefined> {
    return this.#pointers.get(surfacePointerKey(surfaceType, surfaceId));
  }

  async setPointer(surfaceType: SurfaceType, surfaceId: string, record: SurfacePointerRecord): Promise<void> {
    this.#pointers.set(surfacePointerKey(surfaceType, surfaceId), record);
  }

  async removePointer(surfaceType: SurfaceType, surfaceId: string): Promise<void> {
    this.#pointers.delete(surfacePointerKey(surfaceType, surfaceId));
  }

  async listPointers(): Promise<Array<{ surfaceType: SurfaceType; surfaceId: string; record: SurfacePointerRecord }>> {
    const result: Array<{ surfaceType: SurfaceType; surfaceId: string; record: SurfacePointerRecord }> = [];
    for (const [key, record] of this.#pointers) {
      const separatorIndex = key.indexOf(":");
      if (separatorIndex === -1) continue;
      const surfaceType = key.slice(0, separatorIndex) as SurfaceType;
      const surfaceId = key.slice(separatorIndex + 1);
      result.push({ surfaceType, surfaceId, record });
    }
    return result;
  }
}
