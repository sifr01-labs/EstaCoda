import { resolveProfileStateHome } from "../config/profile-home.js";
import { createServer, createConnection, type Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, readFile, writeFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";

const MAX_BYTES = 131_072;
export type PrivateControlRequest = {
  method: "send" | "cancel" | "approval" | "inspect";
  sessionId: string; targetId: string; operationId: string;
  text?: string; approvalId?: string; decision?: "approved" | "denied";
};
type Discovery = { protocol: 1; version: string; instanceId: string; profileId: string; socket: string; token: string };
async function assertPrivate(path: string, directory = false): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
    (!directory && info.size > MAX_BYTES) || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error("Private control state has unsafe ownership or permissions.");
  }
}
export function validatePrivateControlRequest(value: unknown): asserts value is PrivateControlRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid control request.");
  const request = value as PrivateControlRequest;
  if (!["send", "cancel", "approval", "inspect"].includes(request.method) ||
    [request.sessionId, request.targetId, request.operationId].some((id) => typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) ||
    (request.method === "send" && (typeof request.text !== "string" || request.text.length < 1 || request.text.length > 32_768)) ||
    (request.method === "approval" && (typeof request.approvalId !== "string" || request.approvalId.length > 160 || !["approved", "denied"].includes(request.decision ?? "")))) {
    throw new Error("Invalid control request.");
  }
}

export async function startPrivateControl(input: {
  directory: string; instanceId: string; profileId: string; version: string;
  handle(request: PrivateControlRequest): Promise<unknown>;
}): Promise<{ close(): Promise<void> }> {
  if (process.platform === "win32") throw new Error("Shared control requires a protected named pipe on Windows; use foreground execution.");
  await assertPrivate(input.directory, true);
  const path = join(input.directory, `c-${randomBytes(4).toString("hex")}.sock`);
  if (Buffer.byteLength(path) > 100) throw new Error("Profile path is too long for private control; use a shorter EstaCoda home.");
  const discovery: Discovery = { protocol: 1, version: input.version, instanceId: input.instanceId,
    profileId: input.profileId, socket: path, token: randomBytes(32).toString("hex") };
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= 32) { socket.destroy(); return; }
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setTimeout(10_000, () => socket.destroy());
    let buffer = Buffer.alloc(0), accepted = false;
    socket.on("data", (chunk: Buffer) => {
      if (accepted) { socket.destroy(); return; }
      if (buffer.length + chunk.length > MAX_BYTES) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end < 0) return;
      accepted = true;
      void (async () => {
        try {
          if (end !== buffer.length - 1) throw new Error("Invalid framing.");
          const message = JSON.parse(buffer.subarray(0, end).toString("utf8"));
          const supplied = Buffer.from(typeof message.token === "string" ? message.token : "");
          const expected = Buffer.from(discovery.token);
          if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) ||
            message.instanceId !== discovery.instanceId || message.protocol !== 1 || message.version !== discovery.version) throw new Error("Authentication or version mismatch.");
          validatePrivateControlRequest(message.request);
          // Profile and principal are bound by this instance; caller labels are ignored.
          const result = await input.handle(message.request);
          const response = JSON.stringify({ ok: true, result });
          socket.end(response.length <= MAX_BYTES ? response + "\n" : '{"ok":false,"error":"Response exceeds control limit; inspect the Session."}\n');
        } catch {
          socket.end('{"ok":false,"error":"Control request rejected; verify ownership, authority, operation binding and host version."}\n');
        }
      })();
    });
  });
  const discoveryPath = join(input.directory, "control.json");
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    await chmod(path, 0o600);
    try { await assertPrivate(discoveryPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await writeFile(discoveryPath, JSON.stringify(discovery), { mode: 0o600, flag: "w" });
  } catch (error) { server.close(); await unlink(path).catch(() => undefined); throw error; }
  return { async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await assertPrivate(discoveryPath);
      if ((JSON.parse(await readFile(discoveryPath, "utf8")) as Discovery).instanceId === input.instanceId) await unlink(discoveryPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await unlink(path).catch(() => undefined);
  } };
}

export async function callPrivateControl(input: { directory: string; profileId: string; version: string; request: PrivateControlRequest; startIfNeeded?: { homeDir: string } }): Promise<unknown> {
  validatePrivateControlRequest(input.request);
  if (input.startIfNeeded) {
    if (resolveProfileStateHome({ homeDir: input.startIfNeeded.homeDir, profileId: input.profileId }).gatewayStatePath !== input.directory) throw new Error("Control directory is outside the selected profile.");
    const { startSharedHostOnDemand } = await import("./shared-host-startup.js");
    const { readGatewayLockContent } = await import("./gateway-lock.js");
    await startSharedHostOnDemand({ homeDir: input.startIfNeeded.homeDir, profileId: input.profileId, sessionId: input.request.sessionId, targetId: input.request.targetId });
    const deadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const path = join(input.directory, "control.json");
        await assertPrivate(path);
        const discovery = JSON.parse(await readFile(path, "utf8")) as Discovery;
        if (discovery.instanceId === (await readGatewayLockContent({ gatewayStatePath: input.directory }))?.instanceId) { ready = true; break; }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("Shared supervisor is unavailable or incompatible. Inspect its existing service; do not start a duplicate host.");
  }

  await assertPrivate(input.directory, true);
  const path = join(input.directory, "control.json");
  await assertPrivate(path);
  const discovery = JSON.parse(await readFile(path, "utf8")) as Discovery;
  if (discovery.protocol !== 1 || discovery.version !== input.version || discovery.profileId !== input.profileId ||
    dirname(discovery.socket) !== input.directory) throw new Error("Shared host version/profile mismatch. Restart the compatible supervisor; do not start a second host.");
  return await new Promise((resolve, reject) => {
    const socket = createConnection(discovery.socket);
    let buffer = Buffer.alloc(0);
    socket.on("connect", () => socket.write(JSON.stringify({ ...discovery, request: input.request }) + "\n"));
    socket.setTimeout(10_000, () => socket.destroy(new Error("Control response unavailable. Query the same operation ID before retrying.")));
    socket.on("error", reject);
    socket.on("close", () => { if (!socket.readableEnded) reject(new Error("Control response lost; inspect the same operation ID.")); });
    socket.on("data", (chunk: Buffer) => {
      if (buffer.length + chunk.length > MAX_BYTES) { socket.destroy(new Error("Control response exceeds limit.")); return; }
      buffer = Buffer.concat([buffer, chunk]);
    });
    socket.on("end", () => {
      try { const response = JSON.parse(buffer.toString("utf8")); if (!response.ok) throw new Error(response.error); resolve(response.result); }
      catch (error) { reject(error); }
    });
  });
}
