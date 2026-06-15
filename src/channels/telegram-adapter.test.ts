import { afterEach, describe, it, expect, vi } from "vitest";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramAdapter, TelegramApiError, updateToChannelMessage } from "./telegram-adapter.js";
import { buildAdapterCapability } from "./adapter-capability.js";
import { AdapterRegistry } from "./adapter-registry.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { renderApprovalActions } from "./approval-actions.js";
import { modelPickerSelectActionKey, renderModelPickerActions } from "./model-picker-actions.js";
import type { ArtifactRecord } from "../contracts/artifact.js";

function createTelegramTextHarness(options: { failOnSendMessage?: number } = {}): {
  adapter: TelegramAdapter;
  bodies: Array<Record<string, unknown>>;
} {
  const bodies: Array<Record<string, unknown>> = [];
  let sendMessageCount = 0;
  const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.endsWith("/sendMessage")) {
      sendMessageCount += 1;
      bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);

      if (sendMessageCount === options.failOnSendMessage) {
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          json: async () => ({ ok: false, description: "message is too long" })
        };
      }
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: sendMessageCount } })
    };
  });

  return {
    adapter: new TelegramAdapter({ botToken: "test-token", fetch }),
    bodies
  };
}

function sentText(body: Record<string, unknown>): string {
  return String(body.text ?? "");
}

type TelegramHarnessCall = {
  method: string;
  body: Record<string, unknown>;
};

type TelegramHarnessFailure = {
  status?: number;
  statusText?: string;
  errorCode?: number;
  description?: string;
  retryAfterSeconds?: number;
};

function createTelegramStreamingHarness(options: {
  failMethods?: Partial<Record<string, number[]>>;
  failResponses?: Partial<Record<string, Record<number, TelegramHarnessFailure>>>;
} = {}): {
  adapter: TelegramAdapter;
  calls: TelegramHarnessCall[];
  fetch: ReturnType<typeof vi.fn>;
} {
  const calls: TelegramHarnessCall[] = [];
  const methodCounts = new Map<string, number>();
  let nextMessageId = 1;
  const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
    const method = url.split("/").at(-1) ?? "";
    const count = (methodCounts.get(method) ?? 0) + 1;
    methodCounts.set(method, count);
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ method, body });

    const failure = options.failResponses?.[method]?.[count];
    if (failure !== undefined) {
      return {
        ok: false,
        status: failure.status ?? 400,
        statusText: failure.statusText ?? "Bad Request",
        json: async () => ({
          ok: false,
          error_code: failure.errorCode,
          description: failure.description ?? `${method} failed`,
          parameters: failure.retryAfterSeconds === undefined
            ? undefined
            : { retry_after: failure.retryAfterSeconds }
        })
      };
    }

    if (options.failMethods?.[method]?.includes(count)) {
      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ ok: false, description: `${method} failed` })
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: method === "sendMessage"
          ? { message_id: nextMessageId++ }
          : { message_id: Number(body.message_id ?? nextMessageId - 1) }
      })
    };
  });

  return {
    adapter: new TelegramAdapter({ botToken: "test-token", fetch }),
    calls,
    fetch
  };
}

async function flushTelegramStreamingTimers(): Promise<void> {
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
}

function callsFor(calls: TelegramHarnessCall[], method: string): TelegramHarnessCall[] {
  return calls.filter((call) => call.method === method);
}

