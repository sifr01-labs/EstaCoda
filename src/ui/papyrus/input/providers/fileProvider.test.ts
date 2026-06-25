import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSuggestionTokenContext } from "../suggestionTypes.js";
import {
  createFileSuggestionProvider,
  FILE_SUGGESTION_PROVIDER_ID,
} from "./fileProvider.js";

describe("Papyrus file suggestion provider skeleton", () => {
  it("returns deferred unavailable suggestion data without indexing", async () => {
    const provider = createFileSuggestionProvider();
    const result = await provider.getSuggestions(pathContext("src/"));

    expect(result.type).toBe("success");
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      id: "file:deferred",
      label: "File suggestions unavailable",
      replacementText: "src/",
      providerId: FILE_SUGGESTION_PROVIDER_ID,
      kind: "file",
      availability: {
        state: "unavailable",
      },
      metadata: {
        deferred: true,
      },
    });
  });

  it("returns canceled data when the signal is already aborted", async () => {
    const provider = createFileSuggestionProvider();
    const controller = new AbortController();
    controller.abort();

    const result = await provider.getSuggestions(pathContext("src/"), controller.signal);

    expect(result.type).toBe("canceled");
    expect(result.suggestions).toEqual([]);
  });

  it("does not index workspaces or use command-backed lookup helpers", () => {
    const source = readFileSync(fileURLToPath(new URL("./fileProvider.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/child_process|spawn|execFile|ripgrep|rg\s|git\s|readdir|process\./i);
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
