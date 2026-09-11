import { expect, it, vi } from "vitest";
import { SharedSessionHost } from "./shared-session-host.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { SessionDB } from "../contracts/session.js";

it("keeps priority cancellation reachable while a hosted turn waits", async () => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const runtime = { sessionId: "session", dispose: vi.fn(async () => undefined),
    handle: vi.fn(async (input) => { started(); await new Promise((resolve) => input.signal.addEventListener("abort", resolve, { once: true })); return { text: "cancelled" }; }) } as unknown as Runtime;
  const sessionDb = { getSessionForProfile: vi.fn(async () => ({ id: "session", executionTarget: { targetId: "target" } })) } as unknown as SessionDB;
  const host = new SharedSessionHost({ profileId: "default", sessionDb, acquire: async () => runtime, channelApproval: vi.fn() });
  const base = { sessionId: "session", targetId: "target", operationId: "op" };
  const turn = host.handle({ ...base, method: "send", text: "work" });
  await running;
  await expect(host.handle({ ...base, method: "cancel" })).resolves.toEqual({ cancellationRequested: true, terminationConfirmed: false });
  await expect(turn).resolves.toMatchObject({ text: "cancelled" });
  expect(runtime.dispose).toHaveBeenCalledOnce();
  await host.close();
});
it("rejects target mismatch before runtime construction or channel approval", async () => {
  const acquire = vi.fn(), channelApproval = vi.fn();
  const host = new SharedSessionHost({ profileId: "default", acquire, channelApproval,
    sessionDb: { getSessionForProfile: async () => ({ executionTarget: { targetId: "other" } }) } as unknown as SessionDB });
  await expect(host.handle({ method: "send", sessionId: "s", targetId: "t", operationId: "o", text: "work" })).rejects.toThrow("target");
  expect(acquire).not.toHaveBeenCalled(); expect(channelApproval).not.toHaveBeenCalled();
});

it("routes priority channel cancellation and never invents termination confirmation", async () => {
  const channelCancel = vi.fn((id: string) => id === "session");
  const host = new SharedSessionHost({ profileId: "default", channelCancel, acquire: vi.fn(), channelApproval: vi.fn(),
    sessionDb: { getSessionForProfile: async () => ({ executionTarget: { targetId: "target" } }) } as unknown as SessionDB });
  await expect(host.handle({ method: "cancel", sessionId: "session", targetId: "target", operationId: "op" }))
    .resolves.toEqual({ cancellationRequested: true, terminationConfirmed: false });
  await expect(host.handle({ method: "cancel", sessionId: "foreign", targetId: "target", operationId: "op2" }))
    .resolves.toEqual({ cancellationRequested: false, terminationConfirmed: false });
  expect(channelCancel).toHaveBeenCalledWith("session");
  await host.close();
});
it('requires trusted generation validation before Desktop runtime construction', async () => {
  const acquire = vi.fn(), validateTarget = vi.fn(async () => { throw new Error('Target was archived'); });
  const sessionDb = { getSessionForProfile: async () => ({ executionTarget: { targetId: 'target', targetGeneration: 2 } }) } as unknown as SessionDB;
  const request = { method: 'send' as const, sessionId: 's', targetId: 'target', targetGeneration: 2, operationId: 'op', text: 'work' };
  const host = new SharedSessionHost({ profileId: 'p', acquire, sessionDb, validateTarget, channelApproval: vi.fn() });
  await expect(host.handle({ ...request, targetGeneration: 1 })).rejects.toThrow('generation');
  expect(validateTarget).not.toHaveBeenCalled();
  await expect(host.handle(request)).rejects.toThrow('archived'); expect(acquire).not.toHaveBeenCalled();
  const legacy = new SharedSessionHost({ profileId: 'p', acquire, sessionDb, channelApproval: vi.fn() });
  await expect(legacy.handle(request)).rejects.toThrow('generation');
});
