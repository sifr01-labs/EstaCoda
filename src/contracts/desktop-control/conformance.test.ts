import { expect, it } from "vitest";
import {
  CONTROL_EVENTS, CONTROL_LIMITS, CONTROL_METHODS, assertEnvelope, cursorDisposition, failureEnvelope, negotiateControl,
  parseControlFrame, serializeControlFrame, validateControlRequest, validateControlResponse, validateEventNotification,
  type ActivityProjection, type ControlContext, type ControlEvent, type InitializeParams, type MethodContracts,
  type OperationReceipt, type WorkProjection,
} from "../../../apps/desktop/src/control-protocol.js";

const context: ControlContext = { profileId: "p", instanceId: "b", capabilities: { methods: [...CONTROL_METHODS], events: [...CONTROL_EVENTS] } };
const cursor = { instanceId: "b", streamId: "stream", sequence: 10 };
const target = { targetId: "t", targetGeneration: 2 };
const binding = { operationId: "100:op", sessionId: "s", target };
const work: WorkProjection = { id: "w", canonicalId: "s", profileId: "p", kind: "session", title: "العمل — Work", status: "partial", updatedAt: 1,
  target: { ...target, label: "Selected workspace", isolation: "host" } };
const inbox = { id: "attention", profileId: "p", workId: "w", kind: "approval" as const, title: "Review action", summary: "One command", createdAt: 1,
  approval: { id: "a", sessionId: "s", target, actionSummary: "Run focused tests", scope: "once" as const, decisions: ["approved" as const, "denied" as const] } };
const model = { id: "local/model:latest", providerId: "local", label: "Local model", runnable: true, credentialState: "not_required" as const, role: "primary" as const };
const connection = { id: "telegram", profileId: "p", channel: "telegram" as const, configurationState: "unconfigured" as const,
  runtimeState: "unknown" as const, authorizationState: "denied" as const, summary: "Not configured" };
const receipt: OperationReceipt = { ...binding, profileId: "p", method: "sessions.send", state: "uncertain", cancellation: "not_requested" };
const initialize: InitializeParams = { protocolVersion: { major: 1, minor: 0 }, clientVersion: "test", profileId: "p", capabilities: context.capabilities };
const initialized = negotiateControl(initialize, { profileId: "p", instanceId: "b", serviceVersion: "test", implemented: context.capabilities });
const activityBase = { id: "event", workId: "w", profileId: "p", sequence: 1, timestamp: 1 };
const activities: ActivityProjection[] = [
  { ...activityBase, kind: "message", role: "user", text: "مرحبا 🌊" },
  { ...activityBase, kind: "assistant_delta", text: "Working" },
  { ...activityBase, kind: "tool", name: "files.read", state: "completed", summary: "Read source" },
  { ...activityBase, kind: "plan", steps: [{ id: "step", title: "Inspect", status: "completed" }] },
  { ...activityBase, kind: "result", status: "partial", evidence: { state: "unverified", summary: "Not verified", artifactIds: [] }, usage: { reportedTokens: null, cost: null } },
  { ...activityBase, kind: "status", status: "needs_attention", reason: "Waiting for approval" },
];
const cases = {
  "control.initialize": { params: initialize, result: initialized },
  "control.bootstrap": { params: {}, result: { profile: { id: "p", label: "Personal", configuration: "unconfigured" }, runtime: { state: "unavailable" }, capabilities: context.capabilities, cursor } },
  "control.subscribe": { params: { after: cursor, events: [...CONTROL_EVENTS] }, result: { state: "subscribed", subscriptionId: "sub", cursor } },
  "control.unsubscribe": { params: { subscriptionId: "sub" }, result: { removed: true } },
  "control.cancelRequest": { params: { requestId: "old" }, result: { cancellationRequested: true } },
  "work.list": { params: { limit: 10 }, result: { items: [work], nextCursor: null } },
  "work.get": { params: { workId: "w" }, result: work },
  "work.activity": { params: { workId: "w", limit: 10 }, result: { items: activities, nextCursor: "next_page" } },
  "inbox.list": { params: { limit: 10 }, result: { items: [inbox], nextCursor: null } },
  "models.list": { params: { limit: 10 }, result: { items: [model], nextCursor: null } },
  "providers.list": { params: { limit: 10 }, result: { items: [{ id: "local", label: "Local", authMethods: ["none"], state: "ready" }], nextCursor: null } },
  "connections.list": { params: { limit: 10 }, result: { items: [connection], nextCursor: null } },
  "connections.get": { params: { connectionId: "telegram" }, result: connection },
  "tasks.pause": { params: { ...binding, taskId: "task" }, result: { ...receipt, taskId: "task", method: "tasks.pause" } },
  "tasks.resume": { params: { ...binding, taskId: "task" }, result: { ...receipt, taskId: "task", method: "tasks.resume" } },
  "tasks.cancel": { params: { ...binding, taskId: "task" }, result: { ...receipt, taskId: "task", method: "tasks.cancel" } },
  "tasks.retry": { params: { ...binding, taskId: "task" }, result: { ...receipt, taskId: "task", method: "tasks.retry" } },
  "tasks.guide": { params: { ...binding, taskId: "task", guidance: "Focus on the tests" }, result: { ...receipt, taskId: "task", method: "tasks.guide" } },
  "sessions.start": { params: binding, result: { ...receipt, method: "sessions.start" } },
  "sessions.resume": { params: binding, result: { ...receipt, method: "sessions.resume" } },
  "sessions.send": { params: { ...binding, text: "Hello" }, result: receipt },
  "sessions.cancelTurn": { params: binding, result: { ...receipt, method: "sessions.cancelTurn", state: "completed", cancellation: "requested" } },
  "approvals.resolve": { params: { ...binding, approvalId: "a", decision: "denied" }, result: { ...receipt, method: "approvals.resolve" } },
  "operations.inspect": { params: { ...binding, method: "sessions.send" }, result: receipt },
} satisfies { [M in keyof MethodContracts]: MethodContracts[M] };

