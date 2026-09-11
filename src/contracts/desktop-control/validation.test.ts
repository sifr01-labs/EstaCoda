import { expect, it } from "vitest";
import { CONTROL_EVENTS, CONTROL_METHODS } from "./bootstrap.js";
import { validateControlRequest, validateControlResponse, validateEventNotification, type ControlContext } from "./validation.js";
import type { MethodRequest } from "./methods.js";
const context: ControlContext = { profileId: "p", instanceId: "b", capabilities: { methods: [...CONTROL_METHODS], events: [...CONTROL_EVENTS] } };
const target = { targetId: "t", targetGeneration: 1 };
const request: MethodRequest<"sessions.send"> = { jsonrpc: "2.0", id: "r", method: "sessions.send", params: { operationId: "100:op", sessionId: "s", target, text: "hello" } };
const receipt = { operationId: "100:op", profileId: "p", sessionId: "s", target, method: "sessions.send", state: "accepted", cancellation: "not_requested" };
const work = { id: "w", canonicalId: "s", profileId: "p", kind: "session", title: "Work", status: "partial", updatedAt: 1, target: null };
it("requires timestamped operation IDs without blocking old receipt reconciliation", () => {
  const requests: MethodRequest[] = [request,
    { ...request, method: "sessions.cancelTurn", params: { operationId: "100:op", sessionId: "s", target } },
    { ...request, method: "approvals.resolve", params: { operationId: "100:op", sessionId: "s", target, approvalId: "a", decision: "denied" } },
    { ...request, method: "operations.inspect", params: { operationId: "100:op", sessionId: "s", target, method: "sessions.send" } },
  ];
  for (const original of requests) {
    expect(validateControlRequest(original, context)).toEqual(original);
    for (const operationId of ["op", "550e8400-e29b-41d4-a716-446655440000", "100:", ":nonce", "1e3:nonce", "-1:nonce", "01:nonce", "9007199254740992:nonce", "100:" + "x".repeat(157)]) {
      expect(() => validateControlRequest({ ...original, params: { ...original.params, operationId } }, context)).toThrow("parameters");
    }
  }
  expect(() => validateControlResponse({ jsonrpc: "2.0", id: "r", result: { ...receipt, operationId: "op" } }, request, context)).toThrow("parameters");
  const inspect = requests[3]!;
  for (const state of ["accepted", "uncertain", "unknown", "expired"]) {
    expect(validateControlResponse({ jsonrpc: "2.0", id: "r", result: { ...receipt, state } }, inspect, context)).toBeDefined();
  }
});
it("requires initialization and negotiated methods before dispatch", () => {
  expect(() => validateControlRequest(request, null)).toThrow("initialization");
  expect(() => validateControlRequest(request, { ...context, capabilities: { methods: [], events: [] } })).toThrow("unavailable");
  expect(validateControlRequest(request, context)).toEqual(request);
});
it("rejects authority fields and incomplete or invalid target generations", () => {
  for (const params of [{ ...request.params, profileId: "other" }, { ...request.params, ownerFence: 42 },
    { ...request.params, target: { targetId: "t" } }, { ...request.params, target: { ...target, targetGeneration: 0 } },
    { ...request.params, token: "secret" }]) expect(() => validateControlRequest({ ...request, params }, context)).toThrow();
});
it("correlates response IDs and durable receipts to the exact operation binding", () => {
  expect(validateControlResponse({ jsonrpc: "2.0", id: "r", result: receipt }, request, context)).toBeDefined();
  for (const result of [{ ...receipt, profileId: "other" }, { ...receipt, operationId: "100:other" },
    { ...receipt, sessionId: "other" }, { ...receipt, target: { ...target, targetGeneration: 2 } },
    { ...receipt, method: "approvals.resolve" }, { ...receipt, secret: "not allowed" }])
    expect(() => validateControlResponse({ jsonrpc: "2.0", id: "r", result }, request, context)).toThrow();
  expect(() => validateControlResponse({ jsonrpc: "2.0", id: "other", result: receipt }, request, context)).toThrow();
});
it("validates bounded profile-scoped projections including nested fields", () => {
  const get: MethodRequest<"work.list"> = { jsonrpc: "2.0", id: "r", method: "work.list", params: { limit: 1 } };
  const response = { jsonrpc: "2.0", id: "r", result: { items: [work], nextCursor: null } };
  expect(validateControlResponse(response, get, context)).toEqual(response);
  for (const item of [{ ...work, profileId: "other" }, { ...work, status: "success-ish" },
    { ...work, target: { ...target, label: "target", isolation: "host", path: "/private/file" } }])
    expect(() => validateControlResponse({ ...response, result: { items: [item], nextCursor: null } }, get, context)).toThrow();
  expect(() => validateControlResponse({ ...response, result: { items: [work, work], nextCursor: null } }, get, context)).toThrow("limit");
});
it("refuses credential material and misleading runnable model metadata", () => {
  const get: MethodRequest<"models.list"> = { jsonrpc: "2.0", id: "r", method: "models.list", params: { limit: 10 } };
  const model = { id: "provider/model:latest", providerId: "local", label: "Local", runnable: true, credentialState: "not_required", role: "primary" };
  expect(() => validateControlResponse({ jsonrpc: "2.0", id: "r", result: { items: [model], nextCursor: null } }, get, context)).not.toThrow();
  for (const item of [{ ...model, apiKey: "secret" }, { ...model, credentialState: "missing" }, { ...model, credentialState: "expired" }])
    expect(() => validateControlResponse({ jsonrpc: "2.0", id: "r", result: { items: [item], nextCursor: null } }, get, context)).toThrow();
});
it("binds notifications to the selected profile, bridge, stream and subscription", () => {
  const subscription = { subscriptionId: "sub", streamId: "stream", events: ["work.changed" as const] };
  const params = { profileId: "p", subscriptionId: "sub", cursor: { instanceId: "b", streamId: "stream", sequence: 1 }, timestamp: 1, type: "work.changed", payload: work };
  const notification = { jsonrpc: "2.0", method: "control.event", params };
  expect(validateEventNotification(notification, context, subscription)).toEqual(notification);
  for (const changed of [{ ...params, profileId: "other" }, { ...params, subscriptionId: "old" },
    { ...params, cursor: { ...params.cursor, instanceId: "old" } }, { ...params, payload: { ...work, profileId: "other" } }])
    expect(() => validateEventNotification({ ...notification, params: changed }, context, subscription)).toThrow();
});
