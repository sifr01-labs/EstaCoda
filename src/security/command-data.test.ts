import { describe, expect, it } from "vitest";
import { assessCommandSafety } from "./command-safety.js";

describe("source patterns versus credential operands", () => {
  it.each([
    "grep -nE 'token|auth|loopback|origin' packages/host/webserver/src/*.ts",
    "grep -nE 'token|auth' src/server.ts | head -30",
    "grep -nE '\\.env' src/server.ts"
  ])("does not escalate a literal source search: %s", command => {
    const result = assessCommandSafety(command);
    expect(result.riskClass).not.toBe("credential-access");
    expect(result.hardBlock).toBeUndefined();
  });
  it.each(["cat .env", "grep -nE 'token|auth' .env", "grep -nE 'token|auth' src/server.ts | sh", "grep -nE \"$(cat .env)\" src/server.ts"])("retains protected operands and execution carriers: %s", command => {
    const result = assessCommandSafety(command);
    expect(result.hardBlock).toBeDefined();
  });
});