describe("TelegramAdapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("getCapabilities exists and returns correct kind", () => {
    const adapter = new TelegramAdapter({ botToken: "test-token" });
    expect(typeof adapter.getCapabilities).toBe("function");
    const cap = adapter.getCapabilities!();
    expect(cap.kind).toBe("telegram");
  });

  it("getCapabilities returns live_proven traits", () => {
    const adapter = new TelegramAdapter({ botToken: "test-token", enabled: true });
    const cap = adapter.getCapabilities!();
    expect(cap.enabled).toBe(true);
    expect(cap.configured).toBe(true);
    expect(cap.inboundMode).toBe("polling");
    expect(cap.outboundMode).toBe("push");
    expect(cap.supportsAttachments).toBe(true);
    expect(cap.supportsThreads).toBe(true);
    expect(cap.supportsApprovals).toBe(true);
    expect(cap.supportsProgressStreaming).toBe(true);
    expect(cap.experimental).toBe(false);
    expect(cap.implementationStatus).toBe("live_proven");
  });

  it("getCapabilities reflects missing config", () => {
    const adapter = new TelegramAdapter({
      botToken: "test-token",
      enabled: true,
      missing: ["BOT_TOKEN_ENV"],
    });
    const cap = adapter.getCapabilities!();
    expect(cap.enabled).toBe(true);
    expect(cap.configured).toBe(false);
    expect(cap.missingConfig).toEqual(["BOT_TOKEN_ENV"]);
  });

  it("getCapabilities delegates to shared builder", () => {
    const adapter = new TelegramAdapter({
      botToken: "test-token",
      enabled: false,
      defaultChatId: "123",
      missing: ["BOT_TOKEN_ENV"],
    });
    const cap = adapter.getCapabilities!();
    const expected = buildAdapterCapability({
      kind: "telegram",
      config: {
        enabled: false,
        defaultChatId: "123",
      },
      missing: ["BOT_TOKEN_ENV"],
    });
    expect(cap).toEqual(expected);
  });

  it("getCapabilities matches registry output for same normalized config", () => {
    const channels = {
      telegram: {
        enabled: true,
        ready: false,
        botTokenEnv: "BOT_TOKEN",
        missing: ["BOT_TOKEN_ENV"],
      },
      discord: { enabled: false, ready: false },
      email: { enabled: false, ready: false },
      whatsapp: { enabled: false, ready: false, experimental: false },
    } as unknown as LoadedRuntimeConfig["channels"];

    const adapter = new TelegramAdapter({
      botToken: "test-token",
      enabled: true,
      missing: ["BOT_TOKEN_ENV"],
    });

    const registry = new AdapterRegistry(channels);
    expect(adapter.getCapabilities!()).toEqual(registry.get("telegram"));
  });

  it("renders generic actions as Telegram inline keyboard buttons", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } })
      };
    });
    const adapter = new TelegramAdapter({ botToken: "test-token", fetch });
    const actions = renderApprovalActions("gateway-approval-1");

    await adapter.delivery.sendText({ platform: "telegram", chatId: "123" }, "approve?", { actions });

    expect(bodies[0]?.reply_markup).toEqual({
      inline_keyboard: actions.map((row) =>
        row.map((action) => ({
          text: action.label,
          callback_data: action.value
        }))
      )
    });
    expect(JSON.stringify(bodies[0]?.reply_markup)).not.toContain("rm -rf");
  });

  it("delivery.sendText sends short messages once", async () => {
    const { adapter, bodies } = createTelegramTextHarness();

    await adapter.delivery.sendText({ platform: "telegram", chatId: "123" }, "short reply");

    expect(bodies).toHaveLength(1);
    expect(sentText(bodies[0])).toBe("short reply");
    expect(bodies[0]?.parse_mode).toBe("HTML");
  });

  it("delivery.sendText chunks long plain messages", async () => {
    const { adapter, bodies } = createTelegramTextHarness();

    await adapter.delivery.sendText(
      { platform: "telegram", chatId: "123" },
      "A ".repeat(5_000),
      { format: "plain" }
    );

    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(sentText(body).length).toBeLessThanOrEqual(4096);
    }
    expect(sentText(bodies[0])).toMatch(/ \(1\/\d+\)$/u);
  });

  it("delivery.sendText measures emoji as UTF-16 code units", async () => {
    const { adapter, bodies } = createTelegramTextHarness();

    await adapter.delivery.sendText(
      { platform: "telegram", chatId: "123" },
      "🙂".repeat(3_000),
      { format: "plain" }
    );

    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(sentText(body).length).toBeLessThanOrEqual(4096);
      expect(sentText(body)).not.toContain("\uFFFD");
    }
  });

  it("delivery.sendText chunks after default HTML formatting expands text", async () => {
    const { adapter, bodies } = createTelegramTextHarness();

    await adapter.delivery.sendText({ platform: "telegram", chatId: "123" }, "<>&".repeat(700));

    expect(bodies.length).toBeGreaterThan(1);
    expect(sentText(bodies[0])).toContain("&lt;&gt;&amp;");
    for (const body of bodies) {
      expect(body.parse_mode).toBe("HTML");
      expect(sentText(body).length).toBeLessThanOrEqual(4096);
    }
  });

  it("delivery.sendText avoids obvious broken HTML boundaries when chunking", async () => {
    const { adapter, bodies } = createTelegramTextHarness();

    await adapter.delivery.sendText({ platform: "telegram", chatId: "123" }, [
      "# Heading",
      "<>& ".repeat(1_000),
      "**bold text** ".repeat(800)
    ].join("\n"));

    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      const text = sentText(body);
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text).not.toMatch(/<\/?[^>]*$/u);
      expect(text).not.toMatch(/&[^;\s]{0,20}$/u);
    }
  });

  it("delivery.sendText chunks long code fences without oversized payloads", async () => {
    const { adapter, bodies } = createTelegramTextHarness();
    const code = [
      "```ts",
      "const ok = value < limit && other > floor;".repeat(600),
      "```"
    ].join("\n");

    await adapter.delivery.sendText({ platform: "telegram", chatId: "123" }, code);

    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      const text = sentText(body);
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text).not.toMatch(/<\/?[^>]*$/u);
      expect(text).not.toMatch(/&[^;\s]{0,20}$/u);
    }
  });

  it("delivery.sendText attaches inline actions only to the final chunk", async () => {
    const { adapter, bodies } = createTelegramTextHarness();
    const actions = renderApprovalActions("gateway-approval-1");

    await adapter.delivery.sendText(
      { platform: "telegram", chatId: "123" },
      "Approve this ".repeat(1_000),
      { actions }
    );

    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies.slice(0, -1)) {
      expect(body.reply_markup).toBeUndefined();
    }
    expect(bodies.at(-1)?.reply_markup).toEqual({
      inline_keyboard: actions.map((row) =>
        row.map((action) => ({
          text: action.label,
          callback_data: action.value
        }))
      )
    });
  });

  it("delivery.sendText rejects on a failed chunk and does not send later chunks", async () => {
    const { adapter, bodies } = createTelegramTextHarness({ failOnSendMessage: 2 });

    await expect(adapter.delivery.sendText(
      { platform: "telegram", chatId: "123" },
      "Failure chunk ".repeat(2_000),
      { format: "plain" }
    )).rejects.toThrow("Telegram sendMessage failed: message is too long");

    expect(bodies).toHaveLength(2);
  });

  it("preserves structured Telegram API error metadata", async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: async () => ({
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 12",
        parameters: { retry_after: 12 }
      })
    }));
    const adapter = new TelegramAdapter({ botToken: "test-token", fetch });

    let caught: unknown;
    try {
      await adapter.delivery.sendText({ platform: "telegram", chatId: "123" }, "rate limited");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TelegramApiError);
    expect(caught).toMatchObject({
      method: "sendMessage",
      httpStatus: 429,
      telegramErrorCode: 429,
      description: "Too Many Requests: retry after 12",
      retryAfterSeconds: 12,
      message: "Telegram sendMessage failed: Too Many Requests: retry after 12"
    });
  });

  it("delivery.startStreamingText append is synchronous and does not await fetch", () => {
    vi.useFakeTimers();
    const { adapter, fetch } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1
    });

    handle.append("hello");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("delivery.startStreamingText threshold prevents tiny messages", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 10
    });

    handle.append("tiny");
    await flushTelegramStreamingTimers();
    const result = await handle.finish("tiny");

    expect(calls).toHaveLength(0);
    expect(result).toEqual({ delivered: false, fallbackRequired: true });
  });

  it("delivery.startStreamingText first send uses HTML parse mode and a cursor", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      cursor: "|"
    });

    handle.append("hello <world>");
    await flushTelegramStreamingTimers();

    expect(callsFor(calls, "sendMessage")[0]?.body).toMatchObject({
      chat_id: "123",
      text: "hello &lt;world&gt;|",
      parse_mode: "HTML"
    });
  });

  it("delivery.startStreamingText edits with HTML parse mode on the configured cadence", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      editIntervalMs: 50,
      cursor: "|"
    });

    handle.append("hello");
    await flushTelegramStreamingTimers();
    handle.append(" & ");
    expect(callsFor(calls, "editMessageText")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(50);

    expect(callsFor(calls, "editMessageText")[0]?.body).toMatchObject({
      chat_id: "123",
      message_id: 1,
      text: "hello &amp; |",
      parse_mode: "HTML"
    });
  });

  it("delivery.startStreamingText segmentBreak removes cursor and seals the message", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      cursor: "|"
    });

    handle.append("first");
    await flushTelegramStreamingTimers();
    handle.segmentBreak("tool-start");
    await flushTelegramStreamingTimers();

    expect(callsFor(calls, "editMessageText").at(-1)?.body).toMatchObject({
      message_id: 1,
      text: "first",
      parse_mode: "HTML"
    });
  });

  it("delivery.startStreamingText segmentBreak rotates progress state for the chat", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    await adapter.delivery.sendProgress!({ platform: "telegram", chatId: "123" }, {
      kind: "tool-start",
      tool: "search"
    });
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      cursor: "|"
    });

    handle.append("first");
    await flushTelegramStreamingTimers();
    handle.segmentBreak("tool-start");
    await flushTelegramStreamingTimers();
    await adapter.delivery.sendProgress!({ platform: "telegram", chatId: "123" }, {
      kind: "tool-start",
      tool: "terminal.run"
    });

    expect(calls.at(-1)?.method).toBe("sendMessage");
    expect(calls.at(-1)?.body.text).toContain("terminal.run");
  });

  it("delivery.startStreamingText append after segmentBreak starts a new Telegram message", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      cursor: "|"
    });

    handle.append("first");
    await flushTelegramStreamingTimers();
    handle.segmentBreak("tool-start");
    await flushTelegramStreamingTimers();
    handle.append("second");
    await flushTelegramStreamingTimers();

    expect(callsFor(calls, "sendMessage").map((call) => call.body.text)).toEqual(["first|", "second|"]);
  });

  it("delivery.startStreamingText finish never edits sealed earlier segments", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      cursor: "|"
    });

    handle.append("first");
    await flushTelegramStreamingTimers();
    handle.segmentBreak("tool-start");
    await flushTelegramStreamingTimers();
    const editsAfterSeal = callsFor(calls, "editMessageText").length;
    handle.append("second");
    await flushTelegramStreamingTimers();

    await handle.finish("final **answer**");

    const finishEdits = callsFor(calls, "editMessageText").slice(editsAfterSeal);
    expect(finishEdits).toHaveLength(1);
    expect(finishEdits[0]?.body.message_id).toBe(2);
  });

  it("delivery.startStreamingText finish finalizes only the current live segment", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1
    });

    handle.append("draft");
    await flushTelegramStreamingTimers();

    const result = await handle.finish("final <answer>");

    expect(result).toEqual({
      delivered: true,
      fallbackRequired: false,
      deliveredText: "final <answer>"
    });
    expect(callsFor(calls, "editMessageText").at(-1)?.body).toMatchObject({
      message_id: 1,
      text: "final &lt;answer&gt;",
      parse_mode: "HTML"
    });
  });

  it("delivery.startStreamingText finish returns fallback when there is no live final segment", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 10
    });

    handle.append("tiny");
    const result = await handle.finish("final");

    expect(result).toEqual({ delivered: false, fallbackRequired: true });
    expect(calls).toHaveLength(0);
  });

  it("delivery.startStreamingText final chunking edits live message chunk 1 and sends later chunks", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1
    });

    handle.append("draft");
    await flushTelegramStreamingTimers();

    const result = await handle.finish("<>&".repeat(1_500));

    expect(result.fallbackRequired).toBe(false);
    expect(callsFor(calls, "editMessageText")[0]?.body.message_id).toBe(1);
    expect(callsFor(calls, "sendMessage").length).toBeGreaterThan(1);
    for (const call of callsFor(calls, "sendMessage").slice(1)) {
      expect(call.body.parse_mode).toBe("HTML");
    }
  });

  it("delivery.startStreamingText failed provider attempt deletes current live provisional message", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1
    });

    handle.append("draft");
    await flushTelegramStreamingTimers();
    handle.providerAttemptResult({ ok: false, willFallback: false, provider: "p", model: "m" });
    await flushTelegramStreamingTimers();
    const result = await handle.finish("final");

    expect(callsFor(calls, "deleteMessage")[0]?.body).toMatchObject({
      chat_id: "123",
      message_id: 1
    });
    expect(result.fallbackRequired).toBe(true);
  });

  it("delivery.startStreamingText fallback provider attempt deletes current live provisional message", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1
    });

    handle.append("draft");
    await flushTelegramStreamingTimers();
    handle.providerAttemptResult({ ok: true, willFallback: true, provider: "p", model: "m" });
    await flushTelegramStreamingTimers();

    expect(callsFor(calls, "deleteMessage")[0]?.body.message_id).toBe(1);
  });

  it("delivery.startStreamingText delete failure neutralizes and requires fallback", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness({
      failMethods: { deleteMessage: [1] }
    });
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1
    });

    handle.append("draft");
    await flushTelegramStreamingTimers();
    handle.providerAttemptResult({ ok: false, willFallback: false, provider: "p", model: "m" });
    await flushTelegramStreamingTimers();
    const result = await handle.finish("final");

    expect(callsFor(calls, "editMessageText").at(-1)?.body).toMatchObject({
      message_id: 1,
      text: "Response interrupted. A complete reply will follow.",
      parse_mode: "HTML"
    });
    expect(result.fallbackRequired).toBe(true);
  });

  it("delivery.startStreamingText finish is idempotent", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1
    });

    handle.append("draft");
    await flushTelegramStreamingTimers();
    const first = await handle.finish("final");
    const second = await handle.finish("final");

    expect(second).toBe(first);
    expect(callsFor(calls, "editMessageText")).toHaveLength(1);
  });

  it("delivery.startStreamingText abort is idempotent", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      cursor: "|"
    });

    handle.append("draft");
    await flushTelegramStreamingTimers();
    await handle.abort("stop");
    await handle.abort("stop");

    expect(callsFor(calls, "editMessageText")).toHaveLength(1);
    expect(callsFor(calls, "editMessageText")[0]?.body.text).toBe("draft");
  });

  it("delivery.startStreamingText append after finish or abort is ignored", async () => {
    vi.useFakeTimers();
    const finished = createTelegramStreamingHarness();
    const finishedHandle = finished.adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1
    });
    await finishedHandle.finish("final");
    finishedHandle.append("ignored");
    await flushTelegramStreamingTimers();

    const aborted = createTelegramStreamingHarness();
    const abortedHandle = aborted.adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1
    });
    await abortedHandle.abort("stop");
    abortedHandle.append("ignored");
    await flushTelegramStreamingTimers();

    expect(finished.calls).toHaveLength(0);
    expect(aborted.calls).toHaveLength(0);
  });

  it("delivery.startStreamingText captures worker errors without unhandled failures", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness({
      failMethods: { sendMessage: [1] }
    });
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1
    });

    handle.append("draft");
    await flushTelegramStreamingTimers();
    const result = await handle.finish("final");

    expect(callsFor(calls, "sendMessage")).toHaveLength(1);
    expect(result).toEqual({ delivered: false, fallbackRequired: true });
  });

  it("delivery.startStreamingText retries 429 partial sends using retry_after", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness({
      failResponses: {
        sendMessage: {
          1: {
            status: 429,
            statusText: "Too Many Requests",
            errorCode: 429,
            description: "Too Many Requests: retry after 2",
            retryAfterSeconds: 2
          }
        }
      }
    });
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      maxFloodStrikes: 2
    });

    handle.append("draft");
    await vi.advanceTimersByTimeAsync(0);
    expect(callsFor(calls, "sendMessage")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(callsFor(calls, "sendMessage")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(callsFor(calls, "sendMessage")).toHaveLength(2);
    const result = await handle.finish("final");

    expect(result.fallbackRequired).toBe(false);
  });

  it("delivery.startStreamingText exceeds max flood strikes and requires fallback", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness({
      failResponses: {
        sendMessage: {
          1: { status: 429, errorCode: 429, description: "retry after 1", retryAfterSeconds: 1 },
          2: { status: 429, errorCode: 429, description: "retry after 1", retryAfterSeconds: 1 }
        }
      }
    });
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      maxFloodStrikes: 1
    });

    handle.append("draft");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    handle.append(" ignored");
    await flushTelegramStreamingTimers();
    const result = await handle.finish("final");

    expect(callsFor(calls, "sendMessage")).toHaveLength(2);
    expect(result).toEqual({ delivered: false, fallbackRequired: true });
  });

  it("delivery.startStreamingText flood degradation stops future partial edits", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness({
      failResponses: {
        editMessageText: {
          1: { status: 429, errorCode: 429, description: "retry after 1", retryAfterSeconds: 1 },
          2: { status: 429, errorCode: 429, description: "retry after 1", retryAfterSeconds: 1 }
        }
      }
    });
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      editIntervalMs: 10,
      maxFloodStrikes: 1
    });

    handle.append("draft");
    await flushTelegramStreamingTimers();
    handle.append(" edit");
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1_000);
    handle.append(" ignored");
    await flushTelegramStreamingTimers();
    const result = await handle.finish("final");

    expect(callsFor(calls, "editMessageText")).toHaveLength(2);
    expect(result.fallbackRequired).toBe(true);
  });

  it("delivery.startStreamingText overflowing edits split preview chunks and keeps the final tail live", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      cursor: "|"
    });

    handle.append("seed");
    await flushTelegramStreamingTimers();
    handle.append("A".repeat(9_000));
    await vi.advanceTimersByTimeAsync(750);
    handle.append(" tail");
    await vi.advanceTimersByTimeAsync(750);

    const sends = callsFor(calls, "sendMessage");
    const edits = callsFor(calls, "editMessageText");
    expect(sends).toHaveLength(3);
    expect(edits[0]?.body).toMatchObject({ message_id: 1, parse_mode: "HTML" });
    expect(String(edits[0]?.body.text)).not.toContain("|");
    expect(String(sends[1]?.body.text)).not.toContain("|");
    expect(String(sends[2]?.body.text)).toContain("|");
    expect(edits.at(-1)?.body).toMatchObject({ message_id: 3, parse_mode: "HTML" });
    expect(String(edits.at(-1)?.body.text)).toContain(" tail|");
  });

  it("delivery.startStreamingText segmentBreak after overflow seals the live tail without cursor", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      cursor: "|"
    });

    handle.append("seed");
    await flushTelegramStreamingTimers();
    handle.append("A".repeat(9_000));
    await vi.advanceTimersByTimeAsync(750);
    handle.segmentBreak("tool-start");
    await flushTelegramStreamingTimers();

    const lastEdit = callsFor(calls, "editMessageText").at(-1);
    expect(lastEdit?.body.message_id).toBe(3);
    expect(String(lastEdit?.body.text)).not.toContain("|");
  });

  it("delivery.startStreamingText abort after overflow strips cursor from the live tail", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      cursor: "|"
    });

    handle.append("seed");
    await flushTelegramStreamingTimers();
    handle.append("A".repeat(9_000));
    await vi.advanceTimersByTimeAsync(750);
    await handle.abort("stop");

    const lastEdit = callsFor(calls, "editMessageText").at(-1);
    expect(lastEdit?.body.message_id).toBe(3);
    expect(String(lastEdit?.body.text)).not.toContain("|");
  });

  it("delivery.startStreamingText failed provider attempt cleanup deletes every overflow preview message", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      cursor: "|"
    });

    handle.append("seed");
    await flushTelegramStreamingTimers();
    handle.append("A".repeat(9_000));
    await vi.advanceTimersByTimeAsync(750);
    handle.providerAttemptResult({ ok: false, willFallback: false, provider: "p", model: "m" });
    await flushTelegramStreamingTimers();

    expect(callsFor(calls, "deleteMessage").map((call) => call.body.message_id)).toEqual([1, 2, 3]);
  });

  it("delivery.startStreamingText cleanup neutralizes every overflow preview when delete fails", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness({
      failMethods: { deleteMessage: [1, 2, 3] }
    });
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      cursor: "|"
    });

    handle.append("seed");
    await flushTelegramStreamingTimers();
    handle.append("A".repeat(9_000));
    await vi.advanceTimersByTimeAsync(750);
    handle.providerAttemptResult({ ok: false, willFallback: false, provider: "p", model: "m" });
    await flushTelegramStreamingTimers();

    const neutralized = callsFor(calls, "editMessageText").filter((call) =>
      call.body.text === "Response interrupted. A complete reply will follow."
    );
    expect(neutralized.map((call) => call.body.message_id)).toEqual([1, 2, 3]);
  });

  it("delivery.startStreamingText retries mid-overflow 429 without losing committed preview IDs", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness({
      failResponses: {
        sendMessage: {
          2: { status: 429, errorCode: 429, description: "retry after 1", retryAfterSeconds: 1 }
        }
      }
    });
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      maxFloodStrikes: 2,
      cursor: "|"
    });

    handle.append("seed");
    await flushTelegramStreamingTimers();
    handle.append("A".repeat(9_000));
    await vi.advanceTimersByTimeAsync(750);

    expect(callsFor(calls, "editMessageText").map((call) => call.body.message_id)).toEqual([1]);
    expect(callsFor(calls, "sendMessage")).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1_000);
    handle.append(" after");
    await vi.advanceTimersByTimeAsync(750);

    expect(callsFor(calls, "editMessageText").map((call) => call.body.message_id)).toEqual([1, 3]);
    expect(String(callsFor(calls, "editMessageText").at(-1)?.body.text)).toContain(" after|");

    handle.providerAttemptResult({ ok: false, willFallback: false, provider: "p", model: "m" });
    await flushTelegramStreamingTimers();

    expect(callsFor(calls, "deleteMessage").map((call) => call.body.message_id)).toEqual([1, 2, 3]);
  });

  it("delivery.startStreamingText overflow splitting avoids escaped entities and surrogate pairs", async () => {
    vi.useFakeTimers();
    const { adapter: entityAdapter, calls: entityCalls } = createTelegramStreamingHarness();
    const entityHandle = entityAdapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      cursor: "|"
    });

    entityHandle.append(`${"A".repeat(4094)}&B`);
    await flushTelegramStreamingTimers();

    const entityTexts = callsFor(entityCalls, "sendMessage").map((call) => String(call.body.text));
    expect(entityTexts).toHaveLength(2);
    expect(entityTexts[0]).toBe("A".repeat(4094));
    expect(entityTexts[1]?.startsWith("&amp;B")).toBe(true);

    const { adapter: emojiAdapter, calls: emojiCalls } = createTelegramStreamingHarness();
    const emojiHandle = emojiAdapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      cursor: "|"
    });

    emojiHandle.append(`${"A".repeat(4095)}🙂B`);
    await flushTelegramStreamingTimers();

    const emojiTexts = callsFor(emojiCalls, "sendMessage").map((call) => String(call.body.text));
    expect(emojiTexts).toHaveLength(2);
    expect(emojiTexts[0]).toBe("A".repeat(4095));
    expect(emojiTexts[1]?.startsWith("🙂B")).toBe(true);
  });

  it("delivery.startStreamingText failed provider attempt cleanup stops pending edits", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      editIntervalMs: 50
    });

    handle.append("draft");
    await flushTelegramStreamingTimers();
    handle.append(" pending");
    handle.providerAttemptResult({ ok: false, willFallback: false, provider: "p", model: "m" });
    await flushTelegramStreamingTimers();

    expect(callsFor(calls, "deleteMessage")).toHaveLength(1);
    expect(callsFor(calls, "editMessageText")).toHaveLength(0);
  });

  it("delivery.startStreamingText fallback provider attempt cleanup stops pending edits", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      editIntervalMs: 50
    });

    handle.append("draft");
    await flushTelegramStreamingTimers();
    handle.append(" pending");
    handle.providerAttemptResult({ ok: true, willFallback: true, provider: "p", model: "m" });
    await flushTelegramStreamingTimers();

    expect(callsFor(calls, "deleteMessage")).toHaveLength(1);
    expect(callsFor(calls, "editMessageText")).toHaveLength(0);
  });

  it("delivery.startStreamingText repeated provider-result cleanup is idempotent", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1
    });

    handle.append("draft");
    await flushTelegramStreamingTimers();
    handle.providerAttemptResult({ ok: false, willFallback: false, provider: "p", model: "m" });
    handle.providerAttemptResult({ ok: false, willFallback: true, provider: "p", model: "m" });
    await flushTelegramStreamingTimers();

    expect(callsFor(calls, "deleteMessage")).toHaveLength(1);
  });

  it("delivery.startStreamingText cleanupFailedAttempts false skips cleanup but forces fallback", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      cleanupFailedAttempts: false
    });

    handle.append("draft");
    await flushTelegramStreamingTimers();
    handle.providerAttemptResult({ ok: false, willFallback: false, provider: "p", model: "m" });
    await flushTelegramStreamingTimers();
    const result = await handle.finish("final");

    expect(callsFor(calls, "deleteMessage")).toHaveLength(0);
    expect(callsFor(calls, "editMessageText")).toHaveLength(0);
    expect(result.fallbackRequired).toBe(true);
  });

  it("delivery.startStreamingText finish and abort are idempotent under concurrent calls", async () => {
    vi.useFakeTimers();
    const finishing = createTelegramStreamingHarness();
    const finishingHandle = finishing.adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1
    });
    finishingHandle.append("draft");
    await flushTelegramStreamingTimers();

    const [firstFinish, secondFinish] = await Promise.all([
      finishingHandle.finish("final"),
      finishingHandle.finish("final")
    ]);

    const aborting = createTelegramStreamingHarness();
    const abortingHandle = aborting.adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1
    });
    abortingHandle.append("draft");
    await flushTelegramStreamingTimers();
    await Promise.all([
      abortingHandle.abort("stop"),
      abortingHandle.abort("stop")
    ]);

    expect(secondFinish).toBe(firstFinish);
    expect(callsFor(finishing.calls, "editMessageText")).toHaveLength(1);
    expect(callsFor(aborting.calls, "editMessageText")).toHaveLength(1);
  });

  it("delivery.startStreamingText abort during retry clears retry and removes cursor when possible", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness({
      failResponses: {
        editMessageText: {
          1: { status: 429, errorCode: 429, description: "retry after 5", retryAfterSeconds: 5 }
        }
      }
    });
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      editIntervalMs: 10,
      maxFloodStrikes: 2,
      cursor: "|"
    });

    handle.append("draft");
    await flushTelegramStreamingTimers();
    handle.append(" pending");
    await vi.advanceTimersByTimeAsync(10);
    await handle.abort("stop");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(callsFor(calls, "editMessageText")).toHaveLength(2);
    expect(callsFor(calls, "editMessageText").at(-1)?.body.text).toBe("draft pending");
  });

  it("delivery.startStreamingText options signal abort triggers stream abort", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { adapter, calls } = createTelegramStreamingHarness();
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      cursor: "|",
      signal: controller.signal
    });

    handle.append("draft");
    await flushTelegramStreamingTimers();
    controller.abort();
    await flushTelegramStreamingTimers();

    expect(callsFor(calls, "editMessageText").at(-1)?.body.text).toBe("draft");
  });

  it("delivery.startStreamingText segmentBreak during retry does not edit sealed segments again", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = createTelegramStreamingHarness({
      failResponses: {
        editMessageText: {
          1: { status: 429, errorCode: 429, description: "retry after 5", retryAfterSeconds: 5 }
        }
      }
    });
    const handle = adapter.delivery.startStreamingText!({ platform: "telegram", chatId: "123" }, {
      minInitialChars: 1,
      editIntervalMs: 10,
      maxFloodStrikes: 2,
      cursor: "|"
    });

    handle.append("first");
    await flushTelegramStreamingTimers();
    handle.append(" pending");
    await vi.advanceTimersByTimeAsync(10);
    handle.segmentBreak("tool-start");
    await flushTelegramStreamingTimers();
    const editsAfterSeal = callsFor(calls, "editMessageText").length;
    handle.append("second");
    await flushTelegramStreamingTimers();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(callsFor(calls, "editMessageText")).toHaveLength(editsAfterSeal);
    expect(callsFor(calls, "sendMessage").map((call) => call.body.text)).toEqual(["first|", "second|"]);
  });

  it("turns callback query data into ChannelMessage text", () => {
    const value = renderApprovalActions("gateway-approval-1")[0][0].value;
    const message = updateToChannelMessage({
      update_id: 42,
      callback_query: {
        id: "callback-1",
        data: value,
        from: {
          id: "user-1",
          first_name: "Ada",
          username: "ada"
        },
        message: {
          message_id: 7,
          date: 1700000000,
          chat: {
            id: "chat-1",
            type: "private"
          }
        }
      }
    });

    expect(message?.text).toBe(value);
    expect(message?.sender.id).toBe("user-1");
    expect(message?.sessionKey).toMatchObject({
      platform: "telegram",
      chatId: "chat-1",
      userId: "user-1",
      chatType: "dm"
    });
  });

  it("round-trips model picker actions through Telegram callback text", () => {
    const value = renderModelPickerActions([
      { label: "phi4:latest", actionKey: modelPickerSelectActionKey("local", "phi4:latest"), kind: "select" }
    ])[0][0].value;
    const message = updateToChannelMessage({
      update_id: 43,
      callback_query: {
        id: "callback-2",
        data: value,
        from: {
          id: "user-1",
          first_name: "Ada",
          username: "ada"
        },
        message: {
          message_id: 8,
          date: 1700000000,
          chat: {
            id: "chat-1",
            type: "private"
          }
        }
      }
    });

    expect(message?.text).toBe(value);
    expect(message?.sessionKey.platform).toBe("telegram");
  });

  it("delivers voice-hinted OGG audio as a Telegram voice bubble", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } })
      };
    });
    const tempDir = await mkdtemp(join(tmpdir(), "estacoda-telegram-voice-"));
    try {
      const path = join(tempDir, "reply.ogg");
      await writeFile(path, "audio");
      const adapter = new TelegramAdapter({ botToken: "test-token", fetch });
      const artifact: ArtifactRecord = {
        id: "auto-tts-1",
        path,
        localPath: path,
        kind: "audio",
        bytes: 5,
        createdAt: new Date().toISOString(),
        mimeType: "audio/ogg",
        metadata: { deliveryHint: "voice", ephemeral: true }
      };

      await adapter.delivery.sendArtifact({ platform: "telegram", chatId: "123" }, artifact);

      expect(calls.some((url) => url.endsWith("/sendVoice"))).toBe(true);
      expect(calls.some((url) => url.endsWith("/sendAudio"))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves Telegram voice delivery for ordinary OGG audio artifacts", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } })
      };
    });
    const tempDir = await mkdtemp(join(tmpdir(), "estacoda-telegram-durable-voice-"));
    try {
      const path = join(tempDir, "manual.ogg");
      await writeFile(path, "audio");
      const adapter = new TelegramAdapter({ botToken: "test-token", fetch });
      const artifact: ArtifactRecord = {
        id: "voice-manual-1",
        path,
        localPath: path,
        kind: "audio",
        bytes: 5,
        createdAt: new Date().toISOString(),
        mimeType: "audio/ogg"
      };

      await adapter.delivery.sendArtifact({ platform: "telegram", chatId: "123" }, artifact);

      expect(calls.some((url) => url.endsWith("/sendVoice"))).toBe(true);
      expect(calls.some((url) => url.endsWith("/sendAudio"))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves Telegram voice delivery for ordinary OPUS audio artifacts without delivery hints", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } })
      };
    });
    const tempDir = await mkdtemp(join(tmpdir(), "estacoda-telegram-durable-opus-"));
    try {
      const path = join(tempDir, "manual.opus");
      await writeFile(path, "audio");
      const adapter = new TelegramAdapter({ botToken: "test-token", fetch });
      const artifact: ArtifactRecord = {
        id: "voice-manual-opus-1",
        path,
        localPath: path,
        kind: "audio",
        bytes: 5,
        createdAt: new Date().toISOString()
      };

      await adapter.delivery.sendArtifact({ platform: "telegram", chatId: "123" }, artifact);

      expect(calls.some((url) => url.endsWith("/sendVoice"))).toBe(true);
      expect(calls.some((url) => url.endsWith("/sendAudio"))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("converts non-OGG voice-hinted audio to Opus before Telegram voice delivery when ffmpeg is available", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } })
      };
    });
    const tempDir = await mkdtemp(join(tmpdir(), "estacoda-telegram-convert-"));
    try {
      const path = join(tempDir, "reply.mp3");
      const ffmpeg = join(tempDir, "ffmpeg");
      const logPath = join(tempDir, "ffmpeg.log");
      await writeFile(path, "audio");
      await writeFile(ffmpeg, [
        "#!/usr/bin/env bash",
        `echo "$@" >> ${JSON.stringify(logPath)}`,
        "printf opus > \"${!#}\""
      ].join("\n"), "utf8");
      await chmod(ffmpeg, 0o755);
      const adapter = new TelegramAdapter({
        botToken: "test-token",
        fetch,
        voiceTempRoot: join(tempDir, "voice-temp"),
        ffmpegPath: ffmpeg
      });
      const artifact: ArtifactRecord = {
        id: "auto-tts-mp3",
        path,
        localPath: path,
        kind: "audio",
        bytes: 5,
        createdAt: new Date().toISOString(),
        mimeType: "audio/mpeg",
        metadata: { deliveryHint: "voice", ephemeral: true }
      };

      await adapter.delivery.sendArtifact({ platform: "telegram", chatId: "123" }, artifact);

      expect(calls.some((url) => url.endsWith("/sendVoice"))).toBe(true);
      expect(calls.some((url) => url.endsWith("/sendAudio"))).toBe(false);
      const log = await readFile(logPath, "utf8");
      expect(log).toContain("-c:a libopus -b:a 24k");
      expect(await readdir(join(tempDir, "voice-temp"))).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to normal audio delivery for non-compatible voice-hinted audio", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } })
      };
    });
    const tempDir = await mkdtemp(join(tmpdir(), "estacoda-telegram-audio-"));
    try {
      const path = join(tempDir, "reply.mp3");
      await writeFile(path, "audio");
      const adapter = new TelegramAdapter({
        botToken: "test-token",
        fetch,
        voiceTempRoot: join(tempDir, "voice-temp"),
        ffmpegPath: join(tempDir, "missing-ffmpeg")
      });
      const artifact: ArtifactRecord = {
        id: "auto-tts-2",
        path,
        localPath: path,
        kind: "audio",
        bytes: 5,
        createdAt: new Date().toISOString(),
        mimeType: "audio/mpeg",
        metadata: { deliveryHint: "voice", ephemeral: true }
      };

      await adapter.delivery.sendArtifact({ platform: "telegram", chatId: "123" }, artifact);

      expect(calls.some((url) => url.endsWith("/sendAudio"))).toBe(true);
      expect(calls.some((url) => url.endsWith("/sendVoice"))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
