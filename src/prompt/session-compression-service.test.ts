import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSessionCompressionConfig } from "../config/runtime-config.js";
import type { ProviderResponse, ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { ReplacementSessionMessage, SessionDB, SessionEvent, SessionMessage } from "../contracts/session.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { SessionCompressionLock } from "../session/session-compression-lock.js";
import { reconstructSessionCompressionState } from "../session/session-compression-state.js";
import { loadSessionContextWindowUsage } from "../session/session-context-window-usage.js";
import { SUMMARY_FORMAT_VERSION, SUMMARY_PREFIX } from "./semantic-compressor.js";
import { SessionCompressionService } from "./session-compression-service.js";
import { estimateMessageTokensRough } from "./token-estimator.js";

describe("SessionCompressionService", () => {
  it("compactIfNeeded no-ops below threshold", async () => {
    const { db, sessionId } = await sessionDbWithMessages(8);
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 100_000,
        threshold: 0.95
      })
    });

    const result = await service.compactIfNeeded({ profileId: "profile", sessionId });

    expect(result.didCompress).toBe(false);
    expect(result.originalSessionId).toBe(sessionId);
    expect(result.activeSessionId).toBe(sessionId);
    expect(result.rotated).toBe(false);
    expect(result.replacementSessionId).toBeUndefined();
    expect(result.diagnostics.reason).toBe("below-threshold");
    expect(await db.listMessages(sessionId)).toHaveLength(8);
  });

  it("compactIfNeeded compresses above threshold and writes state events", async () => {
    const { db, sessionId } = await sessionDbWithMessages(8);
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 1,
        protectLastN: 2,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness("Key Decisions\n- ship it"),
      now: () => new Date("2030-01-02T00:00:00.000Z"),
      id: () => "summary-id"
    });

    const result = await service.compactIfNeeded({ profileId: "profile", sessionId });
    const events = await db.listEvents(sessionId);

    expect(result.didCompress).toBe(true);
    expect(result.originalSessionId).toBe(sessionId);
    expect(result.activeSessionId).toBe(sessionId);
    expect(result.rotated).toBe(false);
    expect(result.replacementSessionId).toBeUndefined();
    expect(result.userFacingMessage).toContain("Session history compacted");
    const summaryMessage = result.messages.find((message) => message.metadata?.semanticCompression === true);
    expect(summaryMessage).toBeDefined();
    const expectedSummaryTokens = estimateMessageTokensRough({
      role: summaryMessage!.role,
      content: summaryMessage!.content,
      metadata: summaryMessage!.metadata
    });
    const compressedEvent = events.find((event) => event.kind === "session-history-compressed");
    expect(compressedEvent).toEqual(expect.objectContaining({
      kind: "session-history-compressed",
      summaryFormatVersion: SUMMARY_FORMAT_VERSION,
      fallbackUsed: false,
      model: "compression-model",
      modelUsed: "compression-model",
      protectedFirstN: 1,
      protectedLastN: 2,
      summaryEstimatedTokens: expectedSummaryTokens,
      summaryLengthTokens: expectedSummaryTokens,
      sourceMessageCount: 8,
      protectedMessageCount: result.diagnostics.protectedMessageCount,
      droppedMessageCount: 4,
      estimatedSavingsTokens: expect.any(Number),
      source: expect.objectContaining({
        messageCount: expect.any(Number),
        estimatedTokens: expect.any(Number)
      }),
      protectedSpans: expect.any(Array)
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "session-compression-state",
      state: expect.objectContaining({
        status: "compressed",
        compressionCount: 1,
        lastCompressedAt: "2030-01-02T00:00:00.000Z",
        previousSummary: expect.stringContaining(SUMMARY_PREFIX),
        lastCompressedThroughMessageId: "session-a-m5",
        lastPromptTokensEstimated: result.diagnostics.preTokens,
        summaryFormatVersion: SUMMARY_FORMAT_VERSION,
        summaryEstimatedTokens: expectedSummaryTokens,
        summaryLengthTokens: expectedSummaryTokens,
        sourceMessageCount: 8,
        protectedMessageCount: result.diagnostics.protectedMessageCount,
        droppedMessageCount: 4,
        fallbackUsed: false,
        modelUsed: "compression-model",
        ineffectiveCompressionCount: 0,
        recentSavingsRatios: expect.any(Array)
      })
    }));
    expect(expectedSummaryTokens).toBeLessThan(result.diagnostics.postTokens);
  });

  it("records supplied prompt token estimates and actual provider input tokens", async () => {
    const { db, sessionId } = await sessionDbWithMessages(8);
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness("summary")
    });

    const result = await service.compactIfNeeded({
      profileId: "profile",
      sessionId,
      lastPromptTokensEstimated: 4_321,
      lastActualPromptTokens: 4_444
    });
    const state = reconstructSessionCompressionState(await db.listEvents(sessionId));

    expect(result.didCompress).toBe(true);
    expect(state.lastPromptTokensEstimated).toBe(4_321);
    expect(state.lastActualPromptTokens).toBe(4_444);
  });

  it("compactNow bypasses threshold", async () => {
    const { db, sessionId } = await sessionDbWithMessages(4);
    let observedPrompt = "";
    const harness = auxiliaryHarness("forced summary");
    harness.providerExecutor.complete = vi.fn(async (request?: unknown): Promise<any> => {
      observedPrompt = String((request as { messages?: Array<{ content?: unknown }> }).messages?.[1]?.content ?? "");
      return providerResult("forced summary");
    });
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: false,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 100_000,
        threshold: 0.95
      }),
      ...harness
    });

    const result = await service.compactNow({ profileId: "profile", sessionId, focusTopic: "manual focus" });
    const events = await db.listEvents(sessionId);

    expect(result.didCompress).toBe(true);
    expect(result.diagnostics.reason).toBe("forced");
    expect(observedPrompt).toContain("Manual focus topic: manual focus");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "session-history-compressed",
      trigger: "manual"
    }));
  });

  it("compactNow uses the same deterministic fallback behavior when summarization is unavailable", async () => {
    const { db, sessionId } = await sessionDbWithMessages(4);
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: false,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 100_000,
        threshold: 0.95
      })
    });

    const result = await service.compactNow({ profileId: "profile", sessionId, focusTopic: "manual focus" });
    const state = reconstructSessionCompressionState(await db.listEvents(sessionId));

    expect(result.didCompress).toBe(true);
    expect(result.diagnostics.reason).toBe("forced");
    expect(result.diagnostics.fallbackUsed).toBe(true);
    expect(result.diagnostics.fallbackReason).toBe("deterministic-fallback");
    expect(state.fallbackReason).toBe("deterministic-fallback");
  });

  it("records explicit hygiene trigger for gateway hygiene compression", async () => {
    const { db, sessionId } = await sessionDbWithMessages(8);
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness("hygiene summary")
    });

    const result = await service.compactIfNeeded({ profileId: "profile", sessionId, trigger: "hygiene" });
    const events = await db.listEvents(sessionId);

    expect(result.didCompress).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "session-history-compressed",
      trigger: "hygiene"
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "session-compression-state",
      state: expect.objectContaining({ trigger: "hygiene" })
    }));
  });

  it("compactNow preserves the parent transcript by rotating to a compacted child session", async () => {
    const { db, sessionId } = await sessionDbWithMessages(8);
    const originalMessages = await db.listMessages(sessionId);
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: false,
        protectFirstN: 1,
        protectLastN: 2,
        summaryModelContextLength: 100_000,
        threshold: 0.95
      }),
      ...auxiliaryHarness("preserved summary"),
      now: () => new Date("2030-01-02T00:00:00.000Z"),
      id: () => "summary-id"
    });

    const result = await service.compactNow({
      profileId: "profile",
      sessionId,
      focusTopic: "manual focus",
      preserveTranscript: true
    });
    const parent = await db.getSession(sessionId);
    const child = await db.getSession(result.activeSessionId);
    const childEvents = await db.listEvents(result.activeSessionId);
    const parentEvents = await db.listEvents(sessionId);

    expect(result.didCompress).toBe(true);
    expect(result.originalSessionId).toBe(sessionId);
    expect(result.activeSessionId).not.toBe(sessionId);
    expect(result.replacementSessionId).toBe(result.activeSessionId);
    expect(result.rotated).toBe(true);
    expect(await db.listMessages(sessionId)).toEqual(originalMessages);
    expect((await db.listMessages(result.activeSessionId)).map((message) => message.id)).toEqual(
      result.messages.map((message) => message.id)
    );
    expect(child).toEqual(expect.objectContaining({
      parentSessionId: sessionId,
      metadata: expect.objectContaining({
        compactedFromSessionId: sessionId,
        compactionTrigger: "manual",
        compactedAt: "2030-01-02T00:00:00.000Z"
      })
    }));
    expect(parent).toEqual(expect.objectContaining({
      endedAt: expect.any(String),
      endReason: "compression"
    }));
    expect(childEvents).toContainEqual(expect.objectContaining({
      kind: "session-history-compressed",
      trigger: "manual"
    }));
    expect(childEvents).toContainEqual(expect.objectContaining({
      kind: "session-compression-state",
      state: expect.objectContaining({ trigger: "manual" })
    }));
    expect(parentEvents).toContainEqual(expect.objectContaining({
      kind: "session-compaction-forked",
      childSessionId: result.activeSessionId,
      trigger: "manual"
    }));
  });

  it("compactIfNeeded can rotate hygiene compaction to a compacted child session", async () => {
    const { db, sessionId } = await sessionDbWithMessages(8);
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 1,
        protectLastN: 2,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness("hygiene summary")
    });

    const result = await service.compactIfNeeded({
      profileId: "profile",
      sessionId,
      trigger: "hygiene",
      preserveTranscript: true
    });

    expect(result.didCompress).toBe(true);
    expect(result.rotated).toBe(true);
    await expect(db.getSession(result.activeSessionId)).resolves.toEqual(expect.objectContaining({
      parentSessionId: sessionId
    }));
    await expect(db.getSession(sessionId)).resolves.toEqual(expect.objectContaining({
      endReason: "compression"
    }));
  });

  it("does not create a child session when preserveTranscript compaction no-ops", async () => {
    const { db, sessionId } = await sessionDbWithMessages(4);
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 100_000,
        threshold: 0.95
      })
    });

    const result = await service.compactIfNeeded({ profileId: "profile", sessionId, preserveTranscript: true });

    expect(result.didCompress).toBe(false);
    expect(result.rotated).toBe(false);
    expect(await db.listSessions("profile")).toHaveLength(1);
    await expect(db.getSession(sessionId)).resolves.not.toEqual(expect.objectContaining({
      endReason: "compression"
    }));
  });

  it("does not mark the parent ended when child transcript rewrite fails", async () => {
    const base = await sessionDbWithMessages(8);
    const originalMessages = await base.db.listMessages(base.sessionId);
    const failingDb = forwardingSessionDb(base.db, {
      rewriteTranscript: async () => {
        throw new Error("child rewrite down");
      }
    });
    const service = new SessionCompressionService({
      sessionDb: failingDb,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness("summary")
    });

    await expect(service.compactIfNeeded({
      profileId: "profile",
      sessionId: base.sessionId,
      preserveTranscript: true
    })).rejects.toThrow("child rewrite down");
    await expect(base.db.getSession(base.sessionId)).resolves.not.toEqual(expect.objectContaining({
      endReason: "compression"
    }));
    expect(await base.db.listMessages(base.sessionId)).toEqual(originalMessages);
  });

  it("keeps child compaction successful when audit event writes fail", async () => {
    const base = await sessionDbWithMessages(8);
    const throwingDb = forwardingSessionDb(base.db, {
      appendEvent: async () => {
        throw new Error("event sink down");
      }
    });
    const service = new SessionCompressionService({
      sessionDb: throwingDb,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness("summary")
    });

    const result = await service.compactIfNeeded({
      profileId: "profile",
      sessionId: base.sessionId,
      preserveTranscript: true
    });

    expect(result.didCompress).toBe(true);
    expect(result.rotated).toBe(true);
    await expect(base.db.getSession(base.sessionId)).resolves.toEqual(expect.objectContaining({
      endReason: "compression"
    }));
    expect(await base.db.listMessages(result.activeSessionId)).toHaveLength(result.messages.length);
    await expect(base.db.listEvents(result.activeSessionId)).resolves.toContainEqual({
      kind: "context-window-usage-invalidated",
      reason: "compaction"
    });
    expect(result.diagnostics.eventWarnings).toEqual([
      "session compression event write failed: event sink down",
      "session compression event write failed: event sink down",
      "session compaction fork event write failed: event sink down"
    ]);
  });

  it("leaves the parent transcript searchable in SQLite after preserved compaction", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "estacoda-preserve-compaction-"));
    const db = new SQLiteSessionDB({
      path: join(tmpDir, "sessions.sqlite"),
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      id: () => crypto.randomUUID()
    });
    try {
      const session = await db.createSession({ id: "sqlite-parent", profileId: "profile" });
      for (let index = 0; index < 8; index += 1) {
        await db.appendMessage({
          id: `sqlite-message-${index}`,
          sessionId: session.id,
          role: index % 2 === 0 ? "user" : "agent",
          content: `uniqueparentsearchtoken message ${index} ${"x".repeat(120)}`
        });
      }
      const service = new SessionCompressionService({
        sessionDb: db,
        config: normalizeSessionCompressionConfig({
          enabled: true,
          experimental: true,
          protectFirstN: 0,
          protectLastN: 1,
          summaryModelContextLength: 50,
          threshold: 0.10
        }),
        ...auxiliaryHarness("sqlite summary")
      });

      const result = await service.compactIfNeeded({
        profileId: "profile",
        sessionId: session.id,
        preserveTranscript: true
      });
      const matches = await db.search("uniqueparentsearchtoken", { profileId: "profile", limit: 20 });

      expect(result.rotated).toBe(true);
      expect(matches.some((match) => match.session.id === session.id)).toBe(true);
    } finally {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("hydrates latest state event before compression", async () => {
    const { db, sessionId } = await sessionDbWithMessages(8);
    await db.appendEvent(sessionId, {
      kind: "session-compression-state",
      state: {
        status: "compressed",
        compressionCount: 1,
        protectedFirstN: 0,
        protectedLastN: 0,
        protectedSpans: [],
        ineffectiveCompressionCount: 2,
        fallbackUsed: false,
        warnings: []
      }
    });
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        summaryModelContextLength: 50,
        threshold: 0.10
      })
    });

    const result = await service.compactIfNeeded({ profileId: "profile", sessionId });

    expect(result.didCompress).toBe(false);
    expect(result.diagnostics.reason).toBe("anti-thrashing");
    expect(result.diagnostics.warnings).toContain("last 2 compressions saved <10% each; skipped to avoid thrashing");
  });

  it("persists ineffective compression count after low-savings compression", async () => {
    const { db, sessionId } = await sessionDbWithMessages(8);
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness("low savings summary ".repeat(2_000))
    });

    const result = await service.compactIfNeeded({ profileId: "profile", sessionId });
    const state = reconstructSessionCompressionState(await db.listEvents(sessionId));

    expect(result.didCompress).toBe(true);
    expect(result.diagnostics.lastCompressionSavingsPct).toBeLessThan(10);
    expect(result.diagnostics.ineffectiveCompressionCount).toBe(1);
    expect(state.ineffectiveCompressionCount).toBe(1);
    expect(state.lastCompressionSavingsPct).toBe(result.diagnostics.lastCompressionSavingsPct);
    expect(state.recentSavingsRatios).toEqual([result.diagnostics.estimatedSavingsRatio]);
  });

  it("reaches skip state after two consecutive low-savings compressions", async () => {
    const { db, sessionId } = await sessionDbWithMessages(8);
    await db.appendEvent(sessionId, {
      kind: "session-compression-state",
      state: {
        status: "compressed",
        compressionCount: 1,
        protectedFirstN: 0,
        protectedLastN: 0,
        protectedSpans: [],
        lastCompressionSavingsPct: 8,
        ineffectiveCompressionCount: 1,
        recentSavingsRatios: [0.08],
        fallbackUsed: false,
        warnings: []
      }
    });
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness("another low savings summary ".repeat(2_000))
    });

    const result = await service.compactNow({ profileId: "profile", sessionId });
    const state = reconstructSessionCompressionState(await db.listEvents(sessionId));

    expect(result.didCompress).toBe(true);
    expect(state.compressionCount).toBe(2);
    expect(result.diagnostics.ineffectiveCompressionCount).toBe(2);
    expect(state.ineffectiveCompressionCount).toBe(2);
    expect(state.recentSavingsRatios).toHaveLength(2);
    expect(state.recentSavingsRatios?.every((ratio) => ratio < 0.10)).toBe(true);
  });

  it("resets ineffective compression count after high-savings compression", async () => {
    const { db, sessionId } = await sessionDbWithMessages(8);
    await db.appendEvent(sessionId, {
      kind: "session-compression-state",
      state: {
        status: "compressed",
        protectedFirstN: 0,
        protectedLastN: 0,
        protectedSpans: [],
        lastCompressionSavingsPct: 8,
        ineffectiveCompressionCount: 1,
        recentSavingsRatios: [0.08],
        fallbackUsed: false,
        warnings: []
      }
    });
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness("short summary")
    });

    const result = await service.compactNow({ profileId: "profile", sessionId });
    const state = reconstructSessionCompressionState(await db.listEvents(sessionId));

    expect(result.didCompress).toBe(true);
    expect(result.diagnostics.lastCompressionSavingsPct).toBeGreaterThanOrEqual(10);
    expect(result.diagnostics.ineffectiveCompressionCount).toBe(0);
    expect(state.ineffectiveCompressionCount).toBe(0);
  });

  it("manual compaction bypasses anti-thrashing skip state", async () => {
    const { db, sessionId } = await sessionDbWithMessages(8);
    await db.appendEvent(sessionId, {
      kind: "session-compression-state",
      state: {
        status: "compressed",
        protectedFirstN: 0,
        protectedLastN: 0,
        protectedSpans: [],
        ineffectiveCompressionCount: 2,
        fallbackUsed: false,
        warnings: []
      }
    });
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness("manual summary")
    });

    await expect(service.compactNow({ profileId: "profile", sessionId })).resolves.toMatchObject({
      didCompress: true,
      diagnostics: expect.objectContaining({ reason: "forced" })
    });
  });

  it("persists redacted and bounded previous summary observability", async () => {
    const { db, sessionId } = await sessionDbWithMessages(8);
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness(`OPENAI_API_KEY=super-secret-value ${"long summary ".repeat(1_200)}`)
    });

    const result = await service.compactIfNeeded({ profileId: "profile", sessionId });
    const state = reconstructSessionCompressionState(await db.listEvents(sessionId));

    expect(result.didCompress).toBe(true);
    expect(state.previousSummary).toBeDefined();
    expect(state.previousSummary).not.toContain("super-secret-value");
    expect(state.previousSummary).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(state.previousSummary!.length).toBeLessThanOrEqual(10_000);
  });

  it("event write failure is non-fatal after message replacement", async () => {
    const base = await sessionDbWithMessages(8);
    await base.db.appendEvent(base.sessionId, {
      kind: "context-window-usage",
      usedTokens: 90_000,
      totalTokens: 128_000,
      provider: "openai",
      model: "gpt-test"
    });
    const throwingDb = forwardingSessionDb(base.db, {
      appendEvent: async () => {
        throw new Error("event sink down");
      }
    });
    const service = new SessionCompressionService({
      sessionDb: throwingDb,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness("summary")
    });

    const result = await service.compactIfNeeded({ profileId: "profile", sessionId: base.sessionId });

    expect(result.didCompress).toBe(true);
    expect(result.diagnostics.eventWarnings).toEqual([
      "session compression event write failed: event sink down",
      "session compression event write failed: event sink down"
    ]);
    expect((await base.db.listMessages(base.sessionId)).some((message) => message.metadata?.semanticCompression === true)).toBe(true);
    await expect(loadSessionContextWindowUsage({
      sessionDb: base.db,
      sessionId: base.sessionId,
      profileId: "profile"
    })).resolves.toBeUndefined();
    await expect(base.db.listEvents(base.sessionId)).resolves.toContainEqual({
      kind: "context-window-usage-invalidated",
      reason: "compaction"
    });
  });

  it("records fallback and provider failure observability with redaction", async () => {
    const { db, sessionId } = await sessionDbWithMessages(8);
    const providerExecutor = {
      complete: vi.fn(async (_request?: unknown, _preferences?: unknown, options?: { primaryRoute?: ResolvedModelRoute }): Promise<any> => {
        if (options?.primaryRoute?.id === "compression-model") {
          return providerExecution({
            ok: false,
            provider: "test-provider",
            model: "compression-model",
            errorClass: "network",
            content: "primary failed OPENAI_API_KEY=primary-secret"
          });
        }
        return providerExecution({
          ok: false,
          provider: "test-provider",
          model: "main-model",
          errorClass: "timeout",
          content: "main failed OPENAI_API_KEY=main-secret"
        });
      })
    };
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      route: auxiliaryRoute(),
      mainRoute: mainRoute(),
      providerExecutor
    });

    const result = await service.compactIfNeeded({ profileId: "profile", sessionId });
    const events = await db.listEvents(sessionId);
    const compressedEvent = events.find((event) => event.kind === "session-history-compressed");
    const state = reconstructSessionCompressionState(events);

    expect(result.didCompress).toBe(true);
    expect(compressedEvent).toEqual(expect.objectContaining({
      fallbackUsed: true,
      fallbackReason: "deterministic-fallback",
      auxModelFailure: {
        code: "network",
        message: "primary failed OPENAI_API_KEY=[REDACTED]",
        recoverable: true
      },
      mainRetryFailure: {
        code: "timeout",
        message: "main failed OPENAI_API_KEY=[REDACTED]",
        recoverable: true
      }
    }));
    expect(JSON.stringify(compressedEvent)).not.toContain("primary-secret");
    expect(JSON.stringify(compressedEvent)).not.toContain("main-secret");
    expect(state.fallbackUsed).toBe(true);
    expect(state.fallbackReason).toBe("deterministic-fallback");
    expect(state.auxModelFailure?.message).toContain("[REDACTED]");
    expect(state.mainRetryFailure?.message).toContain("[REDACTED]");
  });

  it("releases the lock when message replacement fails", async () => {
    const base = await sessionDbWithMessages(8);
    let failReplace = true;
    const lock = new SessionCompressionLock();
    const replacingDb = forwardingSessionDb(base.db, {
      replaceMessages: async (input) => {
        if (failReplace) {
          failReplace = false;
          throw new Error("replace down");
        }
        return base.db.replaceMessages(input);
      }
    });
    const service = new SessionCompressionService({
      sessionDb: replacingDb,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness("summary"),
      lock
    });

    await expect(service.compactIfNeeded({ profileId: "profile", sessionId: base.sessionId })).rejects.toThrow("replace down");
    await expect(service.compactIfNeeded({ profileId: "profile", sessionId: base.sessionId })).resolves.toMatchObject({
      didCompress: true
    });
  });

  it("returns an immutable shape", async () => {
    const { db, sessionId } = await sessionDbWithMessages(8);
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness("summary")
    });

    const result = await service.compactIfNeeded({ profileId: "profile", sessionId });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.messages)).toBe(true);
    expect(Object.isFrozen(result.messages[0])).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(Object.isFrozen(result.diagnostics.protectedSpans[0])).toBe(true);
  });

  it("uses the lock, releases on failure, and does not block unrelated sessions", async () => {
    const { db, sessionId } = await sessionDbWithMessages(8, "session-a");
    await appendMessages(db, "session-b", 8);
    const lock = new SessionCompressionLock();
    let releaseProvider!: () => void;
    const providerExecutor = {
      complete: vi.fn(async (): Promise<any> => {
        if (providerExecutor.complete.mock.calls.length === 1) {
          await new Promise<void>((resolve) => {
            releaseProvider = resolve;
          });
        }
        return providerResult("summary");
      })
    };
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      route: auxiliaryRoute(),
      mainRoute: mainRoute(),
      providerExecutor,
      lock
    });

    const first = service.compactIfNeeded({ profileId: "profile", sessionId });
    await waitFor(() => providerExecutor.complete.mock.calls.length === 1);
    const unrelated = await service.compactIfNeeded({ profileId: "profile", sessionId: "session-b" });
    expect(unrelated.didCompress).toBe(true);
    releaseProvider();
    await first;

    const failing = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      route: auxiliaryRoute(),
      mainRoute: mainRoute(),
      providerExecutor: {
        complete: vi.fn(async (): Promise<any> => {
          throw new Error("provider boom");
        })
      },
      lock
    });
    await expect(failing.compactNow({ profileId: "profile", sessionId })).resolves.toMatchObject({
      didCompress: true,
      diagnostics: expect.objectContaining({ fallbackUsed: true })
    });
    await expect(service.compactNow({ profileId: "profile", sessionId })).resolves.toMatchObject({ didCompress: true });
  });

  it("returns a user-facing compression message without wiring CLI commands", async () => {
    const { db, sessionId } = await sessionDbWithMessages(8);
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: true,
        experimental: true,
        protectFirstN: 0,
        protectLastN: 1,
        summaryModelContextLength: 50,
        threshold: 0.10
      }),
      ...auxiliaryHarness("summary")
    });

    const result = await service.compactIfNeeded({ profileId: "profile", sessionId });

    expect(result.userFacingMessage).toContain("Session history compacted");
    expect(result.messages.find((message) => message.metadata?.semanticCompression === true)?.content).toContain(SUMMARY_PREFIX);
  });

  it("persists protected provider tool groups without splitting them", async () => {
    const db = new InMemorySessionDB({ now: () => new Date("2030-01-01T00:00:00.000Z") });
    const session = await db.createSession({ id: "provider-tool-group-session", profileId: "profile" });
    await db.appendMessage({
      id: "latest-user",
      sessionId: session.id,
      role: "user",
      content: "latest user request"
    });
    await db.appendMessage({
      id: "compressible-agent",
      sessionId: session.id,
      role: "agent",
      content: "old compressible context ".repeat(20)
    });
    await db.appendMessage(providerToolTurn(session.id, "provider-turn", ["call-1"]));
    await db.appendMessage({
      id: "provider-tool-result",
      sessionId: session.id,
      role: "tool",
      content: "provider tool result",
      metadata: {
        tool_call_id: "call-1",
        tool_call_name: "files.read"
      }
    });
    const service = new SessionCompressionService({
      sessionDb: db,
      config: normalizeSessionCompressionConfig({
        enabled: false,
        protectFirstN: 0,
        protectLastN: 1
      }),
      ...auxiliaryHarness("compressed older context")
    });

    const result = await service.compactNow({ profileId: "profile", sessionId: session.id });
    const persisted = await db.listMessages(session.id);

    expect(result.didCompress).toBe(true);
    expect(persisted.map((message) => message.id)).toEqual([
      "latest-user",
      expect.stringMatching(/^summary-/u),
      "provider-turn",
      "provider-tool-result"
    ]);
    expect(persisted.find((message) => message.id === "provider-turn")?.metadata).toEqual(expect.objectContaining({
      kind: "provider-tool-call-turn",
      providerToolCalls: expect.any(Array)
    }));
    expect(persisted.find((message) => message.id === "provider-tool-result")?.metadata?.tool_call_id).toBe("call-1");
    expect(result.diagnostics.protectedSpans).toContainEqual(expect.objectContaining({
      startMessageId: "provider-turn",
      endMessageId: "provider-tool-result",
      messageCount: 2
    }));
  });
});

