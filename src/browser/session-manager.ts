import type { BrowserSessionLifecycle } from "./session-lifecycle.js";
import { BrowserSessionStateError } from "./session-state.js";
import {
  createBrowserSnapshotIdentityState,
  observeBrowserState,
  type BrowserDocumentSignal,
  type BrowserSnapshotIdentityState,
  type BrowserSnapshotInput,
  type BrowserSnapshotObservation
} from "./snapshot-state.js";
import type {
  AttachedCdpTarget,
  CdpPageTarget,
  CdpTargetManager,
  ManagedCdpTarget
} from "./cdp-target-manager.js";

export interface BrowserManagedSession {
  key: string;
  browserContextId: string;
  targetId: string;
  tabRef: string;
  pageWebSocketDebuggerUrl: string;
  supervisor: ManagedCdpTarget["supervisor"];
  lastActiveAt: number;
  touch: () => void;
  close: () => Promise<void>;
}

export type BrowserManagedTab = CdpPageTarget & {
  ref: string;
  controlled: boolean;
};

type BrowserTargetManager = Pick<CdpTargetManager, "createTarget"> &
  Partial<Pick<CdpTargetManager, "listPageTargets" | "attachTarget" | "activateTarget" | "findVisiblePageTargetId">>;

export interface BrowserSessionManagerOptions {
  targetManager: BrowserTargetManager;
  lifecycle?: Pick<BrowserSessionLifecycle, "register" | "touch" | "unregister">;
  now?: () => number;
}

type StoredBrowserSession = BrowserManagedSession & {
  ownerTarget: ManagedCdpTarget;
  activeAttachment?: AttachedCdpTarget;
  retiredAttachments: AttachedCdpTarget[];
  tabRefs: Map<string, string>;
  nextTabNumber: number;
  snapshotIdentity: BrowserSnapshotIdentityState;
};

export class BrowserSessionManager {
  readonly #targetManager: BrowserTargetManager;
  readonly #lifecycle: Pick<BrowserSessionLifecycle, "register" | "touch" | "unregister"> | undefined;
  readonly #now: () => number;
  readonly #sessions = new Map<string, StoredBrowserSession>();

  constructor(options: BrowserSessionManagerOptions) {
    this.#targetManager = options.targetManager;
    this.#lifecycle = options.lifecycle;
    this.#now = options.now ?? Date.now;
  }

