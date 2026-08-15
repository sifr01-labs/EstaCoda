import { describe, expect, it, vi, afterEach } from "vitest";
import { BrowserSessionManager } from "./session-manager.js";
import { BrowserSessionLifecycle } from "./session-lifecycle.js";
import type {
  AttachedCdpTarget,
  CdpPageTarget,
  CdpTargetSupervisor,
  ManagedCdpTarget
} from "./cdp-target-manager.js";
import type { BrowserSnapshot } from "../contracts/browser.js";
import { resolveBrowserTarget } from "./browser-locator.js";

class FakeSupervisor implements CdpTargetSupervisor {
  close = vi.fn();
}

class FakeManagedTarget implements ManagedCdpTarget {
  readonly browserContextId: string;
  readonly targetId: string;
  readonly pageWebSocketDebuggerUrl: string;
  readonly supervisor = new FakeSupervisor();
  readonly close = vi.fn(async () => {
    this.events.push(`target:${this.targetId}:close`);
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
  });

  closeError: Error | undefined;

  constructor(
    index: number,
    private readonly events: string[]
  ) {
    this.browserContextId = `context-${index}`;
    this.targetId = `target-${index}`;
    this.pageWebSocketDebuggerUrl = `ws://page-${index}`;
  }
}

class FakeTargetManager {
  readonly targets: FakeManagedTarget[] = [];
  readonly pageTargets: CdpPageTarget[] = [];
  readonly attachments: AttachedCdpTarget[] = [];
  readonly activated: string[] = [];
  readonly createTarget = vi.fn(async (): Promise<ManagedCdpTarget> => {
    if (this.createError !== undefined) {
      throw this.createError;
    }
    const target = new FakeManagedTarget(this.targets.length + 1, this.events);
    this.targets.push(target);
    this.pageTargets.push({
      browserContextId: target.browserContextId,
      targetId: target.targetId,
      pageWebSocketDebuggerUrl: target.pageWebSocketDebuggerUrl,
      url: "about:blank",
      title: `Page ${this.targets.length}`
    });
    return target;
  });
  readonly listPageTargets = vi.fn(async (browserContextId: string) =>
    this.pageTargets.filter((target) => target.browserContextId === browserContextId));
  readonly attachTarget = vi.fn(async (browserContextId: string, targetId: string): Promise<AttachedCdpTarget> => {
    const target = this.pageTargets.find((candidate) =>
      candidate.browserContextId === browserContextId && candidate.targetId === targetId);
    if (target === undefined) throw new Error("target unavailable");
    const supervisor = new FakeSupervisor();
    const attached: AttachedCdpTarget = {
      ...target,
      supervisor,
      close: vi.fn(async () => supervisor.close())
    };
    this.attachments.push(attached);
    return attached;
  });
  readonly activateTarget = vi.fn(async (browserContextId: string, targetId: string) => {
    const target = this.pageTargets.find((candidate) =>
      candidate.browserContextId === browserContextId && candidate.targetId === targetId);
    if (target === undefined) throw new Error("target unavailable");
    this.activated.push(targetId);
  });
  readonly findVisiblePageTargetId = vi.fn(async (browserContextId: string) =>
    this.pageTargets.find((target) =>
      target.browserContextId === browserContextId && target.targetId === this.visibleTargetId)?.targetId);

  createError: Error | undefined;
  visibleTargetId: string | undefined;

  constructor(private readonly events: string[] = []) {}

  addTab(browserContextId: string, targetId: string, url: string): void {
    this.pageTargets.push({
      browserContextId,
      targetId,
      pageWebSocketDebuggerUrl: `ws://${targetId}`,
      url,
      title: targetId
    });
  }
}

class FakeLifecycle {
  readonly registered = new Set<string>();
  readonly calls: string[] = [];
  readonly register = vi.fn((key: string) => {
    this.calls.push(`register:${key}`);
    this.registered.add(key);
  });
  readonly touch = vi.fn((key: string) => {
    this.calls.push(`touch:${key}`);
  });
  readonly unregister = vi.fn((key: string) => {
    this.calls.push(`unregister:${key}`);
    this.registered.delete(key);
  });
}