async function sessionDbWithMessages(count: number, sessionId = "session-a") {
  const db = new InMemorySessionDB({ now: () => new Date("2030-01-01T00:00:00.000Z") });
  await db.createSession({ id: sessionId, profileId: "profile" });
  await appendMessages(db, sessionId, count);
  return { db, sessionId };
}

async function appendMessages(db: InMemorySessionDB, sessionId: string, count: number): Promise<void> {
  if ((await db.getSession(sessionId)) === undefined) {
    await db.createSession({ id: sessionId, profileId: "profile" });
  }
  for (let index = 0; index < count; index += 1) {
    await db.appendMessage({
      id: `${sessionId}-m${index}`,
      sessionId,
      role: index % 2 === 0 ? "user" : "agent",
      content: `message ${index} ${"x".repeat(120)}`
    });
  }
}

function providerToolTurn(sessionId: string, id: string, callIds: string[]) {
  return {
    id,
    sessionId,
    role: "agent" as const,
    content: "provider tool call",
    metadata: {
      kind: "provider-tool-call-turn",
      nativeReplaySafe: true,
      providerToolCalls: callIds.map((callId) => ({
        id: callId,
        name: "files.read",
        argumentsText: "{\"path\":\"src/index.ts\"}"
      })),
      provider: "deepseek",
      model: "deepseek-chat"
    }
  };
}

