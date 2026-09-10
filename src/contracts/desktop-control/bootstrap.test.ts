import { expect, it } from "vitest";
import { cursorDisposition, negotiateControl, type InitializeParams } from "./bootstrap.js";
const client: InitializeParams = { protocolVersion: { major: 1, minor: 4 }, clientVersion: "test", profileId: "default",
  capabilities: { methods: ["control.bootstrap", "work.get", "future.method"], events: ["work.changed"] } };
const server = { profileId: "default", instanceId: "bridge1", serviceVersion: "test",
  implemented: { methods: ["control.bootstrap" as const], events: ["work.changed" as const] } };
it("negotiates same-major capabilities without exposing unimplemented methods", () => {
  const result = negotiateControl(client, server);
  expect(result.protocolVersion).toEqual({ major: 1, minor: 0 });
  expect(result.capabilities).toEqual({ methods: ["control.bootstrap"], events: ["work.changed"] });
  expect(() => negotiateControl({ ...client, profileId: "other" }, server)).toThrow("scope");
  expect(() => negotiateControl({ ...client, protocolVersion: { major: 2, minor: 0 } }, server)).toThrow("Incompatible");
});
it("rejects malformed handshake data and duplicate capability requests", () => {
  expect(() => negotiateControl({ ...client, capabilities: { methods: ["work.get", "work.get"], events: [] } }, server)).toThrow();
  expect(() => negotiateControl({ ...client, protocolVersion: { major: 1, minor: -1 } }, server)).toThrow();
});
it("requires a snapshot for a new instance, new stream or sequence gap", () => {
  const cursor = { instanceId: "b", streamId: "s", sequence: 10 };
  expect(cursorDisposition(cursor, { ...cursor, sequence: 11 })).toBe("next");
  expect(cursorDisposition(cursor, cursor)).toBe("duplicate");
  expect(cursorDisposition(cursor, { ...cursor, sequence: 9 })).toBe("duplicate");
  for (const next of [{ ...cursor, sequence: 12 }, { ...cursor, instanceId: "new" }, { ...cursor, streamId: "new" }])
    expect(cursorDisposition(cursor, next)).toBe("snapshot_required");
});
