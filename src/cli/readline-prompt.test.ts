import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { promptUiContextForLocale } from "../contracts/ui.js";
import { isolateLtr } from "../ui/bidi.js";
import { createFilePasteReferenceStore } from "./paste-interceptor.js";
import { createReadlinePrompt, withPromptUiContext, type Prompt } from "./readline-prompt.js";

describe("readline prompt UI context", () => {
  it("applies default locale and direction to select rendering", async () => {
    const input = Readable.from(["1\n"]);
    const output = captureOutput();
    const prompt = createReadlinePrompt({
      input,
      output,
      uiContext: promptUiContextForLocale("ar"),
    });

    await prompt.select!({
      title: "الثقة بمساحة العمل",
      body: "هل تثق بمساحة العمل هذه؟",
      technicalLines: ["/workspace"],
      options: [{ value: "trust", label: "ثق بمساحة العمل" }],
      fallbackPrompt: "Choose: ",
      surface: "promptCard",
    });

    expect(output.text()).toContain(isolateLtr("/workspace"));
  });

  it("lets direct select overrides win over prompt defaults", async () => {
    const seen: Array<{ locale?: string; direction?: string }> = [];
    const base = Object.assign(
      async () => "",
      {
        uiContext: promptUiContextForLocale("en"),
        select: async <T>(input: { locale?: string; direction?: string; options: Array<{ value: T }> }): Promise<T> => {
          seen.push({ locale: input.locale, direction: input.direction });
          return input.options[0]!.value;
        },
        close: () => undefined,
      }
    ) as Prompt;
    const prompt = withPromptUiContext(base, promptUiContextForLocale("ar"));

    await prompt.select!({
      title: "Language",
      options: [{ value: "en", label: "English" }],
      fallbackPrompt: "Choose: ",
      surface: "promptCard",
      locale: "en",
      direction: "ltr",
    });

    expect(seen).toEqual([{ locale: "en", direction: "ltr" }]);
  });
});