it("has conformance fixtures for every declared method", () => {
  expect(Object.keys(cases).sort()).toEqual([...CONTROL_METHODS].sort());
});
it.each(CONTROL_METHODS)("round trips and validates %s through the Desktop package", (method) => {
  const test = cases[method];
  const scope = method === "control.initialize" ? null : context;
  const request = validateControlRequest({ jsonrpc: "2.0", id: "r", method, params: test.params }, scope);
  expect(validateControlRequest(parseControlFrame(serializeControlFrame(request)), scope)).toEqual(request);
  const response = { jsonrpc: "2.0" as const, id: "r", result: test.result };
  expect(validateControlResponse(parseControlFrame(serializeControlFrame(response)), request, scope)).toEqual(response);
  expect(validateControlResponse(failureEnvelope("r", "-32006"), request, scope)).toEqual(failureEnvelope("r", "-32006"));
  expect(() => validateControlRequest({ ...request, params: { ...test.params, apiKey: "canary" } }, scope)).toThrow();
  expect(() => validateControlResponse({ ...response, result: { ...test.result, token: "canary" } }, request, scope)).toThrow();
});
const eventCases = {
  "control.ready": { state: "ready" }, "work.changed": work, "activity.appended": activities[0]!,
  "attention.changed": { item: inbox, itemId: inbox.id }, "modelRoute.changed": model, "connection.changed": connection,
  "service.warning": { reason: "resync_required" }, "service.shutdown": { reason: "service_restart" },
} satisfies { [E in ControlEvent["type"]]: Extract<ControlEvent, { type: E }>["payload"] };
it.each(CONTROL_EVENTS)("validates the safe %s event payload and rejects raw extras", (type) => {
  const event = { jsonrpc: "2.0", method: "control.event", params: { profileId: "p", subscriptionId: "sub", cursor, timestamp: 1, type, payload: eventCases[type] } };
  const sub = { subscriptionId: "sub", streamId: "stream", events: [...CONTROL_EVENTS] };
  const validated = validateEventNotification(event, context, sub);
  expect(validateEventNotification(parseControlFrame(serializeControlFrame(validated)), context, sub)).toEqual(event);
  expect(() => validateEventNotification({ ...event, params: { ...event.params, payload: { ...event.params.payload, raw: { secret: "canary" } } } }, context, sub)).toThrow();
  expect(() => validateEventNotification(event, context, { ...sub, events: [] })).toThrow();
});
it("reconnects only across an explicit snapshot cursor and rejects stale notifications", () => {
  const request = validateControlRequest({ jsonrpc: "2.0", id: "r", method: "control.subscribe", params: cases["control.subscribe"].params }, context);
  expect(validateControlResponse({ jsonrpc: "2.0", id: "r", result: { state: "snapshot_required", reason: "cursor_expired" } }, request, context)).toBeDefined();
  expect(() => validateControlResponse({ jsonrpc: "2.0", id: "r", result: { state: "subscribed", subscriptionId: "sub", cursor: { ...cursor, sequence: 20 } } }, request, context)).toThrow();
  expect(cursorDisposition(cursor, { ...cursor, sequence: 11 })).toBe("next");
  expect(cursorDisposition(cursor, cursor)).toBe("duplicate");
  expect(cursorDisposition(cursor, { ...cursor, sequence: 12 })).toBe("snapshot_required");
  expect(() => validateControlRequest(request, { ...context, instanceId: "new" })).toThrow("snapshot");
  const filtered = validateControlRequest({ ...request, params: { after: cursor, events: ["work.changed"] } }, context);
  expect(() => validateControlResponse({ jsonrpc: "2.0", id: "r", result: cases["control.subscribe"].result }, filtered, context)).toThrow("snapshot");
  expect(validateControlResponse({ jsonrpc: "2.0", id: "r", result: { state: "snapshot_required", reason: "stream_changed" } }, filtered, context)).toBeDefined();
});
it("does not convert cancellation acknowledgement or unknown receipts into success", () => {
  const request = validateControlRequest({ jsonrpc: "2.0", id: "r", method: "sessions.cancelTurn", params: binding }, context);
  const response = { jsonrpc: "2.0", id: "r", result: cases["sessions.cancelTurn"].result };
  expect(validateControlResponse(response, request, context)).toEqual(response);
  for (const state of ["accepted", "dispatched", "completed", "uncertain", "unknown", "expired"]) {
    const inspect = validateControlRequest({ jsonrpc: "2.0", id: "r", method: "operations.inspect", params: cases["operations.inspect"].params }, context);
    expect(validateControlResponse({ jsonrpc: "2.0", id: "r", result: { ...receipt, state } }, inspect, context)).toBeDefined();
  }
});
it("rejects handshake privilege escalation and duplicate initialization", () => {
  const request = validateControlRequest({ jsonrpc: "2.0", id: "r", method: "control.initialize", params: { ...initialize, capabilities: { methods: [], events: [] } } }, null);
  expect(() => validateControlResponse({ jsonrpc: "2.0", id: "r", result: initialized }, request, null)).toThrow();
  expect(() => validateControlRequest(request, context)).toThrow();
  expect(() => validateControlResponse({ jsonrpc: "2.0", id: "r", result: { ...initialized, protocolVersion: { major: 1, minor: 99 } } }, request, null)).toThrow();
});
it("enforces the exact UTF-8 frame limit before serialization, including escaping", () => {
  const message = { jsonrpc: "2.0" as const, id: "r", result: ["a".repeat(65_536), "a".repeat(65_536), "a".repeat(65_536), ""] };
  const remaining = CONTROL_LIMITS.frameBytes - Buffer.byteLength(JSON.stringify(message) + "\n");
  message.result[3] = "a".repeat(remaining);
  expect(Buffer.byteLength(serializeControlFrame(message))).toBe(CONTROL_LIMITS.frameBytes);
  message.result[3] += "a";
  expect(() => serializeControlFrame(message)).toThrow("limit");
  expect(() => assertEnvelope({ jsonrpc: "2.0", id: "r", result: ["🌊".repeat(32_768), "🌊".repeat(32_768)] })).toThrow();
  expect(() => assertEnvelope({ jsonrpc: "2.0", id: "r", result: "\u0000".repeat(65_536) })).toThrow();
});
it("rejects malformed JSON and ambiguous keys even when escaped", () => {
  for (const raw of ['{"jsonrpc":"2.0","id":"r","\\u0069d":"s","result":null}',
    '{"jsonrpc":"2.0","id":"r","result":{"x":1,"x":2}}',
    '{"jsonrpc":"2.0","id":"r","result":{"__proto__":{}}}',
    '{"jsonrpc":"2.0","id":"r","result":NaN}',
    '{"jsonrpc":"2.0","id":"r","result":0} trailing', '[]', 'null'])
    expect(() => parseControlFrame(raw + "\n")).toThrow();
  const string = 'quotes " / commas , braces { } brackets [ ] slashes \\ and العربية';
  expect(parseControlFrame(serializeControlFrame({ jsonrpc: "2.0", id: "r", result: { [string]: string } }))).toEqual({ jsonrpc: "2.0", id: "r", result: { [string]: string } });
});
it("rejects non-JSON values, sparse arrays, cycles and hidden serialization hooks", () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const sparse: unknown[] = []; sparse.length = 2; sparse[0] = 1; Object.assign(sparse, { extra: 2 });
  for (const result of [undefined, NaN, Infinity, 1n, new Date(), cycle, sparse,
    Object.defineProperty({}, "secret", { value: 1 }), { toJSON: () => "secret" }, { [Symbol("secret")]: 1 }])
    expect(() => assertEnvelope({ jsonrpc: "2.0", id: "r", result })).toThrow();
});
it("survives a deterministic malformed-input corpus with safe errors", () => {
  let state = 17;
  for (let i = 0; i < 128; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const valid = JSON.stringify({ jsonrpc: "2.0", id: "r", result: { text: "🌊 مرحبا", value: state } }) + "\n";
    expect(parseControlFrame(valid)).toBeDefined();
    const cut = state % (valid.length - 1);
    try { parseControlFrame(valid.slice(0, cut) + "\n"); throw new Error("Unexpected acceptance"); }
    catch (error) { expect((error as Error).message).toMatch(/^(Malformed JSON frame\.|Invalid control envelope\.)$/); }
  }
});
