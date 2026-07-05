import { describe, expect, it } from "vitest";
import { redactBenchmarkArtifact, redactBenchmarkText } from "./redaction.js";

describe("benchmark redaction", () => {
  it("redacts nested secret-looking fields", () => {
    const redacted = redactBenchmarkArtifact({
      benchmark: { name: "terminal-bench", version: "2.0" },
      credentials: {
        apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456",
        nested: { token: "abcdefghijklmnopqrstuvwxyz1234567890abcdef" }
      }
    });

    expect(redacted).toMatchObject({
      benchmark: { name: "terminal-bench", version: "2.0" },
      credentials: {
        apiKey: "[REDACTED]",
        nested: { token: "[REDACTED]" }
      }
    });
  });

  it("redacts secret-looking text while preserving harmless context", () => {
    const redacted = redactBenchmarkText("task=openssl OPENAI_API_KEY=super-secret-value status=failed");

    expect(redacted).toContain("task=openssl");
    expect(redacted).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(redacted).toContain("status=failed");
  });
});
