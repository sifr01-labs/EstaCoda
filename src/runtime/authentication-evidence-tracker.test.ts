import { describe, expect, it } from "vitest";
import type { BrowserSnapshot, BrowserStateIdentity } from "../contracts/browser.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { AuthenticationEvidenceTracker } from "./authentication-evidence-tracker.js";

describe("authentication evidence tracker", () => {
  it("verifies newly observed authenticated-only evidence after a protected submission", () => {
    const tracker = new AuthenticationEvidenceTracker();
    tracker.observe([snapshotExecution("before", loginSnapshot(identity(1, 1, 1)))]);

    const observation = tracker.observe([
      protectedExecution("browser.fill_protected_form", "submit", {
        before: identity(1, 1, 1),
        after: identity(2, 2, 2),
        snapshot: authenticatedSnapshot(identity(2, 2, 2)),
      }),
    ]);

    expect(observation.effects.map((effect) => effect.effect)).toEqual([
      "credentials-submitted",
      "authentication-candidate",
      "authentication-verified",
    ]);
    expect(observation.assessments).toEqual([
      expect.objectContaining({
        outcome: "verified",
        reason: "authenticated-evidence-observed",
        submissionToolCallId: "submit",
        evidenceToolCallId: "submit",
        challengeDeparted: true,
        stateTransitionObserved: true,
        postSubmitEvidence: true,
        preexistingEvidence: false,
      }),
    ]);
  });

  it("does not accept authenticated-looking evidence that was already present before submission", () => {
    const tracker = new AuthenticationEvidenceTracker();
    const before = loginSnapshot(identity(1, 1, 1), [
      { ref: "@e4", role: "link", name: "Sign out" },
    ]);
    tracker.observe([snapshotExecution("before", before)]);

    const after = loginSnapshot(identity(1, 2, 2), [
      { ref: "@e4", role: "link", name: "Sign out" },
    ]);
    const observation = tracker.observe([
      protectedExecution("browser.fill_protected_form", "submit", {
        before: before.identity,
        after: after.identity,
        snapshot: after,
      }),
    ]);

    expect(observation.effects.map((effect) => effect.effect)).toEqual([
      "credentials-submitted",
      "authentication-candidate",
    ]);
    expect(observation.assessments).toEqual([
      expect.objectContaining({
        outcome: "candidate",
        reason: "preexisting-authenticated-evidence",
        postSubmitEvidence: true,
        preexistingEvidence: true,
      }),
    ]);
  });

  it("accepts a later causal observation without treating arbitrary successful tools as evidence", () => {
    const tracker = new AuthenticationEvidenceTracker();
    const before = loginSnapshot(identity(1, 1, 1));
    const after = pageSnapshot(identity(2, 2, 2), "Completing sign in", []);
    tracker.observe([snapshotExecution("before", before)]);
    const submission = tracker.observe([
      protectedExecution("browser.fill_protected_form", "submit", {
        before: before.identity,
        after: after.identity,
        snapshot: after,
      }),
    ]);

    expect(submission.effects.some((effect) => effect.effect === "authentication-verified")).toBe(false);
    expect(tracker.observe([successfulToolExecution("unrelated")]).effects).toEqual([]);

    const verified = tracker.observe([
      snapshotExecution("verify", authenticatedSnapshot(identity(2, 2, 3))),
    ]);
    expect(verified.effects).toEqual([{
      effect: "authentication-verified",
      stage: "verification",
      toolCallId: "verify",
    }]);
    expect(verified.assessments).toEqual([
      expect.objectContaining({
        outcome: "verified",
        submissionToolCallId: "submit",
        evidenceToolCallId: "verify",
      }),
    ]);
  });

  it("invalidates the causal chain before a guessed navigation can repair it", () => {
    const tracker = new AuthenticationEvidenceTracker();
    const before = loginSnapshot(identity(1, 1, 1));
    const after = pageSnapshot(identity(2, 2, 2), "Signed-in state unknown", []);
    tracker.observe([snapshotExecution("before", before)]);
    tracker.observe([
      protectedExecution("browser.fill_protected_form", "submit", {
        before: before.identity,
        after: after.identity,
        snapshot: after,
      }),
    ]);

    const invalidated = tracker.observe([
      browserActionExecution("navigate-user", "browser.navigate", authenticatedSnapshot(identity(3, 3, 3))),
    ]);
    expect(invalidated.effects).toEqual([expect.objectContaining({
      effect: "authentication-blocked",
      stage: "verification",
      toolCallId: "navigate-user",
    })]);
    expect(invalidated.assessments).toEqual([
      expect.objectContaining({
        outcome: "invalidated",
        reason: "causal-chain-interrupted",
        navigationInterrupted: true,
      }),
    ]);

    expect(tracker.observe([
      snapshotExecution("guessed-proof", authenticatedSnapshot(identity(3, 3, 4))),
    ]).effects).toEqual([]);
  });

  it("keeps error pages and persistent challenges blocked", () => {
    const errorTracker = new AuthenticationEvidenceTracker();
    const before = loginSnapshot(identity(1, 1, 1));
    errorTracker.observe([snapshotExecution("before-error", before)]);
    const error = errorTracker.observe([
      protectedExecution("browser.fill_protected_form", "error-submit", {
        before: before.identity,
        after: identity(2, 2, 2),
        snapshot: pageSnapshot(identity(2, 2, 2), "Authentication failed", []),
      }),
    ]);
    expect(error.effects).toEqual([expect.objectContaining({
      effect: "authentication-blocked",
      toolCallId: "error-submit",
    })]);
    expect(error.assessments).toEqual([
      expect.objectContaining({ outcome: "blocked", reason: "authentication-error" }),
    ]);

    const challengeTracker = new AuthenticationEvidenceTracker();
    challengeTracker.observe([snapshotExecution("before-challenge", before)]);
    const challenge = challengeTracker.observe([
      protectedExecution("browser.fill_protected_form", "challenge-submit", {
        before: before.identity,
        after: identity(1, 2, 2),
        snapshot: loginSnapshot(identity(1, 2, 2)),
        challengeState: "still-present",
      }),
    ]);
    expect(challenge.effects).toEqual([expect.objectContaining({
      effect: "authentication-blocked",
      toolCallId: "challenge-submit",
    })]);
    expect(challenge.assessments).toEqual([
      expect.objectContaining({ outcome: "blocked", reason: "challenge-still-present" }),
    ]);
  });
});

