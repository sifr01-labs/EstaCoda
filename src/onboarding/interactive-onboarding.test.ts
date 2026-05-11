import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildOnboardingPromptCardViewModel, type BuildOnboardingPromptCardInput } from "../ui/view-models/builders.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import { isolateLtr } from "../ui/bidi.js";
import { runInteractiveOnboarding, type Prompt } from "./interactive-onboarding.js";
import type { SelectPromptInput } from "../cli/interactive-select.js";

describe("interactive onboarding prompt-card integration", () => {
  let tempDir: string;
  let savedKimiKey: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-onboarding-card-test-"));
    savedKimiKey = process.env.KIMI_API_KEY;
    process.env.KIMI_API_KEY = "existing-test-key";
  });

  afterEach(async () => {
    if (savedKimiKey === undefined) {
      delete process.env.KIMI_API_KEY;
    } else {
      process.env.KIMI_API_KEY = savedKimiKey;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("wires first-run onboarding prompts through onboarding cards without changing setup choices", async () => {
    const prompt = makePrompt({
      language: "en",
      provider: "kimi",
      model: "kimi-k2-turbo-preview",
      secretAnswers: ["", "entered-secret"]
    });

    const result = await runInteractiveOnboarding({
      workspaceRoot: join(tempDir, "workspace"),
      homeDir: tempDir,
      prompt,
      continueToSession: false
    });

    expect(result.exitCode).toBe(0);
    const config = JSON.parse(await readFile(join(tempDir, ".estacoda", "config.json"), "utf8")) as {
      model?: { provider?: string; id?: string };
      security?: { approvalMode?: string };
      skills?: { autonomy?: string };
    };
    expect(config.model).toEqual({ provider: "kimi", id: "kimi-k2-turbo-preview" });
    expect(config.security?.approvalMode).toBe("adaptive");
    expect(config.skills?.autonomy).toBe("suggest");
    expect(prompt.selections.map((selection) => selection.surface)).toEqual(
      expect.arrayContaining(["onboarding"])
    );
    expect(prompt.selections.find((selection) => selection.title === "Choose interface language")?.surface).toBe("onboarding");
    expect(prompt.selections.find((selection) => selection.title === "Choose primary provider")?.surface).toBe("onboarding");
    expect(prompt.selections.find((selection) => selection.title === "Choose Kimi model")?.surface).toBe("onboarding");
    expect(prompt.selections.find((selection) => selection.title === "Choose security mode")?.surface).toBe("onboarding");
    expect(prompt.selections.find((selection) => selection.title === "Choose workflow-learning mode")?.surface).toBe("onboarding");

    const rendered = prompt.renderedCards.join("\n");
    const workspaceQuestion = prompt.questions.find((entry) => /Workspace root/u.test(entry.question));
    const secretQuestions = prompt.questions.filter((entry) => entry.secret);

    expect(workspaceQuestion?.question).toContain("Workspace root");
    expect(prompt.cards.find((card) => card.title === "Workspace root")?.bodyLines.join("\n")).not.toContain("Workspace root [");
    expect(secretQuestions).toHaveLength(2);
    expect(secretQuestions.every((entry) => entry.question.includes("Paste Kimi K2 Turbo Preview API key"))).toBe(true);
    expect(rendered).toContain("Workspace trust");
    expect(rendered).toContain("Model credential");
    expect(rendered).toContain("Review setup");
    expect(rendered).not.toContain("Assistant");
    expect(rendered).not.toContain("Paste Kimi K2 Turbo Preview API key");
    expect(rendered).not.toContain("entered-secret");
    expect(rendered).toContain("Kimi K2 Turbo Preview API key cannot be empty.");
  });

  it("switches subsequent onboarding selections and cards to Arabic with isolated technical tokens", async () => {
    const workspaceRoot = join(tempDir, "workspace");
    const prompt = makePrompt({ language: "ar", provider: "local" });

    const result = await runInteractiveOnboarding({
      workspaceRoot,
      homeDir: tempDir,
      prompt,
      continueToSession: false
    });

    expect(result.exitCode).toBe(0);
    const styleSelection = prompt.selections.find((selection) => selection.title === "اختر أسلوب التعبير");
    const providerSelection = prompt.selections.find((selection) => selection.title === "اختر مزوّد النموذج الأساسي");
    expect(styleSelection?.locale).toBe("ar");
    expect(styleSelection?.direction).toBe("rtl");
    expect(providerSelection?.locale).toBe("ar");

    const rendered = prompt.renderedCards.join("\n");
    expect(rendered).toContain("مجلد العمل");
    expect(rendered).toContain(isolateLtr(workspaceRoot));
    expect(rendered).toContain(isolateLtr("local"));
    expect(rendered).toContain(isolateLtr("ollama/auto"));
    expect(rendered).not.toContain("Assistant");
  });

  it("does not request or render hosted credentials for the local provider path", async () => {
    const prompt = makePrompt({ language: "en", provider: "local" });

    const result = await runInteractiveOnboarding({
      workspaceRoot: join(tempDir, "workspace"),
      homeDir: tempDir,
      prompt,
      continueToSession: false
    });

    expect(result.exitCode).toBe(0);
    expect(prompt.questions.some((entry) => entry.secret)).toBe(false);
    expect(prompt.cards.some((card) => card.title === "Model credential")).toBe(false);
    expect(prompt.renderedCards.join("\n")).toContain("local provider, no hosted API key");
  });

  it("isolates Arabic hosted credential technical tokens without rendering secret values", async () => {
    const prompt = makePrompt({
      language: "ar",
      provider: "kimi",
      model: "kimi-k2-turbo-preview",
      secretAnswers: ["entered-secret"]
    });

    const result = await runInteractiveOnboarding({
      workspaceRoot: join(tempDir, "workspace"),
      homeDir: tempDir,
      prompt,
      continueToSession: false
    });

    expect(result.exitCode).toBe(0);
    const rendered = prompt.renderedCards.join("\n");
    expect(rendered).toContain(isolateLtr("KIMI_API_KEY"));
    expect(rendered).toContain(isolateLtr("kimi"));
    expect(rendered).toContain(isolateLtr("kimi-k2-turbo-preview"));
    expect(rendered).not.toContain("entered-secret");
    expect(prompt.questions.filter((entry) => entry.secret)).toHaveLength(1);
  });
});

type PromptControls = {
  readonly language: "en" | "ar";
  readonly provider: string;
  readonly model?: string;
  readonly secretAnswers?: readonly string[];
};

type CapturingPrompt = Prompt & {
  readonly selections: SelectPromptInput<unknown>[];
  readonly cards: BuildOnboardingPromptCardInput[];
  readonly renderedCards: string[];
  readonly questions: Array<{ readonly question: string; readonly secret: boolean }>;
};

function makePrompt(controls: PromptControls): CapturingPrompt {
  const selections: SelectPromptInput<unknown>[] = [];
  const cards: BuildOnboardingPromptCardInput[] = [];
  const renderedCards: string[] = [];
  const questions: Array<{ question: string; secret: boolean }> = [];
  const secretAnswers = [...(controls.secretAnswers ?? ["entered-secret"])];
  const prompt = (async (question: string, options?: { secret?: boolean }) => {
    questions.push({ question, secret: options?.secret === true });
    if (options?.secret === true) {
      return secretAnswers.shift() ?? "entered-secret";
    }
    if (/Workspace root|مجلد العمل/u.test(question)) {
      return "";
    }
    if (/\[Y\/n\]/u.test(question)) {
      return "";
    }
    return "";
  }) as CapturingPrompt;

  prompt.select = async <T>(selection: SelectPromptInput<T>): Promise<T> => {
    selections.push(selection as SelectPromptInput<unknown>);
    const selected = chooseSelection(selection, controls);
    return selected.value;
  };
  prompt.onboardingCard = (card) => {
    cards.push(card);
    renderedCards.push(renderPlain(buildOnboardingPromptCardViewModel(card), card.locale));
  };
  prompt.close = () => undefined;
  Object.defineProperties(prompt, {
    selections: { value: selections },
    cards: { value: cards },
    renderedCards: { value: renderedCards },
    questions: { value: questions },
  });

  return prompt;
}

function chooseSelection<T>(selection: SelectPromptInput<T>, controls: PromptControls): { value: T } {
  const byLabel = (needle: string) => selection.options.find((option) =>
    typeof option.value === "object" &&
    option.value !== null &&
    Object.values(option.value as Record<string, unknown>).includes(needle)
  );

  if (/interface language/i.test(selection.title)) {
    return selection.options.find((option) =>
      typeof option.value === "object" &&
      option.value !== null &&
      (option.value as { language?: string }).language === controls.language
    ) ?? selection.options[0]!;
  }
  if (controls.model !== undefined && /model|نموذج/iu.test(selection.title)) {
    const model = byLabel(controls.model);
    if (model !== undefined) {
      return model;
    }
  }
  if (/provider|مزوّد/iu.test(selection.title)) {
    const provider = byLabel(controls.provider);
    if (provider !== undefined) {
      return provider;
    }
  }
  return selection.options[selection.defaultIndex ?? 0] ?? selection.options[0]!;
}
