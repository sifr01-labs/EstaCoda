import { describe, expect, it } from "vitest";
import { activityKeyForTool, renderChannelProgressLabel } from "./activity-labels.js";

describe("channel activity labels", () => {
  it("renders updated localized lifecycle labels", () => {
    expect(renderChannelProgressLabel({ kind: "agent-start", sessionId: "s1", input: "hello" }, "en")).toBe("◉ Thinking");
    expect(renderChannelProgressLabel({ kind: "agent-start", sessionId: "s1", input: "hello" }, "ar")).toBe("◉ جارٍ التفكير");
    expect(renderChannelProgressLabel({ kind: "provider-attempt", provider: "openrouter", model: "k2", fallback: false }, "en")).toBe("");
    expect(renderChannelProgressLabel({ kind: "provider-attempt", provider: "openrouter", model: "k2", fallback: false }, "ar")).toBe("");
    expect(renderChannelProgressLabel({ kind: "provider-attempt", provider: "openrouter", model: "deepseek-v4-pro", fallback: true }, "en")).toBe("");
    expect(renderChannelProgressLabel({ kind: "provider-serving-transition", transition: "fallback-active", provider: "openrouter", model: "deepseek-v4-pro" }, "en")).toBe("✦ Using fallback · deepseek-v4-pro");
    expect(renderChannelProgressLabel({ kind: "provider-serving-transition", transition: "fallback-active", provider: "openrouter", model: "deepseek-v4-pro" }, "ar")).toBe("✦ استخدام النموذج الاحتياطي · deepseek-v4-pro");
    expect(renderChannelProgressLabel({ kind: "provider-serving-transition", transition: "primary-recovered", provider: "openrouter", model: "k2" }, "en")).toBe("✦ Primary model available again · k2");
    expect(renderChannelProgressLabel({ kind: "provider-serving-transition", transition: "primary-recovered", provider: "openrouter", model: "k2" }, "ar")).toBe("✦ النموذج الأساسي متاح مجددًا · k2");
  });

  it("renders explicit localized provider spending warnings", () => {
    const warning = {
      kind: "provider-spending-warning" as const,
      warningId: "warning-1",
      scopeKind: "session" as const,
      warningThresholdPercent: 80,
      maxEstimatedCostUsd: 10,
      committedCostUsd: 8
    };
    expect(renderChannelProgressLabel(warning, "en")).toContain(
      "Estimated spending warning: Session has used or reserved $8.00 of $10.00 in provider spending"
    );
    expect(renderChannelProgressLabel(warning, "ar")).toContain("تنبيه بشأن الإنفاق التقديري");
  });

  it("renders tool starts with display label and target summary", () => {
    expect(renderChannelProgressLabel({
      kind: "tool-start",
      tool: "file.search",
      targetSummary: "import.*python-env|from.*python-env"
    })).toBe("🔎 Search Files: \"import.*python-env|from.*python-env\"");
    expect(renderChannelProgressLabel({
      kind: "tool-start",
      tool: "terminal.run",
      targetSummary: "pnpm test"
    })).toBe("🖥️ Run Command: \"pnpm test\"");
  });

  it("renders tool starts without summaries and falls back for unknown tools", () => {
    expect(renderChannelProgressLabel({ kind: "tool-start", tool: "terminal.run" })).toBe("🖥️ Run Command");
    expect(renderChannelProgressLabel({ kind: "tool-start", tool: "web_search" })).toBe("🌐 Web Search");
    expect(renderChannelProgressLabel({ kind: "tool-start", tool: "mcp.custom_tool", targetSummary: "payload" })).toBe("⚙️ Custom Tool: \"payload\"");
  });

  it("keeps category labels separate from exact display labels", () => {
    expect(activityKeyForTool("skill.read")).toBe("load_skill");
    expect(activityKeyForTool("skill.search")).toBe("load_skill");
    expect(activityKeyForTool("skill.view")).toBe("load_skill");
  });
});
