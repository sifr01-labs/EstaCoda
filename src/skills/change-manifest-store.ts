import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EvolutionChangeManifest, EvolutionTarget } from "../contracts/evolution.js";
import { normalizeGateCommand } from "../evolution/constraint-gate-runner.js";

export class ChangeManifestStore {
  readonly #root: string;
  readonly #now: () => Date;

  constructor(options: { root: string; now?: () => Date }) {
    this.#root = options.root;
    this.#now = options.now ?? (() => new Date());
  }

  async propose(
    input: Omit<EvolutionChangeManifest, "id" | "createdAt" | "status">
  ): Promise<EvolutionChangeManifest> {
    const normalized = normalizeManifestGates(input);
    const manifest: EvolutionChangeManifest = {
      id: `manifest_${randomUUID()}`,
      status: "proposed",
      createdAt: this.#nowIso(),
      ...normalized,
    };
    await this.#appendJsonl("manifests.jsonl", manifest);
    return manifest;
  }

  async list(filter?: {
    target?: EvolutionTarget;
    status?: EvolutionChangeManifest["status"];
    riskLevel?: EvolutionChangeManifest["riskLevel"];
  }): Promise<EvolutionChangeManifest[]> {
    const manifests = await this.#readJsonl<EvolutionChangeManifest>("manifests.jsonl");
    return manifests.filter(
      (m) =>
        (filter?.target === undefined || m.target === filter.target) &&
        (filter?.status === undefined || m.status === filter.status) &&
        (filter?.riskLevel === undefined || m.riskLevel === filter.riskLevel)
    );
  }

  async find(id: string): Promise<EvolutionChangeManifest | undefined> {
    return (await this.list()).find((m) => m.id === id);
  }

  async updateStatus(
    id: string,
    status: EvolutionChangeManifest["status"],
    meta?: { promotedBy?: string }
  ): Promise<EvolutionChangeManifest | undefined> {
    return await this.#rewriteManifest(id, (manifest) => ({
      ...manifest,
      status,
      updatedAt: this.#nowIso(),
      ...(status === "promoted"
        ? { promotedAt: this.#nowIso(), promotedBy: meta?.promotedBy }
        : {}),
    }));
  }

  async linkEvidence(
    id: string,
    evidence: Partial<EvolutionChangeManifest["evidence"]>
  ): Promise<EvolutionChangeManifest | undefined> {
    return await this.#rewriteManifest(id, (manifest) => ({
      ...manifest,
      evidence: {
        traces: [
          ...manifest.evidence.traces,
          ...(evidence.traces ?? []),
        ],
        failures: [
          ...manifest.evidence.failures,
          ...(evidence.failures ?? []),
        ],
        evalCases: [
          ...manifest.evidence.evalCases,
          ...(evidence.evalCases ?? []),
        ],
        userCorrections: [
          ...(manifest.evidence.userCorrections ?? []),
          ...(evidence.userCorrections ?? []),
        ],
      },
      updatedAt: this.#nowIso(),
    }));
  }

  async #appendJsonl(file: string, value: unknown): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    await appendFile(join(this.#root, file), `${JSON.stringify(value)}\n`, "utf8");
  }

  async #readJsonl<T>(file: string): Promise<T[]> {
    const raw = await readFile(join(this.#root, file), "utf8").catch(() => "");
    return raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  }

  async #writeJsonl(file: string, values: unknown[]): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    await writeFile(
      join(this.#root, file),
      values.map((v) => JSON.stringify(v)).join("\n") + "\n",
      "utf8"
    );
  }

  async #rewriteManifest(
    id: string,
    update: (manifest: EvolutionChangeManifest) => EvolutionChangeManifest
  ): Promise<EvolutionChangeManifest | undefined> {
    const manifests = await this.#readJsonl<EvolutionChangeManifest>("manifests.jsonl");
    let updated: EvolutionChangeManifest | undefined;
    const next = manifests.map((m) => {
      if (m.id !== id) return m;
      updated = update(m);
      return updated;
    });
    if (updated === undefined) return undefined;
    await this.#writeJsonl("manifests.jsonl", next);
    return updated;
  }

  #nowIso(): string {
    return this.#now().toISOString();
  }
}

function normalizeManifestGates(
  input: Omit<EvolutionChangeManifest, "id" | "createdAt" | "status">
): Omit<EvolutionChangeManifest, "id" | "createdAt" | "status"> {
  return {
    ...input,
    evalCommand: input.evalCommand.length === 0 ? "" : normalizeGateCommand(input.evalCommand),
    constraintGates: input.constraintGates.map((gate) => normalizeGateCommand(gate))
  };
}
