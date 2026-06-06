import { describe, expect, it } from "vitest";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import {
  SESSION_SCROLL_MAX_WINDOW,
  SESSION_SEARCH_MAX_LIMIT,
  SESSION_SEARCH_MESSAGE_EXCERPT_CHARS,
  SESSION_SEARCH_UNTRUSTED_LABEL
} from "../session/session-search-service.js";
import { createSessionSearchTool, SESSION_SEARCH_TOOL_MAX_RESULT_CHARS, sessionSearchToolProvider } from "./session-search-tool.js";
import { toolRegistrationPlan } from "./index.js";
import type { SessionRole } from "../contracts/session.js";

describe("session_search tool", () => {
  it("supports browse mode", async () => {
    const db = createDb();
    await seedSessions(db, 3);
    const tool = createSessionSearchTool({ sessionDb: db, profileId: "default" });

    const result = await tool.run({ mode: "browse", sort: "newest" });
    const payload = parsePayload(result);

    expect(result.ok).toBe(true);
    expect(payload.sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual([
      "session-3",
      "session-2",
      "session-1"
    ]);
  });

  it("supports search mode with role_filter", async () => {
    const db = createDb();
    await db.createSession({ id: "roles", profileId: "default" });
    await appendMessage(db, "roles", "user", "needle user");
    await appendMessage(db, "roles", "agent", "needle agent");
    await appendMessage(db, "roles", "tool", "needle tool");
    const tool = createSessionSearchTool({ sessionDb: db, profileId: "default" });

    const result = await tool.run({
      mode: "search",
      query: "needle",
      role_filter: ["tool"]
    });
    const payload = parsePayload(result);

    expect(payload.messages.map((message: { role: string }) => message.role)).toEqual(["tool"]);
  });

  it("supports scroll mode", async () => {
    const db = createDb();
    await seedTranscript(db, "scroll", 7);
    const tool = createSessionSearchTool({ sessionDb: db, profileId: "default" });

    const result = await tool.run({
      mode: "scroll",
      session_id: "scroll",
      around_message_id: "scroll-message-4",
      window: 3
    });
    const payload = parsePayload(result);

    expect(result.ok).toBe(true);
    expect(payload.messages.map((message: { messageId: string }) => message.messageId)).toEqual([
      "scroll-message-3",
      "scroll-message-4",
      "scroll-message-5"
    ]);
  });

  it("supports newest, oldest, and rank sort in search mode", async () => {
    const db = createDb();
    await db.createSession({ id: "sorting", profileId: "default" });
    await appendMessage(db, "sorting", "user", "needle alpha");
    await appendMessage(db, "sorting", "user", "needle alpha beta");
    await appendMessage(db, "sorting", "user", "needle alpha");
    const tool = createSessionSearchTool({ sessionDb: db, profileId: "default" });

    const newest = parsePayload(await tool.run({ mode: "search", query: "needle", sort: "newest" }));
    const oldest = parsePayload(await tool.run({ mode: "search", query: "needle", sort: "oldest" }));
    const rank = parsePayload(await tool.run({ mode: "search", query: "needle beta", sort: "rank" }));

    expect(newest.messages[0].createdAt > newest.messages[1].createdAt).toBe(true);
    expect(oldest.messages[0].createdAt < oldest.messages[1].createdAt).toBe(true);
    expect(rank.messages[0].excerpt).toContain("needle alpha beta");
  });

  it("clamps limit and window through the service", async () => {
    const db = createDb();
    await db.createSession({ id: "many", profileId: "default" });
    for (let index = 1; index <= 30; index += 1) {
      await appendMessage(db, "many", "user", `needle ${index}`);
    }
    const tool = createSessionSearchTool({ sessionDb: db, profileId: "default" });

    const search = parsePayload(await tool.run({ mode: "search", query: "needle", limit: 999 }));
    const scroll = parsePayload(await tool.run({
      mode: "scroll",
      session_id: "many",
      around_message_id: "generated-message-15",
      window: 999
    }));

    expect(search.messages).toHaveLength(SESSION_SEARCH_MAX_LIMIT);
    expect(scroll.messages).toHaveLength(SESSION_SCROLL_MAX_WINDOW);
  });

  it("keeps large messages excerpted and large outputs under the tool cap", async () => {
    const db = createDb();
    for (let index = 1; index <= 24; index += 1) {
      await createSessionWithMessage(db, {
        sessionId: `large-${index}`,
        content: `needle ${"x".repeat(2_000)}`
      });
    }
    const tool = createSessionSearchTool({ sessionDb: db, profileId: "default" });

    const search = await tool.run({ mode: "search", query: "needle", limit: 999 });
    const browse = await tool.run({ mode: "browse", limit: 999 });
    const searchPayload = parsePayload(search);

    expect(searchPayload.messages[0].excerpt.length).toBeLessThanOrEqual(SESSION_SEARCH_MESSAGE_EXCERPT_CHARS);
    expect(search.content.length).toBeLessThanOrEqual(tool.maxResultSizeChars);
    expect(browse.content.length).toBeLessThanOrEqual(tool.maxResultSizeChars);
    expect(tool.maxResultSizeChars).toBe(SESSION_SEARCH_TOOL_MAX_RESULT_CHARS);
  });

  it("schema does not expose maxChars", () => {
    const tool = createSessionSearchTool({});
    const schema = tool.inputSchema as {
      oneOf?: Array<{ properties?: Record<string, { const?: string; enum?: string[] }>; required?: string[] }>;
    };

    expect(JSON.stringify(tool.inputSchema)).not.toContain("maxChars");
    expect(JSON.stringify(tool.inputSchema)).not.toContain("max_chars");
    expect(JSON.stringify(tool.inputSchema)).not.toContain("provider");
    expect(JSON.stringify(tool.inputSchema)).not.toContain("summar");
    expect(JSON.stringify(tool.inputSchema)).toContain("limit");
    expect(JSON.stringify(tool.inputSchema)).toContain("window");
    expect(schema.oneOf?.map((entry) => entry.properties?.mode?.const)).toEqual(["browse", "search", "scroll"]);
    expect(schema.oneOf?.[0]?.properties?.sort?.enum).toEqual(["newest", "oldest"]);
    expect(schema.oneOf?.[1]?.properties?.sort?.enum).toEqual(["newest", "oldest", "rank"]);
    expect(schema.oneOf?.[1]?.required).toEqual(["mode", "query"]);
    expect(schema.oneOf?.[2]?.required).toEqual(["mode", "session_id", "around_message_id"]);
  });

  it("returns bounded redacted output with untrusted labels", async () => {
    const db = createDb();
    await createSessionWithMessage(db, {
      sessionId: "secret",
      content: "needle OPENAI_API_KEY=secretsecretsecretsecretsecret"
    });
    const tool = createSessionSearchTool({ sessionDb: db, profileId: "default" });

    const result = await tool.run({ mode: "search", query: "needle" });
    const payload = parsePayload(result);

    expect(result.content).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(result.content).not.toContain("secretsecret");
    expect(result.content.length).toBeLessThanOrEqual(tool.maxResultSizeChars);
    expect(payload.messages[0]).toMatchObject({
      untrusted: true,
      untrustedLabel: SESSION_SEARCH_UNTRUSTED_LABEL
    });
  });

  it("excludes the active session when current context is available", async () => {
    const db = createDb();
    await createSessionWithMessage(db, {
      sessionId: "active",
      content: "needle active"
    });
    await createSessionWithMessage(db, {
      sessionId: "historical",
      content: "needle historical"
    });
    const tool = createSessionSearchTool({
      sessionDb: db,
      profileId: "default",
      currentSessionId: () => "active"
    });

    const result = parsePayload(await tool.run({ mode: "search", query: "needle" }));

    expect(result.messages.map((message: { sessionId: string }) => message.sessionId)).toEqual(["historical"]);
  });

  it("missing sessionDb dependency fails clearly", async () => {
    const tool = createSessionSearchTool({});

    const result = await tool.run({ mode: "browse" });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        error: "missing-session-db",
        dependency: "sessionDb"
      }
    });
  });

  it("missing message returns structured diagnostics", async () => {
    const db = createDb();
    await seedTranscript(db, "missing", 2);
    const tool = createSessionSearchTool({ sessionDb: db, profileId: "default" });

    const result = await tool.run({
      mode: "scroll",
      session_id: "missing",
      around_message_id: "nope"
    });
    const payload = parsePayload(result);

    expect(result.ok).toBe(false);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "message-not-found",
        sessionId: "missing",
        messageId: "nope"
      }
    });
  });

  it("tool registration includes session_search", () => {
    const entry = toolRegistrationPlan.find((item) => item.provider.name === "sessionSearch");

    expect(entry).toMatchObject({
      phase: "pre-skill-visibility",
      provider: {
        kind: "session",
        name: "sessionSearch"
      }
    });
    expect(sessionSearchToolProvider.createTools({
      workspaceRoot: "/workspace",
      profileId: "default",
      sessionId: "session",
      currentSessionId: () => "session"
    }).map((tool) => tool.name)).toEqual(["session_search"]);
  });
});

function createDb(): InMemorySessionDB {
  let tick = 0;
  return new InMemorySessionDB({
    now: () => new Date(Date.UTC(2030, 0, 1, 0, 0, tick++)),
    id: (() => {
      let next = 0;
      return () => `generated-message-${++next}`;
    })()
  });
}

async function seedSessions(db: InMemorySessionDB, count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await createSessionWithMessage(db, {
      sessionId: `session-${index}`,
      content: `session ${index}`
    });
  }
}

async function createSessionWithMessage(
  db: InMemorySessionDB,
  input: {
    sessionId: string;
    content: string;
  }
): Promise<void> {
  await db.createSession({
    id: input.sessionId,
    profileId: "default",
    title: `Title ${input.sessionId}`
  });
  await db.appendMessage({
    id: `${input.sessionId}-message-1`,
    sessionId: input.sessionId,
    role: "user",
    content: input.content
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

function parsePayload(result: { content: string }): any {
  return JSON.parse(result.content);
}