  async acquire(key: string): Promise<BrowserManagedSession> {
    const sessionKey = validateSessionKey(key);
    const existing = this.#sessions.get(sessionKey);
    if (existing !== undefined) {
      this.#touch(existing);
      return existing;
    }

    let target: ManagedCdpTarget;
    try {
      target = await this.#targetManager.createTarget();
    } catch (error) {
      throw new Error(`Failed to create browser session for key ${sessionKey}: ${errorMessage(error)}`, {
        cause: error
      });
    }

    const session: StoredBrowserSession = {
      key: sessionKey,
      browserContextId: target.browserContextId,
      targetId: target.targetId,
      tabRef: "@t1",
      pageWebSocketDebuggerUrl: target.pageWebSocketDebuggerUrl,
      supervisor: target.supervisor,
      lastActiveAt: this.#now(),
      ownerTarget: target,
      retiredAttachments: [],
      tabRefs: new Map([[target.targetId, "@t1"]]),
      nextTabNumber: 2,
      snapshotIdentity: createBrowserSnapshotIdentityState(),
      touch: () => {
        this.#touch(session);
      },
      close: async () => {
        await this.close(sessionKey);
      }
    };

    this.#sessions.set(sessionKey, session);
    this.#lifecycle?.register(sessionKey, {
      browserContextId: target.browserContextId,
      targetId: target.targetId,
      pageWebSocketDebuggerUrl: target.pageWebSocketDebuggerUrl
    });
    this.#lifecycle?.touch(sessionKey);
    return session;
  }

  async listTabs(key: string): Promise<BrowserManagedTab[]> {
    const session = this.#requireSession(key);
    const listPageTargets = this.#targetManager.listPageTargets;
    if (listPageTargets === undefined) {
      throw new Error("Browser target manager does not support tab listing.");
    }
    const targets = await listPageTargets.call(this.#targetManager, session.browserContextId);
    const visibleTargetIds = new Set(targets.map((target) => target.targetId));
    for (const targetId of session.tabRefs.keys()) {
      if (!visibleTargetIds.has(targetId) && targetId !== session.ownerTarget.targetId) {
        session.tabRefs.delete(targetId);
      }
    }
    return targets.map((target) => ({
      ...target,
      ref: this.#tabRef(session, target.targetId),
      controlled: target.targetId === session.targetId
    }));
  }

  async visibleTab(key: string): Promise<BrowserManagedTab | undefined> {
    const session = this.#requireSession(key);
    const findVisiblePageTargetId = this.#targetManager.findVisiblePageTargetId;
    if (findVisiblePageTargetId === undefined) return undefined;
    const targetId = await findVisiblePageTargetId.call(
      this.#targetManager,
      session.browserContextId,
      session.targetId
    );
    if (targetId === undefined) return undefined;
    return (await this.listTabs(session.key)).find((tab) => tab.targetId === targetId);
  }

  async switchTab(key: string, tabRef: string): Promise<BrowserManagedSession> {
    const session = this.#requireSession(key);
    const attachTarget = this.#targetManager.attachTarget;
    const activateTarget = this.#targetManager.activateTarget;
    if (attachTarget === undefined || activateTarget === undefined) {
      throw new Error("Browser target manager does not support tab switching.");
    }
    const normalizedRef = validateTabRef(tabRef);
    const target = (await this.listTabs(session.key)).find((candidate) => candidate.ref === normalizedRef);
    if (target === undefined) {
      throw new BrowserSessionStateError("tab_missing", `Browser tab not found: ${normalizedRef}`);
    }

    if (target.targetId === session.targetId) {
      await activateTarget.call(this.#targetManager, session.browserContextId, target.targetId);
      this.#touch(session);
      return session;
    }

    let nextAttachment: AttachedCdpTarget | undefined;
    const switchingToOwner = target.targetId === session.ownerTarget.targetId;
    try {
      if (!switchingToOwner) {
        nextAttachment = await attachTarget.call(this.#targetManager, session.browserContextId, target.targetId);
      }
      await activateTarget.call(this.#targetManager, session.browserContextId, target.targetId);
    } catch (error) {
      if (nextAttachment !== undefined) {
        try {
          await nextAttachment.close();
        } catch {
          session.retiredAttachments.push(nextAttachment);
        }
      }
      throw new Error(`Failed to switch browser tab to ${normalizedRef}: ${errorMessage(error)}`, { cause: error });
    }

    const previousAttachment = session.activeAttachment;
    session.activeAttachment = nextAttachment;
    session.targetId = target.targetId;
    session.tabRef = normalizedRef;
    session.pageWebSocketDebuggerUrl = target.pageWebSocketDebuggerUrl;
    session.supervisor = switchingToOwner ? session.ownerTarget.supervisor : nextAttachment!.supervisor;
    this.#touch(session);
    if (previousAttachment !== undefined) {
      try {
        await previousAttachment.close();
      } catch {
        session.retiredAttachments.push(previousAttachment);
      }
    }
    return session;
  }

  async close(key: string): Promise<void> {
    const sessionKey = validateSessionKey(key);
    const session = this.#sessions.get(sessionKey);
    if (session === undefined) {
      this.#lifecycle?.unregister(sessionKey);
      return;
    }

    this.#sessions.delete(sessionKey);
    this.#lifecycle?.unregister(sessionKey);
    try {
      await closeStoredSession(session);
    } catch (error) {
      throw new Error(`Failed to close browser session for key ${sessionKey}: ${errorMessage(error)}`, {
        cause: error
      });
    }
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    const failures: { key: string; error: unknown }[] = [];

    for (const session of sessions) {
      this.#lifecycle?.unregister(session.key);
      try {
        await closeStoredSession(session);
      } catch (error) {
        failures.push({ key: session.key, error });
      }
    }

    if (failures.length > 0) {
      const keys = failures.map((failure) => failure.key).join(", ");
      throw new Error(`Failed to close ${failures.length} browser session(s): ${keys}`, {
        cause: failures[0]?.error
      });
    }
  }

  has(key: string): boolean {
    const sessionKey = validateSessionKey(key);
    return this.#sessions.has(sessionKey);
  }

  observeSnapshot(
    key: string,
    snapshot: BrowserSnapshotInput,
    documentSignal?: BrowserDocumentSignal
  ): BrowserSnapshotObservation {
    const session = this.#requireSession(key);
    this.#touch(session);
    return observeBrowserState(snapshot, session.snapshotIdentity, documentSignal, this.#now);
  }

  #touch(session: StoredBrowserSession): void {
    session.lastActiveAt = this.#now();
    this.#lifecycle?.touch(session.key);
  }

  #requireSession(key: string): StoredBrowserSession {
    const sessionKey = validateSessionKey(key);
    const session = this.#sessions.get(sessionKey);
    if (session === undefined) {
      throw new BrowserSessionStateError("session_missing", `Browser session not found: ${sessionKey}`);
    }
    return session;
  }

  #tabRef(session: StoredBrowserSession, targetId: string): string {
    const existing = session.tabRefs.get(targetId);
    if (existing !== undefined) return existing;
    const ref = `@t${session.nextTabNumber++}`;
    session.tabRefs.set(targetId, ref);
    return ref;
  }
}

async function closeStoredSession(session: StoredBrowserSession): Promise<void> {
  let firstError: unknown;
  for (const attachment of [session.activeAttachment, ...session.retiredAttachments]) {
    if (attachment === undefined) continue;
    try {
      await attachment.close();
    } catch (error) {
      firstError ??= error;
    }
  }
  try {
    await session.ownerTarget.close();
  } catch (error) {
    firstError ??= error;
  }
  if (firstError !== undefined) throw firstError;
}

function validateSessionKey(key: string): string {
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error("Browser session key must be a non-empty string.");
  }
  return key;
}

function validateTabRef(ref: string): string {
  if (!/^@t[1-9]\d*$/u.test(ref)) {
    throw new Error("Browser tab ref must look like @t1.");
  }
  return ref;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
