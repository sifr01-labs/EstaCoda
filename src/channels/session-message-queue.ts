import type { ChannelKind } from "../contracts/channel.js";
import type { ChannelMessage } from "../contracts/channel.js";
import {
  mergedTelegramAttributionMetadata,
  telegramAttributionMessageIds
} from "./telegram-message-attribution.js";

export type ChannelBusyPolicy = "reject" | "queue" | "interrupt";

export type BusyTextCoalescingPolicy = {
  enabled: boolean;
  windowMs: number;
  maxMessages: number;
  maxChars: number;
};

type CoalescedTextMessageReference = {
  id: string;
  receivedAt: string;
};

type QueuedTextCoalescingState = {
  messages: CoalescedTextMessageReference[];
  lastUpdatedAt: number;
  totalChars: number;
};

export type QueuedMessage = {
  /** The queued inbound message, possibly a bounded text composite. */
  message: ChannelMessage;
  /** Channel kind at enqueue time (derived from message.channel) */
  channelKind: ChannelKind;
  /** When this message was enqueued */
  enqueuedAt: number;
  /** The policy that was in effect when this message arrived */
  policyAtArrival: ChannelBusyPolicy;
  /** The queue depth limit that was in effect when this message arrived */
  queueDepthAtArrival: number;
  /** Gateway-owned provenance for optional bounded FIFO-tail text coalescing. */
  textCoalescing?: QueuedTextCoalescingState;
  /** Durable pending-turn identity when SQLite queue persistence is enabled. */
  durableTurnId?: string;
};

export type QueueEnqueueResult = {
  accepted: boolean;
  position?: number;
  rejectedBecauseFull?: boolean;
  coalesced?: boolean;
  duplicate?: boolean;
};

export type QueueMutation =
  | { kind: "enqueue"; queuedMessage: QueuedMessage }
  | {
      kind: "coalesce";
      previousQueuedMessage: QueuedMessage;
      queuedMessage: QueuedMessage;
      incomingMessage: ChannelMessage;
    };

export type QueueMutationCommit = {
  duplicate?: boolean;
  durableTurnId?: string;
};

export type BeforeQueueMutation = (mutation: QueueMutation) => QueueMutationCommit | undefined;

export class SessionMessageQueue {
  #queues = new Map<string, QueuedMessage[]>();

  enqueue(
    key: string,
    message: ChannelMessage,
    policyAtArrival: ChannelBusyPolicy,
    queueDepthAtArrival: number,
    beforeCommit?: BeforeQueueMutation
  ): QueueEnqueueResult {
    const queue = this.#queues.get(key) ?? [];
    if (queue.length >= queueDepthAtArrival) {
      return { accepted: false, rejectedBecauseFull: true };
    }
    const queuedMessage = this.#createQueuedMessage(message, policyAtArrival, queueDepthAtArrival);
    const commit = beforeCommit?.({ kind: "enqueue", queuedMessage });
    if (commit?.duplicate === true) {
      return { accepted: false, duplicate: true };
    }
    queuedMessage.durableTurnId = commit?.durableTurnId;
    queue.push(queuedMessage);
    this.#queues.set(key, queue);
    return { accepted: true, position: queue.length };
  }

