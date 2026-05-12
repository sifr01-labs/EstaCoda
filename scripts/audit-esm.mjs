import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const distRoot = path.resolve(process.argv[2] ?? "dist");
const sourceExtensionPattern = /\.(?:ts|tsx|mts|cts)$/;

async function collectJsFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }

  return files;
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function hasNodeResolvableExtension(specifier) {
  return path.extname(specifier) !== "";
}

function resolveRelativeImport(importerPath, specifier) {
  return path.resolve(path.dirname(importerPath), specifier);
}

function collectImportSpecifiers(sourceText, fileName) {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const specifiers = [];

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }

    if (ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

const failures = [];

if (!existsSync(distRoot)) {
  failures.push(`dist directory does not exist: ${distRoot}`);
} else {
  const files = await collectJsFiles(distRoot);

  if (files.length === 0) {
    failures.push(`no emitted JavaScript files found in: ${distRoot}`);
  }

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const importSpecifiers = collectImportSpecifiers(source, file);

    for (const specifier of importSpecifiers) {
      if (!isRelativeSpecifier(specifier)) {
        continue;
      }

      const relativeFile = path.relative(distRoot, file);

      if (sourceExtensionPattern.test(specifier)) {
        failures.push(`${relativeFile}: relative import points at TypeScript source: ${specifier}`);
      }

      if (!hasNodeResolvableExtension(specifier)) {
        failures.push(`${relativeFile}: extensionless relative import is not Node ESM-resolvable: ${specifier}`);
        continue;
      }

      const resolved = resolveRelativeImport(file, specifier);
      if (!existsSync(resolved)) {
        failures.push(`${relativeFile}: relative import target is missing: ${specifier}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("ESM audit failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`ESM audit passed for ${distRoot}`);
