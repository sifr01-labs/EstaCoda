import { expect, it } from "vitest";
import { PRIVATE_CONTROL_MAX_BYTES, validatePrivateControlRequest } from "./control-protocol.js";
import { validatePrivateControlRequest as legacyValidator } from "../gateway/private-control.js";
import { validatePrivateControlRequest as desktopValidator } from "../../apps/desktop/src/control-protocol.js";

it("shares the exact validator across legacy gateway and Desktop workspace imports", () => {
  expect(legacyValidator).toBe(validatePrivateControlRequest);
  expect(desktopValidator).toBe(validatePrivateControlRequest);
  expect(PRIVATE_CONTROL_MAX_BYTES).toBe(131_072);
});

it("preserves host v1 request boundaries through the Desktop package", () => {
  const binding = { sessionId: "s", targetId: "t", operationId: "op" };
  for (const request of [
    { ...binding, method: "send", text: "x".repeat(32_768) },
    { ...binding, method: "cancel" },
    { ...binding, method: "inspect" },
    { ...binding, method: "approval", approvalId: "a", decision: "approved" },
    { ...binding, method: "approval", approvalId: "a", decision: "denied" },
  ]) expect(() => desktopValidator(request)).not.toThrow();
  for (const request of [
    null, {}, { ...binding, method: "exec" },
    { ...binding, method: "send", text: "" },
    { ...binding, method: "send", text: "x".repeat(32_769) },
    { ...binding, method: "cancel", targetId: "../target" },
    { ...binding, method: "approval", approvalId: "a", decision: "always" },
  ]) expect(() => desktopValidator(request)).toThrow("Invalid control request.");
});
