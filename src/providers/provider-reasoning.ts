import type {
  ProviderReasoningFormat,
  ProviderReasoningMetadata
} from "../contracts/provider.js";

const REASONING_TAGS = ["think", "thinking", "reasoning"] as const;
const OPEN_TAGS = REASONING_TAGS.map((tag) => `<${tag}>`);
const MAX_OPEN_TAG_LENGTH = Math.max(...OPEN_TAGS.map((tag) => tag.length));

export type ReasoningExtractionResult = {
  visible: string;
  reasoning?: string;
  reasoningMetadata?: ProviderReasoningMetadata;
};

export type ProviderContentListPart = {
  type?: string;
  text?: string;
  thinking?: string;
  reasoning?: string;
};

export function extractInlineReasoning(text: string): ReasoningExtractionResult {
  const filter = new StreamingReasoningFilter();
  const visible = filter.push(text) + filter.finish();
  const reasoning = filter.reasoning();

  return {
    visible,
    ...(reasoning === undefined ? {} : {
      reasoning,
      reasoningMetadata: reasoningMetadataFromReasoning(reasoning, "think_block")
    })
  };
}

export function stripInlineReasoning(text: string): string {
  return extractInlineReasoning(text).visible;
}

export function stripThinkBlocks(text: string): string {
  return stripInlineReasoning(text).trim();
}

export function extractReasoningFromContentList(parts: ProviderContentListPart[]): ReasoningExtractionResult {
  const visibleParts: string[] = [];
  const reasoningParts: string[] = [];

  for (const part of parts) {
    const type = part.type?.toLowerCase();
    if (type === "thinking") {
      if (part.thinking !== undefined) {
        reasoningParts.push(part.thinking);
      }
      if (part.reasoning !== undefined) {
        reasoningParts.push(part.reasoning);
      }
      continue;
    }

    if (type === "reasoning") {
      if (part.reasoning !== undefined) {
        reasoningParts.push(part.reasoning);
      } else if (part.text !== undefined) {
        reasoningParts.push(part.text);
      }
      continue;
    }

    if (
      part.text !== undefined &&
      (type === undefined || type === "text" || type === "output" || type === "output_text")
    ) {
      visibleParts.push(part.text);
    }
  }

  const visible = visibleParts.join("\n");
  const reasoning = mergeReasoningParts(reasoningParts);

  return {
    visible,
    ...(reasoning === undefined ? {} : {
      reasoning,
      reasoningMetadata: reasoningMetadataFromReasoning(reasoning, contentListReasoningFormat(parts))
    })
  };
}

export function mergeReasoningParts(parts: Array<string | undefined | null>): string | undefined {
  const cleaned = parts
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0);

  return cleaned.length === 0 ? undefined : cleaned.join("\n\n");
}

export function reasoningMetadataFromReasoning(
  reasoning: string | undefined,
  format: ProviderReasoningFormat = "unknown"
): ProviderReasoningMetadata {
  return {
    present: reasoning !== undefined && reasoning.trim().length > 0,
    chars: reasoning?.length ?? 0,
    format
  };
}

export class StreamingReasoningFilter {
  #buffer = "";
  #hiddenTag: (typeof REASONING_TAGS)[number] | undefined;
  #currentReasoning = "";
  readonly #reasoningParts: string[] = [];

  push(chunk: string): string {
    if (chunk.length === 0) {
      return "";
    }

    this.#buffer += chunk;
    return this.#drain(false);
  }

  finish(): string {
    const visible = this.#drain(true);
    if (this.#hiddenTag !== undefined) {
      this.#currentReasoning += this.#buffer;
      this.#buffer = "";
      this.#finishReasoningPart();
      this.#hiddenTag = undefined;
    }
    return visible;
  }

