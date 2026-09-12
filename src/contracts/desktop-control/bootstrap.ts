import { CONTROL_LIMITS, ControlProtocolError, DESKTOP_PROTOCOL_VERSION, assertBoundedJson, exactKeys, isControlId, isRecord, type ProtocolVersion } from "./envelopes.js";

/** Schema availability is not service availability. Advertise only implemented handlers. */
export const CONTROL_METHODS = ["settings.read","settings.review","settings.cancel","browser.control","browser.snapshot","browser.list","artifacts.list","artifacts.get","artifacts.open","evidence.get","terminal.acquire","terminal.verify","terminal.release","diff.list","diff.patch","files.list","files.preview","targets.inspectOperation","targets.execute","targets.cancelReview","targets.create","targets.reviewCreate","targets.inspect","targets.list","telegram.handoff","telegram.sessionDetails","telegram.sessions","telegram.pairing","telegram.execute","gateway.diagnostics","gateway.execute","connections.inspectOperation","telegram.verify","telegram.settings","telegram.review","telegram.apply","telegram.cancel","telegram.inspectApply","models.verifyDraft", "models.reviewConfigured", "models.validateRoute", "models.refreshCatalog", "models.oauthStart", "models.oauthStatus", "models.oauthCancel", "models.workOverride", "sessions.setModel", "tasks.setModel", "control.initialize", "control.bootstrap", "control.subscribe", "control.unsubscribe", "control.cancelRequest",
  "work.usage", "work.counts", "work.live", "work.targets", "work.list", "work.get", "work.activity", "inbox.get", "inbox.list", "models.list", "models.verifyCandidate", "models.reviewPrimary", "models.fallbacks", "models.auxiliary", "models.reviewAuxiliary", "models.reviewAuxiliaryMode", "models.reviewFallback", "models.reviewFallbackOrder", "models.applyDraft", "models.cancelDraft", "models.inspectApply", "providers.list", "connections.list", "connections.get",
  "tasks.create", "tasks.pause", "tasks.resume", "tasks.cancel", "tasks.retry", "tasks.guide", "sessions.start", "sessions.resume", "sessions.send", "sessions.cancelTurn", "approvals.resolve", "operations.inspect"] as const;
export type ControlMethod = typeof CONTROL_METHODS[number];
export const CONTROL_EVENTS = ["control.ready", "work.changed", "activity.appended", "attention.changed", "modelRoute.changed",
  "connection.changed", "service.warning", "service.shutdown"] as const;
export type ControlEventType = typeof CONTROL_EVENTS[number];
export type Capabilities = { methods: ControlMethod[]; events: ControlEventType[] };
export type InitializeParams = {
  protocolVersion: ProtocolVersion; clientVersion: string; profileId: string;
  capabilities: { methods: string[]; events: string[] };
};
export type InitializeResult = {
  protocolVersion: ProtocolVersion; serviceVersion: string; profileId: string; instanceId: string;
  capabilities: Capabilities; limits: { frameBytes: number; subscriptions: number; replayEvents: number };
};
export type ControlCursor = { instanceId: string; streamId: string; sequence: number };
export type BootstrapResult = {
  profile: { id: string; label: string; configuration: "unconfigured" | "ready" | "repair_required" };
  runtime: { state: "stopped" | "starting" | "ready" | "disconnected" | "incompatible" | "unavailable" };
  capabilities: Capabilities; cursor: ControlCursor;
};
export function isProtocolVersion(value: unknown): value is ProtocolVersion {
  return isRecord(value) && exactKeys(value, ["major", "minor"]) &&
    [value.major, value.minor].every((n) => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 65_535);
}
function nameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128 && new Set(value).size === value.length &&
    value.every((name) => typeof name === "string" && /^[a-z][A-Za-z0-9]{0,63}\.[a-z][A-Za-z0-9]{0,63}$/.test(name));
}
export function assertInitializeParams(value: unknown): asserts value is InitializeParams {
  assertBoundedJson(value);
  if (!isRecord(value) || !exactKeys(value, ["protocolVersion", "clientVersion", "profileId", "capabilities"]) ||
    !isProtocolVersion(value.protocolVersion) || !isControlId(value.profileId) || typeof value.clientVersion !== "string" ||
    !/^[A-Za-z0-9_.+-]{1,80}$/.test(value.clientVersion) || !isRecord(value.capabilities) ||
    !exactKeys(value.capabilities, ["methods", "events"]) || !nameList(value.capabilities.methods) || !nameList(value.capabilities.events)) {
    throw new ControlProtocolError("-32602");
  }
}
/** Inputs on the server side come from trusted registration, never the renderer. */
export function negotiateControl(client: InitializeParams, server: {
  profileId: string; instanceId: string; serviceVersion: string; implemented: Capabilities;
}): InitializeResult {
  assertInitializeParams(client);
  if (client.profileId !== server.profileId) throw new ControlProtocolError("-32003");
  if (client.protocolVersion.major !== DESKTOP_PROTOCOL_VERSION.major) throw new ControlProtocolError("-32001");
  if (!isControlId(server.instanceId) || !isControlId(server.profileId) || !/^[A-Za-z0-9_.+-]{1,80}$/.test(server.serviceVersion)) throw new ControlProtocolError("-32602");
  // Canonical order and intersection prevent duplicate or future methods becoming authority.
  return {
    protocolVersion: { major: DESKTOP_PROTOCOL_VERSION.major, minor: Math.min(client.protocolVersion.minor, DESKTOP_PROTOCOL_VERSION.minor) },
    serviceVersion: server.serviceVersion, profileId: server.profileId, instanceId: server.instanceId,
    capabilities: {
      methods: CONTROL_METHODS.filter((name) => server.implemented.methods.includes(name) && client.capabilities.methods.includes(name)),
      events: CONTROL_EVENTS.filter((name) => server.implemented.events.includes(name) && client.capabilities.events.includes(name)),
    },
    limits: { frameBytes: CONTROL_LIMITS.frameBytes, subscriptions: 32, replayEvents: 256 },
  };
}
export function isControlCursor(value: unknown): value is ControlCursor {
  return isRecord(value) && exactKeys(value, ["instanceId", "streamId", "sequence"]) && isControlId(value.instanceId) &&
    isControlId(value.streamId) && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0;
}
/** Use only after validating the event and scope. Duplicate events are not applied twice. */
export function cursorDisposition(previous: ControlCursor, incoming: ControlCursor): "next" | "duplicate" | "snapshot_required" {
  if (!isControlCursor(previous) || !isControlCursor(incoming)) throw new ControlProtocolError("-32602");
  if (previous.instanceId !== incoming.instanceId || previous.streamId !== incoming.streamId) return "snapshot_required";
  if (incoming.sequence <= previous.sequence) return "duplicate";
  return incoming.sequence === previous.sequence + 1 ? "next" : "snapshot_required";
}
