import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const papyrusRoot = dirname(fileURLToPath(import.meta.url));

type SourceFile = {
  path: string;
  relativePath: string;
  content: string;
};

const implementationFiles = collectSourceFiles(papyrusRoot).filter((file) => !file.relativePath.endsWith(".test.ts"));

const bannedImportSpecifiers = [
  /^react$/u,
  /^react\//u,
  /^react-dom$/u,
  /^react-dom\//u,
  /^react-reconciler$/u,
  /^react-reconciler\//u,
  /^ink$/u,
  /^ink\//u,
  /^jsdom$/u,
  /^jsdom\//u,
  /^yoga$/u,
  /^yoga\//u,
  /^yoga-wasm$/u,
  /^yoga-wasm\//u,
  /^yoga-layout$/u,
  /^yoga-layout\//u,
  /(^|\/)yogini-style(\/|$)/u,
  /^bun:/u,
  /^analytics(\/|$)/u,
  /^@[^/]+\/analytics(\/|$)/u,
  /(^|\/)analytics(\/|$)/u,
  /^source-app(\/|$)/u,
  /^@source-app\//u,
  /^src\/(config|state|app-state|session|cli|runtime|providers)\//u,
  /^src\/ui\/renderers(\/|$)/u,
];

const bannedImplementationPatterns = [
  { name: "stdout writes", pattern: /\bprocess\.stdout\.write\b|\bstdout\.write\b/u },
  { name: "stderr writes", pattern: /\bprocess\.stderr\.write\b|\bstderr\.write\b/u },
  { name: "raw mode mutation", pattern: /\bsetRawMode\s*\(/u },
  { name: "child process imports", pattern: /\bchild_process\b|node:child_process/u },
  { name: "subprocess helpers", pattern: /\bexecFile\s*\(|\bexec\s*\(|\bspawn\s*\(/u },
  { name: "dynamic require", pattern: /\brequire\s*\(/u },
  { name: "clipboard commands", pattern: /\b(pbcopy|pbpaste|xclip|xsel|wl-copy|wl-paste|clip\.exe)\b/u },
];

describe("Papyrus substrate boundaries", () => {
  it("keeps root inert while admitting intended input and widget exports", () => {
    expect(read("index.ts").trim()).toBe("export {};");
    expect(exportedModules(read("input/index.ts"))).toEqual([
      "./providers/directoryProvider.js",
      "./providers/fileProvider.js",
      "./providers/slashCommandProvider.js",
      "./suggestionTypes.js",
      "./typeaheadController.js",
    ]);
    expect(exportedModules(read("widgets/index.ts"))).toEqual([
      "./dialogModel.js",
      "./multiSelectModel.js",
      "./optionMap.js",
      "./overlayStack.js",
      "./selectKeymap.js",
      "./selectModel.js",
      "./selectRenderRows.js",
    ]);
  });

  it("exports only the intended nested substrate modules", () => {
    expect(exportedModules(read("layout/index.ts"))).toEqual(["./geometry.js"]);
    expect(exportedModules(read("termio/index.ts"))).toEqual([
      "./ansi.js",
      "./csi.js",
      "./dec.js",
      "./esc.js",
      "./osc.js",
      "./parser.js",
      "./sgr.js",
      "./tokenize.js",
      "./types.js",
    ]);
    expect(exportedModules(read("screen/index.ts"))).toEqual([
      "./bidi.js",
      "./compositor.js",
      "./frame.js",
      "./lineWidthCache.js",
      "./logUpdate.js",
      "./optimizer.js",
      "./output.js",
      "./renderBorder.js",
      "./screen.js",
      "./stringWidth.js",
      "./widestLine.js",
    ]);
  });

  it("does not import React, Yoga, DOM/source-app, Bun-only, or adjacent app layers", () => {
    const violations: string[] = [];

    for (const file of implementationFiles) {
      for (const specifier of importSpecifiers(file.content)) {
        if (isBannedImportSpecifier(specifier)) {
          violations.push(`${file.relativePath}: ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("classifies banned and local import specifiers deterministically", () => {
    expect(isBannedImportSpecifier("react-dom")).toBe(true);
    expect(isBannedImportSpecifier("jsdom")).toBe(true);
    expect(isBannedImportSpecifier("analytics")).toBe(true);
    expect(isBannedImportSpecifier("src/config/runtime-config.js")).toBe(true);
    expect(isBannedImportSpecifier("src/state/session.js")).toBe(true);
    expect(isBannedImportSpecifier("src/ui/renderers/layout.js")).toBe(true);
    expect(isBannedImportSpecifier("./screen.js")).toBe(false);
    expect(isBannedImportSpecifier("../termio/types.js")).toBe(false);
  });

  it("does not mutate terminals, spawn subprocesses, or call clipboard helpers", () => {
    const violations: string[] = [];

    for (const file of implementationFiles) {
      for (const banned of bannedImplementationPatterns) {
        if (banned.pattern.test(file.content)) violations.push(`${file.relativePath}: ${banned.name}`);
      }
    }

    expect(violations).toEqual([]);
  });
});

function read(path: string): string {
  return readFileSync(join(papyrusRoot, path), "utf8");
}

function exportedModules(content: string): string[] {
  return [...content.matchAll(/^export \* from "([^"]+)";$/gmu)].map((match) => match[1]!);
}

function importSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  for (const match of content.matchAll(/\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gmu)) {
    specifiers.add(match[1]!);
  }
  for (const match of content.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gmu)) {
    specifiers.add(match[1]!);
  }
  for (const match of content.matchAll(/\bexport\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']/gmu)) {
    specifiers.add(match[1]!);
  }
  return [...specifiers];
}

function isBannedImportSpecifier(specifier: string): boolean {
  return bannedImportSpecifiers.some((pattern) => pattern.test(specifier));
}

function collectSourceFiles(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const entries = readdirSync(root, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push({
        path,
        relativePath: relative(papyrusRoot, path),
        content: readFileSync(path, "utf8"),
      });
    }
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
