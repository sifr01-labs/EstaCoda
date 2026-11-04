import { describe, expect, it } from "vitest";
import { packetizeToolResult, providerVisibleToolResultMaxChars, renderToolResultPacket } from "./tool-result-packet.js";

describe("bounded provider tool feedback", () => {
  it("delivers complete task pages including middle evidence and uses its own reader for recovery", () => {
    const content = "a".repeat(9_000) + "MIDDLE FINDING" + "z".repeat(9_000);
    const result = { ok: true, content, metadata: { nextOffset: content.length } };
    const packet = packetizeToolResult({ tool: "task.result.read", maxChars: providerVisibleToolResultMaxChars("task.result.read"), result });
    expect(packet.excerpt).toBe(content);
    expect(packet.truncated).toBe(false);
    const clipped = packetizeToolResult({ tool: "task.result.read", maxChars: 500, result });
    expect(clipped.recoveryHint).toContain("same offset");
    expect(clipped.recoveryHint).not.toContain("file.read");
  });
  it("delivers recovery pages intact instead of skipping bytes at nextOffset", () => {
    const page = JSON.stringify({ content: "a".repeat(3000), nextOffset: 3000 });
    const packet = packetizeToolResult({ tool: "session_search", maxChars: providerVisibleToolResultMaxChars("session_search"), result: { ok: true, content: page } });
    expect(packet.truncated).toBe(false);
    expect(packet.excerpt).toBe(page);
  });

  it("points truncated active feedback at retained output even when metadata is crowded", () => {
    const packet = packetizeToolResult({ tool: "terminal.run", maxChars: 1000, result: { ok: true,
      content: "x".repeat(30_000), metadata: { ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`diagnostic${i}`, i])),
        retainedOutput: true, observationSessionId: "session", observationMessageId: "observation" } } });
    expect(packet.recoveryHint).toContain('around_message_id="observation"');
    expect(packet.sentChars).toBeLessThanOrEqual(1000);
  });

  it("keeps a late failure and identifies omitted output without suggesting mutation replay", () => {
    const packet = packetizeToolResult({ tool: "terminal.run", maxChars: 1400,
      result: { ok: false, content: "BUILD START\n" + "intermediate log\n".repeat(300) + "ASSERTION FAILED: final invariant" } });
    expect(packet.excerpt).toContain("BUILD START");
    expect(packet.excerpt).toContain("ASSERTION FAILED");
    expect(packet.excerpt).toContain("characters omitted");
    expect(packet.sentChars).toBeLessThanOrEqual(1400);
    expect(renderToolResultPacket(packet)).toContain("Do not rerun a mutating command");
  });

  it("delivers bounded file pages beyond the old 1400-character prefix intact", () => {
    const page = "   first line\n\n\n" + "content\n".repeat(300) + "LATE FUNCTION\n";
    const packet = packetizeToolResult({ tool: "file.read", maxChars: providerVisibleToolResultMaxChars("file.read"), result: { ok: true, content: page } });
    expect(packet.truncated).toBe(false);
    expect(packet.excerpt).toBe(page);
    const clipped = packetizeToolResult({ tool: "file.read", maxChars: 1000, result: { ok: true, content: page } });
    expect(clipped.recoveryHint).toContain("lineStart/lineEnd");
  });

  it("keeps Arabic and supplementary Unicode valid at both clipping boundaries", () => {
    const packet = packetizeToolResult({ tool: "terminal.run", maxChars: 1400, result: { ok: true, content: "مرحبا 😀".repeat(1000) } });
    expect(Buffer.from(packet.excerpt, "utf8").toString("utf8")).toBe(packet.excerpt);
    expect(packet.sentChars).toBeLessThanOrEqual(1400);
  });
});
