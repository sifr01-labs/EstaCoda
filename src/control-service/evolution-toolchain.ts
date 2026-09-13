import { access, readFile, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, delimiter } from "node:path";
import { homedir } from "node:os";

/** Resolve installed pnpm without shell startup files, project binaries or downloads.
 * The bridge's owned Node executes pnpm; scripts see that same Node on PATH. */
export async function evolutionToolchain(home = homedir(), node = process.execPath) {
  const roots = [
    join(dirname(node), "../lib/node_modules/pnpm"),
    "/opt/homebrew/lib/node_modules/pnpm",
    "/usr/local/lib/node_modules/pnpm",
    join(home, ".local/share/pnpm/global/5/node_modules/pnpm")
  ];
  for (const cache of [join(home, ".cache/node/corepack/v1/pnpm"), join(home, "Library/Caches/node/corepack/v1/pnpm")]) {
    const versions = await readdir(cache).catch(() => []);
    roots.push(...versions.filter(v => /^\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .slice(0, 32).map(v => join(cache, v)));
  }
  for (const root of roots) {
    try {
      const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      if (pkg.name !== "pnpm" || typeof pkg.version !== "string") continue;
      const entry = await realpath(join(root, "bin/pnpm.cjs"));
      await access(entry, constants.R_OK);
      return {
        command: node,
        args: [entry],
        path: [dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter)
      };
    } catch { /* Try the next operator-installed toolchain. */ }
  }
  throw new Error("Install pnpm before running Evolution command gates.");
}
