import { describe, expect, it } from "vitest";
import { isolateLtr, isolateRtl } from "../../../ui/bidi.js";
import { mapSetupSelectToSetupPanelState } from "./setupSelectRuntimeMapper.js";

describe("Operator Console setup select runtime mapper", () => {
  it("maps provider/model/status/notes cells into a setup panel state", () => {
    const state = mapSetupSelectToSetupPanelState({
      title: "Model route",
      body: "Choose the active provider and model route.\n",
      statusLines: [{ text: "Current: OpenAI", tone: "active", direction: "ltr" }],
      selectedIndex: 1,
      options: [
        {
          id: "openai",
          label: "OpenAI",
          cells: {
            provider: "OpenAI",
            model: "gpt-5.5",
            status: "ready",
            notes: "API key set",
          },
        },
        {
          id: "local",
          label: "Local",
          cells: {
            provider: "Local",
            model: "qwen3-coder",
            status: "offline",
            notes: "endpoint unset",
          },
        },
      ],
    });

    expect(state).toEqual({
      kind: "table",
      layout: "routeTable",
      title: "Model route",
      description: "Choose the active provider and model route.",
      statusLines: [{ text: "Current: OpenAI", tone: "active", direction: "ltr" }],
      locale: undefined,
      selectedRowId: "local",
      footer: "↑↓ navigate   ENTER select   CTRL+C exit",
      rows: [
        { id: "openai", provider: "OpenAI", model: "gpt-5.5", status: "ready", notes: "API key set" },
        { id: "local", provider: "Local", model: "qwen3-coder", status: "offline", notes: "endpoint unset" },
      ],
    });
  });

  it("maps two-column setup choices without cells into a choice menu", () => {
    const state = mapSetupSelectToSetupPanelState({
      title: "محرّر الإعدادات",
      body: "اختار اللي تحب تضبطه:\n",
      locale: "ar",
      columns: [
        { key: "description", header: "التفاصيل", align: "left" },
        { key: "name", header: "الاسم", align: "right" },
      ],
      selectedIndex: 1,
      options: [
        {
          id: "primary",
          label: "النموذج الأساسي",
          description: "النموذج الافتراضي الذي يستخدمه الوكيل.",
        },
        {
          id: "fallback",
          label: "النماذج الاحتياطية",
          description: "نماذج احتياطية تُستخدم إذا فشل النموذج الأساسي.",
        },
        {
          id: "exit",
          label: "الخروج دون تغييرات",
          description: "غادر الإعداد دون تعديل التكوين.",
          group: "navigation",
        },
      ],
    });

    expect(state).toMatchObject({
      kind: "table",
      layout: "choiceMenu",
      selectedRowId: "fallback",
      rows: [
        {
          id: "primary",
          provider: "النموذج الأساسي",
          status: "النموذج الافتراضي الذي يستخدمه الوكيل.",
        },
        {
          id: "fallback",
          provider: "النماذج الاحتياطية",
          status: "نماذج احتياطية تُستخدم إذا فشل النموذج الأساسي.",
        },
        {
          id: "exit",
          provider: "الخروج دون تغييرات",
          status: "غادر الإعداد دون تعديل التكوين.",
          group: "navigation",
        },
      ],
    });
  });

  it("maps columnless setup choices without route cells into a choice menu", () => {
    const state = mapSetupSelectToSetupPanelState({
      title: "Finalize configuration",
      body: "Review the changes before applying.\n",
      statusLines: [{ text: "Pending changes: Security", tone: "warning", direction: "ltr" }],
      selectedIndex: 1,
      options: [
        {
          id: "approve",
          label: "Apply changes",
          description: "Write reviewed setup changes.",
        },
        {
          id: "cancel",
          label: "Cancel",
          description: "Leave setup unchanged.",
          group: "navigation",
        },
      ],
    });

    expect(state).toMatchObject({
      kind: "table",
      layout: "choiceMenu",
      title: "Finalize configuration",
      statusLines: [{ text: "Pending changes: Security", tone: "warning", direction: "ltr" }],
      selectedRowId: "cancel",
      rows: [
        {
          id: "approve",
          provider: "Apply changes",
          status: "Write reviewed setup changes.",
        },
        {
          id: "cancel",
          provider: "Cancel",
          status: "Leave setup unchanged.",
          group: "navigation",
        },
      ],
    });
  });

  it("preserves intentional multiline setup choice body copy", () => {
    const state = mapSetupSelectToSetupPanelState({
      title: "Setup language",
      body: `Choose the language EstaCoda uses for setup and CLI guidance.\n${isolateRtl(`اختر اللغة التي تستخدمها ${isolateLtr("EstaCoda")} للإعداد وإرشادات الطرفية.`)}\n`,
      selectedIndex: 0,
      options: [
        { id: "en", label: "English" },
        { id: "ar", label: "العربية" },
      ],
    });

    expect(state?.description).toBe(
      `Choose the language EstaCoda uses for setup and CLI guidance.\n${isolateRtl(`اختر اللغة التي تستخدمها ${isolateLtr("EstaCoda")} للإعداد وإرشادات الطرفية.`)}`
    );
  });

  it("maps existing setup name/details cells without changing semantic option values", () => {
    const state = mapSetupSelectToSetupPanelState({
      title: "Primary provider",
      body: "Choose your primary model provider.\n",
      hint: "↑↓ navigate   ENTER select",
      selectedIndex: 0,
      options: [
        {
          id: "openai",
          label: "OpenAI",
          cells: {
            name: "OpenAI",
            details: "Hosted OpenAI models. API key required.",
          },
          current: true,
        },
      ],
    });

    expect(state?.rows).toEqual([
      {
        id: "openai",
        provider: "OpenAI",
        model: "",
        status: "Hosted OpenAI models. API key required.",
        notes: "current",
      },
    ]);
    expect(state?.footer).toBe("↑↓ navigate   ENTER select   CTRL+C exit");
  });

  it("preserves Arabic copy and technical tokens", () => {
    const state = mapSetupSelectToSetupPanelState({
      title: "إعداد النموذج",
      body: "اختر مزود النموذج والمسار النشط.",
      locale: "ar",
      selectedIndex: 0,
      options: [
        {
          id: "openai",
          label: "OpenAI",
          cells: {
            provider: "OpenAI",
            model: "gpt-5.5",
            status: "جاهز",
            notes: "API key محفوظ",
          },
        },
        {
          id: "local",
          label: "Local",
          cells: {
            provider: "Local",
            model: "qwen3-coder",
            status: "غير متصل",
            notes: "URL غير مضبوط",
          },
        },
      ],
    });

    expect(state?.locale).toBe("ar");
    expect(state?.rows[0]).toMatchObject({
      provider: "OpenAI",
      model: "gpt-5.5",
      notes: "API key محفوظ",
    });
    expect(state?.rows[1]).toMatchObject({
      provider: "Local",
      model: "qwen3-coder",
      notes: "URL غير مضبوط",
    });
    expect(state?.footer).toContain("ENTER");
    expect(state?.footer).toContain("CTRL+C");
  });
});
