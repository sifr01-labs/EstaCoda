import { expect, it } from "vitest";
import { assertEnvelope, failureEnvelope, parseControlFrame, serializeControlFrame, utf8Bytes, type RpcEnvelope } from "./envelopes.js";

it("round trips framed requests, notifications, results and fixed safe errors", () => {
  const values: RpcEnvelope[] = [
    { jsonrpc: "2.0" as const, id: "r1", method: "control.initialize", params: {} },
    { jsonrpc: "2.0" as const, method: "control.event", params: { text: "مرحبا 🌊\nnext" } },
    { jsonrpc: "2.0" as const, id: "r1", result: null }, failureEnvelope(null, "-32700"),
  ];
  for (const value of values) expect(parseControlFrame(serializeControlFrame(value))).toEqual(value);
  expect(utf8Bytes("مرحبا 🌊")).toBe(Buffer.byteLength("مرحبا 🌊"));
});
it("rejects batches, ambiguous envelopes, unknown fields and unsafe error bodies", () => {
  expect(() => parseControlFrame('{"jsonrpc":"2.0","id":"r","result":1,"result":2}\n')).toThrow();
  for (const value of [[], null, { jsonrpc: "1.0" },
    { jsonrpc: "2.0", id: 1, method: "work.get", params: {} },
    { jsonrpc: "2.0", id: "r", result: {}, error: {} },
    { jsonrpc: "2.0", id: "r", result: {}, token: "secret" },
    { jsonrpc: "2.0", id: "r", error: { code: -32603, message: "secret" } },
  ]) expect(() => assertEnvelope(value)).toThrow();
});
it("bounds frames and nesting and refuses serialization side effects", () => {
  for (const frame of ["{}", "{}\n{}\n", "{}\r\n", "{\n", " ".repeat(262_145) + "\n"])
    expect(() => parseControlFrame(frame)).toThrow();
  let deep: unknown = {};
  for (let i = 0; i < 15; i++) deep = { nested: deep };
  expect(() => assertEnvelope({ jsonrpc: "2.0", id: "r", result: deep })).toThrow();
  let read = false;
  expect(() => assertEnvelope({ jsonrpc: "2.0", id: "r", result: { get secret() { read = true; return "secret"; } } })).toThrow();
  expect(read).toBe(false);
});
