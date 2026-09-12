/** Desktop protocol version; independent of private supervisor wire v1. */
export const DESKTOP_PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 1 });
export type ProtocolVersion = { major: number; minor: number };
export const CONTROL_LIMITS = Object.freeze({ frameBytes: 262_144, depth: 12, nodes: 8_192, array: 256, keys: 64, text: 65_536 });
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type RpcRequest = { jsonrpc: "2.0"; id: string; method: string; params: { [key: string]: JsonValue } };
export type RpcNotification = { jsonrpc: "2.0"; method: string; params: { [key: string]: JsonValue } };
export type RpcSuccess = { jsonrpc: "2.0"; id: string; result: JsonValue };
export const CONTROL_ERRORS = Object.freeze({
  "-32700": "Malformed JSON frame.", "-32600": "Invalid control envelope.",
  "-32601": "Method unavailable.", "-32602": "Invalid control parameters.",
  "-32603": "Control operation failed.", "-32001": "Incompatible protocol version.",
  "-32002": "Control initialization required.", "-32003": "Control scope rejected.",
  "-32004": "Control binding is stale.", "-32005": "Operation identity conflict.",
  "-32006": "Control service unavailable.", "-32007": "Canonical snapshot required.",
  "-32008": "Operation outcome uncertain; reconcile before retrying.",
  "-32009": "Control limit exceeded.", "-32010": "Control request cancelled.",
});
export type ControlErrorCode = keyof typeof CONTROL_ERRORS;
export type RpcFailure = { jsonrpc: "2.0"; id: string | null; error: { code: number; message: string } };
export type RpcEnvelope = RpcRequest | RpcNotification | RpcSuccess | RpcFailure;

/** Fixed messages only: no provider exceptions, user text or credential material. */
export class ControlProtocolError extends Error {
  constructor(readonly code: ControlErrorCode) { super(CONTROL_ERRORS[code]); }
}
export function failureEnvelope(id: string | null, code: ControlErrorCode): RpcFailure {
  if (id !== null && !isControlId(id)) throw new ControlProtocolError("-32600");
  return { jsonrpc: "2.0", id, error: { code: Number(code), message: CONTROL_ERRORS[code] } };
}
export function isControlId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
}
/** Core createControlOperationId() emits timestamp:nonce. Freshness belongs to
 * receipt acceptance, not decoding: old IDs must remain usable for reconciliation. */
