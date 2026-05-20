import { describe, expect, it, vi } from "vitest";
import { normalizeSessionCompressionConfig } from "../config/runtime-config.js";
import type { CompactResult, SessionCompressionRequest } from "../prompt/session-compression-service.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { GATEWAY_HYGIENE_THRESHOLD, SessionHygieneService } from "./session-hygiene-service.js";

describe("SessionHygieneService", () => {
  it("skips without reading messages when semantic compression is disabled", async () => {
    const listMessages = vi.fn(async () => {
      throw new Error("should not read messages");
    });
    const compactIfNeeded = vi.fn();
    const service = new SessionHygieneService({
      sessionDb: { listMessages },
      profileId: "profile",
      compressionConfig: normalizeSessionCompressionConfig({ enabled: false }),
      compressionService: { compactIfNeeded },
      contextWindowTokens: 100
    });

    await expect(service.run({ sessionId: "session" })).resolves.toMatchObject({
      status: "skipped",
      reason: "disabled",
      thresholdTokens: Math.floor(100 * GATEWAY_HYGIENE_THRESHOLD)
    });
    expect(listMessages).not.toHaveBeenCalled();
    expect(compactIfNeeded).not.toHaveBeenCalled();
  });

  it("skips below the gateway hygiene threshold", async () => {
    const db = await dbWithMessages("session", ["short"]);
    const compactIfNeeded = vi.fn();
    const service = new SessionHygieneService({
      sessionDb: db,
      profileId: "profile",
      compressionConfig: normalizeSessionCompressionConfig({ enabled: true, experimental: true }),
      compressionService: { compactIfNeeded },
      contextWindowTokens: 1_000
    });

    await expect(service.run({ sessionId: "session" })).resolves.toMatchObject({
      status: "skipped",
      reason: "below-threshold"
    });
    expect(compactIfNeeded).not.toHaveBeenCalled();
  });

  it("runs shared semantic compression at the 85 percent gateway hygiene threshold", async () => {
    const db = await dbWithMessages("session", ["x".repeat(300)]);
    const compactIfNeeded = vi.fn(async () => compactResult());
    const service = new SessionHygieneService({
      sessionDb: db,
      profileId: "profile",
      compressionConfig: normalizeSessionCompressionConfig({ enabled: true, experimental: true }),
      compressionService: { compactIfNeeded },
      contextWindowTokens: 100
    });

    const result = await service.run({ sessionId: "session" });

    expect(result.status).toBe("compacted");
    expect(compactIfNeeded).toHaveBeenCalledWith(expect.objectContaining<Partial<SessionCompressionRequest>>({
      profileId: "profile",
      sessionId: "session",
      trigger: "hygiene"
    }));
  });

  it("uses image-heavy message metadata for the gateway hygiene threshold", async () => {
    const db = await dbWithMessages("session", ["short"]);
    await db.appendMessage({
      id: "image-history",
      sessionId: "session",
      role: "user",
      content: "image-heavy history",
      metadata: {
        attachments: [
          { kind: "image", status: "ready" }
        ]
      }
    });
    const compactIfNeeded = vi.fn(async () => compactResult());
    const service = new SessionHygieneService({
      sessionDb: db,
      profileId: "profile",
      compressionConfig: normalizeSessionCompressionConfig({ enabled: true, experimental: true }),
      compressionService: { compactIfNeeded },
      contextWindowTokens: 1_000
    });

    const result = await service.run({ sessionId: "session" });

    expect(result.status).toBe("compacted");
    expect(compactIfNeeded).toHaveBeenCalledTimes(1);
  });

  it("returns a safe failure result when the compression service fails", async () => {
    const db = await dbWithMessages("session", ["x".repeat(300)]);
    const compactIfNeeded = vi.fn(async () => {
      throw new Error("lock busy");
    });
    const warnings: string[] = [];
    const service = new SessionHygieneService({
      sessionDb: db,
      profileId: "profile",
      compressionConfig: normalizeSessionCompressionConfig({ enabled: true, experimental: true }),
      compressionService: { compactIfNeeded },
      contextWindowTokens: 100,
      logWarning: (message) => warnings.push(message)
    });

    await expect(service.run({ sessionId: "session" })).resolves.toMatchObject({
      status: "failed",
      reason: "compression-failed",
      error: "lock busy"
    });
    expect(warnings.join("\n")).toContain("lock busy");
  });
});

async function dbWithMessages(sessionId: string, contents: string[]): Promise<InMemorySessionDB> {
  const db = new InMemorySessionDB({
    now: () => new Date("2030-01-02T00:00:00.000Z"),
    id: () => "generated-id"
  });
  await db.createSession({ id: sessionId, profileId: "profile" });
  for (const [index, content] of contents.entries()) {
    await db.appendMessage({
      id: `m${index}`,
      sessionId,
      role: index % 2 === 0 ? "user" : "agent",
      content
    });
  }
  return db;
}

function compactResult(): CompactResult {
  return {
    didCompress: true,
    messages: [
      { id: "summary", role: "system", content: "summary", metadata: { semanticCompression: true } },
      { id: "latest", role: "user", content: "latest" }
    ],
    diagnostics: {
      shouldCompress: true,
      reason: "above-threshold",
      preTokens: 100,
      postTokens: 30,
      estimatedSavingsTokens: 70,
      estimatedSavingsRatio: 0.70,
      sourceMessageCount: 6,
      summarizedMessageCount: 4,
      protectedMessageCount: 2,
      protectedFirstN: 1,
      protectedLastN: 1,
      protectedSpans: [],
      protectedCategories: [],
      summaryFormatVersion: "v1",
      summaryChars: 7,
      fallbackUsed: false,
      warnings: [],
      eventWarnings: [],
      prunedToolResults: 0,
      prunedToolResultChars: 0,
      protectedToolResultsKept: 0,
      scopeKey: "profile:session",
      ineffectiveCompressionCount: 0
    },
    userFacingMessage: "Session history compacted"
  };
}
