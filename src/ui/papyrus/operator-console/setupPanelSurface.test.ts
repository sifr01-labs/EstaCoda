import { describe, expect, it } from "vitest";
import { stringWidth } from "../screen/stringWidth.js";
import { resolveTokens } from "../../../theme/token-resolver.js";
import { isolateLtr, isolateRtl, LRI, RLI } from "../../../ui/bidi.js";
import {
  createOperatorConsoleStyle,
  renderSetupPanelSurface,
  type SecretEntryPanelState,
  type SetupPanelState,
  type TextEntryPanelState,
} from "./index.js";

describe("Papyrus operator console setup panel surface", () => {
  it("renders provider/model table with measured columns and selected row at wide width", () => {
    const output = renderSetupPanelSurface(modelRoutePanel(), { width: 72 });
    const text = output.join("\n");

    expect(output[0]).toContain("𓂀  Model Route");
    expect(text).not.toContain("│ Model route");
    expect(text).toContain("Choose the active provider and model route.");
    expect(text).toContain("Provider");
    expect(text).toContain("Model");
    expect(text).toContain("Status");
    expect(text).toContain("Notes");
    expect(text).toContain("❯");
    expect(text).toContain("OpenAI");
    expect(text).toContain("gpt-5.5");
    expect(text).toContain("ready");
    expect(text).toContain("API key set");
    expect(text).toContain("↑↓ navigate   ENTER select   CTRL+C exit");
    expect(output.slice(1, -1).every((line) => !line.trimStart().startsWith("│"))).toBe(true);
    expect(output.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("renders compact provider/model fallback under narrow width", () => {
    const output = renderSetupPanelSurface(modelRoutePanel(), { width: 44 });
    const text = output.join("\n");

    expect(text).toContain("❯ OpenAI");
    expect(text).toContain("gpt-5.5");
    expect(text).toContain("ready · API key set");
    expect(output.every((line) => stringWidth(line) <= 44)).toBe(true);
  });

  it("renders intentional multiline setup descriptions", () => {
    const output = renderSetupPanelSurface({
      kind: "table",
      layout: "choiceMenu",
      title: "Setup language",
      description: `Choose the language EstaCoda uses for setup and CLI guidance.\n${isolateRtl(`اختر اللغة التي تستخدمها ${isolateLtr("EstaCoda")} للإعداد وإرشادات الطرفية.`)}`,
      rows: [
        { id: "en", provider: "English", model: "", status: "", notes: "" },
        { id: "ar", provider: "العربية", model: "", status: "", notes: "" },
      ],
      selectedRowId: "en",
    }, { width: 96 });
    const text = output.join("\n");

    expect(text).toContain("Choose the language EstaCoda uses for setup and CLI guidance.");
    expect(text).toContain(isolateRtl(`اختر اللغة التي تستخدمها ${isolateLtr("EstaCoda")} للإعداد وإرشادات الطرفية.`));
    expect(output.every((line) => stringWidth(line) <= 96)).toBe(true);
  });

  it("truncates long provider, model, status, and notes safely", () => {
    const output = renderSetupPanelSurface({
      ...modelRoutePanel(),
      rows: [{
        id: "long",
        provider: "VeryLongProviderName",
        model: "very-long-model-name-with-routing-suffix",
        status: "ready-with-extra-detail",
        notes: "API key set with a very long diagnostic note",
      }],
      selectedRowId: "long",
    }, { width: 42 });
    const text = output.join("\n");

    expect(text).not.toContain("routing-suffix");
    expect(text).not.toContain("very long diagnostic note");
    expect(output.every((line) => stringWidth(line) <= 42)).toBe(true);
  });

  it("renders Arabic route choices as right-anchored stacked blocks", () => {
    const output = renderSetupPanelSurface({
      kind: "table",
      title: "إعداد النموذج",
      locale: "ar",
      rows: [
        { id: "openai", provider: "OpenAI", model: "gpt-5.5", status: "جاهز", notes: "المفتاح محفوظ" },
        { id: "local", provider: "Local", model: "qwen3-coder", status: "غير متصل", notes: "URL غير مضبوط" },
      ],
      selectedRowId: "openai",
    }, { width: 72 });
    const text = output.join("\n");

    expect(text).toContain("إعداد النموذج");
    expect(text).not.toContain("المزود");
    expect(text).not.toContain("الحالة");
    expect(text).toContain("OpenAI");
    expect(text).toContain("gpt-5.5");
    expect(text).toContain("Local");
    expect(text).toContain("qwen3-coder");
    expect(text).toContain("URL");
    expect(text).toContain("ENTER");
    expect(text).toContain("CTRL+C");
    expect(visibleColumn(output[0]!, "𓂀  إعداد النموذج")).toBeGreaterThan(24);
    expect(output.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("renders Arabic setup choices as stable stacked Papyrus blocks", () => {
    const output = renderSetupPanelSurface({
      kind: "table",
      layout: "choiceMenu",
      title: "محرّر الإعدادات",
      description: "اختار اللي تحب تضبطه:",
      locale: "ar",
      rows: [
        {
          id: "primary",
          provider: "النموذج الأساسي",
          model: "",
          status: "النموذج الافتراضي الذي يستخدمه الوكيل.",
          notes: "",
        },
        {
          id: "fallback",
          provider: "النماذج الاحتياطية",
          model: "",
          status: "نماذج احتياطية تُستخدم إذا فشل النموذج الأساسي.",
          notes: "",
        },
        {
          id: "search",
          provider: "البحث",
          model: "",
          status: "اضبط كيف تعثر EstaCoda على نتائج الويب وتسترجعها.",
          notes: "",
        },
        {
          id: "exit",
          provider: "الخروج دون تغييرات",
          model: "",
          status: "غادر الإعداد دون تعديل التكوين.",
          notes: "",
          group: "navigation",
        },
      ],
      selectedRowId: "fallback",
      footer: "↑↓ navigate   ENTER select   CTRL+C exit",
    }, { width: 120 });
    const text = output.join("\n");
    const fallbackLabelLine = output.find((line) => line.includes("النماذج الاحتياطية") && line.includes("◂")) ?? "";
    const fallbackDetailLine = output.find((line) => line.includes("نماذج احتياطية")) ?? "";
    const descriptionLine = output.find((line) => line.includes("اختار اللي تحب تضبطه")) ?? "";

    expect(output[0]).toContain("𓂀  محرّر الإعدادات");
    expect(text).toContain("محرّر الإعدادات");
    expect(text).toContain("◂");
    expect(text).not.toContain("المزود");
    expect(text).not.toContain("الحالة");
    expect(fallbackLabelLine).toContain("◂");
    expect(fallbackDetailLine).toContain("نماذج احتياطية");
    expect(visibleColumn(output[0]!, "𓂀  محرّر الإعدادات")).toBeGreaterThan(70);
    expect(descriptionLine).toContain(`${RLI}اختار اللي تحب تضبطه:`);
    expect(visibleColumn(descriptionLine, "اختار اللي تحب تضبطه")).toBeGreaterThan(70);
    expect(visibleColumn(fallbackLabelLine, "النماذج الاحتياطية")).toBeGreaterThan(80);
    expect(output.every((line) => stringWidth(line) <= 120)).toBe(true);
  });

  it("isolates and colors the selected Arabic setup choice when styled", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const output = renderSetupPanelSurface(arabicChoiceMenu(), {
      width: 120,
      style: createOperatorConsoleStyle({
        tokens,
        capabilities: { supportsColor: true, supportsTrueColor: true },
      }),
    });
    const selectedLine = output.find((line) => line.includes("النماذج الاحتياطية") && line.includes("◂")) ?? "";
    const unselectedLine = output.find((line) => line.includes("النموذج الأساسي")) ?? "";
    const selectedDetailLine = output.find((line) => line.includes("نماذج احتياطية")) ?? "";

    expect(selectedLine).toContain(ansiFg(tokens.contract.palette.action));
    expect(selectedLine).not.toContain(ansiFg(tokens.contract.text.primary));
    expect(selectedLine).not.toContain("\x1b[1m");
    expect(selectedLine).toContain(`${RLI}النماذج الاحتياطية`);
    expect(selectedLine).toMatch(/النماذج الاحتياطية.*◂.*\x1b\[0m/u);
    expect(unselectedLine).toContain(ansiFg(tokens.contract.text.primary));
    expect(unselectedLine).not.toContain(ansiFg(tokens.contract.palette.action));
    expect(unselectedLine).not.toContain("\x1b[1m");
    expect(selectedDetailLine).toContain(ansiFg(tokens.contract.text.secondary));
    expect(selectedDetailLine).not.toContain(ansiFg(tokens.contract.palette.action));
    expect(selectedDetailLine).not.toContain("\x1b[1m");
    expect(selectedDetailLine).toContain(`${RLI}نماذج احتياطية`);
  });

  it("colors the selected setup route row when styled", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const output = renderSetupPanelSurface(modelRoutePanel(), {
      width: 72,
      style: createOperatorConsoleStyle({
        tokens,
        capabilities: { supportsColor: true, supportsTrueColor: true },
      }),
    });
    const selectedLine = output.find((line) => line.includes("OpenAI")) ?? "";
    const unselectedLine = output.find((line) => line.includes("Anthropic")) ?? "";

    expect(selectedLine).toContain(ansiFg(tokens.contract.palette.action));
    expect(selectedLine).toContain("❯");
    expect(selectedLine).toMatch(/OpenAI.*gpt-5\.5.*\x1b\[0m/u);
    expect(unselectedLine).not.toContain(ansiFg(tokens.contract.palette.action));
  });

  it("colors setup shell title with plain brand color, current status, and footer when styled", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const output = renderSetupPanelSurface({
      ...modelRoutePanel(),
      statusLines: [{ text: "Current: OpenAI", tone: "active", direction: "ltr" }],
      footer: "↑↓ navigate   ENTER select   CTRL+C exit",
    }, {
      width: 72,
      style: createOperatorConsoleStyle({
        tokens,
        capabilities: { supportsColor: true, supportsTrueColor: true },
      }),
    }).join("\n");
    const footerLine = output.split("\n").find((line) => line.includes("↑↓ navigate")) ?? "";

    expect(output).toContain(`${ansiFg(tokens.contract.palette.brand)}𓂀  Model Route\x1b[0m`);
    expect(output).not.toContain("\x1b[1m𓂀  Model Route");
    expect(output).toContain(`${ansiFg(tokens.contract.severity.ok)}Current: OpenAI\x1b[0m`);
    expect(footerLine).toContain(ansiFg(tokens.contract.text.secondary));
    expect(footerLine).toContain("↑↓ navigate   ENTER select   CTRL+C exit");
  });

  it("right-aligns English setup footers and leaves Arabic setup footers on the left", () => {
    const english = renderSetupPanelSurface({
      ...modelRoutePanel(),
      footer: "↑↓ navigate   ENTER select   CTRL+C exit",
    }, { width: 72 });
    const arabic = renderSetupPanelSurface({
      ...arabicChoiceMenu(),
      footer: "↑↓ navigate   ENTER select   CTRL+C exit",
    }, { width: 72 });
    const englishFooter = english.find((line) => line.includes("↑↓ navigate")) ?? "";
    const arabicFooter = arabic.find((line) => line.includes("↑↓ navigate")) ?? "";

    expect(visibleColumn(englishFooter, "↑↓ navigate")).toBeGreaterThan(24);
    expect(visibleColumn(arabicFooter, "↑↓ navigate")).toBe(2);
  });

  it("renders required API key panel with masked value and env var only", () => {
    const output = renderSetupPanelSurface(requiredSecretPanel(), { width: 72 });
    const text = output.join("\n");

    expect(output[0]).toContain("API Key · OpenAI");
    expect(text).not.toContain("│ API key · OpenAI");
    expect(text).toContain("Enter API key for OpenAI.");
    expect(text).toContain("sk-••••••••••••••••");
    expect(text).toContain("Stored as: OPENAI_API_KEY");
    expect(text).toContain("Enter save · Esc back · Ctrl+C exit");
    expect(text).not.toContain("sk-live-raw-secret");
    expect(output.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("renders optional local key panel with leave-empty state", () => {
    const output = renderSetupPanelSurface({
      kind: "secret",
      title: "API key · Local",
      description: "API key is optional for this endpoint.",
      optional: true,
      emptyLabel: "[leave empty]",
      footer: "Enter continue without key · Esc back",
    }, { width: 72 });
    const text = output.join("\n");

    expect(text).toContain("API key is optional for this endpoint.");
    expect(text).toContain("[leave empty]");
    expect(text).toContain("Enter continue without key · Esc back");
  });

  it("renders visible text entry panels without masking typed values", () => {
    const output = renderSetupPanelSurface(textEntryPanel(), { width: 72 });
    const text = output.join("\n");

    expect(output[0]).toContain("Workspace");
    expect(text).toContain("Enter workspace path.");
    expect(text).toContain("Press Enter to use the current default");
    expect(text).toContain("Current default: /Users/ahnwy/project");
    expect(text).toContain("/Users/ahnwy/project child");
    expect(text).not.toContain("/Users/ahnwy/project\nchild");
    expect(text).toContain("Enter save · Ctrl+C cancel");
    expect(text).not.toContain("••••");
    expect(output.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("wraps full-width setup output rows without truncating long blockers", () => {
    const message = "Verification blocked setup because of Missing env var DEEPSEEK_API_KEY for route deepseek/deepseek-v4.";
    const output = renderSetupPanelSurface({
      kind: "table",
      layout: "choiceMenu",
      title: "Setup result",
      description: "Review setup output without applying changes.",
      rows: [{
        id: "line-0",
        provider: "",
        model: "",
        status: message,
        notes: "",
      }],
      footer: "Read-only output",
    }, { width: 72 });
    const text = output.join("\n");

    expect(text).toContain("DEEPSEEK_API_KEY");
    expect(text).toContain("deepseek/deepseek-v4.");
    expect(text).not.toContain("route..");
    expect(output.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("never renders raw secret when raw value is modeled without a masked value", () => {
    const output = renderSetupPanelSurface({
      ...requiredSecretPanel(),
      maskedValue: undefined,
      rawValue: "sk-live-raw-secret",
    }, { width: 72 });
    const text = output.join("\n");

    expect(text).not.toContain("sk-live-raw-secret");
    expect(text).toContain("••••••••");
  });

  it("emits no ANSI/cursor-control strings and does not mutate setup state", () => {
    const state = modelRoutePanel();
    const before = JSON.stringify(state);
    const output = [
      ...renderSetupPanelSurface(state, { width: 72 }),
      ...renderSetupPanelSurface(requiredSecretPanel(), { width: 72 }),
    ].join("\n");

    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\\x1b");
    expect(output).not.toContain("\\u001b");
    expect(output).not.toContain("\\033");
    expect(output).not.toMatch(/\b(moveCursor|clearLine|clearScreenDown|cursorTo|setRawMode)\b/u);
    expect(JSON.stringify(state)).toBe(before);
  });
});

function visibleColumn(line: string, text: string): number {
  const index = line.indexOf(text);
  expect(index).toBeGreaterThanOrEqual(0);
  return stringWidth(line.slice(0, index));
}

function arabicChoiceMenu(): SetupPanelState {
  return {
    kind: "table",
    layout: "choiceMenu",
    title: "محرّر الإعدادات",
    description: "اختار اللي تحب تضبطه:",
    locale: "ar",
    rows: [
      {
        id: "primary",
        provider: "النموذج الأساسي",
        model: "",
        status: "النموذج الافتراضي الذي يستخدمه الوكيل.",
        notes: "",
      },
      {
        id: "fallback",
        provider: "النماذج الاحتياطية",
        model: "",
        status: "نماذج احتياطية تُستخدم إذا فشل النموذج الأساسي.",
        notes: "",
      },
    ],
    selectedRowId: "fallback",
  };
}

function ansiFg(hex: string): string {
  const clean = hex.replace("#", "");
  const bigint = Number.parseInt(clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `\x1b[38;2;${r};${g};${b}m`;
}

function modelRoutePanel(): SetupPanelState {
  return {
    kind: "table",
    title: "Model route",
    description: "Choose the active provider and model route.",
    rows: [
      { id: "openai", provider: "OpenAI", model: "gpt-5.5", status: "ready", notes: "API key set" },
      { id: "anthropic", provider: "Anthropic", model: "claude-sonnet-4.5", status: "ready", notes: "API key set" },
      { id: "local", provider: "Local", model: "qwen3-coder", status: "offline", notes: "endpoint unset" },
      { id: "zai", provider: "Z.AI", model: "glm-4.5", status: "ready", notes: "API key set" },
    ],
    selectedRowId: "openai",
  };
}

function requiredSecretPanel(): SecretEntryPanelState {
  return {
    kind: "secret",
    title: "API key · OpenAI",
    description: "Enter API key for OpenAI.",
    maskedValue: "sk-••••••••••••••••",
    rawValue: "sk-live-raw-secret",
    envVar: "OPENAI_API_KEY",
    footer: "Enter save · Esc back · Ctrl+C exit",
  };
}

function textEntryPanel(): TextEntryPanelState {
  return {
    kind: "textInput",
    title: "Workspace",
    description: "Enter workspace path.\nPress Enter to use the current default.\n\nCurrent default: /Users/ahnwy/project",
    value: "/Users/ahnwy/project\nchild",
    placeholder: "[leave empty]",
    footer: "Enter save · Ctrl+C cancel",
  };
}
