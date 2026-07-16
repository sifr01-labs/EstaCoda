import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySessionDB } from "./in-memory-session-db.js";
import { SQLiteSessionDB } from "./sqlite-session-db.js";
import {
  loadSessionContextWindowUsage,
  normalizeSessionContextWindowUsage,
  reconstructSessionContextWindowUsage
} from "./session-context-window-usage.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("session context-window usage", () => {
  it("reconstructs the latest valid provider actual event", () => {
    expect(reconstructSessionContextWindowUsage([
      { kind: "context-window-usage", usedTokens: 100, totalTokens: 8_000, provider: "openai", model: "first", routeRole: "primary" },
      { kind: "context-window-usage", usedTokens: -1, totalTokens: 8_000, provider: "openai", model: "invalid" },
      { kind: "context-window-usage", usedTokens: 321.9, totalTokens: 16_000.8, provider: " anthropic ", model: " claude ", routeRole: "fallback" },
      { kind: "context-window-usage", usedTokens: 999, totalTokens: 0, provider: "openai", model: "invalid-latest" }
    ])).toEqual({
      usedTokens: 321,
      totalTokens: 16_000,
      provider: "anthropic",
      model: "claude",
      routeRole: "fallback"
    });
  });

  it("invalidates pre-compaction usage until a fresh provider measurement arrives", () => {
    const preCompaction = {
      kind: "context-window-usage",
      usedTokens: 90_000,
      totalTokens: 128_000,
      provider: "openai",
      model: "gpt-test",
    };
    const compressed = { kind: "session-history-compressed" };
    const postCompaction = {
      kind: "context-window-usage",
      usedTokens: 6_000,
      totalTokens: 128_000,
      provider: "openai",
      model: "gpt-test",
    };

    expect(reconstructSessionContextWindowUsage([preCompaction, compressed])).toBeUndefined();
    expect(reconstructSessionContextWindowUsage([preCompaction, compressed, postCompaction])).toEqual({
      usedTokens: 6_000,
      totalTokens: 128_000,
      provider: "openai",
      model: "gpt-test",
    });
  });

  it("invalidates pre-model-change usage until a fresh provider measurement arrives", () => {
    const prior = {
      kind: "context-window-usage",
      usedTokens: 12_000,
      totalTokens: 128_000,
      provider: "openai",
      model: "old-model",
    };
    const boundary = {
      kind: "context-window-usage-invalidated",
      reason: "model-change",
    };
    const fresh = {
      kind: "context-window-usage",
      usedTokens: 4_000,
      totalTokens: 64_000,
      provider: "openai",
      model: "new-model",
    };

    expect(reconstructSessionContextWindowUsage([prior, boundary])).toBeUndefined();
    expect(reconstructSessionContextWindowUsage([prior, boundary, fresh])).toEqual({
      usedTokens: 4_000,
      totalTokens: 64_000,
      provider: "openai",
      model: "new-model",
    });
  });

  it("rejects malformed, unbounded, and non-positive usage snapshots", () => {
    expect(normalizeSessionContextWindowUsage(undefined)).toBeUndefined();
    expect(normalizeSessionContextWindowUsage({ usedTokens: 1, totalTokens: 0, provider: "openai", model: "gpt" }))
      .toBeUndefined();
    expect(normalizeSessionContextWindowUsage({ usedTokens: Number.NaN, totalTokens: 8_000, provider: "openai", model: "gpt" }))
      .toBeUndefined();
    expect(normalizeSessionContextWindowUsage({ usedTokens: 1, totalTokens: 8_000, provider: "", model: "gpt" }))
      .toBeUndefined();
    expect(normalizeSessionContextWindowUsage({
      usedTokens: 1,
      totalTokens: 8_000,
      provider: "p".repeat(257),
      model: "gpt"
    })).toBeUndefined();
    expect(normalizeSessionContextWindowUsage({
      usedTokens: 1,
      totalTokens: 8_000,
      provider: "openai\nspoofed",
      model: "gpt"
    })).toBeUndefined();
  });

  it("loads usage only from the requested profile-owned session", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({ id: "default-session", profileId: "default" });
    await db.createSession({ id: "other-session", profileId: "other" });
    await db.appendEvent("default-session", {
      kind: "context-window-usage",
      usedTokens: 111,
      totalTokens: 8_000,
      provider: "openai",
      model: "default-model"
    });
    await db.appendEvent("other-session", {
      kind: "context-window-usage",
      usedTokens: 999,
      totalTokens: 32_000,
      provider: "other-provider",
      model: "private-model"
    });

    await expect(loadSessionContextWindowUsage({
      sessionDb: db,
      sessionId: "default-session",
      profileId: "default"
    })).resolves.toEqual({
      usedTokens: 111,
      totalTokens: 8_000,
      provider: "openai",
      model: "default-model"
    });
    const listEvents = vi.spyOn(db, "listEvents");
    await expect(loadSessionContextWindowUsage({
      sessionDb: db,
      sessionId: "other-session",
      profileId: "default"
    })).resolves.toBeUndefined();
    expect(listEvents).not.toHaveBeenCalled();
    await expect(loadSessionContextWindowUsage({
      sessionDb: db,
      sessionId: "missing-session",
      profileId: "default"
    })).resolves.toBeUndefined();
  });

  it("restores the latest usage after reopening the SQLite session store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "estacoda-context-usage-"));
    tempDirs.push(dir);
    const path = join(dir, "sessions.sqlite");
    const first = new SQLiteSessionDB({ path });
    try {
      await first.createSession({ id: "resumed-session", profileId: "default" });
      await first.appendEvent("resumed-session", {
        kind: "context-window-usage",
        usedTokens: 4_200,
        totalTokens: 128_000,
        provider: "openai",
        model: "gpt-test",
        routeRole: "primary"
      });
    } finally {
      first.close();
    }

    const reopened = new SQLiteSessionDB({ path });
    try {
      await expect(loadSessionContextWindowUsage({
        sessionDb: reopened,
        sessionId: "resumed-session",
        profileId: "default"
      })).resolves.toEqual({
        usedTokens: 4_200,
        totalTokens: 128_000,
        provider: "openai",
        model: "gpt-test",
        routeRole: "primary"
      });
    } finally {
      reopened.close();
    }
  });
});
