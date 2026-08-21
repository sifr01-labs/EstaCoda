import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveTokens } from "../../../theme/token-resolver.js";
import { FSI, LRI, PDI } from "../../bidi.js";
import { stringWidth } from "../screen/stringWidth.js";
import {
  APPROVAL_FOCUS_CONTROLS,
  createOperatorConsoleStyle,
  createInitialOperatorConsoleState,
  getApprovalSurfaceDesiredHeight,
  renderApprovalSurface,
  routeApprovalKey,
  type ApprovalCardState,
  type OperatorConsoleState,
} from "./index.js";

const thisDir = dirname(fileURLToPath(import.meta.url));

describe("Papyrus operator console approval surface", () => {
  it("renders a pending approval card with action, target, and risk", () => {
    const output = renderApprovalSurface([approval()], { width: 54 });
    const text = output.join("\n");

    expect(output[0]).toMatch(/^\s*╭─ Approval required ─+ schema change ─╮$/u);
    expect(text).toContain("run migration");
    expect(text).toContain("Target · production database");
    expect(text).toContain("Inspect       Review details before deciding");
    expect(text).toContain("Approve once  Permit only this action");
    expect(text).toContain("Reject        Deny this action");
    expect(text.indexOf("Inspect")).toBeLessThan(text.indexOf("Approve once"));
    expect(text.indexOf("Approve once")).toBeLessThan(text.indexOf("Reject"));
  });

  it("renders file-write approval diff stats", () => {
    const output = renderApprovalSurface([
      approval({
        action: "write file",
        target: "src/runtime/provider-turn-loop.ts",
        risk: "runtime behavior change",
        diffStats: { added: 42, removed: 17 },
      }),
    ], { width: 64 });
    const text = output.join("\n");

    expect(text).toContain("write file");
    expect(text).toContain("Target · src/runtime/provider-turn-loop.ts");
    expect(output[0]).toContain("runtime behavior change");
    expect(text).toContain("+42 lines  -17 lines");
  });

  it("renders only approve once, reject, and inspect controls for pending approvals", () => {
    const text = renderApprovalSurface([approval()], { width: 64 }).join("\n");

    expect(text).toContain("Approve once");
    expect(text).toContain("Reject");
    expect(text).toContain("Inspect");
    expect(text).not.toMatch(/feedback|amend|session|persistent|always|do not ask|scope|forever/iu);
    expect(text).not.toContain("[Add feedback]");
    expect(text).not.toContain("[Amend]");
    expect(text).not.toContain("[Approve session]");
    expect(text).not.toContain("[Approve always]");
  });

  it("renders the scopes explicitly enabled for an ordinary runtime approval", () => {
    const text = renderApprovalSurface([approval({
      availableScopes: ["once", "session", "always"],
      grantMatch: "target",
    })], { width: 88 }).join("\n");

    expect(text).toContain("Approve once");
    expect(text).toContain("Approve for session");
    expect(text).toContain("Permit matches this session");
    expect(text).toContain("Always approve in workspace");
    expect(text).toContain("Permit matches here until revoked");
    expect(text).toContain("Reject");
  });

  it("describes tool-wide grants when an approval has no stable target identity", () => {
    const text = renderApprovalSurface([approval({
      availableScopes: ["once", "session", "always"],
      grantMatch: "tool",
    })], { width: 88 }).join("\n");

    expect(text).toContain("Permit this tool this session");
    expect(text).toContain("Permit this tool here until revoked");
  });

  it("renders visual focus for the focused approval control", () => {
    const output = renderApprovalSurface([
      approval({
        action: "write file",
        focusedControl: "approve",
      }),
    ], { width: 64 });

    expect(output).toContainEqual(expect.stringContaining("❯ Approve once"));
    expect(output.join("\n")).not.toContain("[Approve once]");
  });

  it("cycles focus forward and backward across approval controls", () => {
    const state = createState({ focusedControl: "approve" });
    const reject = routeApprovalKey(state, { type: "key", key: "tab" }).state;
    const inspect = routeApprovalKey(reject, { type: "key", key: "right" }).state;
    const approve = routeApprovalKey(inspect, { type: "key", key: "tab" }).state;
    const back = routeApprovalKey(inspect, { type: "key", key: "left" }).state;

    expect(focusedApproval(back).focusedControl).toBe("reject");
    expect(reject.focus.target).toEqual({ kind: "approval", approvalId: "approval-1", control: "reject" });
    expect(focusedApproval(inspect).focusedControl).toBe("inspect");
    expect(focusedApproval(approve).focusedControl).toBe("approve");
  });

  it("moves through the vertical choices with up and down", () => {
    const down = routeApprovalKey(createState({ focusedControl: "approve" }), { type: "key", key: "down" }).state;
    const up = routeApprovalKey(down, { type: "key", key: "up" }).state;

    expect(focusedApproval(down).focusedControl).toBe("reject");
    expect(focusedApproval(up).focusedControl).toBe("approve");
  });

  it("cycles reverse focus from inspect to reject to approve to inspect", () => {
    const reject = routeApprovalKey(createState({ focusedControl: "inspect" }), { type: "key", key: "tab", shift: true }).state;
    const approve = routeApprovalKey(reject, { type: "key", key: "left" }).state;
    const inspect = routeApprovalKey(approve, { type: "key", key: "left" }).state;

    expect(focusedApproval(reject).focusedControl).toBe("reject");
    expect(focusedApproval(approve).focusedControl).toBe("approve");
    expect(focusedApproval(inspect).focusedControl).toBe("inspect");
  });

  it("emits approve, reject, and inspect intents from focused controls", () => {
    expect(routeApprovalKey(createState({ focusedControl: "approve" }), { type: "key", key: "enter" }).intent).toEqual({
      type: "approve",
      approvalId: "approval-1",
      scope: "once",
    });
    expect(routeApprovalKey(createState({ focusedControl: "reject" }), { type: "key", key: "enter" }).intent).toEqual({
      type: "reject",
      approvalId: "approval-1",
    });
    expect(routeApprovalKey(createState({ focusedControl: "inspect" }), { type: "key", key: "enter" }).intent).toEqual({
      type: "inspect",
      approvalId: "approval-1",
    });
  });

  it("routes session and workspace approval choices with explicit scopes", () => {
    const state = createState({
      availableScopes: ["once", "session", "always"],
      focusedControl: "approve",
      focusedScope: "session",
    });
    const session = routeApprovalKey(state, { type: "key", key: "enter" });
    const alwaysState = routeApprovalKey(state, { type: "key", key: "down" }).state;
    const always = routeApprovalKey(alwaysState, { type: "key", key: "enter" });

    expect(session.intent).toEqual({ type: "approve", approvalId: "approval-1", scope: "session" });
    expect(focusedApproval(alwaysState)).toMatchObject({ focusedControl: "approve", focusedScope: "always" });
    expect(always.intent).toEqual({ type: "approve", approvalId: "approval-1", scope: "always" });
  });

  it("emits reject intent on Escape for pending approval", () => {
    expect(routeApprovalKey(createState({ focusedControl: "approve" }), { type: "key", key: "escape" }).intent).toEqual({
      type: "reject",
      approvalId: "approval-1",
    });
  });

  it("does not emit actionable intents for non-pending cards", () => {
    for (const status of ["approved", "rejected", "expired", "superseded"] as const) {
      const state = createState({ status, focusedControl: "approve" });

      expect(routeApprovalKey(state, { type: "key", key: "enter" }).intent).toEqual({ type: "none" });
      expect(routeApprovalKey(state, { type: "key", key: "escape" }).intent).toEqual({ type: "none" });
    }
  });

  it("renders approved, rejected, expired, and superseded cards as non-actionable", () => {
    const text = renderApprovalSurface([
      approval({ status: "approved" }),
      approval({ id: "approval-2", status: "rejected" }),
      approval({ id: "approval-3", status: "expired" }),
      approval({ id: "approval-4", status: "superseded" }),
    ], { width: 64 }).join("\n");

    expect(text).toContain("Approval approved");
    expect(text).toContain("Approved once");
    expect(text).toContain("Approval rejected");
    expect(text).toContain("Rejected by operator");
    expect(text).toContain("Approval expired");
    expect(text).toContain("Approval superseded");
    expect(text).not.toContain("Permit only this action");
    expect(text).not.toContain("Deny this action");
    expect(text).not.toContain("Review details before deciding");
  });

  it("does not render actionable controls for hardline-like rejected approvals", () => {
    const hardline = approval({
        status: "rejected",
        risk: "hardline policy denial",
        summary: "Blocked by command policy",
        focusedControl: "approve",
    });
    const text = renderApprovalSurface([hardline], { width: 64 }).join("\n");
    const result = routeApprovalKey(createState(hardline), { type: "key", key: "enter" });

    expect(text).toContain("Blocked by command policy");
    expect(text).not.toContain("Approve once");
    expect(text).not.toContain("Inspect");
    expect(result.intent).toEqual({ type: "none" });
  });

  it("wraps long action, target, and risk text safely", () => {
    const longAction = "write file with a very long generated migration and runtime policy change";
    const longTarget = "src/runtime/deeply/nested/provider-turn-loop-with-a-very-long-name.ts";
    const longRisk = "runtime behavior change with persistence and approval implications";
    const output = renderApprovalSurface([
      approval({
        action: longAction,
        target: longTarget,
        risk: longRisk,
      }),
    ], { width: 44 });
    const text = output.join("\n");

    expect(text).toContain("write file");
    expect(text).not.toContain(longAction);
    expect(text).not.toContain(longTarget);
    expect(text).not.toContain(longRisk);
    expect(output.length).toBeGreaterThan(10);
    expect(output.every((line) => stringWidth(line) <= 44)).toBe(true);
  });

  it("keeps multiline risk text inside content rows", () => {
    const output = renderApprovalSurface([approval({ risk: "external side effect\nrequires review" })], { width: 64 });
    const text = output.join("\n");

    expect(output[0]).not.toContain("external side effect");
    expect(text).toContain("Risk · external side effect requires review");
    expect(output.every((line) => stringWidth(line) <= 64)).toBe(true);
  });

  it("keeps every approval card line within the terminal width", () => {
    for (const width of [1, 2, 3, 4, 5, 12, 24, 48, 72, 160]) {
      const output = renderApprovalSurface([
        approval({
          action: "🛑 write file with long runtime action",
          target: "src/runtime/provider-turn-loop.ts",
          risk: "runtime behavior change",
          diffStats: { added: 42, removed: 17 },
          focusedControl: "inspect",
        }),
      ], { width });

      expect(output.every((line) => stringWidth(line) <= width)).toBe(true);
    }
  });

  it("bounds and centers the attention card on wide terminals", () => {
    const output = renderApprovalSurface([approval()], { width: 160 });

    expect(output.every((line) => stringWidth(line.trimStart()) === 104)).toBe(true);
    expect(output[0]).toMatch(/^ {28}╭/u);
  });

  it("uses semantic Papyrus tokens for hierarchy, decisions, and selection", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const output = renderApprovalSurface([
      approval({ focusedControl: "approve", diffStats: { added: 2, removed: 1 } }),
    ], { width: 88, style }).join("\n");

    expect(output).toContain(ansiFg(tokens.contract.palette.caution));
    expect(output).toContain(ansiFg(tokens.contract.severity.info));
    expect(output).toContain(ansiFg(tokens.contract.interactive.selected));
    expect(output).toContain(ansiBg(tokens.contract.interactive.selectedBg));
    expect(output).toContain(ansiFg(tokens.contract.severity.error));
    expect(output).toContain(ansiFg(tokens.contract.severity.ok));
  });

  it("localizes fixed copy and isolates mixed Arabic technical values", () => {
    const output = renderApprovalSurface([approval({
      action: "تشغيل Browser CDP",
      target: "developers.mtn.com تسجيل الدخول",
      risk: "تأثير خارجي",
      focusedControl: "approve",
      availableScopes: ["once", "session", "always"],
    })], { width: 88, locale: "ar" });
    const text = output.join("\n");

    expect(text).toContain("الموافقة مطلوبة");
    expect(text).toContain("فحص");
    expect(text).toContain("موافقة لمرة واحدة");
    expect(text).toContain("موافقة لهذه الجلسة");
    expect(text).toContain("موافقة دائمة في مساحة العمل");
    expect(text).toContain(`${FSI}`);
    expect(text).toContain(`${LRI}developers.mtn.com${PDI}`);
    expect(output.every((line) => stringWidth(line) <= 88)).toBe(true);
  });

  it("calculates desired height from the responsive rendered rows", () => {
    const card = approval({
      action: "write file with a long generated migration and runtime policy change",
      target: "src/runtime/deeply/nested/provider-turn-loop.ts",
      focusedControl: "inspect",
    });

    expect(getApprovalSurfaceDesiredHeight([card], 40, "en")).toBe(
      renderApprovalSurface([card], { width: 40, locale: "en" }).length
    );
  });

  it("emits no ANSI escape sequences or cursor-control strings", () => {
    const output = renderApprovalSurface([approval({ focusedControl: "approve" })], { width: 64 }).join("\n");

    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\\x1b");
    expect(output).not.toContain("\\u001b");
    expect(output).not.toContain("\\033");
    expect(output).not.toMatch(/\b(moveCursor|clearLine|clearScreenDown|cursorTo|setRawMode)\b/u);
  });

  it("does not mutate approval state while rendering or routing", () => {
    const state = createState({ focusedControl: "approve" });
    const before = JSON.stringify(state);

    renderApprovalSurface(state.approvals, { width: 64 });
    routeApprovalKey(state, { type: "key", key: "enter" });

    expect(JSON.stringify(state)).toBe(before);
  });

  it("keeps approval focus controls limited to approve, reject, and inspect", () => {
    expect(APPROVAL_FOCUS_CONTROLS).toEqual(["inspect", "approve", "reject"]);
  });

  it("returns scoped approval UI intents without grant or persistence metadata", () => {
    const result = routeApprovalKey(createState({ focusedControl: "approve" }), { type: "key", key: "enter" });

    expect(Object.keys(result.intent).sort()).toEqual(["approvalId", "scope", "type"]);
    expect(result.intent).toEqual({
      type: "approve",
      approvalId: "approval-1",
      scope: "once",
    });
    expect(result.intent).not.toHaveProperty("persistent");
    expect(result.intent).not.toHaveProperty("grant");
  });

  it("keeps approval policy outside the UI surface", () => {
    const source = readFileSync(join(thisDir, "approvalSurface.ts"), "utf8");

    expect(source).not.toMatch(/\bgrantApproval\b/u);
    expect(source).not.toMatch(/\bpersist(?:ent)?Approval\b/u);
    expect(source).not.toMatch(/\bassessCommandSafety\b/u);
  });
});

