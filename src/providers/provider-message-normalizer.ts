import type { ProviderMessage } from "../contracts/provider.js";

export type ProviderMessageNormalization = {
  messages: ProviderMessage[];
  warnings: string[];
  repairs: string[];
};

export type ProviderMessageNormalizationOptions = {
  ensureSystemIdentity?: boolean;
  identity?: string;
};

export function normalizeProviderMessagesStrict(
  messages: ProviderMessage[],
  options: ProviderMessageNormalizationOptions = {}
): ProviderMessageNormalization {
  const warnings: string[] = [];
  const repairs: string[] = [];
  const identity = options.identity ?? [
    "You are EstaCoda, a proactive autonomous agent.",
    "Describe yourself as an agent, never as an assistant, AI assistant, or code assistant."
  ].join("\n");
  const normalized: Array<Omit<ProviderMessage, "content"> & { content: unknown }> = [];
  let systemContent: unknown;

  for (const message of messages) {
    const content = normalizeContent(message.content);

    if (message.role === "system") {
      systemContent = mergeNormalizedContent(systemContent, content);
      if (normalized.length > 0) {
        repairs.push("moved-system-message-to-front");
      }
      continue;
    }

    const previous = normalized[normalized.length - 1];

    if (message.role === "tool" && (previous === undefined || (previous.role !== "assistant" && previous.role !== "tool"))) {
      normalized.push({
        role: "user",
        content: `Tool result received without a preceding assistant tool call:\n${stringifyNormalizedContent(content)}`,
        name: message.name
      });
      warnings.push(previous === undefined ? "orphan-tool-message" : "tool-message-without-assistant-before-it");
      repairs.push("converted-invalid-tool-to-user-message");
      continue;
    }

    if (
      previous !== undefined &&
      previous.role === message.role &&
      message.role !== "tool" &&
      typeof previous.content === "string" &&
      typeof content === "string"
    ) {
      previous.content = `${previous.content}\n\n${content}`;
      repairs.push(`merged-adjacent-${message.role}-messages`);
      continue;
    }

    if (
      previous !== undefined &&
      previous.role === "tool" &&
      message.role === "tool" &&
      typeof previous.content === "string" &&
      typeof content === "string"
    ) {
      previous.content = `${previous.content}\n\n${content}`;
      repairs.push("merged-adjacent-tool-messages");
      continue;
    }

    normalized.push({
      ...message,
      content
    });
  }

  if (systemContent !== undefined) {
    normalized.unshift({
      role: "system",
      content: systemContent
    });
  } else if (options.ensureSystemIdentity !== false) {
    normalized.unshift({
      role: "system",
      content: identity
    });
    repairs.push("inserted-system-identity");
  }

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];

    if (previous === undefined || current === undefined) {
      continue;
    }

    if (previous.role === current.role && current.role !== "tool") {
      warnings.push(`adjacent-${current.role}-messages`);
    }

    if (current.role === "tool" && previous.role !== "assistant" && previous.role !== "tool") {
      warnings.push("tool-message-without-assistant-before-it");
    }
  }

  return {
    messages: normalized as ProviderMessage[],
    warnings: [...new Set(warnings)],
    repairs: [...new Set(repairs)]
  };
}

function normalizeContent(content: unknown): unknown {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length === 0 ? "[empty]" : trimmed;
  }

  if (Array.isArray(content)) {
    return content.length === 0 ? "[empty]" : content;
  }

  return "[empty]";
}

function mergeNormalizedContent(left: unknown, right: unknown): unknown {
  if (left === undefined) {
    return right;
  }

  if (typeof left === "string" && typeof right === "string") {
    return `${left}\n\n${right}`;
  }

  return stringifyNormalizedContent(left) + "\n\n" + stringifyNormalizedContent(right);
}

function stringifyNormalizedContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "object" && part !== null && "text" in part && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }

        if (typeof part === "object" && part !== null && "type" in part) {
          return `[${String((part as { type?: unknown }).type ?? "content")}]`;
        }

        return "[content]";
      })
      .join("\n");
  }

  return String(content);
}
