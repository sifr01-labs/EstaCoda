import type { ArtifactRecord } from "../contracts/artifact.js";
import type {
  ChannelAdapter,
  ChannelKind,
  ChannelMessage,
  ChannelReply,
  ChannelSessionKey
} from "../contracts/channel.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";

export type MockChannelDelivery = {
  type: "text" | "progress" | "artifact" | "legacy-reply";
  sessionKey: ChannelSessionKey;
  text?: string;
  event?: RuntimeEvent;
  artifact?: ArtifactRecord;
  reply?: ChannelReply;
};

export class MockChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly kind: ChannelKind;
  readonly deliveries: MockChannelDelivery[] = [];
  #handler: ((message: ChannelMessage) => Promise<void>) | undefined;

  readonly delivery = {
    sendText: async (sessionKey: ChannelSessionKey, text: string) => {
      this.deliveries.push({ type: "text", sessionKey, text });
    },
    sendProgress: async (sessionKey: ChannelSessionKey, event: RuntimeEvent) => {
      this.deliveries.push({ type: "progress", sessionKey, event });
    },
    sendArtifact: async (sessionKey: ChannelSessionKey, artifact: ArtifactRecord) => {
      this.deliveries.push({ type: "artifact", sessionKey, artifact });
    }
  };

  constructor(options: {
    id?: string;
    kind: ChannelKind;
  }) {
    this.id = options.id ?? options.kind;
    this.kind = options.kind;
  }

  async start(handler: (message: ChannelMessage) => Promise<void>): Promise<void> {
    this.#handler = handler;
  }

  async emit(message: ChannelMessage): Promise<void> {
    if (this.#handler === undefined) {
      throw new Error("MockChannelAdapter has not been started");
    }

    await this.#handler(message);
  }

  async send(reply: ChannelReply): Promise<void> {
    this.deliveries.push({
      type: "legacy-reply",
      sessionKey: reply.sessionKey ?? {
        platform: this.kind,
        chatId: reply.conversationId
      },
      reply
    });
  }
}