function forwardingSessionDb(db: InMemorySessionDB, overrides: Partial<SessionDB>): SessionDB {
  return {
    createSession: overrides.createSession ?? db.createSession.bind(db),
    getSession: overrides.getSession ?? db.getSession.bind(db),
    listSessions: overrides.listSessions ?? db.listSessions.bind(db),
    endSession: overrides.endSession ?? db.endSession.bind(db),
    appendMessage: overrides.appendMessage ?? db.appendMessage.bind(db),
    replaceMessages: overrides.replaceMessages ?? db.replaceMessages.bind(db),
    rewriteTranscript: overrides.rewriteTranscript ?? db.rewriteTranscript.bind(db),
    appendEvent: overrides.appendEvent ?? db.appendEvent.bind(db),
    recordProviderUsageEntries: overrides.recordProviderUsageEntries ?? db.recordProviderUsageEntries.bind(db),
    listProviderUsageEntries: overrides.listProviderUsageEntries ?? db.listProviderUsageEntries.bind(db),
    listMessages: overrides.listMessages ?? db.listMessages.bind(db),
    listEvents: overrides.listEvents ?? db.listEvents.bind(db),
    search: overrides.search ?? db.search.bind(db),
    setSessionModelOverride: overrides.setSessionModelOverride ?? db.setSessionModelOverride.bind(db),
    clearSessionModelOverride: overrides.clearSessionModelOverride ?? db.clearSessionModelOverride.bind(db),
    getSessionModelOverride: overrides.getSessionModelOverride ?? db.getSessionModelOverride.bind(db),
    saveFailure: overrides.saveFailure ?? db.saveFailure.bind(db)
  };
}