function protectedExecution(
  name: "browser.fill_protected_form" | "browser.type",
  toolCallId: string,
  input: {
    before: BrowserStateIdentity;
    after: BrowserStateIdentity;
    snapshot: BrowserSnapshot;
    challengeState?: "departed" | "still-present" | "unknown";
  }
): ToolExecutionRecord {
  const grouped = name === "browser.fill_protected_form";
  return {
    tool: toolDefinition(name),
    input: { tabRef: "@t1" },
    decision: "allow",
    riskClass: "external-side-effect",
    toolCallId,
    result: {
      ok: input.challengeState !== "still-present",
      content: "safe protected browser receipt",
      metadata: {
        ...(grouped
          ? { secureInputGroupReceipt: { status: "delivered" } }
          : { secureInputReceipt: { status: "delivered" } }),
        protectedDelivery: {
          delivery: "delivered",
          submission: "clicked",
          documentChanged: input.after.documentEpoch > input.before.documentEpoch,
          challengeState: input.challengeState ?? "departed",
          conditionMet: true,
          beforeIdentity: input.before,
          afterIdentity: input.after,
          sensitiveInputActive: false,
        },
        snapshot: input.snapshot,
      },
    },
  };
}

function snapshotExecution(toolCallId: string, snapshot: BrowserSnapshot): ToolExecutionRecord {
  return {
    tool: toolDefinition("browser.snapshot"),
    decision: "allow",
    riskClass: "read-only-network",
    toolCallId,
    result: { ok: true, content: "safe snapshot", metadata: { snapshot } },
  };
}

function browserActionExecution(
  toolCallId: string,
  name: string,
  snapshot: BrowserSnapshot
): ToolExecutionRecord {
  return {
    tool: toolDefinition(name),
    decision: "allow",
    riskClass: "read-only-network",
    toolCallId,
    result: { ok: true, content: "safe browser action", metadata: { snapshot } },
  };
}

function successfulToolExecution(toolCallId: string): ToolExecutionRecord {
  return {
    tool: toolDefinition("mcp.read"),
    decision: "allow",
    riskClass: "read-only-network",
    toolCallId,
    result: { ok: true, content: "Sign out and My profile" },
  };
}

function loginSnapshot(
  browserIdentity: BrowserStateIdentity,
  extraElements: NonNullable<BrowserSnapshot["elements"]> = []
): BrowserSnapshot {
  return pageSnapshot(browserIdentity, "Sign in", [
    { ref: "@e1", role: "textbox", name: "Email" },
    { ref: "@e2", role: "textbox", name: "Password" },
    { ref: "@e3", role: "button", name: "Log in" },
    ...extraElements,
  ]);
}

function authenticatedSnapshot(browserIdentity: BrowserStateIdentity): BrowserSnapshot {
  return pageSnapshot(browserIdentity, "Account home", [
    { ref: "@e1", role: "link", name: "My profile" },
    { ref: "@e2", role: "button", name: "Sign out" },
  ]);
}

function pageSnapshot(
  browserIdentity: BrowserStateIdentity,
  title: string,
  elements: NonNullable<BrowserSnapshot["elements"]>
): BrowserSnapshot {
  return {
    sessionId: "browser-session",
    url: "https://portal.example.com/state",
    identity: browserIdentity,
    observedAt: "2030-01-01T00:00:00.000Z",
    title,
    text: title,
    tab: { ref: "@t1", url: "https://portal.example.com/state", title, controlled: true },
    elements,
  };
}

function identity(documentEpoch: number, actionRevision: number, observationId: number): BrowserStateIdentity {
  return { documentEpoch, actionRevision, observationId };
}

function toolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: {},
    riskClass: name.startsWith("browser.") ? "external-side-effect" : "read-only-network",
    toolsets: name.startsWith("browser.") ? ["browser"] : ["mcp"],
    progressLabel: name,
    maxResultSizeChars: 8_000,
  };
}