  reasoning(): string | undefined {
    return mergeReasoningParts(this.#reasoningParts);
  }

  reasoningMetadata(format: ProviderReasoningFormat = "think_block"): ProviderReasoningMetadata {
    return reasoningMetadataFromReasoning(this.reasoning(), format);
  }

  #drain(final: boolean): string {
    let visible = "";

    while (this.#buffer.length > 0) {
      if (this.#hiddenTag !== undefined) {
        const closeTag = `</${this.#hiddenTag}>`;
        const closeIndex = indexOfCaseInsensitive(this.#buffer, closeTag);
        if (closeIndex !== -1) {
          this.#currentReasoning += this.#buffer.slice(0, closeIndex);
          this.#buffer = this.#buffer.slice(closeIndex + closeTag.length);
          this.#finishReasoningPart();
          this.#hiddenTag = undefined;
          continue;
        }

        const keep = final ? 0 : longestCaseInsensitiveSuffixPrefix(this.#buffer, closeTag);
        const hiddenReady = this.#buffer.slice(0, this.#buffer.length - keep);
        this.#currentReasoning += hiddenReady;
        this.#buffer = this.#buffer.slice(this.#buffer.length - keep);
        break;
      }

      const nextLt = this.#buffer.indexOf("<");
      if (nextLt === -1) {
        const keep = final ? 0 : longestOpeningTagPrefixSuffix(this.#buffer);
        const ready = this.#buffer.slice(0, this.#buffer.length - keep);
        visible += ready;
        this.#buffer = this.#buffer.slice(this.#buffer.length - keep);
        break;
      }

      if (nextLt > 0) {
        const prefix = this.#buffer.slice(0, nextLt);
        visible += prefix;
        this.#buffer = this.#buffer.slice(nextLt);
        continue;
      }

      const opened = completeOpeningTag(this.#buffer);
      if (opened !== undefined && this.#shouldOpenHiddenBlock(opened.openTag, final)) {
        this.#hiddenTag = opened.tag;
        this.#buffer = this.#buffer.slice(opened.openTag.length);
        continue;
      }

      if (!final && isOpeningTagPrefix(this.#buffer)) {
        break;
      }

      const char = this.#buffer[0] ?? "";
      visible += char;
      this.#buffer = this.#buffer.slice(1);
    }

    return visible;
  }

  #shouldOpenHiddenBlock(openTag: string, final: boolean): boolean {
    const afterTag = this.#buffer.slice(openTag.length);
    if (afterTag.length === 0) {
      return final;
    }

    const closingTag = `</${openTag.slice(1)}`;
    if (indexOfCaseInsensitive(afterTag, closingTag) !== -1) {
      return true;
    }

    if (/^[ \t]+[A-Za-z0-9]/u.test(afterTag)) {
      return false;
    }

    return isLikelyHiddenReasoningStart(afterTag);
  }

  #finishReasoningPart(): void {
    if (this.#currentReasoning.trim().length > 0) {
      this.#reasoningParts.push(this.#currentReasoning);
    }
    this.#currentReasoning = "";
  }
}

function completeOpeningTag(value: string): { tag: (typeof REASONING_TAGS)[number]; openTag: string } | undefined {
  for (const tag of REASONING_TAGS) {
    const openTag = `<${tag}>`;
    if (startsWithCaseInsensitive(value, openTag)) {
      return { tag, openTag };
    }
  }
  return undefined;
}

function isOpeningTagPrefix(value: string): boolean {
  if (value.length > MAX_OPEN_TAG_LENGTH) {
    return false;
  }
  return OPEN_TAGS.some((tag) => startsWithCaseInsensitive(tag, value));
}

function longestOpeningTagPrefixSuffix(value: string): number {
  return OPEN_TAGS.reduce((max, tag) => Math.max(max, longestCaseInsensitiveSuffixPrefix(value, tag)), 0);
}

function longestCaseInsensitiveSuffixPrefix(value: string, prefixTarget: string): number {
  const max = Math.min(value.length, prefixTarget.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (startsWithCaseInsensitive(prefixTarget, value.slice(value.length - length))) {
      return length;
    }
  }
  return 0;
}

function startsWithCaseInsensitive(value: string, prefix: string): boolean {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

function indexOfCaseInsensitive(value: string, search: string): number {
  return value.toLowerCase().indexOf(search.toLowerCase());
}

function isLikelyHiddenReasoningStart(value: string): boolean {
  return value.length > 0;
}

function contentListReasoningFormat(parts: ProviderContentListPart[]): ProviderReasoningFormat {
  const hasThinking = parts.some((part) => part.type?.toLowerCase() === "thinking");
  const hasReasoning = parts.some((part) => part.type?.toLowerCase() === "reasoning");
  return hasThinking && hasReasoning ? "mixed" : hasThinking ? "think_block" : hasReasoning ? "reasoning" : "unknown";
}