function auxiliaryHarness(content: string, ok = true) {
  return {
    route: auxiliaryRoute(),
    mainRoute: mainRoute(),
    providerExecutor: {
      complete: vi.fn(async (): Promise<any> => providerResult(content, ok))
    }
  };
}

function providerResult(content: string, ok = true) {
  const response: ProviderResponse = {
    ok,
    content,
    model: "compression-model",
    provider: "test-provider"
  };
  return {
    ok,
    response,
    fallbackUsed: false,
    attempts: [{ provider: "test-provider", model: "compression-model", ok, content }],
    toolCalls: []
  };
}

function providerExecution(input: {
  ok: boolean;
  provider: string;
  model: string;
  errorClass?: string;
  content: string;
}) {
  return {
    ok: input.ok,
    response: {
      ok: input.ok,
      content: input.content,
      model: input.model,
      provider: input.provider
    },
    fallbackUsed: false,
    attempts: [{
      provider: input.provider,
      model: input.model,
      ok: input.ok,
      errorClass: input.errorClass,
      content: input.content
    }],
    toolCalls: []
  };
}

function auxiliaryRoute(): ResolvedAuxiliaryRoute {
  return {
    task: "compression",
    route: mainRoute("compression-model"),
    source: "explicit",
    fallbackToMain: true,
    diagnostics: []
  };
}

function mainRoute(id = "main-model"): ResolvedModelRoute {
  return {
    provider: "test-provider",
    id,
    profile: {
      id,
      provider: "test-provider",
      contextWindowTokens: 128_000,
      supportsTools: false,
      supportsVision: false,
      supportsStructuredOutput: true
    }
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
