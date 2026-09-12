import { resolveProfileStateHome } from "../config/profile-home.js";
import { createServer, createConnection, type Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, readFile, writeFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";

import { PRIVATE_CONTROL_MAX_BYTES as MAX_BYTES, validatePrivateControlRequest, type PrivateControlRequest } from "../contracts/control-protocol.js";
export { validatePrivateControlRequest, type PrivateControlRequest } from "../contracts/control-protocol.js";
export class PrivateControlCompatibilityError extends Error {}
type Discovery = { protocol: 1; version: string; instanceId: string; profileId: string; socket: string; token: string };
async function assertPrivate(path: string, directory = false): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
    (!directory && info.size > MAX_BYTES) || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error("Private control state has unsafe ownership or permissions.");
  }
}

export async function startPrivateControl(input: {
  directory: string; instanceId: string; profileId: string; version: string;
  targetGeneration?: boolean;
  handle(request: PrivateControlRequest): Promise<unknown>;
  configurationChanged?: () => Promise<void>;
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
          if (message.probe === true) {
            if (Object.keys(message).some((key) => !["protocol", "version", "instanceId", "profileId", "socket", "token", "probe"].includes(key))) throw new Error("Invalid probe.");
            socket.end(JSON.stringify({ ok: true, result: { profileId: input.profileId, instanceId: input.instanceId,
              version: input.version, capabilities: { readiness: true, targetGeneration: input.targetGeneration === true } } }) + "\n");
            return;
          }
          if (message.configurationChanged === true) {
            if (!input.configurationChanged || message.profileId !== input.profileId || Object.keys(message).some(key => !['protocol','version','instanceId','profileId','socket','token','configurationChanged'].includes(key))) throw new Error('Invalid configuration notification');
            await input.configurationChanged();socket.end(JSON.stringify({ok:true,result:{acknowledged:true}})+'\n');return;
          }
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

export async function callPrivateControl(input: { directory: string; profileId: string; version: string; request: PrivateControlRequest; startIfNeeded?: { homeDir: string }; requireTargetGeneration?: boolean; signal?: AbortSignal }): Promise<unknown> {
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

  if (input.requireTargetGeneration && !(await probePrivateControl(input)).targetGeneration) throw new PrivateControlCompatibilityError("Supervisor cannot enforce target generations.");
  return exchangePrivateControl(input, { request: input.request });
}

async function exchangePrivateControl(input: { directory: string; profileId: string; version: string; signal?: AbortSignal }, payload: { request: PrivateControlRequest } | { probe: true } | {configurationChanged:true}): Promise<unknown> {
  input.signal?.throwIfAborted();
  await assertPrivate(input.directory, true);
  const path = join(input.directory, "control.json");
  await assertPrivate(path);
  const discovery = JSON.parse(await readFile(path, "utf8")) as Discovery;
  if (discovery.protocol !== 1 || discovery.version !== input.version || discovery.profileId !== input.profileId ||
    dirname(discovery.socket) !== input.directory) throw new PrivateControlCompatibilityError("Shared host version/profile mismatch. Restart the compatible supervisor; do not start a second host.");
  return await new Promise((resolve, reject) => {
    input.signal?.throwIfAborted();
    const socket = createConnection(discovery.socket);
    const abort = () => socket.destroy(new Error("Private control request cancelled."));
    input.signal?.addEventListener("abort", abort, { once: true });
    socket.once("close", () => input.signal?.removeEventListener("abort", abort));
    let buffer = Buffer.alloc(0);
    socket.on("connect", () => socket.write(JSON.stringify({ ...discovery, ...payload }) + "\n"));
    socket.setTimeout(10_000, () => socket.destroy(new Error("Control response unavailable. Query the same operation ID before retrying.")));
    socket.on("error", reject);
    socket.on("close", () => { if (!socket.readableEnded) reject(new Error("Control response lost; inspect the same operation ID.")); });
    socket.on("data", (chunk: Buffer) => {
      if (buffer.length + chunk.length > MAX_BYTES) { socket.destroy(new Error("Control response exceeds limit.")); return; }
      buffer = Buffer.concat([buffer, chunk]);
    });
    socket.on("end", () => {
      try {
        const response = JSON.parse(buffer.toString("utf8"));
        if (!response.ok) {
          if ("probe" in payload) throw new PrivateControlCompatibilityError("Supervisor readiness probe rejected.");
          throw new Error(response.error);
        }
        if ("probe" in payload && response.result?.instanceId !== discovery.instanceId) throw new PrivateControlCompatibilityError("Supervisor instance changed.");
        resolve(response.result);
      }
      catch (error) { reject(error); }
    });
  });
}

/** Authenticated read-only handshake. Older hosts reject it; never infer readiness from discovery alone. */
export async function probePrivateControl(input: { directory: string; profileId: string; version: string; signal?: AbortSignal }): Promise<{ instanceId: string; targetGeneration: boolean }> {
  const result = await exchangePrivateControl(input, { probe: true }) as Record<string, unknown> | null;
  if (!result || Object.keys(result).sort().join(",") !== "capabilities,instanceId,profileId,version" || result.profileId !== input.profileId || result.version !== input.version ||
    typeof result.instanceId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(result.instanceId)) throw new PrivateControlCompatibilityError("Incompatible supervisor readiness contract.");
  const caps = result.capabilities as Record<string, unknown> | null;
  if (!caps || Object.keys(caps).sort().join(",") !== "readiness,targetGeneration" || caps.readiness !== true || typeof caps.targetGeneration !== "boolean") throw new PrivateControlCompatibilityError("Incompatible supervisor capabilities.");
  return { instanceId: result.instanceId, targetGeneration: caps.targetGeneration as boolean };
}

/** Notify an existing authenticated owner; never starts or replaces a supervisor. */
export async function notifyPrivateConfigurationChanged(input:{directory:string;profileId:string;version:string;signal?:AbortSignal}):Promise<void>{
  const result=await exchangePrivateControl(input,{configurationChanged:true}) as {acknowledged?:boolean};
  if(result?.acknowledged!==true)throw new Error('Configuration notification was not acknowledged');
}
