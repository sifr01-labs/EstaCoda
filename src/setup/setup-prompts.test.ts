import { describe, expect, it } from "vitest";
import type { SelectPromptInput } from "../cli/interactive-select.js";
import type { Prompt } from "../cli/prompt-contract.js";
import { isolateLtr, isolateRtl } from "../ui/bidi.js";
import type { SetupVerificationReport } from "./verification.js";
import {
  promptSetupChoice,
  promptSetupChoiceResult,
  promptSetupYesNo,
  renderSetupApplyEndState,
  setupChoiceColumns,
  setupChoiceTableAlign,
  setupChoiceTableDirection,
  setupChoiceTableMaxWidth,
  setupChoiceTableWidth,
  setupCopyText,
  setupCsvPromptLabel,
  setupCurrentStatusLine,
  setupCurrentStatusLines,
  setupNavigationHint,
  setupNavigationChoice,
  setupPromptLabel,
  setupPromptWithDefault,
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
    expect(seen?.columns).toBeUndefined();
    expect(seen?.hint).toBe("↑↓ navigate   ENTER select   CTRL+C exit");
    expect(seen?.options[0]?.id).toBe("yes");
  });

  it("returns a structured Back result only when explicitly enabled", async () => {
    let seen: SelectPromptInput<string | symbol> | undefined;
    const prompt = Object.assign(
      async () => "",
      {
        select: async <T>(input: SelectPromptInput<T>): Promise<T> => {
          seen = input as SelectPromptInput<string | symbol>;
          return input.options.find((option) => option.id === "back")!.value;
        },
        close: () => undefined,
      }
    ) as Prompt;

    const result = await promptSetupChoiceResult(setupPromptContext(prompt, "en"), {
      title: "Choose mode",
      message: "Pick a mode.\n",
      choices: [
        { id: "alpha", label: "Alpha", description: "First option", value: "alpha" },
      ],
      defaultValue: "alpha",
      allowBack: true,
    });

    expect(result).toEqual({ kind: "back" });
    expect(seen?.options.map((option) => option.id)).toEqual(["alpha", "back"]);
    expect(seen?.options[1]).toMatchObject({
      id: "back",
      label: "Back",
      description: "Return to the previous step.",
      group: "navigation",
    });
    expect(seen?.options[1]?.current).toBeUndefined();
    expect(seen?.options[1]?.badges).toBeUndefined();
  });

  it("keeps structured setup choice results selected-only when Back is disabled", async () => {
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

    const result = await promptSetupChoiceResult(setupPromptContext(prompt, "ar"), {
      title: "اختر",
      message: "اختر.\n",
      choices: [
        { id: "alpha", label: "الأول", value: "alpha" },
      ],
      defaultValue: "alpha",
    });

    expect(result).toEqual({ kind: "selected", value: "alpha" });
    expect(seen?.options.map((option) => option.id)).toEqual(["alpha"]);
  });

  it("passes opt-in prompt-card fields through setup choice selectors", async () => {
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
    const statusLine = setupCurrentStatusLine("en", "Alpha");

    const selected = await promptSetupChoice(setupPromptContext(prompt, "en"), {
      title: "Choose mode",
      message: "Pick a mode.\n",
      bodyLineStyles: [{ emphasis: "strong" }],
      columns: setupChoiceColumns("en"),
      statusLines: [statusLine],
      hint: "Use arrows.",
      showCurrentBadge: false,
      showColumnHeaders: false,
      tableDirection: setupChoiceTableDirection("en"),
      tableWidth: setupChoiceTableWidth("en"),
      tableMaxWidth: setupChoiceTableMaxWidth("en"),
      tableAlign: setupChoiceTableAlign("en"),
      choices: [
        {
          id: "alpha",
          label: "Alpha",
          description: "First option",
          technical: true,
          cells: { name: "Alpha", description: "First option" },
          badges: ["Recommended"],
          current: true,
          value: "alpha",
        },
        setupNavigationChoice({
          id: "back",
          label: "Back",
          description: "Return to the previous step.",
          value: "back",
        }),
      ],
      defaultValue: "alpha",
    });

    expect(selected).toBe("alpha");
    expect(seen?.bodyLineStyles).toEqual([{ emphasis: "strong" }]);
    expect(seen?.columns).toEqual([
      { key: "name", header: "Name", align: "left" },
      { key: "description", header: "Details", align: "left" },
    ]);
    expect(seen?.statusLines).toEqual([statusLine]);
    expect(seen?.hint).toBe("Use arrows.");
    expect(seen?.showCurrentBadge).toBe(false);
    expect(seen?.showColumnHeaders).toBe(false);
    expect(seen?.tableDirection).toBe("ltr");
    expect(seen?.tableWidth).toBe("full");
    expect(seen?.tableMaxWidth).toBeUndefined();
    expect(seen?.tableAlign).toBeUndefined();
    expect(seen?.options[0]).toMatchObject({
      id: "alpha",
      label: "Alpha",
      description: "First option",
      technical: true,
      cells: { name: "Alpha", description: "First option" },
      badges: ["Recommended"],
      current: true,
      value: "alpha",
    });
    expect(seen?.options[1]).toMatchObject({
      id: "back",
      group: "navigation",
      value: "back",
    });
  });

  it("keeps simple setup choice callers stacked unless they opt into columns", async () => {
    let seen: SelectPromptInput<boolean> | undefined;
    const prompt = Object.assign(
      async () => "",
      {
        select: async <T>(input: SelectPromptInput<T>): Promise<T> => {
          seen = input as SelectPromptInput<boolean>;
          return input.options[1]!.value;
        },
        close: () => undefined,
      }
    ) as Prompt;

    const selected = await promptSetupYesNo(setupPromptContext(prompt, "en"), {
      title: "Continue",
      message: "Continue?\n",
      yes: { id: "yes", label: "Yes", description: "Continue setup." },
      no: { id: "no", label: "No", description: "Stop here." },
      defaultValue: true,
    });

    expect(selected).toBe(false);
    expect(seen?.columns).toBeUndefined();
    expect(seen?.tableDirection).toBeUndefined();
    expect(seen?.tableWidth).toBeUndefined();
    expect(seen?.tableMaxWidth).toBeUndefined();
    expect(seen?.tableAlign).toBeUndefined();
    expect(seen?.statusLines).toBeUndefined();
    expect(seen?.hint).toBe(setupNavigationHint("en"));
    expect(seen?.showCurrentBadge).toBeUndefined();
    expect(seen?.options).toEqual([
      { id: "yes", label: "Yes", description: "Continue setup.", value: true },
      { id: "no", label: "No", description: "Stop here.", value: false },
    ]);
  });

  it("localizes generic setup prompt helper columns and status lines", () => {
    expect(setupChoiceColumns("ar")).toEqual([
      { key: "description", header: "التفاصيل", align: "right" },
      { key: "name", header: "الاسم", align: "right" },
    ]);
    expect(setupChoiceColumns("en")).toEqual([
      { key: "name", header: "Name", align: "left" },
      { key: "description", header: "Details", align: "left" },
    ]);
    expect(setupChoiceTableDirection("ar")).toBe("rtl");
    expect(setupChoiceTableDirection("en")).toBe("ltr");
    expect(setupChoiceTableWidth("ar")).toBe("content");
    expect(setupChoiceTableWidth("en")).toBe("full");
    expect(setupChoiceTableMaxWidth("ar")).toBe(88);
    expect(setupChoiceTableMaxWidth("en")).toBeUndefined();
    expect(setupChoiceTableAlign("ar")).toBe("right");
    expect(setupChoiceTableAlign("en")).toBeUndefined();
    expect(setupCurrentStatusLine("ar", "English")).toEqual({
      text: "الحالي: English",
      tone: "active",
      direction: "rtl",
    });
    expect(setupCurrentStatusLines("ar", "English")).toEqual([{
      text: "الحالي: English",
      tone: "active",
      direction: "rtl",
    }]);
    expect(setupCurrentStatusLines("ar", undefined)).toBeUndefined();
    expect(setupNavigationHint("ar")).toBe("↑↓ navigate   ENTER select   CTRL+C exit");
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

    expect(english).toBe("Enter your DeepSeek API key. It will not be shown while you type: ");
    expect(arabic).toBe(isolateRtl(`أدخل مفتاح ${isolateLtr("API")} الخاص بـ ${isolateLtr("DeepSeek")}. لن يظهر أثناء الكتابة: `));
    expect(english).not.toContain("DEEPSEEK_API_KEY");
    expect(arabic).not.toContain("DEEPSEEK_API_KEY");
    expect(setupProviderCredentialQuestion("ar", {
      providerName: "Telegram",
      envVarName: "ESTACODA_TELEGRAM_BOT_TOKEN",
    })).toContain(isolateLtr("Telegram"));
    expect(setupProviderCredentialQuestion("ar", {
      providerName: "Telegram",
      envVarName: "ESTACODA_TELEGRAM_BOT_TOKEN",
    })).not.toContain("ESTACODA_TELEGRAM_BOT_TOKEN");
  });

  it("wraps Arabic raw prompt lines while isolating technical values", () => {
    expect(setupPromptWithDefault("en", "Workspace", "/tmp/example")).toBe("Workspace [/tmp/example]: ");
    expect(setupPromptWithDefault("ar", "اختر مساحة العمل", "/tmp/example")).toBe(
      isolateRtl(`اختر مساحة العمل [${isolateLtr("/tmp/example")}]: `)
    );
    expect(setupPromptLabel("ar", "النموذج")).toBe(isolateRtl("النموذج: "));
    expect(setupCsvPromptLabel("ar", "المستخدمون")).toBe(
      isolateRtl(`المستخدمون, ${isolateLtr("comma-separated")}: `)
    );
  });

  it("wraps Arabic setup apply end-state lines", () => {
    const verification: SetupVerificationReport = {
      stateWritable: true,
      envFilePresent: false,
      envFileSecure: true,
      workspaceTrusted: true,
      securityModeLabel: "Adaptive",
      securityModeValue: "adaptive",
      skillAutonomyLabel: "Suggest",
      skillAutonomyValue: "suggest",
      providerDiagnostic: {
        status: "ready",
        lines: [],
        warnings: [],
      },
      toolStatus: "skipped",
      configSources: [],
      warnings: [],
      issueCodes: [],
    };

    expect(renderSetupApplyEndState({ kind: "verified-ready", verification }, "ar")).toBe(
      isolateRtl(setupCopyText("ar", "setupApply.endState.verifiedReady"))
    );
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
