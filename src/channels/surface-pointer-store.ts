import { readJsonState, updateJsonState } from "../storage/json-state.js";
import { join } from "node:path";
import { resolveHomeDir } from "../config/home-dir.js";
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
  constructor(options: { path?: string; homeDir?: string } = {}) {
    this.#path = options.path ?? join(resolveHomeDir(options.homeDir), ".estacoda", "surface-pointers.json");
  }
  get path(): string { return this.#path; }
  #read(): SurfacePointerFile {
    return readJsonState(this.#path, () => ({ version: 1, pointers: {} }), (value) => {
      const file = value as SurfacePointerFile;
      if (file?.version !== 1 || !file.pointers || typeof file.pointers !== "object" || Array.isArray(file.pointers) ||
        Object.values(file.pointers).some((pointer) => !pointer || typeof pointer.sessionId !== "string" || typeof pointer.attachedAt !== "string")) throw new Error("Unsupported or corrupt surface pointer state. Renew attachment explicitly.");
      return file;
    });
  }
  async getPointer(type: SurfaceType, id: string): Promise<SurfacePointerRecord | undefined> { return this.#read().pointers[surfacePointerKey(type, id)]; }
  async setPointer(type: SurfaceType, id: string, record: SurfacePointerRecord): Promise<void> {
    updateJsonState(this.#path, () => this.#read(), (file) => { file.pointers[surfacePointerKey(type, id)] = structuredClone(record); });
  }
  async removePointer(type: SurfaceType, id: string): Promise<void> {
    updateJsonState(this.#path, () => this.#read(), (file) => { delete file.pointers[surfacePointerKey(type, id)]; });
  }
  async listPointers(): Promise<Array<{ surfaceType: SurfaceType; surfaceId: string; record: SurfacePointerRecord }>> {
    return Object.entries(this.#read().pointers).map(([key, record]) => {
      const separator = key.indexOf(":");
      return { surfaceType: key.slice(0, separator) as SurfaceType, surfaceId: key.slice(separator + 1), record };
    });
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
