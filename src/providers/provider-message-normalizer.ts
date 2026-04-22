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
  const identity = options.identity ?? "You are EstaCoda, an autonomous agent.";
  const normalized: ProviderMessage[] = [];
  let systemContent: string | undefined;

  for (const message of messages) {
    const content = normalizeContent(message.content);

    if (message.role === "system") {
      systemContent = systemContent === undefined
        ? content
        : `${systemContent}\n\n${content}`;
      if (normalized.length > 0) {
        repairs.push("moved-system-message-to-front");
      }
      continue;
    }

    const previous = normalized[normalized.length - 1];

    if (message.role === "tool" && (previous === undefined || (previous.role !== "assistant" && previous.role !== "tool"))) {
      normalized.push({
        role: "user",
        content: `Tool result received without a preceding assistant tool call:\n${content}`,
        name: message.name
      });
      warnings.push(previous === undefined ? "orphan-tool-message" : "tool-message-without-assistant-before-it");
      repairs.push("converted-invalid-tool-to-user-message");
      continue;
    }

    if (previous !== undefined && previous.role === message.role && message.role !== "tool") {
      previous.content = `${previous.content}\n\n${content}`;
      repairs.push(`merged-adjacent-${message.role}-messages`);
      continue;
    }

    if (previous !== undefined && previous.role === "tool" && message.role === "tool") {
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
    messages: normalized,
    warnings: [...new Set(warnings)],
    repairs: [...new Set(repairs)]
  };
}

function normalizeContent(content: string): string {
  const trimmed = content.trim();

  return trimmed.length === 0 ? "[empty]" : trimmed;
}
