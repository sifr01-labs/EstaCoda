import { describe, expect, it } from "vitest";
import {
  createTelegramStreamTextSanitizer,
  escapeTelegramPartialHtml,
  escapedTelegramPartialHtmlExceedsLimit,
  getUtf16Length,
  stripTelegramMediaDirectives
} from "./telegram-stream-text.js";

describe("Telegram stream text sanitizer", () => {
  it("strips full think blocks", () => {
    const sanitizer = createTelegramStreamTextSanitizer();

    const chunk = sanitizer.append("visible <think>hidden</think> text");

    expect(chunk.visibleText).toBe("visible  text");
    expect(sanitizer.snapshot().visibleText).toBe("visible  text");
  });

  it("strips split think opening tags", () => {
    const sanitizer = createTelegramStreamTextSanitizer();

    expect(sanitizer.append("hello <thi").visibleText).toBe("hello ");
    expect(sanitizer.append("nk>hidden</think> world").visibleText).toBe(" world");
    expect(sanitizer.snapshot().visibleText).toBe("hello  world");
  });

  it("resumes visible text after split think closing tags", () => {
    const sanitizer = createTelegramStreamTextSanitizer();

    expect(sanitizer.append("<think>hidden</thi").visibleText).toBe("");
    expect(sanitizer.append("nk>visible").visibleText).toBe("visible");
    expect(sanitizer.snapshot().visibleText).toBe("visible");
  });

  it("does not leak partial think candidates", () => {
    const sanitizer = createTelegramStreamTextSanitizer();

    expect(sanitizer.append("before <think").visibleText).toBe("before ");
    expect(sanitizer.snapshot().visibleText).toBe("before ");
  });

  it("emits non-think angle bracket prose once proven normal", () => {
    const sanitizer = createTelegramStreamTextSanitizer();

    expect(sanitizer.append("a <thi").visibleText).toBe("a ");
    expect(sanitizer.append("X value").visibleText).toBe("<thiX value");
    expect(sanitizer.snapshot().escapedHtml).toBe("a &lt;thiX value");
  });

  it("strips multiple think blocks", () => {
    const sanitizer = createTelegramStreamTextSanitizer();

    sanitizer.append("a <think>one</think>b<think>two</think> c");

    expect(sanitizer.snapshot().visibleText).toBe("a b c");
  });

  it("keeps unmatched open think blocks hidden", () => {
    const sanitizer = createTelegramStreamTextSanitizer();

    expect(sanitizer.append("a <think>hidden").visibleText).toBe("a ");
    expect(sanitizer.append(" still hidden").visibleText).toBe("");
    expect(sanitizer.snapshot().visibleText).toBe("a ");
  });

  it("strips media directives without counting them as visible", () => {
    const sanitizer = createTelegramStreamTextSanitizer();

    const chunk = sanitizer.append("MEDIA:/tmp/file.png\nvisible");

    expect(chunk.visibleText).toBe("visible");
    expect(chunk.visibleCharCount).toBe(7);
    expect(sanitizer.snapshot().visibleText).toBe("visible");
  });

  it("strips media directives with a space after the marker", () => {
    expect(stripTelegramMediaDirectives("MEDIA: /tmp/file.png\nnext")).toBe("next");
  });

  it("strips split media directives without leaking prefixes", () => {
    const sanitizer = createTelegramStreamTextSanitizer();

    expect(sanitizer.append("ME").visibleText).toBe("");
    expect(sanitizer.append("DIA:/tmp/file.png\nvisible").visibleText).toBe("visible");
    expect(sanitizer.snapshot().visibleText).toBe("visible");
  });

  it("preserves normal prose containing media", () => {
    const text = "This media file is useful. Not a MEDIA directive in prose.";

    expect(stripTelegramMediaDirectives(text)).toBe(text);
  });

  it("escapes partial HTML angle brackets safely", () => {
    expect(escapeTelegramPartialHtml("a < b > c")).toBe("a &lt; b &gt; c");
  });

  it("escapes ampersands safely", () => {
    expect(escapeTelegramPartialHtml("a & b")).toBe("a &amp; b");
  });

  it("computes visible character count after filtering", () => {
    const sanitizer = createTelegramStreamTextSanitizer();

    const chunk = sanitizer.append("🙂<think>hidden</think>a");

    expect(chunk.visibleText).toBe("🙂a");
    expect(chunk.visibleCharCount).toBe(2);
  });

  it("computes escaped UTF-16 length after escaping", () => {
    const sanitizer = createTelegramStreamTextSanitizer();

    const chunk = sanitizer.append("🙂 & <tag>");

    expect(chunk.escapedHtml).toBe("🙂 &amp; &lt;tag&gt;");
    expect(chunk.escapedUtf16Length).toBe(getUtf16Length("🙂 &amp; &lt;tag&gt;"));
  });

  it("detects escaped HTML expansion over a supplied limit", () => {
    expect(escapedTelegramPartialHtmlExceedsLimit("<>&", 10)).toBe(true);
    expect(escapedTelegramPartialHtmlExceedsLimit("abc", 10)).toBe(false);
  });

  it("reset clears sanitizer state", () => {
    const sanitizer = createTelegramStreamTextSanitizer();
    sanitizer.append("visible <think>hidden");

    sanitizer.reset();
    const chunk = sanitizer.append(" shown");

    expect(chunk.visibleText).toBe(" shown");
    expect(sanitizer.snapshot().visibleText).toBe(" shown");
  });
});