function ansiFg(hex: string): string {
  const { r, g, b } = rgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function ansiBg(hex: string): string {
  const { r, g, b } = rgb(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

function rgb(hex: string): { readonly r: number; readonly g: number; readonly b: number } {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function createState(input: Partial<ApprovalCardState> = {}): OperatorConsoleState {
  const card = approval(input);
  return createInitialOperatorConsoleState({
    approvals: [card],
    focus: {
      target: {
        kind: "approval",
        approvalId: card.id,
        control: card.focusedControl ?? "approve",
      },
    },
  });
}

function focusedApproval(state: OperatorConsoleState): ApprovalCardState {
  return state.approvals[0]!;
}

function approval(input: Partial<ApprovalCardState> = {}): ApprovalCardState {
  return {
    id: input.id ?? "approval-1",
    status: input.status ?? "pending",
    action: input.action ?? "run migration",
    target: input.target ?? "production database",
    risk: input.risk ?? "schema change",
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.availableScopes === undefined ? {} : { availableScopes: input.availableScopes }),
    ...(input.grantMatch === undefined ? {} : { grantMatch: input.grantMatch }),
    ...(input.diffStats === undefined ? {} : { diffStats: input.diffStats }),
    ...(input.focusedControl === undefined ? {} : { focusedControl: input.focusedControl }),
    ...(input.focusedScope === undefined ? {} : { focusedScope: input.focusedScope }),
  };
}
