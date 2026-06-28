import { describe, expect, it } from "vitest";
import { stringWidth } from "../screen/stringWidth.js";
import { LRI, PDI } from "../../bidi.js";
import { resolveTokens } from "../../../theme/token-resolver.js";
import {
  createOperatorConsoleStyle,
  createDefaultStartupDashboardState,
  renderStartupDashboardSurface,
  type StartupDashboardState,
} from "./index.js";

describe("Papyrus operator console startup dashboard surface", () => {
  it("renders wide startup identity, session, commands, update, tips, and footer seal", () => {
    const output = renderStartupDashboardSurface(startupState(), { width: 80 });
    const text = output.join("\n");

    expect(output[0]).toContain("EstaCoda  𓂀  v0.1.0");
    expect(text).not.toContain("sovereign agentic infrastructure");
    expect(text).toContain("v0.1.0");
    expect(text).toContain("session    20ea8195");
    expect(text).toContain("╭─ Session");
    expect(text).toContain("╭─ Commands");
    expect(text).toContain("model      kimi-k2.6 ◐");
    expect(text).toContain("workspace  verified");
    expect(text).toContain("security   open");
    expect(text).toContain("evolution  autonomous");
    expect(text).toContain("/tools");
    expect(text).toContain("/skills");
    expect(text).toContain("/model");
    expect(text).toContain("/status");
    expect(text).toContain("/compact");
    expect(text).toContain("Update");
    expect(text).toContain("Up to date.");
    expect(text).toContain("Tips");
    expect(text).toContain("Paste large context as attachments.");
    expect(text).not.toContain("╭─ Tips");
    expect(output.at(-2)).toContain("☥ Kemet Research ☥");
    expect(output.every((line) => stringWidth(line) <= 80)).toBe(true);
  });

  it("stacks Session and Commands boxes in narrow layout", () => {
    const output = renderStartupDashboardSurface(startupState(), { width: 46 });
    const text = output.join("\n");
    const sessionIndex = output.findIndex((line) => line.includes("Session"));
    const commandsIndex = output.findIndex((line) => line.includes("Commands"));

    expect(text).toContain("EstaCoda");
    expect(text).toContain("Kemet Research");
    expect(text).toContain("EstaCoda  𓂀  v0.1.0");
    expect(sessionIndex).toBeGreaterThanOrEqual(0);
    expect(commandsIndex).toBeGreaterThan(sessionIndex);
    expect(output.every((line) => stringWidth(line) <= 46)).toBe(true);
  });

  it("renders Arabic startup dashboard as stacked right-aligned sections", () => {
    const output = renderStartupDashboardSurface({
      ...startupState(),
      sessionId: "53007044",
      updateStatus: "Update available.",
      session: {
        ...startupState().session,
        model: "kimi-k2.7-code ●",
        modelRoute: "primary",
        workspace: "/home/idris/estacoda",
      },
    }, { width: 96, locale: "ar" });
    const text = output.join("\n");
    const sessionIndex = output.findIndex((line) => line.includes("الجلسة"));
    const commandsIndex = output.findIndex((line) => line.includes("الأوامر"));
    const updateIndex = output.findIndex((line) => line.includes("التحديث"));
    const tipsIndex = output.findIndex((line) => line.includes("تلميحات"));

    expect(sessionIndex).toBeGreaterThan(0);
    expect(commandsIndex).toBeGreaterThan(sessionIndex);
    expect(updateIndex).toBeGreaterThan(commandsIndex);
    expect(tipsIndex).toBeGreaterThan(updateIndex);
    expect(text).not.toContain("╭─ الأوامر");
    expect(text).not.toContain("╭─ الجلسة");
    expect(text).toContain("النموذج");
    expect(text).toContain("مساحة العمل");
    expect(text).toContain("الموافقة");
    expect(text).toContain("تطوّر الوكيل");
    expect(text).toContain("مفتوحة");
    expect(text).toContain("مفعّل");
    expect(text).toContain("فحص الأدوات");
    expect(text).toContain("تغيير النموذج الأساسي");
    expect(text).toContain("يوجد تحديث متاح");
    expect(text).not.toContain("يوجد تحديث متاح.");
    expect(text).not.toContain("شغّل:");
    expect(text).toContain("شغّل");
    expect(text).toContain("estacoda update");
    expect(text).toContain("الصق السياق الكبير كمرفقات");
    expect(text).not.toContain("الصق السياق الكبير كمرفقات.");
    expect(text).toContain("لتغيير المسارات استخدم");
    expect(text).toContain("/model");
    expect(output.some((line) => line.includes("الأوامر") && line.includes("الجلسة"))).toBe(false);
    expect(stripBidi(output[0]).startsWith("  ╭")).toBe(true);
    expect(stringWidth(stripBidi(output[0]).trimStart())).toBeLessThan(96);
    expect(stripBidi(output.find((line) => line.includes("kimi-k2.7-code")) ?? "").trimEnd().endsWith("النموذج")).toBe(true);
    expect(stripBidi(output.find((line) => line.includes("53007044")) ?? "").trimEnd().endsWith("الجلسة")).toBe(true);
    expect(stripBidi(output.find((line) => line.includes("/home/idris/estacoda")) ?? "").trimEnd().endsWith("مساحة العمل")).toBe(true);
    const approvalLine = output.find((line) => line.includes("الموافقة")) ?? "";
    const evolutionLine = output.find((line) => line.includes("تطوّر الوكيل")) ?? "";
    expect(approvalLine.indexOf("الموافقة")).toBeLessThan(approvalLine.indexOf("مفتوحة"));
    expect(evolutionLine.indexOf("تطوّر الوكيل")).toBeLessThan(evolutionLine.indexOf("مفعّل"));
    expect(output.every((line) => stringWidth(line) <= 96)).toBe(true);
    expect(output.every((line) => line.startsWith(LRI) && line.endsWith(PDI))).toBe(true);
  });

  it("truncates long model, session, and tip text safely", () => {
    const output = renderStartupDashboardSurface({
      ...startupState(),
      sessionId: "20ea8195-with-an-extremely-long-suffix",
      session: {
        ...startupState().session,
        model: "kimi-k2.6-with-an-extremely-long-route-name ◐",
      },
      tips: ["Paste a very long context bundle as attachments instead of flooding the prompt surface."],
    }, { width: 44 });
    const text = output.join("\n");

    expect(text).not.toContain("extremely-long-route-name");
    expect(text).not.toContain("extremely-long-suffix");
    expect(output.every((line) => stringWidth(line) <= 44)).toBe(true);
  });

  it("emits no ANSI escape sequences or cursor-control strings and does not mutate input", () => {
    const state = startupState();
    const before = JSON.stringify(state);
    const output = renderStartupDashboardSurface(state, { width: 80 }).join("\n");

    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\\x1b");
    expect(output).not.toContain("\\u001b");
    expect(output).not.toContain("\\033");
    expect(output).not.toMatch(/\b(moveCursor|clearLine|clearScreenDown|cursorTo|setRawMode)\b/u);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("provides deterministic fallback values", () => {
    const output = renderStartupDashboardSurface(createDefaultStartupDashboardState(), { width: 72 }).join("\n");

    expect(output).toContain("EstaCoda");
    expect(output).toContain("model pending");
    expect(output).toContain("/tools");
  });

  it("uses token colors for brand title, section labels, and model route dot when styled", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const output = renderStartupDashboardSurface({
      ...startupState(),
      session: {
        ...startupState().session,
        modelRoute: "fallback",
      },
    }, { width: 80, style }).join("\n");

    expect(output).toContain(ansiFg(tokens.contract.palette.brand));
    expect(output).toContain(`${ansiFg(tokens.contract.palette.accent)}Session\x1b[0m`);
    expect(output).toContain(`${ansiFg(tokens.contract.palette.accent)}Commands\x1b[0m`);
    expect(output).toContain(`${ansiFg(tokens.contract.palette.accent)}Update\x1b[0m`);
    expect(output).toContain(`${ansiFg(tokens.contract.palette.accent)}Tips\x1b[0m`);
    expect(output).toContain(`${ansiFg(tokens.contract.text.secondary)}☥ Kemet Research ☥\x1b[0m`);
    expect(output).toContain(`${ansiFg(tokens.contract.palette.caution)}◐\x1b[0m`);
  });
});

function startupState(): StartupDashboardState {
  return {
    productName: "EstaCoda",
    orgName: "Kemet Research",
    tagline: "sovereign agentic infrastructure",
    version: "v0.1.0",
    sessionId: "20ea8195",
    updateStatus: "Up to date.",
    session: {
      model: "kimi-k2.6 ◐",
      context: "0 / 262k",
      workspace: "verified",
      security: "open",
      autonomy: "autonomous",
    },
    commands: [
      { command: "/tools", description: "inspect tools" },
      { command: "/skills", description: "loaded skills" },
      { command: "/model", description: "switch primary model" },
      { command: "/status", description: "runtime state" },
      { command: "/compact", description: "compact session context" },
    ],
    tips: [
      "Paste large context as attachments.",
      "Use /model to switch routes.",
      "Approvals appear inline when an action needs permission.",
    ],
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

function stripBidi(value: string): string {
  return value.replaceAll(LRI, "").replaceAll(PDI, "");
}
