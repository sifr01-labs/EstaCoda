import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = resolve(root, "apps/desktop/src/control-protocol.ts");
const core = resolve(root, "src/contracts/control-protocol.ts");
const facade = resolve(root, "packages/control-protocol/src");
const config = ts.readConfigFile(resolve(root, "apps/desktop/tsconfig.json"), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(root, "apps/desktop"));
if (parsed.errors.length) throw new Error("Desktop foundation TypeScript configuration is invalid.");
const visited = new Set();
function visit(path) {
  const file = realpathSync(path);
  if (visited.has(file)) return;
  if (file !== entry && file !== core && !file.startsWith(facade + sep)) {
    throw new Error(`Protocol imports non-contract source: ${relative(root, file)}`);
  }
  visited.add(file);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  function dependency(node) {
    if (!ts.isStringLiteral(node)) throw new Error("Protocol dependencies must be static module names.");
    const name = node.text;
    if (!name.startsWith(".") && !(file === entry && name === "@estacoda/control-protocol")) {
      throw new Error(`Protocol imports a runtime dependency: ${name}`);
    }
    const resolved = ts.resolveModuleName(name, file, parsed.options, ts.sys).resolvedModule;
    if (!resolved) throw new Error(`Unresolved protocol import: ${name}`);
    visit(resolved.resolvedFileName);
  }
  function walk(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) dependency(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node)) throw new Error("CommonJS protocol imports are forbidden.");
    if (ts.isImportTypeNode(node)) {
      if (!ts.isLiteralTypeNode(node.argument)) throw new Error("Protocol type imports must be literal.");
      dependency(node.argument.literal);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      throw new Error("Dynamic protocol imports are forbidden.");
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
}
visit(entry);
if (!visited.has(core)) throw new Error("Desktop is not consuming the canonical core contract.");
console.log(`Desktop protocol boundary passed (${visited.size} source modules; no Node/Electron transport imports).`);
