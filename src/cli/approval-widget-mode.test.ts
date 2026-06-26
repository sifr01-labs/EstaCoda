import { describe, expect, it } from "vitest";
import {
  APPROVAL_WIDGET_MODE_ENV_VAR,
  APPROVAL_WIDGET_MODES,
  parseApprovalWidgetMode,
  resolveCoreSessionApprovalWidgetMode,
  resolveApprovalWidgetMode,
  type ApprovalWidgetMode,
} from "./approval-widget-mode.js";

describe("approval widget mode", () => {
  it("keeps Papyrus as the only core session approval widget mode", () => {
    expect(resolveCoreSessionApprovalWidgetMode({
      env: {},
      inputMode: "raw",
      rendererMode: "papyrus",
    })).toBe("papyrus");
    expect(resolveCoreSessionApprovalWidgetMode({
      env: { [APPROVAL_WIDGET_MODE_ENV_VAR]: "legacy" },
      inputMode: "raw",
      rendererMode: "papyrus",
    })).toBe("papyrus");
  });

  it("defaults unset, empty, invalid, and removed legacy values to Papyrus", () => {
    expect(resolveApprovalWidgetMode({ env: {} })).toBe("papyrus");
    expect(parseApprovalWidgetMode(undefined)).toBe("papyrus");
    expect(parseApprovalWidgetMode("")).toBe("papyrus");
    expect(parseApprovalWidgetMode("   ")).toBe("papyrus");
    expect(parseApprovalWidgetMode("raw")).toBe("papyrus");
    expect(parseApprovalWidgetMode("legacy")).toBe("papyrus");
  });

  it("accepts papyrus case-insensitively", () => {
    expect(parseApprovalWidgetMode("papyrus")).toBe("papyrus");
    expect(parseApprovalWidgetMode("PAPYRUS")).toBe("papyrus");
    expect(parseApprovalWidgetMode("  papyrus  ")).toBe("papyrus");
  });

  it("resolves ESTACODA_APPROVAL_WIDGETS from a passed env object without mutating it", () => {
    const env = { [APPROVAL_WIDGET_MODE_ENV_VAR]: " legacy " };
    const before = { ...env };
    expect(resolveApprovalWidgetMode({ env })).toBe("papyrus");
    expect(env).toEqual(before);
  });

  it("exports only the narrow supported mode", () => {
    const modes = [...APPROVAL_WIDGET_MODES] satisfies ApprovalWidgetMode[];
    expect(modes).toEqual(["papyrus"]);
  });
});
