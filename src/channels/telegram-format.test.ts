import { describe, expect, it } from "vitest";
import { formatTelegramReply } from "./telegram-format.js";

describe("Telegram HTML fallback", () => {
  it("renders cited links with balanced URL parentheses and escaped attributes", () => {
    expect(formatTelegramReply('**[المصدر](https://example.com/docs_(v2)?x="y"&q=1)**').text)
      .toBe('<b><a href="https://example.com/docs_(v2)?x=&quot;y&quot;&amp;q=1">المصدر</a></b>');
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "https://x.test/\" onclick=\"bad"])("does not make active links from %s", (url) => {
    expect(formatTelegramReply(`[source](${url})`).text).not.toContain("<a ");
  });

  it("keeps code literal and escapes HTML instead of trusting provider markup", () => {
    const result = formatTelegramReply('`[source](https://example.com)`\n\n```md\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```\n<script>bad</script>').text;
    expect(result).toContain('<code>[source](https://example.com)</code>');
    expect(result).toContain('<pre>| a | b |');
    expect(result).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(result).not.toContain('<a ');
  });

  it("retains cell associations and clickable sources when rich tables are unavailable", () => {
    const result = formatTelegramReply('| النموذج | Service |\n| --- | --- |\n| Kimi | [AWS](https://aws.amazon.com) |\n| GLM | A\\|B |').text;
    expect(result).toBe('النموذج: Kimi\nService: <a href="https://aws.amazon.com">AWS</a>\n\nالنموذج: GLM\nService: A|B');
  });

  it("leaves ordinary pipe text and explicitly formatted delivery alone", () => {
    expect(formatTelegramReply('a | b\nc | d').text).toBe('a | b\nc | d');
    expect(formatTelegramReply('<b>Approved</b>', { format: 'html' }).text).toBe('<b>Approved</b>');
  });
});