  enqueueOrCoalesceText(
    key: string,
    message: ChannelMessage,
    policyAtArrival: ChannelBusyPolicy,
    queueDepthAtArrival: number,
    coalescing: BusyTextCoalescingPolicy,
    eligible: boolean,
    now = Date.now(),
    beforeCommit?: BeforeQueueMutation
  ): QueueEnqueueResult {
    if (!coalescing.enabled || policyAtArrival !== "queue") {
      return this.enqueue(key, message, policyAtArrival, queueDepthAtArrival, beforeCommit);
    }

    const queue = this.#queues.get(key) ?? [];
    const tail = queue.at(-1);
    if (
      eligible &&
      tail?.textCoalescing !== undefined &&
      tail.message.channel === message.channel &&
      tail.message.sender.id === message.sender.id
    ) {
      const separator = "\n\n";
      const combinedChars = tail.textCoalescing.totalChars + separator.length + message.text.length;
      const elapsedMs = now - tail.textCoalescing.lastUpdatedAt;
      const withinWindow = elapsedMs >= 0 && elapsedMs <= coalescing.windowMs;
      const withinMessageLimit = tail.textCoalescing.messages.length < coalescing.maxMessages;
      const withinCharacterLimit = combinedChars <= coalescing.maxChars;
      if (withinWindow && withinMessageLimit && withinCharacterLimit) {
        const messages = [
          ...tail.textCoalescing.messages,
          { id: message.id, receivedAt: message.receivedAt }
        ];
        const updatedTail: QueuedMessage = {
          ...tail,
          textCoalescing: {
            messages,
            lastUpdatedAt: now,
            totalChars: combinedChars
          },
          message: {
            ...tail.message,
            text: `${tail.message.text}${separator}${message.text}`,
            metadata: {
              ...(tail.message.metadata ?? {}),
              ...mergedTelegramAttributionMetadata(tail.message, telegramAttributionMessageIds(message)),
              busyTextCoalescedMessageIds: messages.map((item) => item.id),
              busyTextCoalescedReceivedAts: messages.map((item) => item.receivedAt),
              busyTextCoalescingSize: messages.length,
              busyTextCoalescingWindowMs: coalescing.windowMs,
            },
          }
        };
        const commit = beforeCommit?.({
          kind: "coalesce",
          previousQueuedMessage: tail,
          queuedMessage: updatedTail,
          incomingMessage: message
        });
        if (commit?.duplicate === true) {
          return { accepted: false, duplicate: true };
        }
        updatedTail.durableTurnId = commit?.durableTurnId ?? tail.durableTurnId;
        queue[queue.length - 1] = updatedTail;
        return { accepted: true, position: queue.length, coalesced: true };
      }
    }

    if (queue.length >= queueDepthAtArrival) {
      return { accepted: false, rejectedBecauseFull: true };
    }
    const queuedMessage = this.#createQueuedMessage(
      message,
      policyAtArrival,
      queueDepthAtArrival,
      eligible
        ? {
            messages: [{ id: message.id, receivedAt: message.receivedAt }],
            lastUpdatedAt: now,
            totalChars: message.text.length,
          }
        : undefined,
      now
    );
    const commit = beforeCommit?.({ kind: "enqueue", queuedMessage });
    if (commit?.duplicate === true) {
      return { accepted: false, duplicate: true };
    }
    queuedMessage.durableTurnId = commit?.durableTurnId;
    queue.push(queuedMessage);
    this.#queues.set(key, queue);
    return { accepted: true, position: queue.length, coalesced: false };
  }

  dequeue(key: string): QueuedMessage | undefined {
    const queue = this.#queues.get(key);
    if (queue === undefined || queue.length === 0) {
      return undefined;
    }
    const item = queue.shift();
    if (queue.length === 0) {
      this.#queues.delete(key);
    }
    return item;
  }

  peek(key: string): QueuedMessage | undefined {
    const queue = this.#queues.get(key);
    return queue?.[0];
  }

  size(key: string): number {
    return this.#queues.get(key)?.length ?? 0;
  }

  totalSize(): number {
    let total = 0;
    for (const queue of this.#queues.values()) {
      total += queue.length;
    }
    return total;
  }

  clear(key: string): void {
    this.#queues.delete(key);
  }

  list(key: string): QueuedMessage[] {
    return [...(this.#queues.get(key) ?? [])];
  }

  enqueueRecovered(key: string, queuedMessage: QueuedMessage): void {
    const queue = this.#queues.get(key) ?? [];
    queue.push(queuedMessage);
    this.#queues.set(key, queue);
  }

  unshift(
    key: string,
    message: ChannelMessage,
    policyAtArrival: ChannelBusyPolicy,
    queueDepthAtArrival: number,
    durableTurnId?: string
  ): void {
    const queue = this.#queues.get(key) ?? [];
    const queuedMessage = this.#createQueuedMessage(message, policyAtArrival, queueDepthAtArrival);
    queuedMessage.durableTurnId = durableTurnId;
    queue.unshift(queuedMessage);
    this.#queues.set(key, queue);
  }

  unshiftQueued(key: string, queuedMessage: QueuedMessage): void {
    const queue = this.#queues.get(key) ?? [];
    queue.unshift(queuedMessage);
    this.#queues.set(key, queue);
  }

  #createQueuedMessage(
    message: ChannelMessage,
    policyAtArrival: ChannelBusyPolicy,
    queueDepthAtArrival: number,
    textCoalescing?: QueuedTextCoalescingState,
    enqueuedAt = Date.now()
  ): QueuedMessage {
    return {
      message,
      channelKind: message.channel,
      enqueuedAt,
      policyAtArrival,
      queueDepthAtArrival,
      textCoalescing,
    };
  }
}
