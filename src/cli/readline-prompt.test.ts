import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { promptUiContextForLocale } from "../contracts/ui.js";
import { isolateLtr } from "../ui/bidi.js";
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

function captureOutput(): Writable & { text: () => string } {
  let value = "";
  return Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        value += String(chunk);
        callback();
      },
    }),
    { text: () => value }
  );
}
