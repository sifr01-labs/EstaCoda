import { describe, expect, it } from "vitest";
import type { SecureInputRequestSnapshot } from "../../../contracts/secure-input.js";
import { resolveTokens } from "../../../theme/token-resolver.js";
import { LRI, PDI } from "../../bidi.js";
import { stringWidth } from "../screen/stringWidth.js";
import { createOperatorConsoleRuntimeHost } from "./operatorConsoleRuntimeHost.js";
import { createOperatorConsoleStyle, styleColor } from "./operatorConsoleStyle.js";
import {
  createSecureInputSurfaceState,
  getSecureInputSurfaceDesiredHeight,
  OperatorConsoleSecureInputCollector,
  renderSecureInputSurface,
  SecureInputSurfaceController,
} from "./secureInputSurface.js";

const context = { verifiedDestinationLabel: "https://accounts.example.com · Password" };

describe("Papyrus secure-input surface", () => {
  it("renders verified metadata and only a masked character count", () => {
    const controller = controllerFor();
    controller.apply({ type: "key", key: "enter" });
    controller.apply({ type: "paste", text: "sentinel-secret-value" });

    const state = controller.renderState;
    const output = renderSecureInputSurface(state, { width: 80, locale: "en" }).join("\n");

    expect(state.maskedCharacterCount).toBe(21);
    expect(state.entryActive).toBe(true);
    expect(output).toContain("✓ Verified destination");
    expect(output).toContain("https://accounts.example.com · Password");
    expect(output).toContain("Value · •••••••••••••••••••••");
    expect(output).toContain("Typing securely; input is masked");
    expect(output).toContain("Enter submit · Tab return · Esc cancel");
    expect(output).toContain("❯ Enter securely");
    expect(output).toContain("Type in browser");
    expect(output).not.toContain("sentinel-secret-value");
    expect(JSON.stringify(state)).not.toContain("sentinel-secret-value");
    expect(state).not.toHaveProperty("rawValue");
    expect(state).not.toHaveProperty("phase");
  });

  it("keeps narrow and plain rendering width-bounded without ANSI output", () => {
    const state = createSecureInputSurfaceState(snapshot({ purpose: "Authenticate to a very long service name" }), context);
    const rows = renderSecureInputSurface(state, { width: 24, locale: "en" });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.join("\n")).not.toContain("\x1b[");
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(24);
  });

  it("renders grouped progress using metadata only", () => {
    const groupContext = {
      ...context,
      group: { purpose: "Sign in to MTN", index: 1, total: 2 },
    };
    const state = createSecureInputSurfaceState(
      { ...snapshot(), request: { ...snapshot().request, kind: "account-identifier" } },
      groupContext
    );
    const output = renderSecureInputSurface(state, { width: 80, locale: "en" }).join("\n");

    expect(output).toContain("1 of 2");
    expect(output).toContain("Email or account ID");
    expect(output).toContain("Flow · Sign in to MTN");
    expect(output).toContain("Purpose · Sign in to continue");
    expect(output).toContain("Use once · Expires 2026-08-13 10:05 UTC");
    expect(state.group).toEqual(groupContext.group);
    expect(JSON.stringify(state)).not.toContain("secret");
  });

  it("uses Papyrus selection and action colors only when terminal color is enabled", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const controller = controllerFor();
    const menu = renderSecureInputSurface(controller.renderState, { width: 80, locale: "en", style }).join("\n");
    controller.apply({ type: "key", key: "enter" });
    controller.apply({ type: "key", key: "enter" });
    const invalid = renderSecureInputSurface(controller.renderState, { width: 80, locale: "en", style }).join("\n");
    controller.apply({ type: "text", text: "abc" });
    const entry = renderSecureInputSurface(controller.renderState, { width: 80, locale: "en", style }).join("\n");

    expect(menu).toContain("\x1b[48;2;");
    expect(menu).toContain("❯ Enter securely");
    expect(menu).toContain(styleColor(style, "✓ Verified destination", tokens.contract.severity.ok));
    expect(menu).toContain(styleColor(
      style,
      "Use once · Expires 2026-08-13 10:05 UTC",
      tokens.contract.text.muted
    ));
    expect(invalid).toContain(styleColor(
      style,
      "! Enter a value or cancel this request.",
      tokens.contract.severity.error
    ));
    expect(entry).toContain(styleColor(style, "Value · •••", tokens.contract.palette.action));
    expect(entry).toContain("\x1b[48;2;");
  });

  it("uses the bounded attention card and stacks actions only when narrow", () => {
    const state = createSecureInputSurfaceState(snapshot(), context);
    const narrow = renderSecureInputSurface(state, { width: 40, locale: "en" });
    const normal = renderSecureInputSurface(state, { width: 80, locale: "en" });
    const wide = renderSecureInputSurface(state, { width: 160, locale: "en" });

    expect(narrow.filter((row) => row.includes("Enter securely") || row.includes("Type in browser") || row.includes("Cancel"))).toHaveLength(3);
    expect(normal.filter((row) => row.includes("Enter securely") && row.includes("Type in browser") && row.includes("Cancel"))).toHaveLength(1);
    expect(wide[0]?.startsWith("                            ╭")).toBe(true);
    expect(getSecureInputSurfaceDesiredHeight(state, 40, "en")).toBe(narrow.length);
    for (const [width, rows] of [[40, narrow], [80, normal], [160, wide]] as const) {
      for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(width);
    }
  });

  it("renders Arabic copy and isolates mixed technical destinations", () => {
    const state = createSecureInputSurfaceState(snapshot({ purpose: "تسجيل الدخول إلى الحساب" }), context);
    const output = renderSecureInputSurface(state, { width: 90, locale: "ar" }).join("\n");

    expect(output).toContain("مطلوب إدخال آمن");
    expect(output).toContain("الوجهة المتحقق منها");
    expect(output).toContain(`${LRI}${context.verifiedDestinationLabel}${PDI}`);
    expect(output).toContain("اكتب في المتصفح");
    expect(output).toContain("Tab");
    expect(output).toContain("Enter");
    expect(output).toContain("Esc");
  });

  it("navigates actions and distinguishes direct entry from secure entry", () => {
    const controller = controllerFor();

    expect(controller.renderState.focusedAction).toBe("enter-securely");
    expect(controller.apply({ type: "key", key: "tab" }).state.focusedAction).toBe("enter-directly");
    expect(controller.apply({ type: "key", key: "enter" }).intent).toEqual({ type: "enter-directly" });

    const secure = controllerFor();
    const result = secure.apply({ type: "key", key: "enter" });
    expect(result.intent).toEqual({ type: "none" });
    expect(result.state.entryActive).toBe(true);
    expect(secure.apply({ type: "text", text: "x" }).state.maskedCharacterCount).toBe(1);
  });

  it("returns from entry to the menu without clearing the protected value", () => {
    const controller = controllerFor();
    controller.apply({ type: "key", key: "enter" });
    controller.apply({ type: "paste", text: "a\u0301🔐" });

    const returned = controller.apply({ type: "key", key: "tab" }).state;
    expect(returned.entryActive).toBe(false);
    expect(returned.maskedCharacterCount).toBe(2);
    expect(JSON.stringify(returned)).not.toContain("a\u0301");

    controller.apply({ type: "key", key: "enter" });
    const submitted = controller.apply({ type: "key", key: "enter" });
    expect(submitted.intent).toEqual({ type: "submit", value: "a\u0301🔐" });
    expect(submitted.state).toMatchObject({ entryActive: false, maskedCharacterCount: 0 });
  });

  it("handles Unicode graphemes, backspace, empty validation, and cancellation", () => {
    const controller = controllerFor();
    controller.apply({ type: "key", key: "enter" });

    expect(controller.apply({ type: "key", key: "enter" }).state.validationError).toBeTruthy();
    controller.apply({ type: "paste", text: "a\u0301🔐" });
    expect(controller.renderState.maskedCharacterCount).toBe(2);
    controller.apply({ type: "key", key: "backspace" });
    expect(controller.renderState.maskedCharacterCount).toBe(1);
    const cancelled = controller.apply({ type: "key", key: "escape" });
    expect(cancelled.intent).toEqual({ type: "cancel" });
    expect(cancelled.state.maskedCharacterCount).toBe(0);
    expect(cancelled.state.entryActive).toBe(false);
    expect(JSON.stringify(cancelled.state)).not.toContain("a\u0301");
  });

  it("bridges runtime collection through modal host state without retaining the value", async () => {
    const host = createOperatorConsoleRuntimeHost({ terminal: { width: 80, height: 24, isTty: true } });
    const collector = new OperatorConsoleSecureInputCollector(host);
    const abort = new AbortController();
    const resultPromise = collector.collect(snapshot(), abort.signal, context);

    expect(host.getState().secureInput?.destinationLabel).toBe(context.verifiedDestinationLabel);
    expect(host.render().layout.regions.map((region) => region.kind)).toEqual(["secureInput"]);
    collector.routeInput({ type: "key", key: "enter" });
    collector.routeInput({ type: "paste", text: "collector-sentinel" });
    expect(JSON.stringify(host.getState())).not.toContain("collector-sentinel");
    collector.routeInput({ type: "key", key: "enter" });

    const result = await resultPromise;
    expect(result.status).toBe("provided");
    if (result.status === "provided") {
      expect(new TextDecoder().decode(result.value)).toBe("collector-sentinel");
      result.value.fill(0);
    }
    expect(host.getState().secureInput).toBeUndefined();
    expect(host.render().layout.regions.map((region) => region.kind)).toEqual(["prompt", "statusRail"]);
  });

  it("clears the modal and resolves cancellation when collection is aborted", async () => {
    const host = createOperatorConsoleRuntimeHost();
    const collector = new OperatorConsoleSecureInputCollector(host);
    const abort = new AbortController();
    const resultPromise = collector.collect(snapshot(), abort.signal, context);

    abort.abort();

    await expect(resultPromise).resolves.toEqual({ status: "cancelled" });
    expect(host.getState().secureInput).toBeUndefined();
  });

  it("clears active protected input during collector disposal", async () => {
    const host = createOperatorConsoleRuntimeHost();
    const collector = new OperatorConsoleSecureInputCollector(host);
    const resultPromise = collector.collect(snapshot(), new AbortController().signal, context);

    collector.routeInput({ type: "key", key: "enter" });
    collector.routeInput({ type: "paste", text: "dispose-sentinel" });
    expect(host.getState().secureInput).toMatchObject({ entryActive: true, maskedCharacterCount: 16 });
    expect(JSON.stringify(host.getState())).not.toContain("dispose-sentinel");
    collector.dispose();

    await expect(resultPromise).resolves.toEqual({ status: "cancelled" });
    expect(host.getState().secureInput).toBeUndefined();
  });
});

function controllerFor(): SecureInputSurfaceController {
  return new SecureInputSurfaceController(createSecureInputSurfaceState(snapshot(), context));
}

function snapshot(overrides: { readonly purpose?: string } = {}): SecureInputRequestSnapshot {
  return {
    id: "secure-request-1",
    scope: { profileId: "default", sessionId: "session-1" },
    request: {
      kind: "password",
      purpose: overrides.purpose ?? "Sign in to continue",
      destination: {
        type: "browser-field",
        sessionId: "browser-1",
        ref: "password",
        expectedOrigin: "https://accounts.example.com",
      },
      retention: "use-once",
    },
    status: "awaiting_input",
    requestedAt: "2026-08-13T10:00:00.000Z",
    expiresAt: "2026-08-13T10:05:00.000Z",
  };
}
