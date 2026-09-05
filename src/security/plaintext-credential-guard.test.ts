import { describe, expect, it } from "vitest";
import {
  inspectPlaintextCredentials,
  interceptPlaintextCredentialInput,
  protectPlaintextToolArguments
} from "./plaintext-credential-guard.js";

describe("plaintext credential guard", () => {
  it.each(["\r", "\n", "\r\n"])("intercepts explicitly introduced terminal paste blocks with %j separators", (separator) => {
    const values = ["A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6", "Q7r8S9t0U1v2W3x4"];
    const text = `okay here are the key and secret - you can also retry any blocker\n[Pasted text 1]\n${values.join(separator)}`;
    const inspected = inspectPlaintextCredentials(text);
    expect(inspected.detected).toBe(true);
    for (const value of values) expect(inspected.redactedText).not.toContain(value);
    expect(interceptPlaintextCredentialInput(text)?.projectedText).toContain("protected-input");
  });

  it("leaves ordinary identifiers, credential discussions, and example placeholders alone", () => {
    for (const text of [
      "Explain the key and secret fields\ncollection-12345678",
      "Here are the workspace IDs\nworkspace-12345678",
      "Here are the credentials\nYOUR_API_KEY\nYOUR_API_SECRET",
      "Use this reference\nA1b2C3d4E5f6G7h8I9j0"
    ]) expect(inspectPlaintextCredentials(text).detected).toBe(false);
  });

  it("recollects only secret literals at declared destinations, preserving non-secret variables", () => {
    const input = { environment: { values: [
      { key: "subscription_key", value: "opaque-literal" },
      { key: "opaque", type: "secret", value: "another-literal" },
      { key: "base_url", value: "https://example.test" },
      { key: "client_secret", value: "{{secret_reference}}" },
      { key: "client_secret", value: "" }
    ] } };
    expect(protectPlaintextToolArguments(input, [])).toBeUndefined();
    const projected = protectPlaintextToolArguments(input, ["/environment/values/*/value"]);
    expect(JSON.stringify(projected)).not.toContain("opaque-literal");
    expect(JSON.stringify(projected)).not.toContain("another-literal");
    expect(projected).toMatchObject({ environment: { values: [
      { value: { protectedInput: { kind: "generic-secret" } } },
      { value: { protectedInput: { kind: "generic-secret" } } },
      input.environment.values[2], input.environment.values[3], input.environment.values[4]
    ] } });
    expect(input.environment.values[0]?.value).toBe("opaque-literal");
  });

  it("recognizes camel-case secret fields even beside unrelated envelope metadata", () => {
    expect(protectPlaintextToolArguments({ protectedInput: "unrelated", auth: { apiKey: "opaque-literal" } }, ["/auth/apiKey"]))
      .toMatchObject({ protectedInput: "unrelated", auth: { apiKey: { protectedInput: { kind: "generic-secret" } } } });
  });
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
