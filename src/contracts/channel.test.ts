import { describe, expect, it } from "vitest";
import type {
  ChannelDelivery,
  ChannelStreamingTextHandle,
  ChannelStreamingTextResult
} from "./channel.js";

describe("ChannelDelivery streaming contract", () => {
  it("exposes an optional session-scoped streaming text handle", async () => {
    const result: ChannelStreamingTextResult = {
      delivered: true,
      fallbackRequired: false,
      deliveredText: "hello"
    };
    const handle: ChannelStreamingTextHandle = {
      append: () => undefined,
      segmentBreak: () => undefined,
      providerAttemptResult: () => undefined,
      finish: async () => result,
      abort: async () => undefined
    };
    const delivery: ChannelDelivery = {
      sendText: async () => undefined,
      startStreamingText: (sessionKey, options) => {
        expect(sessionKey.platform).toBe("telegram");
        expect(options?.cursor).toBe("▌");
        return handle;
      }
    };

    const stream = delivery.startStreamingText?.(
      { platform: "telegram", chatId: "123" },
      { cursor: "▌" }
    );

    stream?.append("hello");
    expect(await stream?.finish("hello")).toEqual(result);
  });
});
