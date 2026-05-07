import { describe, it, expect, vi } from "vitest";
import {
  RuntimeCache,
  safeDispose,
  createCachedRuntimeProxy,
  type RuntimeCacheOptions,
} from "./runtime-cache.js";
import type { Runtime } from "./create-runtime.js";
import type { RuntimeFingerprint } from "./runtime-fingerprint.js";
import type { SecurityPolicy } from "../contracts/security.js";
import type { SessionDB } from "../contracts/session.js";

let mockRuntimeId = 0;

function createMockRuntime(overrides?: Partial<Runtime> & { id?: string }): Runtime & { id: string; disposeCalls: number; disposed: boolean } {
  const id = overrides?.id ?? `mock-${++mockRuntimeId}`;
  let disposed = false;
  let disposeCalls = 0;

  const rt = {
    id,
    describe: () => `mock-${id}`,
    getStatus: () => ({ sections: [] }),
    getModelInfo: () => ({ title: "model", items: [] }),
    getStartup: () => ({ title: "startup", items: [] }),
    tools: () => [],
    skills: () => [],
    latestResumeNote: async () => undefined,
    inspectMemoryPromotions: async () => [],
    inspectMcpServers: () => [],
    handle: async () => ({ replyText: "ok", artifactCount: 0, progressCount: 0 }),
    dispose: async () => {
      disposeCalls++;
      disposed = true;
    },
    sessionDb: {} as SessionDB,
    sessionId: id,
    disposed,
    get disposeCalls() {
      return disposeCalls;
    },
    ...overrides,
  } as Runtime & { id: string; disposeCalls: number; disposed: boolean };

  return rt;
}

function fakeFingerprint(overrides?: Partial<RuntimeFingerprint>): RuntimeFingerprint {
  return {
    modelProvider: "openai",
    modelId: "gpt-4",
    modelContextWindowTokens: 128_000,
    profileId: "default",
    securityMode: "adaptive",
    securityAssessorEnabled: false,
    securityAssessorTimeoutMs: 30_000,
    approvalControllerPresent: false,
    explicitSecurityPolicyPresent: false,
    workspaceRoot: "/workspace",
    homeDir: "/home/test",
    localSkillsRoot: "/home/test/.estacoda/skills",
    trustStorePath: "/home/test/.estacoda/trust.json",
    disabledToolsets: [],
    mcpServersHash: "0000000000000000",
    browserHash: "0000000000000000",
    enableWebNetwork: true,
    webMaxContentChars: 5000,
    disableCronTools: false,
    skillAutonomy: "suggest",
    skillConfigHash: "0000000000000000",
    externalSkillRoots: [],
    uiLanguage: "en",
    uiFlavor: "standard",
    activityLabels: "en",
    agentProfileMode: "focused",
    agentResponseLanguage: "en",
    imageGenHash: "0000000000000000",
    ttsHash: "0000000000000000",
    sttHash: "0000000000000000",
    telegramReady: false,
    currentPlatform: "linux",
    ...overrides,
  };
}

const fakeSecurityPolicy: SecurityPolicy = {
  decide: () => "allow",
};

function createCache(overrides?: Partial<RuntimeCacheOptions>): RuntimeCache {
  return new RuntimeCache({
    createRuntime: async () => createMockRuntime(),
    maxEntries: 3,
    idleTtlMs: 60_000,
    ...overrides,
  });
}