export function isControlOperationId(value: unknown): value is string {
  return isControlId(value) && /^(0|[1-9][0-9]*):[A-Za-z0-9_.:-]+$/.test(value) &&
    Number.isSafeInteger(Number(value.split(":", 1)[0]));
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
export function utf8Bytes(text: string): number {
  let size = 0;
  for (const char of text) { const point = char.codePointAt(0)!; size += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4; }
  return size;
}
/** Check non-JSON values before serialization can coerce them or invoke toJSON. */
export function assertBoundedJson(value: unknown): asserts value is JsonValue {
  let nodes = 0;
  let bytes = 1; // Trailing LF.
  function charge(size: number): void {
    bytes += size;
    if (bytes > CONTROL_LIMITS.frameBytes) throw new ControlProtocolError("-32009");
  }
  function visit(item: unknown, depth: number): void {
    if (++nodes > CONTROL_LIMITS.nodes || depth > CONTROL_LIMITS.depth) throw new ControlProtocolError("-32009");
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) { charge(JSON.stringify(item).length); return; }
    if (typeof item === "string") {
      if (item.length > CONTROL_LIMITS.text) throw new ControlProtocolError("-32009");
      charge(utf8Bytes(JSON.stringify(item))); return;
    }
    if (Array.isArray(item)) {
      if (item.length > CONTROL_LIMITS.array) throw new ControlProtocolError("-32009");
      const indices = Object.keys(item);
      if (indices.length !== item.length || indices.some((key, i) => key !== String(i))) throw new ControlProtocolError("-32600");
    } else if (!isRecord(item)) throw new ControlProtocolError("-32600");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors).filter((key) => !(Array.isArray(item) && key === "length"));
    if (keys.length > (Array.isArray(item) ? CONTROL_LIMITS.array : CONTROL_LIMITS.keys)) throw new ControlProtocolError("-32009");
    charge(2 + Math.max(0, keys.length - 1));
    for (const key of keys) {
      if (typeof key !== "string" || key.length > 160 || ["__proto__", "constructor", "prototype"].includes(key)) throw new ControlProtocolError("-32600");
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new ControlProtocolError("-32600");
      if (!Array.isArray(item)) charge(utf8Bytes(JSON.stringify(key)) + 1);
      visit(descriptor.value, depth + 1);
    }
  }
  visit(value, 0);
}
export function assertEnvelope(value: unknown): asserts value is RpcEnvelope {
  assertBoundedJson(value);
  const fail = () => { throw new ControlProtocolError("-32600"); };
  if (!isRecord(value) || value.jsonrpc !== "2.0") return fail();
  if (Object.hasOwn(value, "method")) {
    if (!exactKeys(value, ["jsonrpc", "method", "params"], ["id"]) ||
      typeof value.method !== "string" || !/^[a-z][A-Za-z0-9]{0,63}\.[a-z][A-Za-z0-9]{0,63}$/.test(value.method) ||
      !isRecord(value.params) || (Object.hasOwn(value, "id") && !isControlId(value.id))) return fail();
  } else if (Object.hasOwn(value, "result")) {
    if (!exactKeys(value, ["jsonrpc", "id", "result"]) || !isControlId(value.id)) return fail();
  } else {
    if (!exactKeys(value, ["jsonrpc", "id", "error"]) || (value.id !== null && !isControlId(value.id)) || !isRecord(value.error) ||
      !exactKeys(value.error, ["code", "message"]) || typeof value.error.code !== "number" ||
      !Object.hasOwn(CONTROL_ERRORS, String(value.error.code)) || value.error.message !== CONTROL_ERRORS[String(value.error.code) as ControlErrorCode]) return fail();
  }
}
/** Exactly one LF-terminated frame. Transport must also bound incomplete buffers. */
export function parseControlFrame(frame: string): RpcEnvelope {
  if (frame.length > CONTROL_LIMITS.frameBytes || utf8Bytes(frame) > CONTROL_LIMITS.frameBytes) throw new ControlProtocolError("-32009");
  if (!frame.endsWith("\n") || frame.slice(0, -1).includes("\n") || frame.includes("\r")) throw new ControlProtocolError("-32600");
  let value: unknown;
  try { rejectDuplicateKeys(frame); value = JSON.parse(frame.slice(0, -1)); }
  catch (error) { if (error instanceof ControlProtocolError) throw error; throw new ControlProtocolError("-32700"); }
  assertEnvelope(value);
  return value;
}
/** JSON.parse discards duplicate keys. Detect ambiguity before that information is lost. */
function rejectDuplicateKeys(source: string): void {
  const stack: ({ keys: Set<string>; keyExpected: boolean } | null)[] = [];
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      const start = i++;
      while (i < source.length && source[i] !== '"') { if (source[i] === "\\") i++; i++; }
      const current = stack[stack.length - 1];
      if (current?.keyExpected) {
        const key: string = JSON.parse(source.slice(start, i + 1));
        if (current.keys.has(key)) throw new ControlProtocolError("-32600");
        current.keys.add(key); current.keyExpected = false;
      }
    } else if (char === "{" || char === "[") {
      stack.push(char === "{" ? { keys: new Set(), keyExpected: true } : null);
      if (stack.length > CONTROL_LIMITS.depth + 1) throw new ControlProtocolError("-32009");
    } else if (char === "}" || char === "]") stack.pop();
    else if (char === ",") { const current = stack[stack.length - 1]; if (current) current.keyExpected = true; }
  }
}
export function serializeControlFrame(value: RpcEnvelope): string {
  assertEnvelope(value);
  const frame = JSON.stringify(value) + "\n";
  if (utf8Bytes(frame) > CONTROL_LIMITS.frameBytes) throw new ControlProtocolError("-32009");
  return frame;
}
