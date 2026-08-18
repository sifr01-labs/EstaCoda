import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { ExecutionEvidenceIndex } from "./execution-evidence-index.js";
import { ExecutionPlanController } from "./execution-plan-controller.js";
import { ExecutionPlanStore } from "./execution-plan-store.js";
import {
  applyAuthenticationExecutionEffects,
  deriveAuthenticationExecutionEffects,
  prioritizeAuthenticationExecutionEffects,
  type AuthenticationExecutionEffectReceipt,
} from "./authentication-execution-effects.js";

describe("authentication execution effects", () => {
  it("derives credential and challenge progress only from allowed protected-browser receipts", () => {
    const execution = protectedExecution("browser.fill_protected_form", "credentials-call", {
      secureInputGroupReceipt: { status: "delivered" },
      protectedDelivery: settledDelivery(),
      snapshot: {
        title: "Verify your account",
        elements: [{ ref: "@e1", role: "textbox", label: "One-time verification code" }],
      },
    });

    expect(deriveAuthenticationExecutionEffects([execution])).toEqual([
      { effect: "credentials-submitted", stage: "credentials", toolCallId: "credentials-call" },
      { effect: "challenge-required", stage: "challenge", toolCallId: "credentials-call" },
    ]);
    expect(deriveAuthenticationExecutionEffects([
      { ...execution, tool: toolDefinition("mcp.untrusted.browser") },
      { ...execution, decision: "deny" },
    ])).toEqual([]);
  });

  it("records precise user and browser blockers", () => {
    const missingCredentials = protectedExecution("browser.fill_protected_form", "credentials-call", {
      secureInputGroupReceipt: { status: "cancelled" },
    }, false);
    const rejectedChallenge = protectedExecution("browser.type", "challenge-call", {
      secureInputReceipt: { status: "delivered" },
      protectedDelivery: {
        ...settledDelivery(),
        challengeState: "still-present",
      },
    }, false);

    expect(deriveAuthenticationExecutionEffects([missingCredentials, rejectedChallenge])).toEqual([
      {
        effect: "credentials-required",
        stage: "credentials",
        toolCallId: "credentials-call",
        blocker: {
          kind: "user_input_required",
          summary: "The required authentication credentials were not provided.",
        },
      },
      {
        effect: "challenge-submitted",
        stage: "challenge",
        toolCallId: "challenge-call",
      },
      {
        effect: "challenge-required",
        stage: "challenge",
        toolCallId: "challenge-call",
        blocker: {
          kind: "user_input_required",
          summary: "The authentication challenge remained after submission; provide a new or corrected response.",
        },
      },
    ]);
  });

  it("gives an active challenge precedence over authenticated-looking evidence from the same receipt", () => {
    expect(prioritizeAuthenticationExecutionEffects([
      { effect: "credentials-submitted", stage: "credentials", toolCallId: "submit" },
      { effect: "challenge-required", stage: "challenge", toolCallId: "submit" },
      { effect: "authentication-verified", stage: "verification", toolCallId: "submit" },
    ])).toEqual([
      { effect: "credentials-submitted", stage: "credentials", toolCallId: "submit" },
      { effect: "challenge-required", stage: "challenge", toolCallId: "submit" },
    ]);
  });

  it("recognizes generic interactive authentication challenges without OTP-specific fields", () => {
    const execution = protectedExecution("browser.fill_protected_form", "credentials-call", {
      secureInputGroupReceipt: { status: "delivered" },
      protectedDelivery: settledDelivery(),
      snapshot: {
        title: "Approve sign-in",
        elements: [{ ref: "@e1", role: "button", name: "Use a passkey" }],
      },
    });

    expect(deriveAuthenticationExecutionEffects([execution])).toEqual([
      { effect: "credentials-submitted", stage: "credentials", toolCallId: "credentials-call" },
      { effect: "challenge-required", stage: "challenge", toolCallId: "credentials-call" },
    ]);
  });

  it("attributes credential settlement failure to the credential phase without regressing completed navigation", async () => {
    const evidence = new ExecutionEvidenceIndex();
    evidence.record({
      tool: toolDefinition("browser.navigate"),
      decision: "allow",
      riskClass: "read-only-network",
      toolCallId: "navigation-call",
      result: { ok: true, content: "Reached the login form" },
    });
    const controller = new ExecutionPlanController(new ExecutionPlanStore(), undefined, evidence);
    await controller.write({
      objective: "Open the developer portal and authenticate",
      items: [
        {
          id: "navigate-login",
          content: "Navigate to the portal and reach the login form",
          status: "completed",
          evidenceCallIds: ["navigation-call"],
        },
        { id: "authenticate", content: "Fill the account credentials through the protected form", status: "in_progress" },
        { id: "verify-account", content: "Verify the authenticated state", status: "pending" },
      ],
    }, "turn-auth");
    const failure = protectedExecution("browser.fill_protected_form", "credentials-failure", {
      secureInputGroupReceipt: { status: "failed" },
    }, false);

    await applyAuthenticationExecutionEffects({
      controller,
      effects: deriveAuthenticationExecutionEffects([failure]),
      objective: "ignored",
      originTurnId: "turn-auth",
    });

    expect(controller.current()?.items).toMatchObject([
      { id: "navigate-login", status: "completed" },
      {
        id: "authenticate",
        status: "blocked",
        blocker: {
          kind: "external_state",
          summary: "Protected credential delivery failed before authentication could continue.",
        },
      },
      { id: "verify-account", status: "pending" },
    ]);
  });

  it("turns a post-submit authentication error page into a blocker instead of a candidate", () => {
    const execution = protectedExecution("browser.fill_protected_form", "credentials-call", {
      secureInputGroupReceipt: { status: "delivered" },
      protectedDelivery: settledDelivery(),
      snapshot: {
        url: "https://portal.example.com/login-error",
        title: "Authentication failed",
        text: "Invalid credentials",
      },
    });

    expect(deriveAuthenticationExecutionEffects([execution])).toEqual([{
      effect: "authentication-blocked",
      stage: "credentials",
      toolCallId: "credentials-call",
      failureProof: "authentication-error",
      blocker: {
        kind: "external_state",
        summary: "The protected credential submission reached an authentication error state.",
      },
    }]);
  });

  it("advances an existing Mission through credentials, challenge, and verification without replacing post-login work", async () => {
    const evidence = new ExecutionEvidenceIndex();
    const controller = new ExecutionPlanController(new ExecutionPlanStore(), undefined, evidence);
    await controller.write({
      objective: "Log in, then update the Postman collection",
      items: [
        { id: "login", content: "Submit the developer login credentials", status: "in_progress" },
        { id: "otp", content: "Complete the OTP challenge", status: "pending" },
        { id: "verify-login", content: "Verify the authenticated state", status: "pending" },
        { id: "postman", content: "Update the Postman collection", status: "pending" },
      ],
    }, "turn-1");

    const credentials = protectedExecution("browser.fill_protected_form", "credentials-call", {
      secureInputGroupReceipt: { status: "delivered" },
      protectedDelivery: settledDelivery(),
      snapshot: { text: "Enter the OTP verification code" },
    });
    evidence.record(credentials);
    await applyAuthenticationExecutionEffects({
      controller,
      effects: deriveAuthenticationExecutionEffects([credentials]),
      objective: "ignored because the Mission already exists",
      originTurnId: "turn-1",
    });

    expect(controller.current()).toMatchObject({
      objective: "Log in, then update the Postman collection",
      items: [
        { id: "login", status: "completed", evidenceCallIds: ["credentials-call"] },
        { id: "otp", status: "in_progress" },
        { id: "verify-login", status: "pending" },
        { id: "postman", status: "pending" },
      ],
    });

    const challenge = protectedExecution("browser.type", "challenge-call", {
      secureInputReceipt: { status: "delivered" },
      protectedDelivery: settledDelivery(),
    });
    evidence.record(challenge);
    await applyAuthenticationExecutionEffects({
      controller,
      effects: deriveAuthenticationExecutionEffects([challenge]),
      objective: "ignored",
      originTurnId: "turn-1",
    });

    expect(controller.current()?.items).toMatchObject([
      { id: "login", status: "completed" },
      { id: "otp", status: "pending", evidenceCallIds: ["challenge-call"] },
      { id: "verify-login", status: "in_progress" },
      { id: "postman", status: "pending" },
    ]);

    await applyAuthenticationExecutionEffects({
      controller,
      effects: [{ effect: "challenge-required", stage: "challenge", toolCallId: "resend-call" }],
      objective: "ignored",
      originTurnId: "turn-1",
    });
    expect(controller.current()?.items.filter((item) => item.id === "otp")).toHaveLength(1);
    expect(controller.current()?.items).toMatchObject([
      { id: "login", status: "completed" },
      { id: "otp", status: "in_progress", evidenceCallIds: ["challenge-call"] },
      { id: "verify-login", status: "pending" },
      { id: "postman", status: "pending" },
    ]);

    const verified: AuthenticationExecutionEffectReceipt = {
      effect: "authentication-verified",
      stage: "verification",
      toolCallId: "challenge-call",
    };
    await applyAuthenticationExecutionEffects({
      controller,
      effects: [verified],
      objective: "ignored",
      originTurnId: "turn-1",
    });

    expect(controller.current()).toMatchObject({
      objective: "Log in, then update the Postman collection",
      status: "active",
      items: [
        { id: "login", status: "completed" },
        { id: "otp", status: "completed" },
        { id: "verify-login", status: "completed" },
        { id: "postman", content: "Update the Postman collection", status: "in_progress" },
      ],
    });

    await applyAuthenticationExecutionEffects({
      controller,
      effects: [{
        effect: "authentication-blocked",
        stage: "verification",
        toolCallId: "no-op-action",
        blocker: { kind: "external_state", summary: "An unrelated browser action did not prove authentication failure." },
      }],
      objective: "ignored",
      originTurnId: "turn-1",
    });
    expect(controller.current()?.items).toMatchObject([
      { id: "login", status: "completed" },
      { id: "otp", status: "completed" },
      { id: "verify-login", status: "completed" },
      { id: "postman", status: "in_progress" },
    ]);

    await applyAuthenticationExecutionEffects({
      controller,
      effects: [{
        effect: "authentication-blocked",
        stage: "verification",
        toolCallId: "explicit-auth-error",
        failureProof: "authentication-error",
        blocker: { kind: "external_state", summary: "The authenticated session explicitly reached an authentication error." },
      }],
      objective: "ignored",
      originTurnId: "turn-1",
    });
    expect(controller.current()?.items).toMatchObject([
      { id: "login", status: "completed" },
      { id: "otp", status: "completed" },
      { id: "verify-login", status: "blocked" },
      { id: "postman", status: "pending" },
    ]);
  });

  it("creates a catch-up Mission when linguistic activation missed a credential request", async () => {
    const controller = new ExecutionPlanController(new ExecutionPlanStore());
    const execution = protectedExecution("browser.fill_protected_form", "credentials-call", {
      secureInputGroupReceipt: { status: "cancelled" },
    }, false);

    await applyAuthenticationExecutionEffects({
      controller,
      effects: deriveAuthenticationExecutionEffects([execution]),
      objective: "Access the developer workspace, then update its collection",
      originTurnId: "turn-missed",
    });

    expect(controller.current()).toMatchObject({
      objective: "Access the developer workspace, then update its collection",
      originTurnId: "turn-missed",
      items: [
        {
          id: "authentication.credentials",
          status: "blocked",
          blocker: {
            kind: "user_input_required",
            summary: "The required authentication credentials were not provided.",
          },
        },
        { id: "authentication.verify", status: "pending" },
        { id: "authentication.continue", content: "Continue the requested post-login work", status: "pending" },
      ],
    });
  });

  it("does not invent credential completion evidence when catch-up begins at a challenge", async () => {
    const controller = new ExecutionPlanController(new ExecutionPlanStore());
    const execution = protectedExecution("browser.type", "challenge-call", {
      secureInputReceipt: { status: "cancelled" },
    }, false);

    await applyAuthenticationExecutionEffects({
      controller,
      effects: deriveAuthenticationExecutionEffects([execution]),
      objective: "Continue access to the developer workspace",
      originTurnId: "turn-challenge",
    });

    expect(controller.current()?.items).toMatchObject([
      {
        id: "authentication.challenge",
        status: "blocked",
        blocker: { kind: "user_input_required" },
      },
      { id: "authentication.verify", status: "pending" },
    ]);
    expect(controller.current()?.items.some((item) => item.id === "authentication.credentials")).toBe(false);
  });
});

function protectedExecution(
  name: "browser.fill_protected_form" | "browser.type",
  toolCallId: string,
  metadata: Record<string, unknown>,
  ok = true
): ToolExecutionRecord {
  return {
    tool: toolDefinition(name),
    decision: "allow",
    riskClass: "external-side-effect",
    toolCallId,
    result: { ok, content: "safe protected browser receipt", metadata },
  };
}

function toolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: {},
    riskClass: "external-side-effect",
    toolsets: ["browser"],
    progressLabel: name,
    maxResultSizeChars: 8_000,
  };
}

function settledDelivery() {
  return {
    delivery: "delivered",
    submission: "clicked",
    challengeState: "departed",
    sensitiveInputActive: false,
  } as const;
}