describe("readline prompt bracketed paste", () => {
  it("leaves plain input unchanged", async () => {
    const prompt = createReadlinePrompt({
      input: ttyInput(["hello world\n"]),
      output: captureOutput({ isTTY: true }),
    });

    await expect(prompt("> ")).resolves.toBe("hello world");
  });

  it("renders idle placeholder text and clears it when typing starts", async () => {
    const output = captureOutput({ isTTY: true });
    const input = ttyInteractiveInput();
    const prompt = createReadlinePrompt({
      input,
      output,
    });

    const answer = prompt("> ", { placeholder: "/help", onRowsChange: () => undefined });
    await waitFor(() => output.text().includes("/help\x1b[5D"));
    input.write("h\n");
    await expect(answer).resolves.toBe("h");

    expect(output.text()).toContain("/help\x1b[5D");
    expect(output.text()).toContain("\x1b[0K");
  });

  it("preserves manually typed paste marker text", async () => {
    const prompt = createReadlinePrompt({
      input: ttyInput(["a ↵ b\n"]),
      output: captureOutput({ isTTY: true }),
    });

    await expect(prompt("> ")).resolves.toBe("a ↵ b");
  });

  it("restores multiline pasted text in the returned answer", async () => {
    const seen: Array<{ original: string; displayed: string }> = [];
    const prompt = createReadlinePrompt({
      input: ttyInput(["\x1b[200~line 1\nline 2\x1b[201~\n"]),
      output: captureOutput({ isTTY: true }),
    });

    await expect(prompt("> ", {
      onPastePreview: (original, displayed) => seen.push({ original, displayed }),
    })).resolves.toBe("line 1\nline 2");
    expect(seen).toEqual([{ original: "line 1\nline 2", displayed: "line 1 ↵ line 2" }]);
  });

  it("displays multiline paste as a compact reference while returning the original content", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "estacoda-readline-paste-"));
    try {
      const seen: Array<{ original: string; displayed: string }> = [];
      const prompt = createReadlinePrompt({
        input: ttyInput(["\x1b[200~line 1\nline 2\x1b[201~\n"]),
        output: captureOutput({ isTTY: true }),
      });

      await expect(prompt("> ", {
        onPastePreview: (original, displayed) => seen.push({ original, displayed }),
        pasteReferenceStore: createFilePasteReferenceStore({ directory: tempDir }),
      })).resolves.toBe("line 1\nline 2");

      expect(seen).toHaveLength(1);
      expect(seen[0]?.original).toBe("line 1\nline 2");
      expect(seen[0]?.displayed).toMatch(/^\[Pasted text #\d+: 2 lines → /u);
      const path = seen[0]?.displayed.match(/→ (.*)\]$/u)?.[1];
      expect(path).toBeDefined();
      await expect(readFile(path!, "utf8")).resolves.toBe("line 1\nline 2");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves typed prefix and suffix around a paste", async () => {
    const prompt = createReadlinePrompt({
      input: ttyInput(["prefix \x1b[200~a\nb\x1b[201~ suffix\n"]),
      output: captureOutput({ isTTY: true }),
    });

    await expect(prompt("> ")).resolves.toBe("prefix a\nb suffix");
  });

  it("preserves multiple paste regions", async () => {
    const prompt = createReadlinePrompt({
      input: ttyInput(["one \x1b[200~a\nb\x1b[201~ two \x1b[200~c\nd\x1b[201~ three\n"]),
      output: captureOutput({ isTTY: true }),
    });

    await expect(prompt("> ")).resolves.toBe("one a\nb two c\nd three");
  });

  it("handles split bracket markers", async () => {
    const prompt = createReadlinePrompt({
      input: ttyInput(["prefix \x1b[2", "00~a\nb\x1b[20", "1~ suffix\n"]),
      output: captureOutput({ isTTY: true }),
    });

    await expect(prompt("> ")).resolves.toBe("prefix a\nb suffix");
  });

  it("does not emit paste previews for secret prompts", async () => {
    const seen: string[] = [];
    const prompt = createReadlinePrompt({
      input: ttyInput(["secret-value\n"]),
      output: captureOutput({ isTTY: true }),
    });

    await expect(prompt("> ", {
      secret: true,
      onPastePreview: (original) => seen.push(original),
    })).resolves.toBe("secret-value");
    expect(seen).toEqual([]);
  });

  it("does not persist paste references for secret prompts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "estacoda-readline-secret-paste-"));
    try {
      const prompt = createReadlinePrompt({
        input: ttyInput(["secret-value\n"]),
        output: captureOutput({ isTTY: true }),
      });

      await expect(prompt("> ", {
        secret: true,
        pasteReferenceStore: createFilePasteReferenceStore({ directory: tempDir }),
      })).resolves.toBe("secret-value");
      await expect(readdir(tempDir)).resolves.toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("readline prompt special keys", () => {
  it("handles parsed special keys when the controller is active", async () => {
    const input = ttyInteractiveInput();
    const output = captureOutput({ isTTY: true });
    const seen: string[] = [];
    const prompt = createReadlinePrompt({ input, output });

    const answer = prompt("> ", {
      onRowsChange: () => undefined,
      specialKeyController: {
        shouldHandleSpecialKey: () => true,
        onSpecialKey: (key) => {
          seen.push(key);
          return "handled";
        },
      },
    });
    await waitFor(() => output.text().length > 0);
    input.write("\x1b[A");
    input.write("\x1b[B");
    input.write("\t");
    input.write("\n");

    await expect(answer).resolves.toBe("");
    expect(seen).toEqual(["up", "down", "tab"]);
  });

  it("lets special keys fall through when the controller is inactive", async () => {
    const input = ttyInteractiveInput();
    const output = captureOutput({ isTTY: true });
    const seen: string[] = [];
    const prompt = createReadlinePrompt({ input, output });

    const answer = prompt("> ", {
      onRowsChange: () => undefined,
      specialKeyController: {
        shouldHandleSpecialKey: () => false,
        onSpecialKey: (key) => {
          seen.push(key);
          return "handled";
        },
      },
    });
    await waitFor(() => output.text().length > 0);
    input.write("\x1b[A");
    input.write("typed\n");

    await expect(answer).resolves.toBe("typed");
    expect(seen).toEqual([]);
  });

  it("lets handlers update the live readline input line synchronously", async () => {
    const input = ttyInteractiveInput();
    const output = captureOutput({ isTTY: true });
    const changes: string[] = [];
    const prompt = createReadlinePrompt({ input, output });

    const answer = prompt("> ", {
      onRowsChange: () => undefined,
      onInputChange: (line) => changes.push(line),
      specialKeyController: {
        shouldHandleSpecialKey: () => true,
        onSpecialKey: (key, control) => {
          if (key !== "tab") return undefined;
          control.setInputLine("/help");
          return "handled";
        },
      },
    });
    await waitFor(() => output.text().length > 0);
    input.write("\t");
    await waitFor(() => changes.includes("/help"));
    input.write("\n");

    await expect(answer).resolves.toBe("/help");
    expect(changes).toContain("/help");
  });

  it("does not install special-key handling for hidden secret prompts", async () => {
    const input = ttyInteractiveInput();
    const output = captureOutput({ isTTY: true });
    const seen: string[] = [];
    const prompt = createReadlinePrompt({ input, output });

    const answer = prompt("> ", {
      secret: true,
      specialKeyController: {
        shouldHandleSpecialKey: () => true,
        onSpecialKey: (key) => {
          seen.push(key);
          return "handled";
        },
      },
    });
    await waitFor(() => output.text().length > 0);
    input.write("\x1b[Asecret-value\n");

    await expect(answer).resolves.toBe("secret-value");
    expect(seen).toEqual([]);
  });

  it("restores special-key handling after a prompt resolves", async () => {
    const input = ttyInteractiveInput();
    const output = captureOutput({ isTTY: true });
    const seen: string[] = [];
    const prompt = createReadlinePrompt({ input, output });

    const first = prompt("> ", {
      onRowsChange: () => undefined,
      specialKeyController: {
        shouldHandleSpecialKey: () => true,
        onSpecialKey: (key) => {
          seen.push(key);
          return "handled";
        },
      },
    });
    await waitFor(() => output.text().length > 0);
    input.write("\t\n");
    await expect(first).resolves.toBe("");

    const second = prompt("> ", { onRowsChange: () => undefined });
    input.write("next\n");
    await expect(second).resolves.toBe("next");
    expect(seen).toEqual(["tab"]);
  });

  it("restores special-key handling when tracked readline closes before answering", async () => {
    vi.resetModules();
    const originalTtyWrite = vi.fn();
    const mockReadline = Object.assign(new EventEmitter(), {
      line: "",
      cursor: 0,
      _ttyWrite: originalTtyWrite,
      _refreshLine: vi.fn(),
      _writeToOutput: vi.fn(),
      getCursorPos: () => ({ rows: 0, cols: 0 }),
      question: vi.fn(),
      close: vi.fn(function close(this: EventEmitter) {
        this.emit("close");
      }),
    });
    vi.doMock("node:readline", () => ({
      createInterface: () => mockReadline,
    }));
    try {
      const { createReadlinePrompt: createMockedReadlinePrompt } = await import("./readline-prompt.js");
      const input = ttyInteractiveInput();
      const output = captureOutput({ isTTY: true });
      const prompt = createMockedReadlinePrompt({ input, output });

      void prompt("> ", {
        onRowsChange: () => undefined,
        specialKeyController: {
          shouldHandleSpecialKey: () => true,
          onSpecialKey: () => "handled",
        },
      });

      await waitFor(() => mockReadline._ttyWrite !== originalTtyWrite);
      mockReadline.emit("close");

      expect(mockReadline._ttyWrite).toBe(originalTtyWrite);
    } finally {
      vi.doUnmock("node:readline");
      vi.resetModules();
    }
  });
});

function captureOutput(options: { isTTY?: boolean } = {}): Writable & { text: () => string } {
  let value = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        value += String(chunk);
        callback();
      },
    }),
    { text: () => value }
  );
  if (options.isTTY !== undefined) {
    Object.assign(output, { isTTY: options.isTTY });
  }
  return output;
}

function ttyInput(chunks: string[]): Readable {
  let isRaw = false;
  return Object.assign(
    Readable.from(chunks),
    {
      isTTY: true,
      get isRaw() {
        return isRaw;
      },
      setRawMode(mode: boolean) {
        isRaw = mode;
        return this;
      },
    }
  );
}

function ttyInteractiveInput(): PassThrough & {
  isTTY: true;
  isRaw: boolean;
  setRawMode(mode: boolean): unknown;
} {
  let isRaw = false;
  const input = Object.assign(
    new PassThrough(),
    {
      isTTY: true as const,
      get isRaw() {
        return isRaw;
      },
      setRawMode(mode: boolean) {
        isRaw = mode;
        return input;
      },
    }
  );
  return input;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition");
}
