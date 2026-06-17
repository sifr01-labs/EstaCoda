import { describe, expect, it } from "vitest";
import { renderChannelProgressLabel, toolEmoji } from "./activity-labels.js";

describe("channel activity labels", () => {
  it("renders updated localized lifecycle labels", () => {
    expect(renderChannelProgressLabel({ kind: "agent-start", sessionId: "s1", input: "hello" }, "en")).toBe("◉ Thinking");
    expect(renderChannelProgressLabel({ kind: "agent-start", sessionId: "s1", input: "hello" }, "ar")).toBe("◉ جارٍ التفكير");
    expect(renderChannelProgressLabel({ kind: "provider-attempt", provider: "openrouter", model: "k2", fallback: false }, "en")).toBe("✦ Routing provider · k2");
    expect(renderChannelProgressLabel({ kind: "provider-attempt", provider: "openrouter", model: "k2", fallback: false }, "ar")).toBe("✦ توجيه النموذج · k2");
    expect(renderChannelProgressLabel({ kind: "provider-attempt", provider: "openrouter", model: "deepseek-v4-pro", fallback: true }, "en")).toBe("✦ Routing fallback · deepseek-v4-pro");
    expect(renderChannelProgressLabel({ kind: "provider-attempt", provider: "openrouter", model: "deepseek-v4-pro", fallback: true }, "ar")).toBe("✦ توجيه احتياطي · deepseek-v4-pro");
  });

  it("renders tool starts with tool name and target summary", () => {
    expect(renderChannelProgressLabel({
      kind: "tool-start",
      tool: "file.search",
      targetSummary: "import.*python-env|from.*python-env"
    })).toBe("🔎 file.search: \"import.*python-env|from.*python-env\"");
    expect(renderChannelProgressLabel({
      kind: "tool-start",
      tool: "terminal.run",
      targetSummary: "pnpm test"
    })).toBe("🖥️ terminal.run: \"pnpm test\"");
  });

  it("renders tool starts without summaries and falls back for unknown tools", () => {
    expect(renderChannelProgressLabel({ kind: "tool-start", tool: "terminal.run" })).toBe("🖥️ terminal.run");
    expect(renderChannelProgressLabel({ kind: "tool-start", tool: "web_search" })).toBe("🌐 web_search");
    expect(renderChannelProgressLabel({ kind: "tool-start", tool: "mcp.custom_tool", targetSummary: "payload" })).toBe("⚙️ mcp.custom_tool: \"payload\"");
  });

  it("uses mixed EstaCoda glyphs for selected tool families", () => {
    expect(toolEmoji("skill.create")).toBe("✦");
    expect(toolEmoji("config.image.setup")).toBe("🎨");
    expect(toolEmoji("image.generate")).toBe("🎨");
    expect(toolEmoji("python.probe")).toBe("𓆙");
    expect(toolEmoji("execute_code")).toBe("𓆙");
  });
});
