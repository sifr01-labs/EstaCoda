import { describe, expect, it } from "vitest";
import type { SelectPromptInput } from "../cli/interactive-select.js";
import type { Prompt } from "../cli/readline-prompt.js";
import { isolateLtr, isolateRtl } from "../ui/bidi.js";
import {
  promptSetupChoice,
  setupCopyText,
  setupProviderCredentialQuestion,
  setupPromptContext,
  setupTelegramAllowedChatIdsQuestion,
  setupTelegramAllowedUserIdsQuestion,
  setupTelegramBotTokenQuestion,
} from "./setup-prompts.js";

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

describe("shared setup string prompt copy", () => {
  it("renders provider credential questions from shared setup editor copy", () => {
    const english = setupProviderCredentialQuestion("en", {
      providerName: "DeepSeek",
      envVarName: "DEEPSEEK_API_KEY",
    });
    const arabic = setupProviderCredentialQuestion("ar", {
      providerName: "DeepSeek",
      envVarName: "DEEPSEEK_API_KEY",
    });

    expect(english).toContain(setupCopyText("en", "setupEditor.actions.storeProviderCredentialReference.description"));
    expect(arabic).toContain(setupCopyText("ar", "setupEditor.actions.storeProviderCredentialReference.description"));
    expect(english).toContain("DeepSeek [DEEPSEEK_API_KEY]: ");
    expect(arabic).toContain(`${isolateLtr("DeepSeek")} [${isolateLtr("DEEPSEEK_API_KEY")}]: `);
    expect(arabic).not.toContain("DeepSeek [DEEPSEEK_API_KEY]");
    expect(setupProviderCredentialQuestion("ar", {
      providerName: "Telegram",
      envVarName: "ESTACODA_TELEGRAM_BOT_TOKEN",
    })).toContain(isolateLtr("ESTACODA_TELEGRAM_BOT_TOKEN"));
  });

  it("renders Telegram input prompts from shared setup editor copy without an env-var question", () => {
    expect(setupTelegramBotTokenQuestion("en")).toBe(`${setupCopyText("en", "setupEditor.prompt.telegram.botToken")} `);
    expect(setupTelegramAllowedUserIdsQuestion("en")).toBe(`${setupCopyText("en", "setupEditor.prompt.telegram.allowedUserIds")} `);
    expect(setupTelegramAllowedChatIdsQuestion("en")).toBe(`${setupCopyText("en", "setupEditor.prompt.telegram.allowedChatIds")} `);

    expect(setupTelegramBotTokenQuestion("ar")).toBe(`${isolateRtl(setupCopyText("ar", "setupEditor.prompt.telegram.botToken"))} `);
    expect(setupTelegramAllowedUserIdsQuestion("ar")).toBe(`${isolateRtl(setupCopyText("ar", "setupEditor.prompt.telegram.allowedUserIds"))} `);
    expect(setupTelegramAllowedChatIdsQuestion("ar")).toBe(`${isolateRtl(setupCopyText("ar", "setupEditor.prompt.telegram.allowedChatIds"))} `);
    expect(setupTelegramBotTokenQuestion("ar")).toContain(isolateLtr("Telegram"));
    expect(setupTelegramAllowedUserIdsQuestion("ar")).toContain(isolateLtr("Telegram"));
    expect(setupTelegramAllowedChatIdsQuestion("ar")).toContain(isolateLtr("Telegram"));
  });
});
