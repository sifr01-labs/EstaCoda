import type { ChannelMessage } from "../contracts/channel.js";

const MAX_ATTRIBUTION_MESSAGE_IDS = 256;

/** Returns only Telegram message IDs that are safe to use as bounded attribution keys. */
export function telegramAttributionMessageIds(message: ChannelMessage): string[] {
  if (message.channel !== "telegram") return [];
  const telegram = telegramMetadata(message);
  const values = [
    telegram?.messageId,
    ...arrayValues(telegram?.mediaGroupMessageIds),
    ...arrayValues(telegram?.attributionMessageIds)
  ];
  return [...new Set(values.flatMap((value) => {
    return validTelegramMessageId(value) === undefined ? [] : [String(value)];
  }))].slice(0, MAX_ATTRIBUTION_MESSAGE_IDS);
}

/** Carries all original Telegram IDs through debounce and queue aggregation. */
export function mergedTelegramAttributionMetadata(
  base: ChannelMessage,
  additionalMessageIds: readonly string[]
): { telegram: Record<string, unknown> } | Record<string, never> {
  if (base.channel !== "telegram") return {};
  const existing = telegramMetadata(base) ?? {};
  const ids = [...new Set(
    [
      ...telegramAttributionMessageIds(base),
      ...additionalMessageIds.filter(validTelegramMessageIdString)
    ]
  )].slice(0, MAX_ATTRIBUTION_MESSAGE_IDS);
  return {
    telegram: {
      ...existing,
      attributionMessageIds: ids.map(Number)
    }
  };
}

function telegramMetadata(message: ChannelMessage): Record<string, unknown> | undefined {
  const telegram = message.metadata?.telegram;
  return telegram !== null && typeof telegram === "object" && !Array.isArray(telegram)
    ? telegram as Record<string, unknown>
    : undefined;
}

function arrayValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_ATTRIBUTION_MESSAGE_IDS) : [];
}

function validTelegramMessageId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function validTelegramMessageIdString(value: string): boolean {
  if (!/^[1-9]\d*$/u.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}
