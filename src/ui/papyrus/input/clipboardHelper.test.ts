import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createClipboardHelper,
  type ClipboardSource,
} from "./clipboardHelper.js";

describe("Papyrus clipboard helper", () => {
  it("is disabled by default and does not read the injected source", async () => {
    const source = textSource("hello");
    const helper = createClipboardHelper({ source });

    await expect(helper.readText()).resolves.toEqual({
      type: "unavailable",
      reason: "Clipboard helper is disabled",
    });
    expect(source.readText).not.toHaveBeenCalled();
  });

  it("does not read automatically during construction", () => {
    const source = textSource("hello");

    createClipboardHelper({ source, enabled: true });

    expect(source.readText).not.toHaveBeenCalled();
  });

  it("reads text through an injected source when enabled", async () => {
    const source = textSource("hello");
    const helper = createClipboardHelper({ source, enabled: true });

    await expect(helper.readText()).resolves.toEqual({
      type: "text",
      text: "hello",
    });
    expect(source.readText).toHaveBeenCalledWith({ signal: undefined });
  });

  it("handles empty clipboard text as empty data", async () => {
    const helper = createClipboardHelper({ source: textSource(""), enabled: true });

    await expect(helper.readText()).resolves.toEqual({ type: "empty" });
  });

  it("rejects text beyond the configured maximum length", async () => {
    const helper = createClipboardHelper({
      source: textSource("123456"),
      enabled: true,
      maxTextLength: 5,
    });

    await expect(helper.readText()).resolves.toEqual({
      type: "unavailable",
      reason: "Clipboard text exceeds the configured maximum length",
    });
  });

  it("returns unavailable data for binary, image, or unknown payloads", async () => {
    const helper = createClipboardHelper({
      source: {
        read: vi.fn(() => ({ type: "binary" as const, byteLength: 8 })),
      },
      enabled: true,
    });

    await expect(helper.readText()).resolves.toEqual({
      type: "unavailable",
      reason: "Clipboard does not contain text",
    });
  });

  it("filters sensitive-looking clipboard text by default", async () => {
    for (const text of [
      "password=secret",
      "token=secret",
      "api_key=secret",
      "SECRET=value",
    ]) {
      const helper = createClipboardHelper({ source: textSource(text), enabled: true });

      await expect(helper.readText()).resolves.toEqual({
        type: "unavailable",
        reason: "Clipboard text was filtered",
      });
    }
  });

  it("supports an injected text filter", async () => {
    const helper = createClipboardHelper({
      source: textSource("private note"),
      enabled: true,
      filterText: (text) => !text.includes("private"),
    });

    await expect(helper.readText()).resolves.toEqual({
      type: "unavailable",
      reason: "Clipboard text was filtered",
    });
  });

  it("represents source errors as data", async () => {
    const helper = createClipboardHelper({
      source: {
        readText: vi.fn(() => {
          throw new Error("clipboard unavailable");
        }),
      },
      enabled: true,
    });

    await expect(helper.readText()).resolves.toEqual({
      type: "error",
      error: {
        message: "clipboard unavailable",
        recoverable: true,
      },
    });
  });

  it("returns canceled data when the signal is already aborted", async () => {
    const source = textSource("hello");
    const helper = createClipboardHelper({ source, enabled: true });
    const controller = new AbortController();
    controller.abort();

    await expect(helper.readText(controller.signal)).resolves.toEqual({
      type: "canceled",
      canceled: true,
    });
    expect(source.readText).not.toHaveBeenCalled();
  });

  it("does not use process, filesystem, shell commands, telemetry, or global clipboard APIs", () => {
    const source = readFileSync(fileURLToPath(new URL("./clipboardHelper.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/\bprocess\b|\bnode:fs\b|\bfs\b|\bchild_process\b/u);
    expect(source).not.toMatch(/\bspawn\s*\(|\bexec\s*\(|\bexecFile\s*\(/u);
    expect(source).not.toMatch(/\bclipboardy\b|\bnavigator\.clipboard\b|\bpasteboard\b|\bpbpaste\b/u);
    expect(source).not.toMatch(/\btelemetry\b|\banalytics\b/u);
  });
});

function textSource(text: string): ClipboardSource & { readonly readText: ReturnType<typeof vi.fn> } {
  return {
    readText: vi.fn(() => text),
  };
}
