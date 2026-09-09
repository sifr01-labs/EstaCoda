import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startPrivateControl, callPrivateControl, validatePrivateControlRequest } from "./private-control.js";

it.skipIf(process.platform === "win32")("authenticates the instance/profile and rejects incompatible clients", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ipc-"));
  await chmod(directory, 0o700);
  const handle = vi.fn(async () => ({ active: false }));
  const server = await startPrivateControl({ directory, instanceId: "instance", profileId: "default", version: "test", handle });
  const input = { directory, profileId: "default", version: "test", request: { method: "inspect" as const, sessionId: "session", targetId: "target", operationId: "op" } };
  try {
    await expect(callPrivateControl(input)).resolves.toEqual({ active: false });
    await expect(callPrivateControl({ ...input, profileId: "other" })).rejects.toThrow("mismatch");
    await expect(callPrivateControl({ ...input, version: "other" })).rejects.toThrow("mismatch");
    await chmod(join(directory, "control.json"), 0o644);
    await expect(callPrivateControl(input)).rejects.toThrow("permissions");
    expect(handle).toHaveBeenCalledTimes(1);
    await chmod(join(directory, "control.json"), 0o600);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
it("rejects unknown methods, oversized input and malformed bindings", () => {
  const request = { method: "send", sessionId: "s", targetId: "t", operationId: "op", text: "hello" };
  expect(() => validatePrivateControlRequest(request)).not.toThrow();
  for (const changed of [{ method: "exec" }, { sessionId: "../s" }, { text: "x".repeat(32_769) }, { operationId: "" }]) {
    expect(() => validatePrivateControlRequest({ ...request, ...changed })).toThrow("Invalid");
  }
});
