import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startPrivateControl, callPrivateControl, validatePrivateControlRequest, notifyPrivateConfigurationChanged } from "./private-control.js";

it.skipIf(process.platform === 'win32')('binds configuration notifications to the authenticated profile owner',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ipc-config-'));await chmod(directory,0o700);const configurationChanged=vi.fn(async()=>{});
  const server=await startPrivateControl({directory,instanceId:'instance',profileId:'p',version:'test',handle:async()=>({}),configurationChanged});
  try{
    await notifyPrivateConfigurationChanged({directory,profileId:'p',version:'test'});expect(configurationChanged).toHaveBeenCalledTimes(1);
    await expect(notifyPrivateConfigurationChanged({directory,profileId:'other',version:'test'})).rejects.toThrow();expect(configurationChanged).toHaveBeenCalledTimes(1);
  }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});

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

it.skipIf(process.platform === "win32")("rejects a wrong instance secret before dispatch", async () => {
  const { createConnection } = await import("node:net");
  const { readFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "ipc-auth-")); await chmod(directory, 0o700);
  const handle = vi.fn(async () => ({}));
  const server = await startPrivateControl({ directory, instanceId: "instance", profileId: "default", version: "test", handle });
  try {
    const discovery = JSON.parse(await readFile(join(directory, "control.json"), "utf8"));
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(discovery.socket); let text = "";
      socket.on("error", reject); socket.on("data", (chunk) => { text += chunk.toString(); }); socket.on("end", () => resolve(text));
      socket.on("connect", () => socket.write(JSON.stringify({ ...discovery, token: "0".repeat(64), request: { method: "cancel", sessionId: "s", targetId: "t", operationId: "op" } }) + "\n"));
    });
    expect(JSON.parse(response).ok).toBe(false); expect(handle).not.toHaveBeenCalled();
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});


it.skipIf(process.platform === 'win32')('requires an enforcing host for conversation permissions and interruption',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ipc-conversation-'));await chmod(directory,0o700);
 const handle=vi.fn(async(_request:unknown)=>({accepted:true}));
 const input={directory,profileId:'p',version:'test',requireTargetGeneration:true,request:{method:'send' as const,sessionId:'s',targetId:'t',targetGeneration:1,operationId:'op',text:'Continue',securityMode:'open' as const,interrupt:true}};
 let server=await startPrivateControl({directory,instanceId:'old',profileId:'p',version:'test',targetGeneration:true,handle});
 try{
  await expect(callPrivateControl(input)).rejects.toThrow('Restart the execution host');expect(handle).not.toHaveBeenCalled();
  await server.close();server=await startPrivateControl({directory,instanceId:'new',profileId:'p',version:'test',targetGeneration:true,conversationControls:true,handle});
  await expect(callPrivateControl(input)).resolves.toEqual({accepted:true});expect(handle).toHaveBeenCalledTimes(1);expect(handle.mock.calls[0]?.[0]).toMatchObject({securityMode:'open',interrupt:true,targetGeneration:1});
  for(const override of [{securityMode:'off'},{interrupt:'yes'},{targetGeneration:undefined},{method:'inspect'}])expect(()=>validatePrivateControlRequest({...input.request,...override})).toThrow('Invalid');
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});

it.skipIf(process.platform==='win32')('reports authenticated build identity only on an opt-in probe',async()=>{
 const {probePrivateControl,probePrivateRuntimeBuild}=await import('./private-control.js');
 const directory=await mkdtemp(join(tmpdir(),'ipc-build-'));await chmod(directory,0o700);
 const input={directory,profileId:'p',version:'test'},digest='a'.repeat(64);
 const server=await startPrivateControl({...input,instanceId:'build-test',runtimeBuild:digest,handle:async()=>({})});
 try{
  expect(await probePrivateControl(input)).toEqual({instanceId:'build-test',targetGeneration:false});
  expect(await probePrivateRuntimeBuild(input)).toBe(digest);
  await expect(probePrivateRuntimeBuild({...input,profileId:'other'})).rejects.toThrow();
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});
