import { describe, expect, it, vi, afterEach } from "vitest";
import { PassThrough, Readable, Writable } from "node:stream";
import { selectOption, type SelectPromptInput } from "./interactive-select.js";
import { measureVisibleWidth, stripAnsi } from "../ui/renderers/layout.js";
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
    const { input, output } = makeTtyStreams();
    void selectOption(input, output, promptCardSelection());

    await Promise.resolve();
    press(input, "\x03");

    expect(emitSpy).toHaveBeenCalledWith("SIGINT");
    expect(output.getText()).toContain("\x1b[?25h");
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

  it("routes TTY setup provider/model tables through the Papyrus setup panel", async () => {
    clearCiEnv();
    const { input, output } = makeTtyStreams(96);
    const pending = selectOption(input, output, setupPanelSelection());

    await Promise.resolve();
    press(input, "\x1b[B");
    press(input, "\r");

    await expect(pending).resolves.toBe("local");
    const rendered = stripAnsi(output.getText());
    const latestFrame = stripAnsi(latestRenderedFrame(output.getText()));
    expect(rendered).toContain("╭─ Model route");
    expect(rendered).toContain("Choose the active provider and model route.");
    expect(rendered).toContain("Provider");
    expect(rendered).toContain("Model");
    expect(rendered).toContain("Status");
    expect(rendered).toContain("Notes");
    expect(rendered).toContain("gpt-5.5");
    expect(rendered).toContain("qwen3-coder");
    expect(rendered).toContain("↑↓ navigate · Enter select · / filter · Esc back");
    expect(latestFrame).toContain("❯ Local");
    expect(latestFrame).not.toContain("❯ OpenAI");
    expect(rendered).toContain("Selected: Local");
  });

  it("hides the cursor during structured TTY setup selects and restores it on exit", async () => {
    clearCiEnv();
    const { input, output } = makeTtyStreams(96);
    const pending = selectOption(input, output, setupPanelSelection());

    await Promise.resolve();
    press(input, "\x1b[B");
    press(input, "\r");

    await expect(pending).resolves.toBe("local");
    expect(output.getText()).not.toMatch(/\x1B7|\x1B8|\x1B\[J|\x1B\[s|\x1B\[u/u);
    expect(output.getText()).toContain("\x1b[?25l");
    expect(output.getText()).toContain("\x1b[?25h");
    expect(output.getText().indexOf("\x1b[?25l")).toBeLessThan(output.getText().lastIndexOf("\x1b[?25h"));
    expect(output.getText()).toContain("\x1b[0K");
  });

  it("keeps setup panel selection stable across redraw-width changes", async () => {
    clearCiEnv();
    const { input, output } = makeTtyStreams(96);
    const pending = selectOption(input, output, setupPanelSelection());

    await Promise.resolve();
    press(input, "\x1b[B");
    output.columns = 44;
    press(input, "\x1b[B");
    press(input, "\x1b[A");
    press(input, "\r");

    await expect(pending).resolves.toBe("local");
    const latestFrame = stripAnsi(latestRenderedFrame(output.getText()));
    expect(latestFrame).toContain("❯ Local");
    expect(latestFrame).toContain("qwen3-coder");
  });

  it("renders narrow TTY setup selections as compact setup panels", async () => {
    clearCiEnv();
    const { input, output } = makeTtyStreams(44);
    const pending = selectOption(input, output, setupPanelSelection());

    await Promise.resolve();
    press(input, "\r");

    await expect(pending).resolves.toBe("openai");
    const latestFrame = stripAnsi(latestRenderedFrame(output.getText()));
    expect(latestFrame).toContain("❯ OpenAI");
    expect(latestFrame).toContain("gpt-5.5");
    expect(latestFrame).toContain("ready · API key set");
    expect(latestFrame).toContain("Local");
    expect(latestFrame.split("\n").every((line) => measureVisibleWidth(line) <= 44)).toBe(true);
  });

  it("renders Arabic TTY setup panels while preserving technical tokens", async () => {
    clearCiEnv();
    process.env.LANG = "ar_EG.UTF-8";
    const { input, output } = makeTtyStreams(80);
    const pending = selectOption(input, output, arabicSetupPanelSelection());

    await Promise.resolve();
    press(input, "\r");

    await expect(pending).resolves.toBe("openai");
    const latestFrame = stripAnsi(latestRenderedFrame(output.getText()));
    expect(latestFrame).toContain("إعداد النموذج");
    expect(latestFrame).toContain("المزود");
    expect(latestFrame).toContain("النموذج");
    expect(latestFrame).toContain("الحالة");
    expect(latestFrame).toContain("OpenAI");
    expect(latestFrame).toContain("gpt-5.5");
    expect(latestFrame).toContain("Local");
    expect(latestFrame).toContain("qwen3-coder");
    expect(latestFrame).toContain("URL");
    expect(latestFrame).toContain("API key");
    expect(latestFrame).toContain("Enter");
    expect(latestFrame).toContain("Esc");
  });

  it("routes two-column setup choices without cells through the Papyrus setup menu", async () => {
    clearCiEnv();
    process.env.LANG = "ar_EG.UTF-8";
    const { input, output } = makeTtyStreams(120);
    const pending = selectOption(input, output, arabicSetupChoiceMenuSelection());

    await Promise.resolve();
    press(input, "\x1b[B");
    press(input, "\r");

    await expect(pending).resolves.toBe("fallback");
    const latestFrame = stripAnsi(latestRenderedFrame(output.getText()));
    expect(latestFrame).toContain("╭─ محرّر الإعدادات");
    expect(latestFrame).toContain("اختار اللي تحب تضبطه:");
    expect(latestFrame).toContain("النموذج الافتراضي الذي يستخدمه الوكيل.");
    expect(latestFrame).toContain("النموذج الأساسي");
    expect(latestFrame).toContain("◂");
    expect(latestFrame).not.toContain("𓂀");
    expect(latestFrame).not.toContain("المزود");
    expect(latestFrame.split("\n").every((line) => measureVisibleWidth(line) <= 120)).toBe(true);
  });

  it("keeps Back and Cancel setup semantics on the Papyrus setup panel path", async () => {
    clearCiEnv();
    const { input, output } = makeTtyStreams(96);
    const pending = selectOption(input, output, {
      ...setupPanelSelection(),
      options: [
        ...setupPanelSelection().options,
        {
          id: "back",
          value: "back",
          label: "Back",
          group: "navigation",
          cells: {
            provider: "Back",
            model: "",
            status: "navigation",
            notes: "Return to previous setup page",
          },
        },
        {
          id: "cancel",
          value: "cancel",
          label: "Cancel",
          group: "navigation",
          cells: {
            provider: "Cancel",
            model: "",
            status: "navigation",
            notes: "Exit setup",
          },
        },
      ],
    });

    await Promise.resolve();
    press(input, "\x1b[F");
    press(input, "\r");

    await expect(pending).resolves.toBe("cancel");
    expect(stripAnsi(output.getText())).toContain("Selected: Cancel");
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

function setupPanelSelection(): SelectPromptInput<string> {
  return {
    surface: "promptCard",
    locale: "en",
    direction: "ltr",
    title: "Model route",
    body: "Choose the active provider and model route.",
    defaultIndex: 0,
    columns: [
      { key: "provider", header: "Provider" },
      { key: "model", header: "Model" },
      { key: "status", header: "Status" },
      { key: "notes", header: "Notes" },
    ],
    options: [
      {
        id: "openai",
        value: "openai",
        label: "OpenAI",
        cells: { provider: "OpenAI", model: "gpt-5.5", status: "ready", notes: "API key set" },
      },
      {
        id: "local",
        value: "local",
        label: "Local",
        cells: { provider: "Local", model: "qwen3-coder", status: "offline", notes: "endpoint unset" },
      },
    ],
    fallbackPrompt: "Choose: ",
  };
}

function arabicSetupPanelSelection(): SelectPromptInput<string> {
  return {
    ...setupPanelSelection(),
    locale: "ar",
    direction: "rtl",
    title: "إعداد النموذج",
    body: "اختر مزود النموذج والمسار النشط.",
    options: [
      {
        id: "openai",
        value: "openai",
        label: "OpenAI",
        cells: { provider: "OpenAI", model: "gpt-5.5", status: "جاهز", notes: "API key محفوظ" },
      },
      {
        id: "local",
        value: "local",
        label: "Local",
        cells: { provider: "Local", model: "qwen3-coder", status: "غير متصل", notes: "URL غير مضبوط" },
      },
    ],
  };
}

function arabicSetupChoiceMenuSelection(): SelectPromptInput<string> {
  return {
    surface: "promptCard",
    locale: "ar",
    direction: "rtl",
    title: "محرّر الإعدادات",
    body: "اختار اللي تحب تضبطه:",
    defaultIndex: 0,
    columns: [
      { key: "description", header: "التفاصيل", align: "left" },
      { key: "name", header: "الاسم", align: "right" },
    ],
    tableDirection: "rtl",
    showColumnHeaders: false,
    options: [
      {
        id: "primary",
        value: "primary",
        label: "النموذج الأساسي",
        description: "النموذج الافتراضي الذي يستخدمه الوكيل.",
      },
      {
        id: "fallback",
        value: "fallback",
        label: "النماذج الاحتياطية",
        description: "نماذج احتياطية تُستخدم إذا فشل النموذج الأساسي.",
      },
      {
        id: "exit",
        value: "exit",
        label: "الخروج دون تغييرات",
        description: "غادر الإعداد دون تعديل التكوين.",
        group: "navigation",
      },
    ],
    fallbackPrompt: "اختر: ",
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

function latestRenderedFrame(text: string): string {
  const restoreCursor = "\x1B8";
  const clearDown = "\x1B[J";
  const lastRender = text.lastIndexOf(`${restoreCursor}${clearDown}`);
  if (lastRender === -1) {
    const repaintPattern = /\x1b\[\d+A\r/gu;
    let lastRepaint: RegExpExecArray | null = null;
    for (let match = repaintPattern.exec(text); match !== null; match = repaintPattern.exec(text)) {
      lastRepaint = match;
    }
    if (lastRepaint === null) return text;
    return text.slice(lastRepaint.index + lastRepaint[0].length);
  }
  return text.slice(lastRender + restoreCursor.length + clearDown.length);
}
