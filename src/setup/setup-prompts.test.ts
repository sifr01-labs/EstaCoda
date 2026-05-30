import { describe, expect, it } from "vitest";
import type { SelectPromptInput } from "../cli/interactive-select.js";
import type { Prompt } from "../cli/readline-prompt.js";
import { promptSetupChoice, setupPromptContext } from "./setup-prompts.js";

describe("setup prompt context", () => {
  it("passes Arabic locale and RTL direction to setup choice selectors", async () => {
    let seen: SelectPromptInput<string> | undefined;
    const prompt = Object.assign(
      async () => "",
      {
        select: async <T>(input: SelectPromptInput<T>): Promise<T> => {
          seen = input as SelectPromptInput<string>;
          return input.options[0]!.value;
        },
        close: () => undefined,
      }
    ) as Prompt;

    await promptSetupChoice(setupPromptContext(prompt, "ar"), {
      title: "هل تريد تشغيل EstaCoda الآن؟",
      message: "هل تريد تشغيل EstaCoda الآن؟\n",
      choices: [{ id: "yes", label: "نعم", value: "yes" }],
      defaultValue: "yes",
    });

    expect(seen?.locale).toBe("ar");
    expect(seen?.direction).toBe("rtl");
  });
});
