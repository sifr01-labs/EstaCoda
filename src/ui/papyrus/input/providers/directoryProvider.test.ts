import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSuggestionTokenContext } from "../suggestionTypes.js";
import {
  createDirectorySuggestionProvider,
  DIRECTORY_SUGGESTION_PROVIDER_ID,
  type DirectoryProviderEntry,
  type DirectoryProviderFileSystem,
} from "./directoryProvider.js";

const cwd = resolve("/workspace/app");
const workspaceRoot = resolve("/workspace/app");

describe("Papyrus directory suggestion provider", () => {
  it("returns bounded directory suggestions for ./", async () => {
    const provider = createDirectorySuggestionProvider({
      fs: fakeFs({
        [cwd]: [dir("src"), dir("docs"), file("README.md")],
      }),
      cwd,
      workspaceRoot,
      maxSuggestions: 2,
    });

    const result = await provider.getSuggestions(pathContext("./"));

    expect(result.type).toBe("success");
    expect(result.providerId).toBe(DIRECTORY_SUGGESTION_PROVIDER_ID);
    expect(result.suggestions.map((suggestion) => suggestion.label)).toEqual(["src/", "docs/"]);
    expect(result.suggestions.map((suggestion) => suggestion.replacementText)).toEqual(["./src/", "./docs/"]);
  });

  it("handles ../ within the workspace safely", async () => {
    const provider = createDirectorySuggestionProvider({
      fs: fakeFs({
        [workspaceRoot]: [dir("packages"), dir("docs")],
      }),
      cwd: resolve(workspaceRoot, "src"),
      workspaceRoot,
    });

    const result = await provider.getSuggestions(pathContext("../"));

    expect(result.type).toBe("success");
    expect(result.suggestions.map((suggestion) => suggestion.replacementText)).toEqual([
      "../packages/",
      "../docs/",
    ]);
  });

  it("prevents escaping above the workspace root", async () => {
    const reads: string[] = [];
    const provider = createDirectorySuggestionProvider({
      fs: fakeFs({
        [resolve("/workspace")]: [dir("outside")],
      }, { reads }),
      cwd,
      workspaceRoot,
    });

    const result = await provider.getSuggestions(pathContext("../"));

    expect(result.type).toBe("empty");
    expect(result.suggestions).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("hides dot directories unless the query prefix begins with a dot", async () => {
    const fs = fakeFs({
      [cwd]: [dir(".config"), dir("src")],
    });
    const provider = createDirectorySuggestionProvider({ fs, cwd, workspaceRoot });

    expect((await provider.getSuggestions(pathContext("./"))).suggestions.map((suggestion) => suggestion.label)).toEqual([
      "src/",
    ]);
    expect((await provider.getSuggestions(pathContext("./."))).suggestions.map((suggestion) => suggestion.label)).toEqual([
      ".config/",
    ]);
  });

  it("represents permission errors as provider error data", async () => {
    const provider = createDirectorySuggestionProvider({
      fs: fakeFs({
        [cwd]: Object.assign(new Error("permission denied"), { code: "EACCES" }),
      }),
      cwd,
      workspaceRoot,
    });

    const result = await provider.getSuggestions(pathContext("./"));

    expect(result).toMatchObject({
      type: "error",
      error: {
        message: "permission denied",
        code: "EACCES",
        recoverable: true,
      },
    });
  });

  it("handles non-directory bases as empty data", async () => {
    const provider = createDirectorySuggestionProvider({
      fs: fakeFs({
        [resolve(cwd, "README.md")]: Object.assign(new Error("not a directory"), { code: "ENOTDIR" }),
      }),
      cwd,
      workspaceRoot,
    });

    const result = await provider.getSuggestions(pathContext("README.md/"));

    expect(result.type).toBe("empty");
    expect(result.suggestions).toEqual([]);
  });

  it("enforces max entries read before suggestion limiting", async () => {
    const limits: number[] = [];
    const provider = createDirectorySuggestionProvider({
      fs: fakeFs({
        [cwd]: [dir("a"), dir("b"), dir("c")],
      }, { limits }),
      cwd,
      workspaceRoot,
      maxEntriesToRead: 2,
      maxSuggestions: 10,
    });

    const result = await provider.getSuggestions(pathContext("./"));

    expect(limits).toEqual([2]);
    expect(result.suggestions.map((suggestion) => suggestion.label)).toEqual(["a/", "b/"]);
  });

  it("enforces max suggestions returned", async () => {
    const provider = createDirectorySuggestionProvider({
      fs: fakeFs({
        [cwd]: [dir("a"), dir("b"), dir("c")],
      }),
      cwd,
      workspaceRoot,
      maxEntriesToRead: 10,
      maxSuggestions: 1,
    });

    const result = await provider.getSuggestions(pathContext("./"));

    expect(result.suggestions.map((suggestion) => suggestion.label)).toEqual(["a/"]);
  });

  it("returns canceled data when the signal is already aborted", async () => {
    const reads: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const provider = createDirectorySuggestionProvider({
      fs: fakeFs({ [cwd]: [dir("src")] }, { reads }),
      cwd,
      workspaceRoot,
    });

    const result = await provider.getSuggestions(pathContext("./"), controller.signal);

    expect(result.type).toBe("canceled");
    expect(result.suggestions).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("does not use shell, process, or command-backed lookup helpers", () => {
    const source = readFileSync(fileURLToPath(new URL("./directoryProvider.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/child_process|spawn|execFile|ripgrep|rg\s|git\s|process\./i);
  });
});

function pathContext(token: string) {
  return createSuggestionTokenContext({
    input: token,
    cursorOffset: token.length,
    tokenRange: { start: 0, end: token.length },
    triggerKind: "path",
  });
}

function dir(name: string): DirectoryProviderEntry {
  return { name, kind: "directory" };
}

function file(name: string): DirectoryProviderEntry {
  return { name, kind: "file" };
}

function fakeFs(
  entriesByPath: Record<string, readonly DirectoryProviderEntry[] | Error>,
  observed: {
    readonly reads?: string[];
    readonly limits?: number[];
  } = {}
): DirectoryProviderFileSystem {
  return {
    readdir(path, options) {
      observed.reads?.push(path);
      observed.limits?.push(options.limit);
      const result = entriesByPath[path];
      if (result instanceof Error) throw result;
      if (result === undefined) {
        throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
      }
      return result;
    },
  };
}
