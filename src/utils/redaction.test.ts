import { describe, expect, it } from "vitest";
import { redactJson, redactObject, redactSensitiveText } from "./redaction.js";

describe("redactSensitiveText", () => {
  it("redacts API keys", () => {
    expect(redactSensitiveText("key sk-abcdefghijklmnopqrstuvwxyz123456")).toBe("key [REDACTED]");
  });

  it("redacts bearer tokens", () => {
    expect(redactSensitiveText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456")).toBe("Authorization: Bearer [REDACTED]");
  });

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sgn_abcdefghijklmnop";
    expect(redactSensitiveText(`token ${jwt}`)).toBe("token [REDACTED]");
  });

  it("redacts env-style secrets", () => {
    expect(redactSensitiveText("OPENAI_API_KEY=super-secret-value")).toBe("OPENAI_API_KEY=[REDACTED]");
  });

  it("redacts password assignments", () => {
    expect(redactSensitiveText("password: hunter2")).toBe("password: [REDACTED]");
  });

  it("redacts URLs with credentials", () => {
    expect(redactSensitiveText("postgres://user:pass@example.com/db")).toBe("postgres://[REDACTED]:[REDACTED]@example.com/db");
  });

  it("redacts tool-output-like secrets", () => {
    expect(redactSensitiveText("x-api-key: abcdefghijklmnopqrstuvwxyz")).toBe("x-api-key: [REDACTED]");
    expect(redactSensitiveText("client_secret=abcdefghijklmnopqrstuvwxyz")).toBe("client_secret=[REDACTED]");
  });

  it("redacts mixed transcript-grade secret categories while preserving context", () => {
    const redacted = redactSensitiveText([
      "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'",
      "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sgn_abcdefghijklmnop",
      "OPENAI_API_KEY=super-secret-value",
      "DATABASE_URL=https://alice:secret@example.com/path",
      "password: hunter2",
      "tool output: client_secret=abcdefghijklmnopqrstuvwxyz",
      "tool output: x-api-key: abcdefghijklmnopqrstuvwxyz",
      "deploy target remains staging"
    ].join("\n"));

    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redacted).not.toContain("super-secret-value");
    expect(redacted).not.toContain("alice:secret@example.com");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("Authorization: Bearer [REDACTED]");
    expect(redacted).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(redacted).toContain("https://[REDACTED]:[REDACTED]@example.com/path");
    expect(redacted).toContain("deploy target remains staging");
  });

  it("preserves non-secret text", () => {
    const text = "Build succeeded with 12 warnings and no token usage details.";
    expect(redactSensitiveText(text)).toBe(text);
  });

  it("redacts nested object secret keys and string values", () => {
    expect(redactObject({
      nested: {
        apiKey: "plain-secret",
        output: "Bearer abcdefghijklmnopqrstuvwxyz123456"
      }
    })).toEqual({
      nested: {
        apiKey: "[REDACTED]",
        output: "Bearer [REDACTED]"
      }
    });
  });

  it("redacts JSON text deterministically", () => {
    expect(redactJson('{"token":"abcdefghijklmnopqrstuvwxyz"}')).toBe("{\n  \"token\": \"[REDACTED]\"\n}");
  });
});

describe("complete credential value redaction", () => {
  it.each(['"', "'", '`'])("masks complete quoted values and repeats (%s)", quote => {
    const secret = "fixture value with spaces\nand another line";
    const input = `Inspect /app/input.txt.\npassword=${quote}${secret}${quote}\nWrite /app/result.txt.\nRepeated: ${secret}`;
    const output = redactSensitiveText(input);
    expect(output).not.toContain("fixture value");
    expect(output).not.toContain("another line");
    expect(output).toContain("Inspect /app/input.txt.");
    expect(output).toContain("Write /app/result.txt.");
    expect(redactSensitiveText(output)).toBe(output);
  });
  it("masks escaped JSON credentials without destroying other fields", () => {
    const secret = 'fixture "quoted" credential';
    const output = redactSensitiveText(JSON.stringify({ password: secret, task: "inspect report.md", repeated: secret }));
    expect(output).not.toContain("fixture");
    expect(JSON.parse(output)).toEqual({ password: "[REDACTED]", task: "inspect report.md", repeated: "[REDACTED]" });
  });
  it("fails closed on an unclosed credential quote", () => {
    expect(redactSensitiveText('Inspect input.txt.\npassword="fixture words\ncontinued secret')).toBe('Inspect input.txt.\npassword="[REDACTED]"');
  });
  it.each(["PRIVATE KEY", "RSA PRIVATE KEY", "OPENSSH PRIVATE KEY"])("masks a whole PEM %s block while retaining the task", kind => {
    const output = redactSensitiveText(`Inspect output.txt.\n-----BEGIN ${kind}-----\nfixture-material\nsecond-line\n-----END ${kind}-----\nThen verify output.txt.`);
    expect(output).toBe("Inspect output.txt.\n[REDACTED]\nThen verify output.txt.");
  });
  it("retains following task text and non-secret source identifiers", () => {
    expect(redactSensitiveText('token=fixture-token; verify output.txt')).toBe('token=[REDACTED] verify output.txt');
    expect(redactSensitiveText('monkey=42; tokenizer=ready; passwords=unknown')).toBe('monkey=42; tokenizer=ready; passwords=unknown');
    expect(redactSensitiveText('password=fixture;secret&suffix,tail}end]')).toBe('password=[REDACTED]');
    expect(redactSensitiveText('password=[REDACTED]')).toBe('password=[REDACTED]');
  });
});

it("keeps redaction markers stable for short secrets and marker-like placeholders", () => {
  for (const value of ["REDACTED", "]", "a", "$"]) {
    const result = redactSensitiveText(`password="${value}"`);
    expect(redactSensitiveText(result)).toBe(result);
    expect(result).toBe('password="[REDACTED]"');
  }
  expect(redactSensitiveText('password="fixture\\')).toBe('password="[REDACTED]"');
});

it("fails closed on unusually many distinct credential values", () => {
  const input = Array.from({ length: 129 }, (_, index) => `password=fixture-credential-${index}`).join("\n");
  expect(redactSensitiveText(input)).toBe("[REDACTED]");
});


it("withholds token punctuation and placeholder-shaped prefixes completely", () => {
  expect(redactSensitiveText("password=[REDACTED]fixture-suffix")).toBe("password=[REDACTED]");
  for (const scheme of ["Bearer", "Basic"]) {
    expect(redactSensitiveText(`${scheme} abcdefghijklmnopqrstuvwxyz+/==`)).toBe(`${scheme} [REDACTED]`);
  }
  expect(redactSensitiveText("sk-abcdefghijklmnopqrstuvwxyz_-_")).toBe("[REDACTED]");
});

it("does not treat existing URL redaction markers as discovered credentials", () => {
  expect(redactSensitiveText("https://%5BREDACTED%5D:%5BREDACTED%5D@example.test/?code=%5BREDACTED%5D"))
    .toBe("https://[REDACTED]:[REDACTED]@example.test/?code=%5BREDACTED%5D");
});
