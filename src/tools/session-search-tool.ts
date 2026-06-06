import type { SessionDB } from "../contracts/session.js";
import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import {
  SESSION_SEARCH_UNTRUSTED_LABEL,
  SessionSearchService,
  type SessionSearchBrowseOptions,
  type SessionSearchMessageOptions,
  type SessionSearchScrollOptions
} from "../session/session-search-service.js";

export const SESSION_SEARCH_TOOL_MAX_RESULT_CHARS = 20_000;

type SessionSearchInput =
  | {
      mode: "browse";
      limit?: number;
      sort?: "newest" | "oldest";
    }
  | {
      mode: "search";
      query: string;
      limit?: number;
      sort?: "newest" | "oldest" | "rank";
      role_filter?: Array<"user" | "agent" | "tool" | "system">;
    }
  | {
      mode: "scroll";
      session_id: string;
      around_message_id: string;
      window?: number;
    };

export type SessionSearchToolOptions = {
  sessionDb?: Pick<SessionDB, "listSessions" | "getSession" | "listMessages" | "search">;
  profileId?: string;
  workspaceRoot?: string;
  currentSessionId?: string | (() => string);
};

export function createSessionSearchTool(options: SessionSearchToolOptions): RegisteredTool<SessionSearchInput> {
  return {
    name: "session_search",
    description:
      "Browse, search, or scroll raw historical session messages as bounded untrusted reference context. This is deterministic and does not summarize.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["browse", "search", "scroll"] },
        query: { type: "string" },
        session_id: { type: "string" },
        around_message_id: { type: "string" },
        limit: { type: "number" },
        sort: { type: "string", enum: ["newest", "oldest", "rank"] },
        role_filter: {
          type: "array",
          items: { type: "string", enum: ["user", "agent", "tool", "system"] }
        },
        window: { type: "number" }
      },
      required: ["mode"],
      oneOf: [
        {
          properties: {
            mode: { const: "browse" },
            limit: { type: "number" },
            sort: { type: "string", enum: ["newest", "oldest"] }
          },
          required: ["mode"],
          additionalProperties: false
        },
        {
          properties: {
            mode: { const: "search" },
            query: { type: "string" },
            limit: { type: "number" },
            sort: { type: "string", enum: ["newest", "oldest", "rank"] },
            role_filter: {
              type: "array",
              items: { type: "string", enum: ["user", "agent", "tool", "system"] }
            }
          },
          required: ["mode", "query"],
          additionalProperties: false
        },
        {
          properties: {
            mode: { const: "scroll" },
            session_id: { type: "string" },
            around_message_id: { type: "string" },
            window: { type: "number" }
          },
          required: ["mode", "session_id", "around_message_id"],
          additionalProperties: false
        }
      ]
    },
    riskClass: "read-only-local",
    toolsets: ["core", "memory"],
    progressLabel: "searching sessions",
    maxResultSizeChars: SESSION_SEARCH_TOOL_MAX_RESULT_CHARS,
    isAvailable: () => true,
    run: async (input) => runSessionSearchTool(input, options)
  };
}

export const sessionSearchToolProvider: SessionToolProvider = {
  name: "sessionSearch",
  kind: "session",
  createTools(ctx) {
    return [
      createSessionSearchTool({
        sessionDb: ctx.sessionDb,
        profileId: ctx.profileId,
        workspaceRoot: ctx.workspaceRoot,
        currentSessionId: ctx.currentSessionId
      })
    ];
  }
};

async function runSessionSearchTool(input: SessionSearchInput, options: SessionSearchToolOptions): Promise<ToolResult> {
  if (options.sessionDb === undefined) {
    return {
      ok: false,
      content: "session_search requires sessionDb.",
      metadata: {
        error: "missing-session-db",
        dependency: "sessionDb"
      }
    };
  }

  const service = new SessionSearchService({ sessionDb: options.sessionDb });
  if (input.mode === "browse") {
    return toolResult(await service.browseRecentSessions(browseOptions(input, options)));
  }
  if (input.mode === "search") {
    return toolResult(await service.searchMessages(searchOptions(input, options)));
  }
  if (input.mode === "scroll") {
    const result = await service.scrollAroundMessage(scrollOptions(input, options));
    return toolResult(result, { ok: result.ok });
  }

  return {
    ok: false,
    content: "session_search requires mode to be browse, search, or scroll.",
    metadata: {
      error: "invalid-mode"
    }
  };
}

function browseOptions(input: Extract<SessionSearchInput, { mode: "browse" }>, options: SessionSearchToolOptions): SessionSearchBrowseOptions {
  return {
    profileId: options.profileId,
    workspaceRoot: options.workspaceRoot,
    excludeSessionIds: excludedSessionIds(options),
    limit: input.limit,
    sort: input.sort
  };
}

function searchOptions(input: Extract<SessionSearchInput, { mode: "search" }>, options: SessionSearchToolOptions): SessionSearchMessageOptions {
  return {
    query: input.query,
    profileId: options.profileId,
    workspaceRoot: options.workspaceRoot,
    excludeSessionIds: excludedSessionIds(options),
    limit: input.limit,
    sort: input.sort,
    roleFilter: input.role_filter
  };
}

function scrollOptions(input: Extract<SessionSearchInput, { mode: "scroll" }>, options: SessionSearchToolOptions): SessionSearchScrollOptions {
  return {
    sessionId: input.session_id,
    aroundMessageId: input.around_message_id,
    profileId: options.profileId,
    workspaceRoot: options.workspaceRoot,
    window: input.window
  };
}

function excludedSessionIds(options: SessionSearchToolOptions): string[] {
  const currentSessionId = typeof options.currentSessionId === "function"
    ? options.currentSessionId()
    : options.currentSessionId;
  return currentSessionId === undefined ? [] : [currentSessionId];
}

function toolResult(payload: unknown, options: { ok?: boolean } = {}): ToolResult {
  const content = JSON.stringify(payload, null, 2);
  if (content.length > SESSION_SEARCH_TOOL_MAX_RESULT_CHARS) {
    const truncatedContent = renderTruncatedResult(content);
    return {
      ok: options.ok ?? true,
      content: truncatedContent,
      metadata: {
        resultChars: content.length,
        truncated: true
      }
    };
  }
  return {
    ok: options.ok ?? true,
    content,
    metadata: {
      resultChars: content.length
    }
  };
}

function renderTruncatedResult(content: string): string {
  let previewChars = Math.max(0, SESSION_SEARCH_TOOL_MAX_RESULT_CHARS - 1_000);
  while (previewChars >= 0) {
    const rendered = JSON.stringify({
      truncated: true,
      maxResultSizeChars: SESSION_SEARCH_TOOL_MAX_RESULT_CHARS,
      originalResultChars: content.length,
      untrustedLabel: SESSION_SEARCH_UNTRUSTED_LABEL,
      preview: content.slice(0, previewChars)
    }, null, 2);
    if (rendered.length <= SESSION_SEARCH_TOOL_MAX_RESULT_CHARS) {
      return rendered;
    }
    previewChars -= 500;
  }
  return JSON.stringify({
    truncated: true,
    maxResultSizeChars: SESSION_SEARCH_TOOL_MAX_RESULT_CHARS,
    originalResultChars: content.length
  }, null, 2);
}
