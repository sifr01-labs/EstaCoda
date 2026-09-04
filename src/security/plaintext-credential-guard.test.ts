import { describe, expect, it } from "vitest";
import {
  inspectPlaintextCredentials,
  interceptPlaintextCredentialInput
} from "./plaintext-credential-guard.js";

describe("plaintext credential guard", () => {
  it("intercepts labelled multiline credential submissions without retaining their values", () => {
    const apiKey = "fake-consumer-key-123456789";
    const clientSecret = "fake-consumer-secret-987654321";
    const input = `Here are the credentials\nkey\n${apiKey}\nand secret\n${clientSecret}`;

    const result = interceptPlaintextCredentialInput(input);

    expect(result).toMatchObject({ kinds: ["api-key", "generic-secret"] });
    expect(result?.projectedText).toContain("withheld the values");
    expect(result?.projectedText).not.toContain(apiKey);
    expect(result?.projectedText).not.toContain(clientSecret);
  });

  it("redacts inline assignments and credential table cells for provider history", () => {
    const token = "fake-access-token-123456789";
    const secret = "fake-client-secret-123456789";
    const input = `access_token=${token}\n| client secret | ${secret} |`;

    const result = inspectPlaintextCredentials(input);

    expect(result.detected).toBe(true);
    expect(result.redactedText).not.toContain(token);
    expect(result.redactedText).not.toContain(secret);
    expect(result.redactedText.match(/\[REDACTED\]/gu)).toHaveLength(2);
  });

  it("does not intercept ordinary credential discussion or placeholders", () => {
    expect(interceptPlaintextCredentialInput("Explain how protected credential delivery works.")).toBeUndefined();
    expect(interceptPlaintextCredentialInput("api_key=YOUR_API_KEY")).toBeUndefined();
    expect(interceptPlaintextCredentialInput("Can you review the README?")).toBeUndefined();
  });
});
