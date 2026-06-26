import { describe, expect, it, vi } from "vitest";
import { UI_INPUT_MODE_ENV_VAR } from "../ui/input-mode.js";
import { UI_RENDERER_ENV_VAR } from "../ui/renderer-mode.js";
import { promptUiContextForLocale } from "../contracts/ui.js";
import { createInteractivePrompt } from "./create-interactive-prompt.js";
import type { Prompt } from "./prompt-contract.js";

function fakePrompt(answer: string): Prompt {
  return Object.assign(vi.fn(async () => answer), { close: vi.fn() });
}

describe("createInteractivePrompt", () => {
  it("selects the Papyrus prompt by default when interactive capabilities allow", async () => {
    const papyrusPrompt = fakePrompt("papyrus");
    const readlinePrompt = fakePrompt("readline");
    const createPapyrus = vi.fn(() => papyrusPrompt);
    const createReadline = vi.fn(() => readlinePrompt);

    const prompt = createInteractivePrompt({
      canRunInteractive: () => true,
      createPapyrus,
      createReadline,
    });

    await expect(prompt("> ")).resolves.toBe("papyrus");
    expect(createPapyrus).toHaveBeenCalledOnce();
    expect(createReadline).not.toHaveBeenCalled();
  });

  it("ignores the removed input mode fallback flag", async () => {
    const createPapyrus = vi.fn(() => fakePrompt("papyrus"));
    const createReadline = vi.fn(() => fakePrompt("readline"));

    const prompt = createInteractivePrompt({
      env: { [UI_INPUT_MODE_ENV_VAR]: "readline" },
      canRunInteractive: () => true,
      createPapyrus,
      createReadline,
    });

    await expect(prompt("> ")).resolves.toBe("papyrus");
    expect(createPapyrus).toHaveBeenCalledOnce();
    expect(createReadline).not.toHaveBeenCalled();
  });

  it("ignores the removed renderer fallback flag", async () => {
    const createPapyrus = vi.fn(() => fakePrompt("papyrus"));
    const createReadline = vi.fn(() => fakePrompt("readline"));

    const prompt = createInteractivePrompt({
      env: { [UI_RENDERER_ENV_VAR]: "legacy" },
      canRunInteractive: () => true,
      createPapyrus,
      createReadline,
    });

    await expect(prompt("> ")).resolves.toBe("papyrus");
    expect(createPapyrus).toHaveBeenCalledOnce();
    expect(createReadline).not.toHaveBeenCalled();
  });

  it("selects readline when interactive capabilities are unavailable", async () => {
    const createPapyrus = vi.fn(() => fakePrompt("papyrus"));
    const createReadline = vi.fn(() => fakePrompt("readline"));

    const prompt = createInteractivePrompt({
      canRunInteractive: () => false,
      createPapyrus,
      createReadline,
    });

    await expect(prompt("> ")).resolves.toBe("readline");
    expect(createPapyrus).not.toHaveBeenCalled();
    expect(createReadline).toHaveBeenCalledOnce();
  });

  it("forwards env, streams, and UI context to the selected prompt factory", () => {
    const input = { isTTY: true } as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const env = { [UI_INPUT_MODE_ENV_VAR]: "raw" };
    const uiContext = promptUiContextForLocale("ar");
    const createPapyrus = vi.fn(() => fakePrompt("papyrus"));

    createInteractivePrompt({
      input,
      output,
      env,
      uiContext,
      canRunInteractive: () => true,
      createPapyrus,
      createReadline: vi.fn(() => fakePrompt("readline")),
    });

    expect(createPapyrus).toHaveBeenCalledWith({
      input,
      output,
      env,
      uiContext,
    });
  });
});
