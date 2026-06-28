import { describe, expect, it } from "vitest";
import { stringWidth } from "../screen/stringWidth.js";
import { resolveTokens } from "../../../theme/token-resolver.js";
import { LRI, RLI } from "../../../ui/bidi.js";
import {
  createOperatorConsoleStyle,
  renderSetupPanelSurface,
  type SecretEntryPanelState,
  type SetupPanelState,
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
    expect(text).toContain("↑↓ navigate · Enter select · / filter · Esc back");
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
    expect(text).toContain("Enter");
    expect(text).toContain("Esc");
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
    const selectedDetailLine = output.find((line) => line.includes("نماذج احتياطية")) ?? "";

    expect(selectedLine).toContain(ansiFg(tokens.contract.palette.action));
    expect(selectedLine).toContain("\x1b[1m");
    expect(selectedLine).toContain(`${RLI}النماذج الاحتياطية`);
    expect(selectedLine).toMatch(/النماذج الاحتياطية.*◂.*\x1b\[0m/u);
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

  it("colors setup shell title, current status, and footer when styled", () => {
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

    expect(output).toContain(`${ansiFg(tokens.contract.palette.brand)}\x1b[1m𓂀  Model Route\x1b[0m\x1b[0m`);
    expect(output).toContain(`${ansiFg(tokens.contract.severity.ok)}Current: OpenAI\x1b[0m`);
    expect(output).toContain(`${ansiFg(tokens.contract.text.secondary)}↑↓ navigate   ENTER select   CTRL+C exit\x1b[0m`);
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
