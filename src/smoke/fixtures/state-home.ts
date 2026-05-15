import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function installIsolatedStateHome(prefix = "estacoda-smoke-home-"): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = home;
  return home;
}
