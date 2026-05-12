import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourceRoot = path.join(root, "src");

const driverRules = new Map([
  ["bun:sqlite", new Set(["src/storage/bun-sqlite.ts", "src/storage/sqlite-adapter.test.ts"])],
  ["better-sqlite3", new Set(["src/storage/better-sqlite3.ts"])],
  ["node:sqlite", new Set()]
]);

const legacyBunSQLiteFiles = new Set([
  // Transitional allowlist. Keep empty in the Node/pnpm runtime contract.
]);

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(fullPath));
    } else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function containsRuntimeImport(source, specifier) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`\\bimport\\s+(?:type\\s+)?(?:[^'"]+?\\s+from\\s+)?["']${escaped}["']`),
    new RegExp(`\\bexport\\s+[^'"]+?\\s+from\\s+["']${escaped}["']`),
    new RegExp(`\\bimport\\s*\\(\\s*["']${escaped}["']\\s*\\)`),
    new RegExp(`\\bimport\\s*\\(\\s*["']${escaped}["']\\s*\\)`)
  ];
  return patterns.some((pattern) => pattern.test(source));
}

const failures = [];
const legacyWarnings = [];

for (const file of await collectSourceFiles(sourceRoot)) {
  const relativeFile = path.relative(root, file);
  const source = await readFile(file, "utf8");

  for (const [specifier, allowedFiles] of driverRules) {
    if (!containsRuntimeImport(source, specifier)) {
      continue;
    }

    if (specifier === "bun:sqlite" && legacyBunSQLiteFiles.has(relativeFile)) {
      legacyWarnings.push(`${relativeFile}: legacy bun:sqlite import must be removed from runtime code`);
    } else if (!allowedFiles.has(relativeFile)) {
      failures.push(`${relativeFile}: ${specifier} is only allowed in ${[...allowedFiles].join(", ") || "no MVP runtime files"}`);
    }
  }
}

for (const legacyFile of legacyBunSQLiteFiles) {
  if (!legacyWarnings.some((warning) => warning.startsWith(`${legacyFile}:`))) {
    failures.push(`${legacyFile}: remove from legacy bun:sqlite allowlist; no matching import was found`);
  }
}

if (failures.length > 0) {
  console.error("Runtime import audit failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

if (legacyWarnings.length > 0) {
  console.warn("Runtime import audit passed with legacy bun:sqlite allowlist entries:");
  for (const warning of legacyWarnings) {
    console.warn(`- ${warning}`);
  }
}

console.log("Runtime import audit passed");
