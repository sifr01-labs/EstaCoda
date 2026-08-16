import { describe, expect, it } from "vitest";
import type { ExecutionPlan } from "../../../contracts/execution-plan.js";
import { resolveTokens } from "../../../theme/token-resolver.js";
import { FSI, LRI, PDI } from "../../bidi.js";
import { stringWidth } from "../screen/stringWidth.js";
import { createOperatorConsoleStyle } from "./operatorConsoleStyle.js";
import { formatPlainExecutionPlan, getMissionSurfaceDesiredHeight, renderMissionSurface } from "./missionSurface.js";

const plan: ExecutionPlan = {
  objective: "Build six MTN products in Postman",
  originTurnId: "turn-1",
  revision: 3,
  status: "active",
  items: [
    { id: "identify", content: "Identify products", status: "completed" },
    { id: "specs", content: "Obtain specifications", status: "in_progress" },
    { id: "build", content: "Build collection", status: "pending" }
  ]
};

describe("Mission surface", () => {
  it("renders the English Mission checklist", () => {
    expect(renderMissionSurface(plan, { width: 80, locale: "en" })).toEqual([
      "Mission · 1 / 3 · Build six MTN products in Postman",
      "✓ Identify products",
      "● Obtain specifications",
      "○ Build collection"
    ]);
  });

  it("uses the Arabic product label", () => {
    const arabic = { ...plan, objective: "إنشاء مجموعة MTN في Postman" };
    const header = renderMissionSurface(arabic, { width: 80, locale: "ar" })[0] ?? "";

    expect(header).toContain("خطة التنفيذ");
    expect(header).toContain(`${LRI}1 / 3${PDI}`);
    expect(header).toContain(`${FSI}إنشاء مجموعة ${LRI}MTN${PDI} في ${LRI}Postman${PDI}${PDI}`);
  });

  it("stays within narrow terminal width", () => {
    const lines = renderMissionSurface(plan, { width: 18, height: 3, locale: "en" });
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => stringWidth(line) <= 18)).toBe(true);
    expect(lines[0]).toContain("Mission");
  });

  it("uses Papyrus tokens to distinguish Mission hierarchy and statuses", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const withAllStatuses: ExecutionPlan = {
      ...plan,
      items: [
        ...plan.items,
        { id: "blocked", content: "Wait for access", status: "blocked" },
        { id: "cancelled", content: "Use deprecated route", status: "cancelled" },
      ],
    };
    const output = renderMissionSurface(withAllStatuses, { width: 100, locale: "en", style }).join("\n");

    expect(output).toContain(`${ansiFg(tokens.contract.palette.accent)}Mission\x1b[0m`);
    expect(output).toContain(ansiFg(tokens.contract.severity.ok));
    expect(output).toContain(ansiFg(tokens.contract.palette.action));
    expect(output).toContain(ansiFg(tokens.contract.text.muted));
    expect(output).toContain(ansiFg(tokens.contract.severity.warn));
    expect(output).toContain(ansiFg(tokens.contract.severity.error));
    expect(stripAnsi(output)).toContain("Mission · 1 / 5 · Build six MTN products in Postman");
  });

  it("keeps live plain-mode rendering color-free and deterministic", () => {
    const style = createOperatorConsoleStyle({
      tokens: resolveTokens("plain", "dark", "kemetBlue"),
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const first = renderMissionSurface(plan, { width: 80, locale: "en", style });
    const second = renderMissionSurface(plan, { width: 80, locale: "en", style });

    expect(first).toEqual(second);
    expect(first.join("\n")).not.toContain("\x1b");
    expect(first[0]).toBe("Mission · 1 / 3 · Build six MTN products in Postman");
  });

  it("has a deterministic plain rendering", () => {
    expect(formatPlainExecutionPlan(plan)).toContain("✓ Identify products\n● Obtain specifications");
  });

  it("hides terminal Missions from the live surface while retaining a durable plain summary", () => {
    for (const status of ["completed", "abandoned", "transferred"] as const) {
      const terminal = { ...plan, status };
      expect(getMissionSurfaceDesiredHeight(terminal)).toBe(0);
      expect(renderMissionSurface(terminal, { width: 80, locale: "en" })).toEqual([]);
      expect(formatPlainExecutionPlan(terminal)).toContain("Mission · Build six MTN products in Postman");
    }
  });

  it("continues rendering blocked and hydrated unfinished Missions", () => {
    const blocked: ExecutionPlan = {
      ...plan,
      status: "blocked",
      items: plan.items.map((item, index) => index === 1
        ? {
            ...item,
            status: "blocked" as const,
            blocker: { kind: "external_state" as const, summary: "The remote service is unavailable." },
          }
        : item),
    };
    expect(getMissionSurfaceDesiredHeight(blocked)).toBeGreaterThan(0);
    expect(renderMissionSurface(blocked, { width: 80, locale: "en" }).join("\n"))
      .toContain("! Obtain specifications");
    expect(renderMissionSurface(plan, { width: 80, locale: "en" }).join("\n"))
      .toContain("● Obtain specifications");
  });
});

function ansiFg(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "");
}
