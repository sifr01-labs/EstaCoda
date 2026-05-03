import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GoldenFlow } from "../contracts/golden-flow.js";

export async function loadGoldenFlow(path: string): Promise<GoldenFlow> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as GoldenFlow;
  return parsed;
}

export async function loadGoldenFlows(dir: string): Promise<GoldenFlow[]> {
  const entries = await readdir(dir);
  const flows: GoldenFlow[] = [];

  for (const entry of entries) {
    if (entry.endsWith(".json")) {
      flows.push(await loadGoldenFlow(join(dir, entry)));
    }
  }

  return flows;
}
