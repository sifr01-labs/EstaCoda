import type { SessionMessage } from "../contracts/session.js";

export const TOOL_OUTPUT_PREVIEW_CHARS = 12_000;
export const TOOL_OUTPUT_RETAINED_CHARS = 1_000_000;

export function toolOutputPreview(content: string, limit = TOOL_OUTPUT_PREVIEW_CHARS): string {
  if (content.length <= limit) return content;
  const boundary = (offset: number) => offset > 0 && /[\uD800-\uDBFF]/u.test(content[offset - 1]!) ? offset - 1 : offset;
  const head = boundary(Math.floor(limit / 2));
  const tail = boundary(content.length - (limit - Math.floor(limit / 2)));
  return `${content.slice(0, head)}\n[${tail - head} characters omitted from preview]\n${content.slice(tail)}`;
}

/** Project a stored observation into the prompt without modifying durable bytes. */
export function retainedOutputMessage(message: SessionMessage): SessionMessage {
  if (message.role !== "tool" || message.metadata?.retainedOutput !== true) return message;
  return { ...message, content: `${toolOutputPreview(message.content)}\n${outputReadHint(message.sessionId, message.id)}` };
}

export function outputReadHint(sessionId: string, messageId: string): string {
  return `Retained observation: session_search(mode="read", session_id=${JSON.stringify(sessionId)}, around_message_id=${JSON.stringify(messageId)}, offset=0). Advance using nextOffset; do not rerun the command merely to recover output.`;
}
