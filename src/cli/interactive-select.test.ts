import { describe, expect, it, vi, afterEach } from "vitest";
import { PassThrough, Readable, Writable } from "node:stream";
import { selectOption, type SelectPromptInput } from "./interactive-select.js";
import { stripAnsi } from "../ui/renderers/layout.js";
import { isolateLtr, isolateRtl, LRI, PDI, RLI } from "../ui/bidi.js";

type TtyInput = PassThrough & {
  isTTY: true;
  setRawMode: (mode: boolean) => void;
  resume: () => TtyInput;
};

type CapturingOutput = Writable & NodeJS.WriteStream & {
  getText: () => string;
};

const ENV_KEYS = ["FORCE_COLOR", "NO_COLOR", "LANG", "LC_ALL", "TERM", "CI", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI"] as const;
const savedEnv = new Map<string, string | undefined>();

for (const key of ENV_KEYS) {
  savedEnv.set(key, process.env[key]);
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.restoreAllMocks();
});

function stripTrailingBidiControls(text: string): string {
  return text.replace(new RegExp(`[${LRI}${RLI}${PDI}]+$`, "gu"), "");
}

describe("interactive-select prompt card surface", () => {
  it("renders prompt cards while preserving arrow navigation and Enter confirmation", async () => {
    clearCiEnv();
    process.env.FORCE_COLOR = "1";
    process.env.LANG = "en_US.UTF-8";
    const { input, output } = makeTtyStreams();
    const pending = selectOption(input, output, promptCardSelection());

    await Promise.resolve();
    press(input, "\x1b[B");
    press(input, "\r");

    await expect(pending).resolves.toBe("skip");
    const rendered = stripAnsi(output.getText());
    expect(rendered).toContain("𓂀  Workspace trust");
    expect(rendered).toContain("▸ Not now");
    expect(rendered).not.toContain("Assistant");
  });

  it("keeps Ctrl+C cancellation routed through the existing selector path", async () => {
    clearCiEnv();
    const emitSpy = vi.spyOn(process, "emit").mockImplementation(((event: string) => event === "SIGINT") as typeof process.emit);
    const { input } = makeTtyStreams();
    void selectOption(input, makeTtyStreams().output, promptCardSelection());

    await Promise.resolve();
    press(input, "\x03");

    expect(emitSpy).toHaveBeenCalledWith("SIGINT");
  });

  it("selects TTY digit shortcuts through the Papyrus select keymap", async () => {
    clearCiEnv();
    const { input, output } = makeTtyStreams();
    const pending = selectOption(input, output, {
      ...promptCardSelection(),
      options: [
        { value: "trust", label: "Trust workspace" },
        { value: "skip", label: "Not now" },
        { value: "back", label: "Back", group: "navigation" },
      ],
    });

    await Promise.resolve();
    press(input, "3");

    await expect(pending).resolves.toBe("back");
    expect(stripAnsi(output.getText())).toContain("Selected: Back");
  });

  it("preserves setup-style cancel navigation through the Papyrus select keymap", async () => {
    clearCiEnv();
    const { input, output } = makeTtyStreams();
    const pending = selectOption(input, output, {
      ...promptCardSelection(),
      options: [
        { value: "trust", label: "Trust workspace" },
        { value: "back", label: "Back", group: "navigation" },
        { value: "cancel", label: "Cancel", group: "navigation" },
      ],
    });

    await Promise.resolve();
    press(input, "\x1b[B");
    press(input, "\x1b[B");
    press(input, "\r");

    await expect(pending).resolves.toBe("cancel");
    expect(stripAnsi(output.getText())).toContain("Selected: Cancel");
  });

  it("supports Papyrus home and end navigation in TTY mode", async () => {
    clearCiEnv();
    const { input, output } = makeTtyStreams();
    const pending = selectOption(input, output, promptCardSelection());

    await Promise.resolve();
    press(input, "\x1b[F");
    press(input, "\x1b[H");
    press(input, "\x1b[F");
    press(input, "\r");

    await expect(pending).resolves.toBe("skip");
    expect(stripAnsi(output.getText())).toContain("Selected: Not now");
  });

  it("keeps Papyrus TTY rendering usable in narrow terminals", async () => {
    clearCiEnv();
    const { input, output } = makeTtyStreams(32);
    const pending = selectOption(input, output, promptCardSelection());

    await Promise.resolve();
    press(input, "\r");

    await expect(pending).resolves.toBe("trust");
    const rendered = stripAnsi(output.getText());
    expect(rendered).toContain("Workspace trust");
    expect(rendered).toContain("Trust workspace");
  });

  it("renders no-color prompt cards without ANSI leakage", async () => {
    process.env.FORCE_COLOR = "0";
    const input = Readable.from(["\n"]);
    const output = makeOutput(false);

    await selectOption(input, output, promptCardSelection());

    const rendered = output.getText();
    expect(rendered).toContain("Workspace trust");
    expect(rendered).toContain("> Trust workspace");
    expect(/\x1B\[[0-?]*[ -/]*[@-~]/u.test(rendered)).toBe(false);
  });

  it("renders no-Unicode prompt cards with stable fallback markers", async () => {
    clearCiEnv();
    process.env.FORCE_COLOR = "1";
    process.env.LANG = "C";
    process.env.LC_ALL = "C";
    const { input, output } = makeTtyStreams();
    const pending = selectOption(input, output, promptCardSelection());

    await Promise.resolve();
    press(input, "\r");

    await expect(pending).resolves.toBe("trust");
    const rendered = stripAnsi(output.getText());
    expect(rendered).toContain("+---- *  Workspace trust");
    expect(rendered).toContain("> Trust workspace");
    expect(rendered).not.toContain("𓂀");
    expect(rendered).not.toContain("▸");
  });

  it("keeps plain prompt card fallback deterministic", async () => {
    const input = Readable.from(["\n"]);
    const output = makeOutput(false);

    await selectOption(input, output, promptCardSelection());

    expect(output.getText()).toContain([
      "Workspace trust",
      "Trust this workspace?",
      "/workspace",
      "",
      "> Trust workspace",
      "  Not now",
    ].join("\n"));
  });

  it("passes structured prompt-card table fields through plain fallback rendering", async () => {
    const input = Readable.from(["1\n"]);
    const output = makeOutput(false);

    const selected = await selectOption(input, output, {
      surface: "promptCard",
      title: "Choose mode",
      body: "Pick a generic mode.",
      bodyLineStyles: [{ emphasis: "strong" }],
      statusLines: [
        { text: "Current: Alpha", tone: "active", direction: "ltr" },
      ],
      showCurrentBadge: false,
      columns: [
        { key: "name", header: "Name" },
        { key: "description", header: "Description" },
      ],
      options: [
        {
          value: "alpha",
          label: "Alpha",
          cells: { name: "Alpha", description: "First generic option" },
          badges: ["Recommended"],
          current: true,
        },
        {
          value: "back",
          label: "Back",
          group: "navigation",
          cells: { name: "Back", description: "Return to previous step" },
        },
        {
          value: "cancel",
          label: "Cancel",
          group: "navigation",
          cells: { name: "Cancel", description: "Exit without changes" },
        },
      ],
      hint: "Type a number to choose.",
      fallbackPrompt: "Choose: ",
    });

    const rendered = output.getText();
    expect(selected).toBe("alpha");
    expect(rendered).toContain("Pick a generic mode.");
    expect(rendered).toContain("Name");
    expect(rendered).toContain("Description");
    expect(rendered).toContain("Current: Alpha");
    expect(rendered).toContain("> Alpha");
    expect(rendered).toContain("First generic option");
    expect(rendered).toContain("Recommended");
    expect(rendered).not.toContain("Recommended  Current");
    expect(rendered).toContain("Back");
    expect(rendered).toContain("Cancel");
    expect(rendered).toContain("Type a number to choose.");
    const lines = rendered.split("\n");
    const backIndex = lines.findIndex((line) => line.includes("Back"));
    const cancelIndex = lines.findIndex((line) => line.includes("Cancel"));
    expect(lines[backIndex - 1]).toBe("");
    expect(cancelIndex).toBe(backIndex + 1);
  });

  it("passes prompt-card showColumnHeaders through plain fallback rendering", async () => {
    const input = Readable.from(["1\n"]);
    const output = makeOutput(false);

    await selectOption(input, output, {
      surface: "promptCard",
      title: "Choose mode",
      body: "Pick a generic mode.",
      showColumnHeaders: false,
      columns: [
        { key: "name", header: "Name" },
        { key: "description", header: "Description" },
      ],
      options: [
        {
          value: "alpha",
          label: "Alpha",
          description: "First generic option",
        },
        {
          value: "beta",
          label: "Beta",
          description: "Second generic option",
        },
      ],
      hint: "↑↓ navigate   ENTER select   CTRL+C exit",
      fallbackPrompt: "Choose: ",
    });

    const rendered = output.getText();
    expect(rendered).not.toContain("  Name");
    expect(rendered).not.toContain("Description");
    expect(rendered).toContain("> Alpha");
    expect(rendered).toContain("First generic option");
    expect(rendered).toContain("↑↓ navigate   ENTER select   CTRL+C exit");
  });

  it("passes prompt-card table direction and column alignment through plain fallback rendering", async () => {
    const input = Readable.from(["1\n"]);
    const output = makeOutput(false);

    await selectOption(input, output, {
      surface: "promptCard",
      title: "اختر الوضع",
      body: "اختر وضعًا عامًا.",
      columns: [
        { key: "description", header: "التفاصيل", align: "right" },
        { key: "name", header: "الاسم", align: "right" },
      ],
      tableDirection: "rtl",
      tableWidth: "content",
      tableMaxWidth: 44,
      tableAlign: "right",
      locale: "ar",
      direction: "rtl",
      options: [
        {
          value: "alpha",
          label: "ألفا",
          cells: { description: "خيار عام", name: "ألفا" },
        },
      ],
      fallbackPrompt: "Choose: ",
    });

    const rendered = output.getText();
    const selectedLine = rendered.split("\n").find((line) => line.includes("ألفا"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain("خيار عام");
    expect(stripTrailingBidiControls(selectedLine!.trimEnd()).endsWith("<")).toBe(true);
    expect(selectedLine!.startsWith(" ".repeat(20))).toBe(true);
  });

  it("localizes and bolds Arabic selected output", async () => {
    clearCiEnv();
    process.env.FORCE_COLOR = "1";
    process.env.LANG = "ar_EG.UTF-8";
    const { input, output } = makeTtyStreams();
    const pending = selectOption(input, output, arabicPromptCardSelection());

    await Promise.resolve();
    press(input, "\r");

    await expect(pending).resolves.toBe("yes");
    const rendered = output.getText();
    const plain = stripAnsi(rendered);
    expect(plain).toContain(isolateRtl(`تم تحديد: ${isolateRtl("نعم")}`));
    expect(plain).not.toContain("Selected:");
    expect(rendered).toContain("\x1b[1mتم تحديد\x1b[22m");
  });

  it("isolates Arabic selected technical values", async () => {
    clearCiEnv();
    process.env.FORCE_COLOR = "1";
    process.env.LANG = "ar_EG.UTF-8";
    const { input, output } = makeTtyStreams();
    const pending = selectOption(input, output, {
      ...arabicPromptCardSelection(),
      options: [{ value: "model", label: "deepseek-v4-pro", technical: true }],
    });

    await Promise.resolve();
    press(input, "\r");

    await expect(pending).resolves.toBe("model");
    expect(stripAnsi(output.getText())).toContain(isolateRtl(`تم تحديد: ${isolateLtr("deepseek-v4-pro")}`));
  });

  it("keeps mixed technical-token selected output line-level RTL", async () => {
    clearCiEnv();
    process.env.FORCE_COLOR = "1";
    process.env.LANG = "ar_EG.UTF-8";
    const { input, output } = makeTtyStreams();
    const pending = selectOption(input, output, {
      ...arabicPromptCardSelection(),
      options: [{ value: "telegram", label: "Telegram", technical: true }],
    });

    await Promise.resolve();
    press(input, "\r");

    await expect(pending).resolves.toBe("telegram");
    expect(stripAnsi(output.getText())).toContain(isolateRtl(`تم تحديد: ${isolateLtr("Telegram")}`));
  });

  it("keeps selected output readable without ANSI color", async () => {
    clearCiEnv();
    process.env.FORCE_COLOR = "0";
    const { input, output } = makeTtyStreams();
    const pending = selectOption(input, output, promptCardSelection());

    await Promise.resolve();
    press(input, "\r");

    await expect(pending).resolves.toBe("trust");
    const rendered = output.getText();
    expect(rendered).toContain("Selected: Trust workspace");
    expect(rendered).not.toContain("\x1b[1mSelected\x1b[22m");
  });
});

function promptCardSelection(): SelectPromptInput<string> {
  return {
    surface: "promptCard",
    locale: "en",
    direction: "ltr",
    title: "Workspace trust",
    body: "Trust this workspace?",
    technicalLines: ["/workspace"],
    instruction: "Use arrows.",
    selectedLabel: "Selected",
    defaultIndex: 0,
    options: [
      { value: "trust", label: "Trust workspace" },
      { value: "skip", label: "Not now" },
    ],
    fallbackPrompt: "Enter choice number [default: 1 Trust workspace]: ",
  };
}

function arabicPromptCardSelection(): SelectPromptInput<string> {
  return {
    surface: "promptCard",
    locale: "ar",
    direction: "rtl",
    title: "تشغيل EstaCoda",
    body: "هل تريد تشغيل EstaCoda الآن؟",
    instruction: "استخدم الأسهم.",
    defaultIndex: 0,
    options: [
      { value: "yes", label: "نعم", description: "ابدأ الجلسة." },
      { value: "no", label: "لا", description: "ابق في الإعداد." },
    ],
    fallbackPrompt: "اختر رقمًا: ",
  };
}

function clearCiEnv(): void {
  delete process.env.NO_COLOR;
  process.env.TERM = "xterm-256color";
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  delete process.env.GITLAB_CI;
  delete process.env.CIRCLECI;
}

function makeTtyStreams(columns = 80): { input: TtyInput; output: CapturingOutput } {
  const input = new PassThrough() as TtyInput;
  input.isTTY = true;
  input.setRawMode = vi.fn();
  input.resume = vi.fn(() => input);
  return { input, output: makeOutput(true, columns) };
}

function press(input: TtyInput, sequence: string): void {
  input.emit("data", sequence);
}

function makeOutput(isTTY: boolean, columns = 80): CapturingOutput {
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    }
  }) as CapturingOutput;
  output.isTTY = isTTY;
  output.columns = columns;
  output.getText = () => text;
  return output;
}
