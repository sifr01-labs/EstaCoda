import { describe, expect, it } from "vitest";
import { InMemorySessionDB } from "./in-memory-session-db.js";
import {
  SESSION_SCROLL_DEFAULT_WINDOW,
  SESSION_SCROLL_MAX_WINDOW,
  SESSION_SEARCH_DEFAULT_LIMIT,
  SESSION_SEARCH_MAX_LIMIT,
  SESSION_SEARCH_MESSAGE_EXCERPT_CHARS,
  SESSION_SEARCH_SESSION_PREVIEW_CHARS,
  SESSION_SEARCH_UNTRUSTED_LABEL,
  SessionSearchService
} from "./session-search-service.js";
import type { SessionRole } from "../contracts/session.js";

describe("SessionSearchService", () => {
  it("pages observations with the same profile, workspace and child-session boundaries", async () => {
    const db = new InMemorySessionDB();
    const service = new SessionSearchService({ sessionDb: db });
    for (const [id, profileId, metadata] of [
      ["current", "alpha", { workspaceRoot: "/workspace/a" }],
      ["other-profile", "beta", { workspaceRoot: "/workspace/a" }],
      ["other-workspace", "alpha", { workspaceRoot: "/workspace/b" }],
      ["child", "alpha", { workspaceRoot: "/workspace/a", kind: "delegated-child" }]
    ] as const) {
      await db.createSession({ id, profileId, metadata });
      const message = await db.appendMessage({ sessionId: id, role: "tool", content: "a".repeat(3_000) + "final evidence" });
      const read = (offset: number) => service.readMessage({ sessionId: id, aroundMessageId: message.id, profileId: "alpha", workspaceRoot: "/workspace/a", offset });
      if (id !== "current") expect(await read(0)).toMatchObject({ ok: false, error: { code: "session-not-accessible" } });
      else {
        expect(await read(0)).toMatchObject({ ok: true, nextOffset: 3_000 });
        expect(await read(3_000)).toMatchObject({ ok: true, content: "final evidence", nextOffset: null });
        for (const offset of [-1, NaN, 0.5]) expect(await read(offset)).toMatchObject({ ok: false, error: { code: "invalid-offset" } });
      }
    }
  });

  it("browses recent sessions with the default limit", async () => {
    const { db } = createFixture();
    await seedSessions(db, 12);
    const service = new SessionSearchService({ sessionDb: db });

    const result = await service.browseRecentSessions();

    expect(result.sessions).toHaveLength(SESSION_SEARCH_DEFAULT_LIMIT);
    expect(result.sessions[0]?.sessionId).toBe("session-12");
    expect(result.sessions[9]?.sessionId).toBe("session-3");
  });

  it("browse respects profile id", async () => {
    const { db } = createFixture();
    await createSessionWithMessage(db, {
      sessionId: "alpha-session",
      profileId: "alpha",
      content: "alpha profile"
    });
    await createSessionWithMessage(db, {
      sessionId: "beta-session",
      profileId: "beta",
      content: "beta profile"
    });

    const result = await new SessionSearchService({ sessionDb: db }).browseRecentSessions({ profileId: "alpha" });

    expect(result.sessions.map((session) => session.sessionId)).toEqual(["alpha-session"]);
  });

  it("browse respects workspace metadata", async () => {
    const { db } = createFixture();
    await createSessionWithMessage(db, {
      sessionId: "workspace-root",
      metadata: { workspaceRoot: "/workspace/a" },
      content: "root match"
    });
    await createSessionWithMessage(db, {
      sessionId: "workspace-directory",
      metadata: { workspaceDirectory: "/workspace/a" },
      content: "directory match"
    });
    await createSessionWithMessage(db, {
      sessionId: "project-root",
      metadata: { projectRoot: "/workspace/a" },
      content: "project match"
    });
    await createSessionWithMessage(db, {
      sessionId: "other-workspace",
      metadata: { workspaceRoot: "/workspace/b" },
      content: "other workspace"
    });

    const result = await new SessionSearchService({ sessionDb: db }).browseRecentSessions({
      workspaceRoot: "/workspace/a",
      sort: "oldest"
    });

    expect(result.sessions.map((session) => session.sessionId)).toEqual([
      "workspace-root",
      "workspace-directory",
      "project-root"
    ]);
  });

  it("excludes delegated child sessions from browse, search, and scroll by default", async () => {
    const { db } = createFixture();
    await createSessionWithMessage(db, {
      sessionId: "parent",
      content: "needle parent"
    });
    await createSessionWithMessage(db, {
      sessionId: "child",
      content: "needle child",
      metadata: { kind: "delegated-child" }
    });
    const childMessage = (await db.listMessages("child"))[0]!;
    const service = new SessionSearchService({ sessionDb: db });

    const browse = await service.browseRecentSessions({ sort: "oldest" });
    const search = await service.searchMessages({ query: "needle" });
    const scroll = await service.scrollAroundMessage({
      sessionId: "child",
      aroundMessageId: childMessage.id
    });

    expect(browse.sessions.map((session) => session.sessionId)).toEqual(["parent"]);
    expect(search.messages.map((message) => message.sessionId)).toEqual(["parent"]);
    expect(scroll).toMatchObject({
      ok: false,
      error: {
        code: "session-not-accessible",
        sessionId: "child"
      }
    });
  });

  it("browse limit clamps to 20 and supports oldest sort", async () => {
    const { db } = createFixture();
    await seedSessions(db, 25);

    const result = await new SessionSearchService({ sessionDb: db }).browseRecentSessions({
      limit: 200,
      sort: "oldest"
    });

    expect(result.sessions).toHaveLength(SESSION_SEARCH_MAX_LIMIT);
    expect(result.sessions[0]?.sessionId).toBe("session-1");
    expect(result.sessions[19]?.sessionId).toBe("session-20");
  });

  it("searches historical messages", async () => {
    const { db } = createFixture();
    await createSessionWithMessage(db, {
      sessionId: "search-session",
      content: "needle appears in this historical message"
    });

    const result = await new SessionSearchService({ sessionDb: db }).searchMessages({ query: "needle" });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      source: "session-message",
      sessionId: "search-session",
      role: "user",
      untrusted: true,
      untrustedLabel: SESSION_SEARCH_UNTRUSTED_LABEL
    });
  });

  it("search respects role_filter", async () => {
    const { db } = createFixture();
    await db.createSession({ id: "roles", profileId: "default" });
    await appendMessage(db, "roles", "user", "needle from user");
    await appendMessage(db, "roles", "agent", "needle from agent");
    await appendMessage(db, "roles", "tool", "needle from tool");
    await appendMessage(db, "roles", "system", "needle from system");

    const result = await new SessionSearchService({ sessionDb: db }).searchMessages({
      query: "needle",
      roleFilter: ["tool", "system"],
      sort: "oldest"
    });

    expect(result.messages.map((message) => message.role)).toEqual(["tool", "system"]);
  });

  it("search respects profile id", async () => {
    const { db } = createFixture();
    await createSessionWithMessage(db, {
      sessionId: "alpha-session",
      profileId: "alpha",
      content: "needle alpha"
    });
    await createSessionWithMessage(db, {
      sessionId: "beta-session",
      profileId: "beta",
      content: "needle beta"
    });

    const result = await new SessionSearchService({ sessionDb: db }).searchMessages({
      query: "needle",
      profileId: "beta"
    });

    expect(result.messages.map((message) => message.sessionId)).toEqual(["beta-session"]);
  });

  it("search excludes active session when requested", async () => {
    const { db } = createFixture();
    await createSessionWithMessage(db, {
      sessionId: "active",
      content: "needle active"
    });
    await createSessionWithMessage(db, {
      sessionId: "historical",
      content: "needle historical"
    });

    const result = await new SessionSearchService({ sessionDb: db }).searchMessages({
      query: "needle",
      excludeSessionIds: ["active"]
    });

    expect(result.messages.map((message) => message.sessionId)).toEqual(["historical"]);
  });

  it("search supports newest, oldest, and rank sorting", async () => {
    const { db } = createFixture();
    await db.createSession({ id: "sorting", profileId: "default" });
    await appendMessage(db, "sorting", "user", "needle alpha");
    await appendMessage(db, "sorting", "user", "needle alpha beta");
    await appendMessage(db, "sorting", "user", "needle alpha");
    const service = new SessionSearchService({ sessionDb: db });

    const rank = await service.searchMessages({ query: "needle beta", sort: "rank" });
    const oldest = await service.searchMessages({ query: "needle", sort: "oldest" });
    const newest = await service.searchMessages({ query: "needle", sort: "newest" });

    expect(rank.messages[0]?.excerpt).toContain("needle alpha beta");
    expect(oldest.messages.map((message) => message.excerpt)).toEqual([
      "needle alpha",
      "needle alpha beta",
      "needle alpha"
    ]);
    expect(newest.messages.map((message) => message.excerpt)).toEqual([
      "needle alpha",
      "needle alpha beta",
      "needle alpha"
    ]);
    expect(newest.messages[0]?.createdAt > newest.messages[1]!.createdAt).toBe(true);
  });

  it("search limit defaults to 10 and clamps to 20", async () => {
    const { db } = createFixture();
    await db.createSession({ id: "many-messages", profileId: "default" });
    for (let index = 1; index <= 25; index += 1) {
      await appendMessage(db, "many-messages", "user", `needle ${index}`);
    }
    const service = new SessionSearchService({ sessionDb: db });

    expect((await service.searchMessages({ query: "needle" })).messages).toHaveLength(SESSION_SEARCH_DEFAULT_LIMIT);
    expect((await service.searchMessages({ query: "needle", limit: 999 })).messages).toHaveLength(SESSION_SEARCH_MAX_LIMIT);
  });

  it("scrolls around message id with default window and deterministic count", async () => {
    const { db } = createFixture();
    await seedTranscript(db, "scroll", 9);

    const result = await new SessionSearchService({ sessionDb: db }).scrollAroundMessage({
      sessionId: "scroll",
      aroundMessageId: "scroll-message-5"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected scroll success");
    expect(result.messages).toHaveLength(SESSION_SCROLL_DEFAULT_WINDOW);
    expect(result.messages.map((message) => message.messageId)).toEqual([
      "scroll-message-3",
      "scroll-message-4",
      "scroll-message-5",
      "scroll-message-6",
      "scroll-message-7"
    ]);
  });

  it("scroll window clamps to 20", async () => {
    const { db } = createFixture();
    await seedTranscript(db, "wide-scroll", 30);

    const result = await new SessionSearchService({ sessionDb: db }).scrollAroundMessage({
      sessionId: "wide-scroll",
      aroundMessageId: "wide-scroll-message-15",
      window: 200
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected scroll success");
    expect(result.messages).toHaveLength(SESSION_SCROLL_MAX_WINDOW);
  });

  it("scroll clamps at beginning and end", async () => {
    const { db } = createFixture();
    await seedTranscript(db, "edge-scroll", 8);
    const service = new SessionSearchService({ sessionDb: db });

    const beginning = await service.scrollAroundMessage({
      sessionId: "edge-scroll",
      aroundMessageId: "edge-scroll-message-1",
      window: 5
    });
    const end = await service.scrollAroundMessage({
      sessionId: "edge-scroll",
      aroundMessageId: "edge-scroll-message-8",
      window: 5
    });

    expect(beginning.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!beginning.ok || !end.ok) throw new Error("expected scroll success");
    expect(beginning.messages.map((message) => message.messageId)).toEqual([
      "edge-scroll-message-1",
      "edge-scroll-message-2",
      "edge-scroll-message-3",
      "edge-scroll-message-4",
      "edge-scroll-message-5"
    ]);
    expect(end.messages.map((message) => message.messageId)).toEqual([
      "edge-scroll-message-4",
      "edge-scroll-message-5",
      "edge-scroll-message-6",
      "edge-scroll-message-7",
      "edge-scroll-message-8"
    ]);
  });

  it("scroll returns structured error for missing message id", async () => {
    const { db } = createFixture();
    await seedTranscript(db, "missing-message", 3);

    const result = await new SessionSearchService({ sessionDb: db }).scrollAroundMessage({
      sessionId: "missing-message",
      aroundMessageId: "does-not-exist"
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "message-not-found",
        sessionId: "missing-message",
        messageId: "does-not-exist"
      }
    });
  });

  it("large messages and session previews are bounded internally", async () => {
    const { db } = createFixture();
    await createSessionWithMessage(db, {
      sessionId: "large",
      content: `needle ${"x".repeat(2_000)}`
    });
    const service = new SessionSearchService({ sessionDb: db });

    const browse = await service.browseRecentSessions();
    const search = await service.searchMessages({ query: "needle" });

    expect(browse.sessions[0]?.preview.length).toBeLessThanOrEqual(SESSION_SEARCH_SESSION_PREVIEW_CHARS);
    expect(browse.sessions[0]?.preview.endsWith("...")).toBe(true);
    expect(search.messages[0]?.excerpt.length).toBeLessThanOrEqual(SESSION_SEARCH_MESSAGE_EXCERPT_CHARS);
    expect(search.messages[0]?.excerpt.endsWith("...")).toBe(true);
  });

  it("output redacts secrets and labels historical content as untrusted", async () => {
    const { db } = createFixture();
    await createSessionWithMessage(db, {
      sessionId: "secret-session",
      content: "needle OPENAI_API_KEY=secretsecretsecretsecretsecret"
    });

    const service = new SessionSearchService({ sessionDb: db });
    const browse = await service.browseRecentSessions();
    const search = await service.searchMessages({ query: "needle" });
    const scroll = await service.scrollAroundMessage({
      sessionId: "secret-session",
      aroundMessageId: "secret-session-message-1"
    });

    expect(JSON.stringify(browse)).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(JSON.stringify(search)).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(JSON.stringify(browse)).not.toContain("secretsecret");
    expect(JSON.stringify(search)).not.toContain("secretsecret");
    expect(browse.sessions[0]).toMatchObject({
      untrusted: true,
      untrustedLabel: SESSION_SEARCH_UNTRUSTED_LABEL
    });
    expect(search.messages[0]).toMatchObject({
      untrusted: true,
      untrustedLabel: SESSION_SEARCH_UNTRUSTED_LABEL
    });
    expect(scroll.ok).toBe(true);
    if (!scroll.ok) throw new Error("expected scroll success");
    expect(scroll.messages[0]).toMatchObject({
      untrusted: true,
      untrustedLabel: SESSION_SEARCH_UNTRUSTED_LABEL
    });
    expect(JSON.stringify(scroll)).not.toContain("secretsecret");
  });
});

function createFixture(): { db: InMemorySessionDB } {
  let tick = 0;
  return {
    db: new InMemorySessionDB({
      now: () => new Date(Date.UTC(2030, 0, 1, 0, 0, tick++)),
      id: (() => {
        let next = 0;
        return () => `generated-message-${++next}`;
      })()
    })
  };
}

async function seedSessions(db: InMemorySessionDB, count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await createSessionWithMessage(db, {
      sessionId: `session-${index}`,
      content: `session preview ${index}`
    });
  }
}

async function createSessionWithMessage(
  db: InMemorySessionDB,
  options: {
    sessionId: string;
    profileId?: string;
    metadata?: Record<string, unknown>;
    content: string;
  }
): Promise<void> {
  await db.createSession({
    id: options.sessionId,
    profileId: options.profileId ?? "default",
    title: `Title ${options.sessionId}`,
    metadata: options.metadata
  });
  await db.appendMessage({
    id: `${options.sessionId}-message-1`,
    sessionId: options.sessionId,
    role: "user",
    content: options.content
  });
}

async function seedTranscript(db: InMemorySessionDB, sessionId: string, count: number): Promise<void> {
  await db.createSession({ id: sessionId, profileId: "default" });
  for (let index = 1; index <= count; index += 1) {
    await db.appendMessage({
      id: `${sessionId}-message-${index}`,
      sessionId,
      role: index % 2 === 0 ? "agent" : "user",
      content: `message ${index}`
    });
  }
}

async function appendMessage(
  db: InMemorySessionDB,
  sessionId: string,
  role: SessionRole,
  content: string
): Promise<void> {
  await db.appendMessage({
    sessionId,
    role,
    content
  });
}
