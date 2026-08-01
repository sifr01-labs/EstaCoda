import type {
  ChannelAdapter,
  ChannelAttachment,
  ChannelDelivery,
  ChannelKind,
  ChannelSessionKey,
  ChannelTextOptions
} from "../../contracts/channel.js";
import type { ArtifactRecord } from "../../contracts/artifact.js";
import type { RuntimeEvent } from "../../contracts/runtime-event.js";

export type FakeDeliveryRecord = {
  kind: "text" | "progress" | "artifact";
  sessionKey: ChannelSessionKey;
  text?: string;
  event?: RuntimeEvent;
  artifact?: ArtifactRecord;
  options?: ChannelTextOptions;
  timestamp: string;
};

export type FakeChannelAdapterOptions = {
  kind: ChannelKind;
  shouldFailDelivery?: boolean;
  failureMessage?: string;
};

export function createFakeChannelAdapter(options: FakeChannelAdapterOptions): ChannelAdapter {
  const records: FakeDeliveryRecord[] = [];

  const delivery: ChannelDelivery = {
    sendText: async (sessionKey: ChannelSessionKey, text: string, opts?: ChannelTextOptions) => {
      if (options.shouldFailDelivery) {
        throw new Error(options.failureMessage ?? `${options.kind} delivery failed`);
      }
      records.push({
        kind: "text",
        sessionKey: { ...sessionKey },
        text,
        options: opts,
        timestamp: new Date().toISOString()
      });
    },
    sendProgress: async (sessionKey: ChannelSessionKey, event: RuntimeEvent) => {
      if (options.shouldFailDelivery) {
        throw new Error(options.failureMessage ?? `${options.kind} progress failed`);
      }
      records.push({
        kind: "progress",
        sessionKey: { ...sessionKey },
        event,
        timestamp: new Date().toISOString()
      });
    },
    sendArtifact: async (sessionKey: ChannelSessionKey, artifact: ArtifactRecord) => {
      if (options.shouldFailDelivery) {
        throw new Error(options.failureMessage ?? `${options.kind} artifact failed`);
      }
      records.push({
        kind: "artifact",
        sessionKey: { ...sessionKey },
        artifact,
        timestamp: new Date().toISOString()
      });
      return { status: "delivered" as const, method: "native-upload" as const };
    }
  };

  const adapter: ChannelAdapter & { records: FakeDeliveryRecord[]; clearRecords(): void } = {
    kind: options.kind,
    delivery,
    records,
    clearRecords() {
      records.length = 0;
    }
  };

  return adapter;
}
