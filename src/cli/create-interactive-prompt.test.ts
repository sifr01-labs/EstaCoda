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
  it("selects the Papyrus prompt by default", async () => {
    const papyrusPrompt = fakePrompt("papyrus");
    const createPapyrus = vi.fn(() => papyrusPrompt);

    const prompt = createInteractivePrompt({
      createPapyrus,
    });

    await expect(prompt("> ")).resolves.toBe("papyrus");
    expect(createPapyrus).toHaveBeenCalledOnce();
  });

  it("keeps non-TTY prompt construction on the Papyrus prompt seam", async () => {
    const input = { isTTY: false } as NodeJS.ReadStream;
    const output = { isTTY: false, write: vi.fn() } as unknown as NodeJS.WriteStream;
    const papyrusPrompt = fakePrompt("plain");
    const createPapyrus = vi.fn(() => papyrusPrompt);

    const prompt = createInteractivePrompt({
      input,
      output,
      createPapyrus,
    });

    await expect(prompt("> ")).resolves.toBe("plain");
    expect(createPapyrus).toHaveBeenCalledWith({
      input,
      output,
      env: undefined,
      uiContext: undefined,
    });
  });

  it("keeps removed input mode fallback flags on the Papyrus prompt path", async () => {
    const createPapyrus = vi.fn(() => fakePrompt("papyrus"));

    const prompt = createInteractivePrompt({
      env: { [UI_INPUT_MODE_ENV_VAR]: "readline" },
      createPapyrus,
    });

    await expect(prompt("> ")).resolves.toBe("papyrus");
    expect(createPapyrus).toHaveBeenCalledWith({
      input: expect.anything(),
      output: expect.anything(),
      env: { [UI_INPUT_MODE_ENV_VAR]: "readline" },
      uiContext: undefined,
    });
  });

  it("keeps removed renderer fallback flags on the Papyrus prompt path", async () => {
    const createPapyrus = vi.fn(() => fakePrompt("papyrus"));

    const prompt = createInteractivePrompt({
      env: { [UI_RENDERER_ENV_VAR]: "legacy" },
      createPapyrus,
    });

    await expect(prompt("> ")).resolves.toBe("papyrus");
    expect(createPapyrus).toHaveBeenCalledWith({
      input: expect.anything(),
      output: expect.anything(),
      env: { [UI_RENDERER_ENV_VAR]: "legacy" },
      uiContext: undefined,
    });
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
      createPapyrus,
    });

    expect(createPapyrus).toHaveBeenCalledWith({
      input,
      output,
      env,
      uiContext,
    });
  });
});