describe("BrowserSessionManager", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("acquire() creates one context/target for a new key", async () => {
    const targetManager = new FakeTargetManager();
    const manager = new BrowserSessionManager({ targetManager });

    const session = await manager.acquire("session-1");

    expect(targetManager.createTarget).toHaveBeenCalledTimes(1);
    expect(session.key).toBe("session-1");
    expect(session.browserContextId).toBe("context-1");
    expect(session.targetId).toBe("target-1");
    expect(session.pageWebSocketDebuggerUrl).toBe("ws://page-1");
    expect(session.supervisor).toBe(targetManager.targets[0]?.supervisor);
    expect(manager.has("session-1")).toBe(true);
  });

  it("owns canonical snapshot identity independently per browser session", async () => {
    const manager = new BrowserSessionManager({ targetManager: new FakeTargetManager() });
    await manager.acquire("session-a");
    await manager.acquire("session-b");
    const base = (sessionId: string, text: string): BrowserSnapshot => ({
      sessionId,
      url: "https://example.com",
      revision: 0,
      observedAt: "1970-01-01T00:00:00.000Z",
      text,
      elements: []
    });

    const first = manager.observeSnapshot("session-a", base("session-a", "first"), {
      frameId: "main-a",
      loaderId: "loader-1"
    });
    const repeated = manager.observeSnapshot("session-a", base("session-a", "changed"), {
      frameId: "main-a",
      loaderId: "loader-1"
    });
    const secondSession = manager.observeSnapshot("session-b", base("session-b", "first"), {
      frameId: "main-b",
      loaderId: "loader-1"
    });

    expect(first.identity).toEqual({ documentEpoch: 1, actionRevision: 1, observationId: 1 });
    expect(repeated.identity).toEqual({ documentEpoch: 1, actionRevision: 1, observationId: 2 });
    expect(secondSession.identity).toEqual({ documentEpoch: 1, actionRevision: 1, observationId: 1 });
  });

  it("keeps refs from other tabs and replaced documents invalid during compatibility", async () => {
    const targetManager = new FakeTargetManager();
    const manager = new BrowserSessionManager({ targetManager });
    const session = await manager.acquire("session-1");
    targetManager.addTab(session.browserContextId, "target-2", "https://example.com");
    const base = (tabRef: string): BrowserSnapshot => ({
      sessionId: "session-1",
      url: "https://example.com",
      revision: 0,
      observedAt: "1970-01-01T00:00:00.000Z",
      tab: { ref: tabRef, url: "https://example.com", controlled: true },
      elements: [{ ref: "@e1", role: "button", name: "Continue" }]
    });

    const first = manager.observeSnapshot("session-1", base("@t1"), {
      frameId: "main",
      loaderId: "loader-1"
    });
    await manager.switchTab("session-1", "@t2");
    const switched = manager.observeSnapshot("session-1", base("@t2"), {
      frameId: "main",
      loaderId: "loader-1"
    });

    expect(switched.identity.documentEpoch).toBe(first.identity.documentEpoch + 1);
    expect(() => resolveBrowserTarget(switched.snapshot, {
      ref: "@e1",
      revision: first.snapshot.revision,
      tabRef: "@t1"
    })).toThrow("belongs to tab @t1");

    const replaced = manager.observeSnapshot("session-1", base("@t2"), {
      frameId: "main",
      loaderId: "loader-2"
    });
    expect(() => resolveBrowserTarget(replaced.snapshot, {
      ref: "@e1",
      revision: switched.snapshot.revision,
      tabRef: "@t2"
    })).toThrow("came from revision");
  });

  it("acquire() reuses an existing session for the same key", async () => {
    const targetManager = new FakeTargetManager();
    const manager = new BrowserSessionManager({ targetManager });

    const first = await manager.acquire("session-1");
    const second = await manager.acquire("session-1");

    expect(second).toBe(first);
    expect(targetManager.createTarget).toHaveBeenCalledTimes(1);
  });

  it("acquire() updates lastActiveAt for an existing session", async () => {
    const targetManager = new FakeTargetManager();
    let now = 10;
    const manager = new BrowserSessionManager({
      targetManager,
      now: () => now
    });

    const session = await manager.acquire("session-1");
    expect(session.lastActiveAt).toBe(10);

    now = 20;
    const reused = await manager.acquire("session-1");

    expect(reused).toBe(session);
    expect(reused.lastActiveAt).toBe(20);
  });

  it("touch() updates lastActiveAt and the lifecycle activity record", async () => {
    const targetManager = new FakeTargetManager();
    const lifecycle = new FakeLifecycle();
    let now = 10;
    const manager = new BrowserSessionManager({
      targetManager,
      lifecycle,
      now: () => now
    });

    const session = await manager.acquire("session-1");
    now = 30;
    session.touch();

    expect(session.lastActiveAt).toBe(30);
    expect(lifecycle.touch).toHaveBeenLastCalledWith("session-1");
  });

  it("different keys create different contexts/targets", async () => {
    const targetManager = new FakeTargetManager();
    const manager = new BrowserSessionManager({ targetManager });

    const first = await manager.acquire("session-1");
    const second = await manager.acquire("session-2");

    expect(first.browserContextId).toBe("context-1");
    expect(second.browserContextId).toBe("context-2");
    expect(first.targetId).toBe("target-1");
    expect(second.targetId).toBe("target-2");
    expect(targetManager.createTarget).toHaveBeenCalledTimes(2);
  });

  it("lists same-context page tabs with stable opaque refs", async () => {
    const targetManager = new FakeTargetManager();
    const manager = new BrowserSessionManager({ targetManager });
    await manager.acquire("session-1");
    targetManager.addTab("context-1", "target-2", "https://example.com/details");
    targetManager.addTab("context-other", "target-other", "https://other.example");

    const first = await manager.listTabs("session-1");
    const second = await manager.listTabs("session-1");

    expect(first.map((tab) => ({ ref: tab.ref, targetId: tab.targetId, controlled: tab.controlled }))).toEqual([
      { ref: "@t1", targetId: "target-1", controlled: true },
      { ref: "@t2", targetId: "target-2", controlled: false }
    ]);
    expect(second.map((tab) => tab.ref)).toEqual(["@t1", "@t2"]);
  });

  it("reports a manually focused same-context tab without changing control", async () => {
    const targetManager = new FakeTargetManager();
    const manager = new BrowserSessionManager({ targetManager });
    await manager.acquire("session-1");
    targetManager.addTab("context-1", "target-2", "https://example.com/details");
    targetManager.visibleTargetId = "target-2";

    await expect(manager.visibleTab("session-1")).resolves.toMatchObject({
      ref: "@t2",
      targetId: "target-2",
      controlled: false
    });
    expect(targetManager.activated).toEqual([]);
  });

  it("switches the controlled target and returns to the owner without disposing the context", async () => {
    const targetManager = new FakeTargetManager();
    const lifecycle = new FakeLifecycle();
    const manager = new BrowserSessionManager({ targetManager, lifecycle });
    const session = await manager.acquire("session-1");
    targetManager.addTab("context-1", "target-2", "https://example.com/details");
    await manager.listTabs("session-1");

    const switched = await manager.switchTab("session-1", "@t2");

    expect(switched).toBe(session);
    expect(switched).toMatchObject({ targetId: "target-2", tabRef: "@t2" });
    expect(switched.supervisor).toBe(targetManager.attachments[0]?.supervisor);
    expect(targetManager.activated).toEqual(["target-2"]);
    expect(targetManager.targets[0]?.close).not.toHaveBeenCalled();
    expect(lifecycle.register).toHaveBeenCalledTimes(1);
    expect(lifecycle.touch).toHaveBeenCalledWith("session-1");

    const returned = await manager.switchTab("session-1", "@t1");

    expect(returned).toMatchObject({ targetId: "target-1", tabRef: "@t1" });
    expect(returned.supervisor).toBe(targetManager.targets[0]?.supervisor);
    expect(targetManager.attachments[0]?.close).toHaveBeenCalledTimes(1);
    expect(targetManager.targets[0]?.close).not.toHaveBeenCalled();
  });

  it("closes the active attachment before closing the context-owning target", async () => {
    const events: string[] = [];
    const targetManager = new FakeTargetManager(events);
    const manager = new BrowserSessionManager({ targetManager });
    await manager.acquire("session-1");
    targetManager.addTab("context-1", "target-2", "https://example.com/details");
    await manager.listTabs("session-1");
    await manager.switchTab("session-1", "@t2");
    const attachment = targetManager.attachments[0]!;
    vi.mocked(attachment.close).mockImplementation(async () => {
      events.push("attachment:target-2:close");
    });

    await manager.close("session-1");

    expect(events).toEqual([
      "attachment:target-2:close",
      "target:target-1:close"
    ]);
    expect(attachment.close).toHaveBeenCalledTimes(1);
    expect(targetManager.targets[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("retains failed tab detachments and retries them during session cleanup", async () => {
    const targetManager = new FakeTargetManager();
    const manager = new BrowserSessionManager({ targetManager });
    await manager.acquire("session-1");
    targetManager.addTab("context-1", "target-2", "https://example.com/details");
    await manager.listTabs("session-1");
    await manager.switchTab("session-1", "@t2");
    const attachment = targetManager.attachments[0]!;
    vi.mocked(attachment.close)
      .mockRejectedValueOnce(new Error("detach failed"))
      .mockResolvedValueOnce(undefined);

    await manager.switchTab("session-1", "@t1");
    await manager.close("session-1");

    expect(attachment.close).toHaveBeenCalledTimes(2);
    expect(targetManager.targets[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed and unavailable tab refs without changing the controlled target", async () => {
    const targetManager = new FakeTargetManager();
    const manager = new BrowserSessionManager({ targetManager });
    const session = await manager.acquire("session-1");

    await expect(manager.switchTab("session-1", "target-2")).rejects.toThrow("Browser tab ref must look like @t1.");
    await expect(manager.switchTab("session-1", "@t2")).rejects.toThrow("Browser tab not found: @t2");
    expect(session).toMatchObject({ targetId: "target-1", tabRef: "@t1" });
  });

  it("invalid or empty keys throw deterministic errors", async () => {
    const targetManager = new FakeTargetManager();
    const manager = new BrowserSessionManager({ targetManager });

    await expect(manager.acquire("")).rejects.toThrow("Browser session key must be a non-empty string.");
    await expect(manager.acquire("   ")).rejects.toThrow("Browser session key must be a non-empty string.");
    await expect(manager.close("")).rejects.toThrow("Browser session key must be a non-empty string.");
    expect(() => manager.has("")).toThrow("Browser session key must be a non-empty string.");
    expect(targetManager.createTarget).not.toHaveBeenCalled();
  });

  it("target creation failure does not store a session", async () => {
    const targetManager = new FakeTargetManager();
    targetManager.createError = new Error("target failed");
    const manager = new BrowserSessionManager({ targetManager });

    await expect(manager.acquire("session-1")).rejects.toThrow(
      "Failed to create browser session for key session-1: target failed"
    );

    expect(manager.has("session-1")).toBe(false);
  });

  it("close(key) closes the target and removes the session", async () => {
    const targetManager = new FakeTargetManager();
    const lifecycle = new FakeLifecycle();
    const manager = new BrowserSessionManager({ targetManager, lifecycle });
    await manager.acquire("session-1");

    await manager.close("session-1");

    expect(targetManager.targets[0]?.close).toHaveBeenCalledTimes(1);
    expect(manager.has("session-1")).toBe(false);
    expect(lifecycle.unregister).toHaveBeenCalledWith("session-1");
  });

  it("session.close() closes through the manager", async () => {
    const targetManager = new FakeTargetManager();
    const manager = new BrowserSessionManager({ targetManager });
    const session = await manager.acquire("session-1");

    await session.close();

    expect(targetManager.targets[0]?.close).toHaveBeenCalledTimes(1);
    expect(manager.has("session-1")).toBe(false);
  });

  it("close(key) is idempotent for missing or already closed sessions", async () => {
    const targetManager = new FakeTargetManager();
    const manager = new BrowserSessionManager({ targetManager });

    await manager.close("missing-session");
    await manager.acquire("session-1");
    await manager.close("session-1");
    await manager.close("session-1");

    expect(targetManager.targets[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("close(key) removes the session even when target cleanup fails", async () => {
    const targetManager = new FakeTargetManager();
    const manager = new BrowserSessionManager({ targetManager });
    await manager.acquire("session-1");
    targetManager.targets[0]!.closeError = new Error("close failed");

    await expect(manager.close("session-1")).rejects.toThrow(
      "Failed to close browser session for key session-1: close failed"
    );

    expect(manager.has("session-1")).toBe(false);
  });

  it("closeAll() closes every stored session and clears the map", async () => {
    const targetManager = new FakeTargetManager();
    const manager = new BrowserSessionManager({ targetManager });
    await manager.acquire("session-1");
    await manager.acquire("session-2");

    await manager.closeAll();

    expect(targetManager.targets[0]?.close).toHaveBeenCalledTimes(1);
    expect(targetManager.targets[1]?.close).toHaveBeenCalledTimes(1);
    expect(manager.has("session-1")).toBe(false);
    expect(manager.has("session-2")).toBe(false);
  });

  it("closeAll() is idempotent", async () => {
    const targetManager = new FakeTargetManager();
    const manager = new BrowserSessionManager({ targetManager });
    await manager.acquire("session-1");

    await manager.closeAll();
    await manager.closeAll();

    expect(targetManager.targets[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("closeAll() continues cleanup after failures and reports failed keys", async () => {
    const targetManager = new FakeTargetManager();
    const manager = new BrowserSessionManager({ targetManager });
    await manager.acquire("session-1");
    await manager.acquire("session-2");
    targetManager.targets[0]!.closeError = new Error("close failed");

    await expect(manager.closeAll()).rejects.toThrow("Failed to close 1 browser session(s): session-1");

    expect(targetManager.targets[0]?.close).toHaveBeenCalledTimes(1);
    expect(targetManager.targets[1]?.close).toHaveBeenCalledTimes(1);
    expect(manager.has("session-1")).toBe(false);
    expect(manager.has("session-2")).toBe(false);
  });

  it("delegates cleanup order to ManagedCdpTarget.close()", async () => {
    const events: string[] = [];
    const targetManager = new FakeTargetManager(events);
    const manager = new BrowserSessionManager({ targetManager });
    await manager.acquire("session-1");

    await manager.close("session-1");

    expect(events).toEqual(["target:target-1:close"]);
  });

  it("registers, touches, and unregisters lifecycle sessions", async () => {
    const targetManager = new FakeTargetManager();
    const lifecycle = new FakeLifecycle();
    const manager = new BrowserSessionManager({ targetManager, lifecycle });

    await manager.acquire("session-1");
    await manager.acquire("session-1");
    await manager.close("session-1");

    expect(lifecycle.calls).toEqual([
      "register:session-1",
      "touch:session-1",
      "touch:session-1",
      "unregister:session-1"
    ]);
  });

  it("lifecycle inactivity cleanup closes the session and removes it from the manager map", async () => {
    vi.useFakeTimers();
    let manager: BrowserSessionManager;
    const targetManager = new FakeTargetManager();
    const lifecycle = new BrowserSessionLifecycle({
      inactivityTimeoutMs: 1_000,
      onCleanup: async (key) => {
        await manager.close(key);
      }
    });
    manager = new BrowserSessionManager({ targetManager, lifecycle });

    lifecycle.start();
    await manager.acquire("session-1");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(targetManager.targets[0]?.close).toHaveBeenCalledTimes(1);
    expect(manager.has("session-1")).toBe(false);
    lifecycle.stop();
  });
});
