import type { ChannelKind } from "../contracts/channel.js";
import type { ChannelMessage } from "../contracts/channel.js";

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
};

export type QueueEnqueueResult = {
  accepted: boolean;
  position?: number;
  rejectedBecauseFull?: boolean;
  coalesced?: boolean;
};

export class SessionMessageQueue {
  #queues = new Map<string, QueuedMessage[]>();

  enqueue(
    key: string,
    message: ChannelMessage,
    policyAtArrival: ChannelBusyPolicy,
    queueDepthAtArrival: number
  ): QueueEnqueueResult {
    const queue = this.#queues.get(key) ?? [];
    if (queue.length >= queueDepthAtArrival) {
      return { accepted: false, rejectedBecauseFull: true };
    }
    const queuedMessage = this.#createQueuedMessage(message, policyAtArrival, queueDepthAtArrival);
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
    now = Date.now()
  ): QueueEnqueueResult {
    if (!coalescing.enabled || policyAtArrival !== "queue") {
      return this.enqueue(key, message, policyAtArrival, queueDepthAtArrival);
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
        tail.textCoalescing.messages.push({ id: message.id, receivedAt: message.receivedAt });
        tail.textCoalescing.lastUpdatedAt = now;
        tail.textCoalescing.totalChars = combinedChars;
        tail.message = {
          ...tail.message,
          text: `${tail.message.text}${separator}${message.text}`,
          metadata: {
            ...(tail.message.metadata ?? {}),
            busyTextCoalescedMessageIds: tail.textCoalescing.messages.map((item) => item.id),
            busyTextCoalescedReceivedAts: tail.textCoalescing.messages.map((item) => item.receivedAt),
            busyTextCoalescingSize: tail.textCoalescing.messages.length,
            busyTextCoalescingWindowMs: coalescing.windowMs,
          },
        };
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

  unshift(
    key: string,
    message: ChannelMessage,
    policyAtArrival: ChannelBusyPolicy,
    queueDepthAtArrival: number
  ): void {
    const queue = this.#queues.get(key) ?? [];
    const queuedMessage = this.#createQueuedMessage(message, policyAtArrival, queueDepthAtArrival);
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