describe("RuntimeCache", () => {
  it("get() creates runtime on first call", async () => {
    const cache = createCache();
    const proxy = await cache.get("s1", fakeFingerprint(), fakeSecurityPolicy);
    expect(proxy).toBeDefined();
    const stats = cache.stats();
    expect(stats.totalCreated).toBe(1);
    expect(stats.totalReused).toBe(0);
  });

  it("get() reuses runtime on second call with same fingerprint", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    await cache.get("s1", fp, fakeSecurityPolicy);
    await cache.get("s1", fp, fakeSecurityPolicy);
    const stats = cache.stats();
    expect(stats.totalCreated).toBe(1);
    expect(stats.totalReused).toBe(1);
  });

  it("get() creates new runtime when fingerprint changes", async () => {
    const cache = createCache();
    const fp1 = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp1, fakeSecurityPolicy);
    await proxy1.dispose();

    const fp2 = fakeFingerprint({ modelId: "gpt-5" });
    const proxy2 = await cache.get("s1", fp2, fakeSecurityPolicy);
    const stats = cache.stats();
    expect(stats.totalCreated).toBe(2);
    expect(stats.totalDisposed).toBe(1);
    await proxy2.dispose();
  });

  it("get() creates new runtime when old is suspended", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp, fakeSecurityPolicy);
    await cache.suspend("s1", "test-suspend");

    const proxy2 = await cache.get("s1", fp, fakeSecurityPolicy);
    const stats = cache.stats();
    expect(stats.totalCreated).toBe(2);
    await proxy1.dispose();
    await proxy2.dispose();
  });

  it("releaseLease() does not dispose when not pending", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy = await cache.get("s1", fp, fakeSecurityPolicy);
    await proxy.dispose();
    const stats = cache.stats();
    expect(stats.totalDisposed).toBe(0);
    expect(stats.totalEntries).toBe(1);
  });

  it("releaseLease() disposes when disposePending and borrowCount reaches 0", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy = await cache.get("s1", fp, fakeSecurityPolicy);
    await cache.suspend("s1", "test-suspend");
    await proxy.dispose();
    const stats = cache.stats();
    expect(stats.totalDisposed).toBe(1);
    expect(stats.totalEntries).toBe(0);
  });

  it("suspend() disposes immediately when not borrowed", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy = await cache.get("s1", fp, fakeSecurityPolicy);
    await proxy.dispose();
    await cache.suspend("s1", "test-suspend");
    const stats = cache.stats();
    expect(stats.totalDisposed).toBe(1);
    expect(stats.totalEntries).toBe(0);
  });

  it("suspend() defers disposal when borrowed", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy = await cache.get("s1", fp, fakeSecurityPolicy);
    await cache.suspend("s1", "test-suspend");
    let stats = cache.stats();
    expect(stats.totalDisposed).toBe(0);
    await proxy.dispose();
    stats = cache.stats();
    expect(stats.totalDisposed).toBe(1);
  });

  it("invalidate() behaves like suspend with reason invalidated", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy = await cache.get("s1", fp, fakeSecurityPolicy);
    await cache.invalidate("s1");
    const summary = cache.suspendedSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0].reason).toBe("invalidated");
    await proxy.dispose();
  });

  it("prune() disposes idle entries past TTL", async () => {
    const cache = createCache({ idleTtlMs: 10 });
    const fp = fakeFingerprint();
    const proxy = await cache.get("s1", fp, fakeSecurityPolicy);
    await proxy.dispose();
    await new Promise((r) => setTimeout(r, 20));
    await cache.prune();
    const stats = cache.stats();
    expect(stats.totalDisposed).toBe(1);
    expect(stats.totalEntries).toBe(0);
  });

  it("prune() keeps active borrowed entries", async () => {
    const cache = createCache({ idleTtlMs: 10 });
    const fp = fakeFingerprint();
    await cache.get("s1", fp, fakeSecurityPolicy);
    await new Promise((r) => setTimeout(r, 20));
    await cache.prune();
    const stats = cache.stats();
    expect(stats.totalDisposed).toBe(0);
    expect(stats.totalEntries).toBe(1);
  });

  it("prune() LRU-evicts when over maxEntries", async () => {
    const cache = createCache({ maxEntries: 2 });
    const fp = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp, fakeSecurityPolicy);
    await proxy1.dispose();
    const proxy2 = await cache.get("s2", fp, fakeSecurityPolicy);
    await proxy2.dispose();
    const proxy3 = await cache.get("s3", fp, fakeSecurityPolicy);
    await proxy3.dispose();
    await cache.prune();
    const stats = cache.stats();
    expect(stats.totalDisposed).toBe(1);
    expect(stats.totalEntries).toBe(2);
  });

  it("prune() skips eviction-blocked entries when hook provided", async () => {
    const cache = createCache({ maxEntries: 1 });
    const fp = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp, fakeSecurityPolicy);
    await proxy1.dispose();
    const proxy2 = await cache.get("s2", fp, fakeSecurityPolicy);
    await proxy2.dispose();
    await cache.prune({ isEvictionBlocked: (id) => id === "s1" });
    const stats = cache.stats();
    // s1 blocked, s2 should be evicted
    expect(stats.totalDisposed).toBe(1);
    expect(stats.totalEntries).toBe(1);
  });

  it("prune() logs warning when all entries are borrowed", async () => {
    const warnings: string[] = [];
    const cache = createCache({
      maxEntries: 1,
      logWarning: (msg) => warnings.push(msg),
    });
    const fp = fakeFingerprint();
    await cache.get("s1", fp, fakeSecurityPolicy);
    await cache.get("s2", fp, fakeSecurityPolicy);
    await cache.prune();
    expect(warnings.some((w) => w.includes("over cap"))).toBe(true);
  });

  it("disposeAll() disposes all idle entries", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp, fakeSecurityPolicy);
    await proxy1.dispose();
    const proxy2 = await cache.get("s2", fp, fakeSecurityPolicy);
    await proxy2.dispose();
    await cache.disposeAll();
    const stats = cache.stats();
    expect(stats.totalDisposed).toBe(2);
    expect(stats.totalEntries).toBe(0);
  });

  it("disposeAll() defers disposal for borrowed entries until releaseLease", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy = await cache.get("s1", fp, fakeSecurityPolicy);
    await cache.disposeAll();
    let stats = cache.stats();
    expect(stats.totalDisposed).toBe(0);
    expect(stats.totalEntries).toBe(1);
    await proxy.dispose();
    stats = cache.stats();
    expect(stats.totalDisposed).toBe(1);
    expect(stats.totalEntries).toBe(0);
  });

  it("stats() tracks created/reused/disposed", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp, fakeSecurityPolicy);
    await proxy1.dispose();
    const proxy2 = await cache.get("s1", fp, fakeSecurityPolicy);
    await proxy2.dispose();
    const stats = cache.stats();
    expect(stats.totalCreated).toBe(1);
    expect(stats.totalReused).toBe(1);
    expect(stats.totalDisposed).toBe(0);
  });

  it("suspendedSummary() returns suspended entries", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy = await cache.get("s1", fp, fakeSecurityPolicy);
    await proxy.dispose();
    await cache.suspend("s1", "crash");
    const summary = cache.suspendedSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0].sessionId).toBe("s1");
    expect(summary[0].reason).toBe("crash");
    expect(typeof summary[0].suspendedAt).toBe("string");
  });

  it("suspendedSummary() includes recent suspensions after disposal", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy = await cache.get("s1", fp, fakeSecurityPolicy);
    await proxy.dispose();
    await cache.suspend("s1", "crash");
    // After suspend+dispose, entry is gone but should still be in summary
    const summary = cache.suspendedSummary();
    expect(summary.some((s) => s.sessionId === "s1" && s.reason === "crash")).toBe(true);
  });

  it("proxy.dispose() calls releaseLease() not real dispose", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    let createdRuntime!: ReturnType<typeof createMockRuntime>;
    const customCache = new RuntimeCache({
      createRuntime: async () => {
        createdRuntime = createMockRuntime();
        return createdRuntime;
      },
    });
    const proxy = await customCache.get("s1", fp, fakeSecurityPolicy);
    await proxy.dispose();
    expect(createdRuntime.disposeCalls).toBe(0);
    const stats = customCache.stats();
    expect(stats.totalDisposed).toBe(0);
  });

  it("proxy passes through all other methods", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    let createdRuntime!: ReturnType<typeof createMockRuntime>;
    const customCache = new RuntimeCache({
      createRuntime: async () => {
        createdRuntime = createMockRuntime();
        return createdRuntime;
      },
    });
    const proxy = await customCache.get("s1", fp, fakeSecurityPolicy);
    const result = await proxy.handle({ text: "hello", channel: "telegram" });
    expect(result).toEqual({ replyText: "ok", artifactCount: 0, progressCount: 0 });
    await proxy.dispose();
  });

  it("double releaseLease logs warning and is harmless", async () => {
    const warnings: string[] = [];
    const cache = createCache({ logWarning: (msg) => warnings.push(msg) });
    const fp = fakeFingerprint();
    const proxy = await cache.get("s1", fp, fakeSecurityPolicy);
    await proxy.dispose();
    await proxy.dispose();
    expect(warnings.some((w) => w.includes("double-release"))).toBe(true);
    const stats = cache.stats();
    expect(stats.totalDisposed).toBe(0);
  });

  it("borrow/release leak proof: matched pairs", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp, fakeSecurityPolicy);
    const proxy2 = await cache.get("s1", fp, fakeSecurityPolicy);
    await proxy1.dispose();
    await proxy2.dispose();
    const stats = cache.stats();
    expect(stats.activeBorrows).toBe(0);
  });

  it("LRU ordering: oldest evicted first", async () => {
    const cache = createCache({ maxEntries: 2 });
    const fp = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp, fakeSecurityPolicy);
    await proxy1.dispose();
    const proxy2 = await cache.get("s2", fp, fakeSecurityPolicy);
    await proxy2.dispose();
    const proxy3 = await cache.get("s3", fp, fakeSecurityPolicy);
    await proxy3.dispose();
    // Borrow s2 to move it to newest
    const proxy2b = await cache.get("s2", fp, fakeSecurityPolicy);
    await proxy2b.dispose();
    await cache.prune();
    const stats = cache.stats();
    // s1 is oldest and should be evicted
    expect(stats.totalDisposed).toBe(1);
    expect(stats.totalEntries).toBe(2);
  });

  it("get() overwrites old entry on fingerprint mismatch", async () => {
    const cache = createCache();
    const fp1 = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp1, fakeSecurityPolicy);
    const fp2 = fakeFingerprint({ modelId: "gpt-5" });
    const proxy2 = await cache.get("s1", fp2, fakeSecurityPolicy);
    await proxy1.dispose();
    await proxy2.dispose();
    const stats = cache.stats();
    expect(stats.totalCreated).toBe(2);
    expect(stats.totalDisposed).toBe(1);
  });

  it("releaseLease on old proxy after replacement disposes old entry", async () => {
    const cache = createCache();
    const fp1 = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp1, fakeSecurityPolicy);
    const fp2 = fakeFingerprint({ modelId: "gpt-5" });
    const proxy2 = await cache.get("s1", fp2, fakeSecurityPolicy);
    // Dispose old proxy - should dispose old entry, not new
    await proxy1.dispose();
    let stats = cache.stats();
    expect(stats.totalDisposed).toBe(1);
    // New entry still there
    expect(stats.totalEntries).toBe(1);
    await proxy2.dispose();
    stats = cache.stats();
    expect(stats.totalDisposed).toBe(1);
    // New entry remains cached for reuse (not disposePending)
    expect(stats.totalEntries).toBe(1);
  });

  it("suspend while borrowed then new get creates new runtime safely", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp, fakeSecurityPolicy);
    await cache.suspend("s1", "crash");
    const proxy2 = await cache.get("s1", fp, fakeSecurityPolicy);
    const stats = cache.stats();
    expect(stats.totalCreated).toBe(2);
    await proxy1.dispose();
    await proxy2.dispose();
    const finalStats = cache.stats();
    // Old entry disposed on release; new entry stays cached
    expect(finalStats.totalDisposed).toBe(1);
    expect(finalStats.totalEntries).toBe(1);
  });

  it("invalidate while borrowed then new get creates new runtime safely", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp, fakeSecurityPolicy);
    await cache.invalidate("s1");
    const proxy2 = await cache.get("s1", fp, fakeSecurityPolicy);
    const stats = cache.stats();
    expect(stats.totalCreated).toBe(2);
    expect(stats.totalInvalidated).toBe(1);
    await proxy1.dispose();
    await proxy2.dispose();
    const finalStats = cache.stats();
    // Old entry disposed on release; new entry stays cached
    expect(finalStats.totalDisposed).toBe(1);
    expect(finalStats.totalEntries).toBe(1);
  });

  it("releaseLease matches on entryId not just sessionId", async () => {
    const cache = createCache();
    const fp1 = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp1, fakeSecurityPolicy);
    const fp2 = fakeFingerprint({ modelId: "gpt-5" });
    await cache.get("s1", fp2, fakeSecurityPolicy);
    // proxy1 has old entryId; disposing it should not affect new entry
    await proxy1.dispose();
    const stats = cache.stats();
    expect(stats.totalDisposed).toBe(1);
    expect(stats.totalEntries).toBe(1);
  });

  it("prune skips borrowed entries during TTL phase", async () => {
    const cache = createCache({ idleTtlMs: 10 });
    const fp = fakeFingerprint();
    const proxy = await cache.get("s1", fp, fakeSecurityPolicy);
    await new Promise((r) => setTimeout(r, 20));
    await cache.prune();
    const stats = cache.stats();
    expect(stats.totalDisposed).toBe(0);
    await proxy.dispose();
  });

  it("prune skips borrowed entries during LRU phase", async () => {
    const cache = createCache({ maxEntries: 1 });
    const fp = fakeFingerprint();
    await cache.get("s1", fp, fakeSecurityPolicy);
    const proxy2 = await cache.get("s2", fp, fakeSecurityPolicy);
    await cache.prune();
    const stats = cache.stats();
    // s1 is borrowed, so it should not be evicted
    expect(stats.totalDisposed).toBe(0);
    expect(stats.totalEntries).toBe(2);
    await proxy2.dispose();
  });

  it("safeDispose catches and logs timeout", async () => {
    const warnings: string[] = [];
    const hangingRuntime = createMockRuntime({
      dispose: async () => {
        await new Promise(() => {}); // never resolves
      },
    });
    await safeDispose(hangingRuntime, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes("timed out"))).toBe(true);
  }, 15_000);

  it("safeDispose catches and logs rejection", async () => {
    const warnings: string[] = [];
    const throwingRuntime = createMockRuntime({
      dispose: async () => {
        throw new Error("dispose failed");
      },
    });
    await safeDispose(throwingRuntime, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes("dispose failed"))).toBe(true);
  });

  it("safeDispose clears timer on fast disposal", async () => {
    const warnings: string[] = [];
    const fastRuntime = createMockRuntime();
    await safeDispose(fastRuntime, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
  });

  it("createCachedRuntimeProxy forwards sessionId and sessionDb", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    let createdRuntime!: ReturnType<typeof createMockRuntime>;
    const customCache = new RuntimeCache({
      createRuntime: async () => {
        createdRuntime = createMockRuntime();
        return createdRuntime;
      },
    });
    const proxy = await customCache.get("s1", fp, fakeSecurityPolicy);
    expect(proxy.sessionId).toBe(createdRuntime.sessionId);
    expect(proxy.sessionDb).toBe(createdRuntime.sessionDb);
    await proxy.dispose();
  });

  it("suspendedSummary deduplicates live and recent entries", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy = await cache.get("s1", fp, fakeSecurityPolicy);
    await cache.suspend("s1", "crash");
    await proxy.dispose();
    // s1 is now disposed but should appear once in summary
    const summary = cache.suspendedSummary();
    const s1Entries = summary.filter((s) => s.sessionId === "s1");
    expect(s1Entries).toHaveLength(1);
  });

  it("disposeAll handles pending entries already idle", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy = await cache.get("s1", fp, fakeSecurityPolicy);
    await cache.suspend("s1", "crash");
    await proxy.dispose();
    // Entry is now disposed and removed
    await cache.disposeAll();
    const stats = cache.stats();
    expect(stats.totalDisposed).toBe(1);
    expect(stats.totalEntries).toBe(0);
  });

  it("stats counts activeBorrows correctly", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    await cache.get("s1", fp, fakeSecurityPolicy);
    await cache.get("s1", fp, fakeSecurityPolicy);
    const stats = cache.stats();
    expect(stats.activeBorrows).toBe(2);
  });

  it("prune respects maxEntries with multiple evictions", async () => {
    const cache = createCache({ maxEntries: 1 });
    const fp = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp, fakeSecurityPolicy);
    await proxy1.dispose();
    const proxy2 = await cache.get("s2", fp, fakeSecurityPolicy);
    await proxy2.dispose();
    const proxy3 = await cache.get("s3", fp, fakeSecurityPolicy);
    await proxy3.dispose();
    await cache.prune();
    const stats = cache.stats();
    expect(stats.totalDisposed).toBe(2);
    expect(stats.totalEntries).toBe(1);
  });

  it("get() on disposedPending active entry creates new and retires old", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp, fakeSecurityPolicy);
    await cache.suspend("s1", "crash");
    // s1 is now suspended and disposePending but still borrowed
    const proxy2 = await cache.get("s1", fp, fakeSecurityPolicy);
    const stats = cache.stats();
    expect(stats.totalCreated).toBe(2);
    await proxy1.dispose();
    await proxy2.dispose();
    const finalStats = cache.stats();
    // Old entry disposed on release; new entry stays cached
    expect(finalStats.totalDisposed).toBe(1);
    expect(finalStats.totalEntries).toBe(1);
  });

  it("releaseLease rejects pending entry with mismatched sessionId", async () => {
    const warnings: string[] = [];
    const cache = createCache({ logWarning: (msg) => warnings.push(msg) });
    const fp = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp, fakeSecurityPolicy);
    const fp2 = fakeFingerprint({ modelId: "gpt-5" });
    const proxy2 = await cache.get("s1", fp2, fakeSecurityPolicy);
    // proxy1 belongs to session s1. Try releasing with wrong session s2.
    // We need the old entryId to call releaseLease directly.
    // The proxy1.dispose() would call releaseLease("s1", oldEntryId).
    // Instead, extract the entryId from stats or reach into internals.
    // We can infer: the first entry was created, then replaced.
    // The old entry is in pendingEntries. Let's call releaseLease with wrong session.
    await cache.releaseLease("s2", "s1#1");
    expect(warnings.some((w) => w.includes("session mismatch"))).toBe(true);
    // Old entry should still be in pending with borrowCount 1
    await proxy1.dispose(); // now correct session
    const stats = cache.stats();
    expect(stats.totalDisposed).toBe(1);
    await proxy2.dispose();
  });

  it("stats includes pending borrowed entries in activeBorrows", async () => {
    const cache = createCache();
    const fp = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp, fakeSecurityPolicy);
    const fp2 = fakeFingerprint({ modelId: "gpt-5" });
    const proxy2 = await cache.get("s1", fp2, fakeSecurityPolicy);
    // At this point:
    // - old entry for s1 is in pending (borrowCount 1, from proxy1)
    // - new entry for s1 is in active (borrowCount 1, from proxy2)
    const stats = cache.stats();
    expect(stats.activeBorrows).toBe(2);
    expect(stats.totalEntries).toBe(2);
    await proxy1.dispose();
    await proxy2.dispose();
    const finalStats = cache.stats();
    expect(finalStats.activeBorrows).toBe(0);
    expect(finalStats.totalDisposed).toBe(1);
  });

  it("get() preserves old entry when createRuntime throws on fingerprint mismatch", async () => {
    let callCount = 0;
    const cache = createCache({
      createRuntime: async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error("factory failure");
        }
        return createMockRuntime();
      },
    });
    const fp1 = fakeFingerprint();
    const proxy1 = await cache.get("s1", fp1, fakeSecurityPolicy);
    await proxy1.dispose();

    const fp2 = fakeFingerprint({ modelId: "gpt-5" });
    await expect(cache.get("s1", fp2, fakeSecurityPolicy)).rejects.toThrow("factory failure");

    // Old entry should still be active and reusable
    const proxy1b = await cache.get("s1", fp1, fakeSecurityPolicy);
    const stats = cache.stats();
    expect(stats.totalCreated).toBe(1);
    expect(stats.totalReused).toBe(1);
    expect(stats.totalDisposed).toBe(0);
    await proxy1b.dispose();
  });

  it("cloneFingerprint normalizes undefined fields consistently with equality", async () => {
    const cache = createCache();
    // Create a fingerprint with an undefined optional field
    const fpWithUndefined = fakeFingerprint({ auxiliaryProvidersHash: undefined });
    const fpWithoutField = fakeFingerprint();
    delete (fpWithoutField as Record<string, unknown>).auxiliaryProvidersHash;

    // Both should produce the same cache behavior because clone + equality
    // both use JSON serialization which drops undefined.
    const proxy1 = await cache.get("s1", fpWithUndefined, fakeSecurityPolicy);
    await proxy1.dispose();
    const proxy2 = await cache.get("s1", fpWithoutField, fakeSecurityPolicy);
    await proxy2.dispose();
    const stats = cache.stats();
    expect(stats.totalCreated).toBe(1);
    expect(stats.totalReused).toBe(1);
  });
});
