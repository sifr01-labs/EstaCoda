import { describe, expect, it, vi, afterEach } from "vitest";
import { PassThrough, Readable, Writable } from "node:stream";
import { selectOption, type SelectPromptInput } from "./interactive-select.js";
import { stripAnsi } from "../ui/renderers/layout.js";

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

describe("interactive-select onboarding surface", () => {
  it("renders onboarding cards while preserving arrow navigation and Enter confirmation", async () => {
    clearCiEnv();
    process.env.FORCE_COLOR = "1";
    process.env.LANG = "en_US.UTF-8";
    const { input, output } = makeTtyStreams();
    const pending = selectOption(input, output, onboardingSelection());

    await Promise.resolve();
    input.emit("keypress", "", { name: "down" });
    input.emit("keypress", "", { name: "return" });

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
    void selectOption(input, makeTtyStreams().output, onboardingSelection());

    await Promise.resolve();
    input.emit("keypress", "", { name: "c", ctrl: true });

    expect(emitSpy).toHaveBeenCalledWith("SIGINT");
  });

  it("renders no-color onboarding cards without ANSI leakage", async () => {
    process.env.FORCE_COLOR = "0";
    const input = Readable.from(["\n"]);
    const output = makeOutput(false);

    await selectOption(input, output, onboardingSelection());

    const rendered = output.getText();
    expect(rendered).toContain("Workspace trust");
    expect(rendered).toContain("> Trust workspace");
    expect(/\x1B\[[0-?]*[ -/]*[@-~]/u.test(rendered)).toBe(false);
  });

  it("renders no-Unicode onboarding cards with stable fallback markers", async () => {
    clearCiEnv();
    process.env.FORCE_COLOR = "1";
    process.env.LANG = "C";
    process.env.LC_ALL = "C";
    const { input, output } = makeTtyStreams();
    const pending = selectOption(input, output, onboardingSelection());

    await Promise.resolve();
    input.emit("keypress", "", { name: "return" });

    await expect(pending).resolves.toBe("trust");
    const rendered = stripAnsi(output.getText());
    expect(rendered).toContain("+---- *  Workspace trust");
    expect(rendered).toContain("> Trust workspace");
    expect(rendered).not.toContain("𓂀");
    expect(rendered).not.toContain("▸");
  });

  it("keeps plain onboarding fallback deterministic", async () => {
    const input = Readable.from(["\n"]);
    const output = makeOutput(false);

    await selectOption(input, output, onboardingSelection());

    expect(output.getText()).toContain([
      "Workspace trust",
      "Trust this workspace?",
      "/workspace",
      "> Trust workspace",
      "  Not now",
    ].join("\n"));
  });
});

function onboardingSelection(): SelectPromptInput<string> {
  return {
    surface: "onboarding",
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

function clearCiEnv(): void {
  delete process.env.NO_COLOR;
  process.env.TERM = "xterm-256color";
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  delete process.env.GITLAB_CI;
  delete process.env.CIRCLECI;
}

function makeTtyStreams(): { input: TtyInput; output: CapturingOutput } {
  const input = new PassThrough() as TtyInput;
  input.isTTY = true;
  input.setRawMode = vi.fn();
  input.resume = vi.fn(() => input);
  return { input, output: makeOutput(true) };
}

function makeOutput(isTTY: boolean): CapturingOutput {
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    }
  }) as CapturingOutput;
  output.isTTY = isTTY;
  output.columns = 80;
  output.getText = () => text;
  return output;
}
