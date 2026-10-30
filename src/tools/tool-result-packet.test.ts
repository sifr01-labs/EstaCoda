import { describe, expect, it } from "vitest";
import { packetizeToolResult, providerVisibleToolResultMaxChars, renderToolResultPacket } from "./tool-result-packet.js";

describe("bounded provider tool feedback", () => {
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
