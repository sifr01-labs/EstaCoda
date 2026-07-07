import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMORY_CONFIG } from "../config/memory-config.js";
import type { ExternalMemoryProvider } from "../contracts/memory.js";
import type { ExtractedFact } from "./extracted-fact.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { MemoryCurationStore, memoryCurationStorePath } from "./memory-curation-store.js";
import { MemoryCurationService } from "./memory-curation-service.js";
import { MemoryMutationService } from "./memory-mutation-service.js";
import { MemoryPersistenceService } from "./memory-persistence-service.js";
import { MemoryStore } from "./memory-store.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-memory-curation-service-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("MemoryCurationService", () => {
  it("auto-applies explicit low-risk facts and records an inspectable audit trail", async () => {
    const root = await makeTempDir();
    const db = new InMemorySessionDB();
    await db.createSession({ id: "session-1", profileId: "default" });
    await db.appendMessage({
      id: "m1",
      sessionId: "session-1",
      role: "user",
      content: "Please remember that I prefer pnpm for this repo."
    });
    await db.appendMessage({
      id: "m2",
      sessionId: "session-1",
      role: "agent",
      content: "Got it."
    });
    const store = new MemoryStore();
    const curationStore = new MemoryCurationStore({
      path: memoryCurationStorePath(root),
      id: () => "record-1",
      now: () => new Date("2026-05-20T00:00:00.000Z")
    });
    const service = new MemoryCurationService({
      config: { ...DEFAULT_MEMORY_CONFIG.curation, checkpointEveryTurns: 1 },
      profileId: "default",
      sessionId: "session-1",
      sessionDb: db,
      memoryStore: store,
      curationStore,
      extractorOptions: {},
      persistence: new MemoryPersistenceService(),
      persistencePaths: {
        "USER.md": join(root, "USER.md"),
        "MEMORY.md": join(root, "MEMORY.md")
      },
      extractFacts: async () => ({
        facts: [fact()],
        diagnostics: diagnostics(1)
      })
    });
    const events: unknown[] = [];

    const result = await service.observeCompletedTurn({
      onEvent: async (event) => {
        events.push(event);
      }
    });

    expect(result).toMatchObject({
      status: "auto-applied",
      reviewedMessageCount: 2,
      extractedFactCount: 1,
      candidateCount: 1,
      autoAppliedCount: 1
    });
    expect(store.read("USER.md")).toBe("- User prefers pnpm for this repo.");
    expect(await readFile(join(root, "USER.md"), "utf8")).toBe("- User prefers pnpm for this repo.");
    expect(await curationStore.latestForSession("session-1")).toMatchObject({
      id: "record-1",
      trigger: "turn-count",
      status: "auto-applied",
      sourceMessageCount: 2,
      extractedFactIds: ["fact-1"],
      operations: [
        expect.objectContaining({
          file: "USER.md",
          kind: "append",
          contentHash: expect.any(String)
        })
      ]
    });
    expect(await db.listEvents("session-1")).toContainEqual(expect.objectContaining({
      kind: "memory-curation",
      status: "auto-applied",
      autoAppliedCount: 1,
      warningCount: 0
    }));
    expect(events).toEqual([
      expect.objectContaining({
        kind: "memory-curation",
        status: "auto-applied",
        autoAppliedCount: 1
      })
    ]);
  });

  it("waits for the configured turn-count checkpoint", async () => {
    const root = await makeTempDir();
    const db = new InMemorySessionDB();
    await db.createSession({ id: "session-1", profileId: "default" });
    await db.appendMessage({ id: "m1", sessionId: "session-1", role: "user", content: "Remember I use pnpm." });
    const extractFacts = vi.fn(async () => ({
      facts: [fact({ evidence: [{ messageId: "m1", exactSpan: "use pnpm" }] })],
      diagnostics: diagnostics(1)
    }));
    const service = new MemoryCurationService({
      config: { ...DEFAULT_MEMORY_CONFIG.curation, checkpointEveryTurns: 2 },
      profileId: "default",
      sessionId: "session-1",
      sessionDb: db,
      memoryStore: new MemoryStore(),
      curationStore: new MemoryCurationStore({ path: memoryCurationStorePath(root) }),
      extractorOptions: {},
      extractFacts
    });

    const skipped = await service.observeCompletedTurn();
    await service.observeCompletedTurn();

    expect(skipped.status).toBe("skipped");
    expect(extractFacts).toHaveBeenCalledTimes(1);
  });

  it("queues review-mode candidates without mutating memory", async () => {
    const root = await makeTempDir();
    const db = new InMemorySessionDB();
    await db.createSession({ id: "session-1", profileId: "default" });
    await db.appendMessage({
      id: "m1",
      sessionId: "session-1",
      role: "user",
      content: "Please remember that I prefer pnpm for this repo."
    });
    const store = new MemoryStore();
    const service = new MemoryCurationService({
      config: { ...DEFAULT_MEMORY_CONFIG.curation, mode: "review" },
      profileId: "default",
      sessionId: "session-1",
      sessionDb: db,
      memoryStore: store,
      curationStore: new MemoryCurationStore({ path: memoryCurationStorePath(root) }),
      extractorOptions: {},
      extractFacts: async () => ({
        facts: [fact()],
        diagnostics: diagnostics(1)
      })
    });

    const result = await service.checkpoint({ trigger: "manual" });

    expect(result.status).toBe("pending-review");
    expect(result.pendingReviewCount).toBe(1);
    expect(store.read("USER.md")).toBe("");
  });

  it("auto-applies through the shared mutation path including external mirror warnings", async () => {
    const root = await makeTempDir();
    const db = new InMemorySessionDB();
    await db.createSession({ id: "session-1", profileId: "default" });
    await db.appendMessage({
      id: "m1",
      sessionId: "session-1",
      role: "user",
      content: "Please remember that I prefer pnpm for this repo."
    });
    const store = new MemoryStore();
    const provider: ExternalMemoryProvider = {
      id: "fake",
      mirrorMemoryWrite: vi.fn(async () => {
        throw new Error("api_key=secretsecretsecretsecretsecret");
      })
    };
    const service = new MemoryCurationService({
      config: DEFAULT_MEMORY_CONFIG.curation,
      profileId: "default",
      sessionId: "session-1",
      sessionDb: db,
      memoryStore: store,
      curationStore: new MemoryCurationStore({ path: memoryCurationStorePath(root) }),
      extractorOptions: {},
      memoryMutationService: new MemoryMutationService({
        memoryStore: store,
        profileId: "default",
        sessionId: "session-1",
        sessionDb: db,
        externalMemoryProviders: [provider],
        externalMemory: {
          enabled: true,
          timeoutMs: 750,
          maxResults: 3,
          maxChars: 2500,
          mirrorWrites: true
        }
      }),
      extractFacts: async () => ({
        facts: [fact()],
        diagnostics: diagnostics(1)
      })
    });

    const result = await service.checkpoint({ trigger: "manual" });

    expect(result.status).toBe("auto-applied");
    expect(provider.mirrorMemoryWrite).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "default",
      sessionId: "session-1",
      operation: expect.objectContaining({
        kind: "append",
        file: "USER.md"
      })
    }));
    expect(result.warnings).toContain("external memory provider fake mirror write failed: api_key=[REDACTED]");
    expect(await db.listEvents("session-1")).toContainEqual(expect.objectContaining({
      kind: "external-memory-mirror-write",
      mirrorAttempted: true,
      mirrorSucceeded: false,
      warningCount: 1
    }));
  });

  it("advances the cursor when no durable facts are extracted", async () => {
    const root = await makeTempDir();
    const db = new InMemorySessionDB();
    await db.createSession({ id: "session-1", profileId: "default" });
    await db.appendMessage({ sessionId: "session-1", role: "user", content: "One-off task." });
    const extractFacts = vi.fn(async () => ({
      facts: [],
      diagnostics: diagnostics(0)
    }));
    const service = new MemoryCurationService({
      config: DEFAULT_MEMORY_CONFIG.curation,
      profileId: "default",
      sessionId: "session-1",
      sessionDb: db,
      memoryStore: new MemoryStore(),
      curationStore: new MemoryCurationStore({ path: memoryCurationStorePath(root) }),
      extractorOptions: {},
      extractFacts
    });

    await service.checkpoint({ trigger: "manual" });
    const second = await service.checkpoint({ trigger: "manual" });

    expect(second.status).toBe("skipped");
    expect(second.warnings).toContain("no new session messages to review");
    expect(extractFacts).toHaveBeenCalledTimes(1);
  });

  it("skips runtime dispose audits until enough new messages and time have passed", async () => {
    const root = await makeTempDir();
    const db = new InMemorySessionDB();
    await db.createSession({ id: "session-1", profileId: "default" });
    await db.appendMessage({ sessionId: "session-1", role: "user", content: "Remember I use pnpm." });
    const service = new MemoryCurationService({
      config: {
        ...DEFAULT_MEMORY_CONFIG.curation,
        runtimeDisposeMinNewMessages: 2,
        runtimeDisposeMinIntervalMinutes: 60
      },
      profileId: "default",
      sessionId: "session-1",
      sessionDb: db,
      memoryStore: new MemoryStore(),
      curationStore: new MemoryCurationStore({
        path: memoryCurationStorePath(root),
        now: () => new Date("2026-05-20T00:00:00.000Z")
      }),
      extractorOptions: {},
      now: () => new Date("2026-05-20T00:30:00.000Z"),
      extractFacts: async () => ({
        facts: [],
        diagnostics: diagnostics(0)
      })
    });

    const first = await service.checkpoint({ trigger: "runtime-dispose", minNewMessages: 2 });
    await db.appendMessage({ sessionId: "session-1", role: "agent", content: "Done." });
    await service.checkpoint({ trigger: "manual" });
    await db.appendMessage({ sessionId: "session-1", role: "user", content: "Another task." });
    const second = await service.checkpoint({ trigger: "runtime-dispose", minNewMessages: 1 });

    expect(first.status).toBe("skipped");
    expect(first.warnings).toContain("minimum new-message threshold not reached");
    expect(second.status).toBe("skipped");
    expect(second.warnings).toContain("runtime dispose audit interval not reached");
  });
});

function fact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    id: "fact-1",
    statement: "User prefers pnpm for this repo",
    category: "preference",
    evidence: [{ messageId: "m1", exactSpan: "I prefer pnpm" }],
    explicitness: "explicit",
    sensitivity: "none",
    confidence: 0.7,
    ...overrides
  };
}

function diagnostics(count: number) {
  return {
    ok: true,
    routeSource: "semantic-compression" as const,
    fallbackUsed: false,
    rawFactCount: count,
    acceptedFactCount: count,
    rejectedFactCount: 0,
    warnings: []
  };
}
