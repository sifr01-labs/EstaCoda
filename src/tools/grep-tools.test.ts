import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGrepTools } from "./grep-tools.js";

let tempDir: string | undefined;

async function makeTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "estacoda-grep-tools-test-"));
  return tempDir;
}

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("file.grep", () => {
  it("runs content mode with line numbers by default", async () => {
    const { root, argsPath } = await makeFakeRg("console.log('src/app.ts:1:Hello world');");
    const grep = createFakeGrep(root, argsPath);

    const result = await grep.run({ pattern: "Hello" });

    expect(result.ok).toBe(true);
    expect(result.content).toBe("src/app.ts:1:Hello world");
    expect(result.metadata).toMatchObject({
      pattern: "Hello",
      outputMode: "content",
      returned: 1,
      offset: 0,
      limit: 50,
      truncated: false,
      maxResultChars: 100_000,
      maxLineChars: 500,
      linesTruncated: 0,
      binaryFilesSkipped: "rg-default",
      maxFilesize: "2M"
    });
    const args = await readArgs(argsPath);
    expect(args).toContain("--with-filename");
    expect(args).toContain("-n");
    expect(args).toContain("-e");
    expect(args).toContain("Hello");
    expect(args.at(-1)).toBe(".");
  });

  it("supports files mode", async () => {
    const { root, argsPath } = await makeFakeRg("console.log('src/app.ts');");
    const grep = createFakeGrep(root, argsPath);

    const result = await grep.run({ pattern: "Hello", output_mode: "files" });

    expect(result.ok).toBe(true);
    expect(result.content).toBe("src/app.ts");
    expect(result.metadata?.outputMode).toBe("files");
    expect(await readArgs(argsPath)).toContain("-l");
  });

  it("supports count mode", async () => {
    const { root, argsPath } = await makeFakeRg("console.log('src/app.ts:2');");
    const grep = createFakeGrep(root, argsPath);

    const result = await grep.run({ pattern: "Hello", output_mode: "count" });

    expect(result.ok).toBe(true);
    expect(result.content).toBe("src/app.ts:2");
    expect(result.metadata?.outputMode).toBe("count");
    expect(await readArgs(argsPath)).toContain("-c");
  });

  it("passes a scoped file path to rg", async () => {
    const { root, argsPath } = await makeFakeRg("console.log('src/app.ts:1:Hello');");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "Hello", "utf8");
    const grep = createFakeGrep(root, argsPath);

    const result = await grep.run({ pattern: "Hello", path: "src/app.ts" });

    expect(result.ok).toBe(true);
    expect(result.metadata?.path).toBe("src/app.ts");
    expect((await readArgs(argsPath)).at(-1)).toBe("src/app.ts");
  });

  it("passes a scoped subdirectory path to rg", async () => {
    const { root, argsPath } = await makeFakeRg("console.log('src/app.ts:1:Hello');");
    await mkdir(join(root, "src"), { recursive: true });
    const grep = createFakeGrep(root, argsPath);

    const result = await grep.run({ pattern: "Hello", path: "src" });

    expect(result.ok).toBe(true);
    expect(result.metadata?.path).toBe("src");
    expect((await readArgs(argsPath)).at(-1)).toBe("src");
  });

  it("rejects traversal before spawning rg", async () => {
    const { root, argsPath } = await makeFakeRg("console.log('should-not-run');");
    const grep = createFakeGrep(root, argsPath);

    const result = await grep.run({ pattern: "Hello", path: "../outside" });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("outside the trusted workspace");
    await expect(readArgs(argsPath)).rejects.toBeDefined();
  });

  it("returns bad regex errors from rg", async () => {
    const { root, argsPath } = await makeFakeRg("console.error('regex parse error'); process.exit(2);");
    const grep = createFakeGrep(root, argsPath);

    const result = await grep.run({ pattern: "[" });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("regex parse error");
  });

  it("treats rg exit code 1 as a successful no-match result", async () => {
    const { root, argsPath } = await makeFakeRg("process.exit(1);");
    const grep = createFakeGrep(root, argsPath);

    const result = await grep.run({ pattern: "missing" });

    expect(result.ok).toBe(true);
    expect(result.content).toBe("No matches found.");
    expect(result.metadata).toMatchObject({
      returned: 0,
      truncated: false
    });
  });

  it("does not pass --hidden by default and passes it when requested", async () => {
    const first = await makeFakeRg("console.log('src/app.ts:1:Hello');");
    const grepHiddenOff = createFakeGrep(first.root, first.argsPath);
    await grepHiddenOff.run({ pattern: "Hello" });
    expect(await readArgs(first.argsPath)).not.toContain("--hidden");

    const second = await makeFakeRg("console.log('.hidden.ts:1:Hello');");
    const grepHiddenOn = createFakeGrep(second.root, second.argsPath);
    await grepHiddenOn.run({ pattern: "Hello", include_hidden: true });
    expect(await readArgs(second.argsPath)).toContain("--hidden");
  });

  it("filters sensitive outputs even when hidden files are included", async () => {
    const { root, argsPath } = await makeFakeRg([
      "console.log('.env:1:SECRET');",
      "console.log('secrets/private.key:1:SECRET');",
      "console.log('src/app.ts:1:Hello');"
    ].join("\n"));
    const grep = createFakeGrep(root, argsPath);

    const result = await grep.run({ pattern: "SECRET|Hello", include_hidden: true });

    expect(result.ok).toBe(true);
    expect(result.content).toBe("src/app.ts:1:Hello");
  });

  it("truncates long output lines", async () => {
    const longLine = `src/app.ts:1:${"x".repeat(700)}`;
    const { root, argsPath } = await makeFakeRg(`console.log(${JSON.stringify(longLine)});`);
    const grep = createFakeGrep(root, argsPath);

    const result = await grep.run({ pattern: "x", max_line_chars: 100 });

    expect(result.ok).toBe(true);
    expect(result.content.split("\n")[0]?.length).toBe(100);
    expect(result.metadata).toMatchObject({
      truncated: true,
      truncatedReason: "line_length",
      linesTruncated: 1,
      maxLineChars: 100
    });
  });

  it("truncates total rendered result size", async () => {
    const { root, argsPath } = await makeFakeRg([
      "console.log('src/app.ts:1:abcdefghijklmnopqrstuvwxyz');",
      "console.log('src/app.ts:2:abcdefghijklmnopqrstuvwxyz');"
    ].join("\n"));
    const grep = createFakeGrep(root, argsPath);

    const result = await grep.run({ pattern: "abc", max_result_chars: 30 });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Results truncated.");
    expect(result.metadata).toMatchObject({
      truncated: true,
      truncatedReason: "result_size"
    });
  });

  it("enforces limit and offset on logical result rows", async () => {
    const { root, argsPath } = await makeFakeRg([
      "console.log('src/app.ts:1:first');",
      "console.log('src/app.ts:2:second');",
      "console.log('src/app.ts:3:third');",
      "console.log('src/app.ts:4:fourth');"
    ].join("\n"));
    const grep = createFakeGrep(root, argsPath);

    const result = await grep.run({ pattern: "item", limit: 2, offset: 1 });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("src/app.ts:2:second");
    expect(result.content).toContain("src/app.ts:3:third");
    expect(result.content).not.toContain("src/app.ts:1:first");
    expect(result.metadata).toMatchObject({
      returned: 2,
      offset: 1,
      limit: 2,
      truncated: true,
      truncatedReason: "limit"
    });
  });

  it("passes glob, ignore_case, type, and context flags", async () => {
    const { root, argsPath } = await makeFakeRg("console.log('src/app.ts:1:Hello');");
    const grep = createFakeGrep(root, argsPath);

    await grep.run({
      pattern: "hello",
      glob: "*.ts",
      ignore_case: true,
      type: "ts",
      context: 2,
      before: 1,
      after: 1
    });

    const args = await readArgs(argsPath);
    expect(args).toContain("--glob");
    expect(args).toContain("*.ts");
    expect(args).toContain("-i");
    expect(args).toContain("--type");
    expect(args).toContain("ts");
    expect(args).toContain("-C");
    expect(args).toContain("2");
    expect(args).not.toContain("-B");
    expect(args).not.toContain("-A");
  });

  it("applies built-in exclusions after user glob so excluded paths cannot be re-included", async () => {
    const { root, argsPath } = await makeFakeRg("console.log('src/app.ts:1:Hello');");
    const grep = createFakeGrep(root, argsPath);

    await grep.run({ pattern: "secret", glob: ".env" });

    const args = await readArgs(argsPath);
    const userGlobIndex = globArgumentIndex(args, ".env");
    const envExclusionIndex = globArgumentIndex(args, "!.env");
    const nodeModulesExclusionIndex = globArgumentIndex(args, "!node_modules/**");
    expect(userGlobIndex).toBeGreaterThan(-1);
    expect(envExclusionIndex).toBeGreaterThan(userGlobIndex);
    expect(nodeModulesExclusionIndex).toBeGreaterThan(userGlobIndex);
  });

  it("passes before/after context flags when context is omitted", async () => {
    const { root, argsPath } = await makeFakeRg("console.log('src/app.ts:1:Hello');");
    const grep = createFakeGrep(root, argsPath);

    await grep.run({ pattern: "hello", before: 1, after: 2 });

    const args = await readArgs(argsPath);
    expect(args).toContain("-B");
    expect(args).toContain("1");
    expect(args).toContain("-A");
    expect(args).toContain("2");
  });

  it("passes multiline flags", async () => {
    const { root, argsPath } = await makeFakeRg("console.log('src/app.ts:1:Hello');");
    const grep = createFakeGrep(root, argsPath);

    await grep.run({ pattern: "hello", multiline: true });

    const args = await readArgs(argsPath);
    expect(args).toContain("-U");
    expect(args).toContain("--multiline-dotall");
  });

  it("returns a clear missing rg message", async () => {
    const root = await makeTempDir();
    const grep = createGrepTools({ workspaceRoot: root, rgCommand: "estacoda-rg-missing-for-test" })[0]!;

    const result = await grep.run({ pattern: "hello" });

    expect(result.ok).toBe(false);
    expect(result.content).toBe("ripgrep (rg) is not installed; use file.search as a fallback or install rg.");
  });

  it("kills the child process on timeout", async () => {
    const { root, argsPath } = await makeFakeRg("setTimeout(() => {}, 10_000);");
    const grep = createGrepTools({
      workspaceRoot: root,
      rgCommand: process.execPath,
      rgArgsPrefix: [join(root, "fake-rg.mjs"), argsPath],
      commandTimeoutMs: 20
    })[0]!;

    const result = await grep.run({ pattern: "hello" });

    expect(result.ok).toBe(false);
    expect(result.content).toBe("file.grep timed out.");
    expect(result.metadata).toMatchObject({
      truncated: true,
      truncatedReason: "timeout"
    });
  });
});

async function makeFakeRg(body: string): Promise<{ root: string; argsPath: string }> {
  const root = await makeTempDir();
  const argsPath = join(root, "args.json");
  await writeFile(join(root, "fake-rg.mjs"), [
    "const argsPath = process.argv[2];",
    "await import('node:fs/promises').then(({ writeFile }) => writeFile(argsPath, JSON.stringify(process.argv.slice(3)), 'utf8'));",
    body
  ].join("\n"), "utf8");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "secrets"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "Hello", "utf8");
  return { root, argsPath };
}

function createFakeGrep(root: string, argsPath: string) {
  return createGrepTools({
    workspaceRoot: root,
    rgCommand: process.execPath,
    rgArgsPrefix: [join(root, "fake-rg.mjs"), argsPath]
  })[0]!;
}

async function readArgs(path: string): Promise<string[]> {
  return JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8"))) as string[];
}

function globArgumentIndex(args: string[], pattern: string): number {
  return args.findIndex((arg, index) => arg === pattern && args[index - 1] === "--glob");
}
