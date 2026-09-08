import { describe, expect, it } from "vitest";
import type { BrowserSnapshot, BrowserStateIdentity } from "../contracts/browser.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { AuthenticationEvidenceTracker } from "./authentication-evidence-tracker.js";

describe("authentication evidence tracker", () => {
  it("re-observes a checkpointed challenge instead of trusting the recovery hint", () => {
    const tracker = new AuthenticationEvidenceTracker([], "challenge_required");
    const challenge = pageSnapshot(identity(4, 4, 4), "Two-factor authentication", [
      { ref: "@e1", role: "textbox", name: "Verification code" },
      { ref: "@e2", role: "button", name: "Verify" },
    ]);

    expect(tracker.observe([])).toEqual({ effects: [], assessments: [] });
    const observation = tracker.observe([snapshotExecution("fresh-challenge", challenge)]);

    expect(observation.effects).toEqual([
      { effect: "challenge-required", stage: "challenge", toolCallId: "fresh-challenge" }
    ]);
    expect(observation.assessments).toEqual([
      expect.objectContaining({
        outcome: "candidate",
        reason: "challenge-required",
        evidenceToolCallId: "fresh-challenge"
      })
    ]);
  });

  it("requires a fresh authenticated browser observation before completing recovery", () => {
    const tracker = new AuthenticationEvidenceTracker([], "challenge_submitted");

    expect(tracker.observe([]).effects).toEqual([]);
    const observation = tracker.observe([
      snapshotExecution("fresh-account", authenticatedSnapshot(identity(5, 5, 5)))
    ]);

    expect(observation.effects).toEqual([
      { effect: "authentication-verified", stage: "verification", toolCallId: "fresh-account" }
    ]);
    expect(observation.assessments).toEqual([
      expect.objectContaining({
        outcome: "verified",
        reason: "authenticated-evidence-observed",
        evidenceToolCallId: "fresh-account"
      })
    ]);
  });

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

  it("keeps authentication pending when the credential receipt lands on a challenge with authenticated-looking controls", () => {
    const tracker = new AuthenticationEvidenceTracker();
    const before = loginSnapshot(identity(1, 1, 1));
    tracker.observe([snapshotExecution("before", before)]);
    const challenge = pageSnapshot(identity(2, 2, 2), "Approve sign-in", [
      { ref: "@e1", role: "button", name: "Use a passkey" },
      { ref: "@e2", role: "link", name: "Sign out" },
    ]);

    const observation = tracker.observe([
      protectedExecution("browser.fill_protected_form", "submit", {
        before: before.identity,
        after: challenge.identity,
        snapshot: challenge,
      }),
    ]);

    expect(observation.effects).toEqual([
      { effect: "credentials-submitted", stage: "credentials", toolCallId: "submit" },
      { effect: "challenge-required", stage: "challenge", toolCallId: "submit" },
    ]);
    expect(observation.assessments).toEqual([
      expect.objectContaining({ outcome: "candidate", reason: "challenge-required", stage: "challenge" }),
    ]);

    const laterChallenge = pageSnapshot(identity(2, 2, 3), "Approve sign-in", [
      { ref: "@e1", role: "button", name: "Use a passkey" },
      { ref: "@e2", role: "link", name: "My profile" },
    ]);
    const laterObservation = tracker.observe([snapshotExecution("observe-challenge", laterChallenge)]);
    expect(laterObservation.effects).toEqual([]);
    expect(laterObservation.assessments).toEqual([
      expect.objectContaining({ outcome: "candidate", reason: "challenge-required", stage: "challenge" }),
    ]);
  });

  it("verifies a generic approval challenge after a causal browser action", () => {
    const tracker = pendingApprovalChallengeTracker();
    const authenticated = withChangedAction(
      authenticatedSnapshot(identity(3, 3, 3)),
      identity(2, 2, 2)
    );

    const observation = tracker.observe([
      browserActionExecution("approve", "browser.click", authenticated),
    ]);

    expect(observation.effects).toEqual([
      { effect: "challenge-submitted", stage: "challenge", toolCallId: "approve" },
      { effect: "authentication-verified", stage: "verification", toolCallId: "approve" },
    ]);
    expect(observation.assessments).toEqual([
      expect.objectContaining({
        outcome: "verified",
        reason: "authenticated-evidence-observed",
        challengeDeparted: true,
        stateTransitionObserved: true,
      }),
    ]);
  });

  it("keeps resend actions on the same challenge pending without duplicating success", () => {
    const tracker = pendingApprovalChallengeTracker();
    const repeatedChallenge = withChangedAction(pageSnapshot(identity(2, 3, 3), "Approval request sent", [
      { ref: "@e1", role: "button", name: "Resend approval request" },
    ]), identity(2, 2, 2));

    const observation = tracker.observe([
      browserActionExecution("resend", "browser.click", repeatedChallenge),
    ]);

    expect(observation.effects).toEqual([
      { effect: "challenge-required", stage: "challenge", toolCallId: "resend" },
    ]);
    expect(observation.effects.some((effect) => effect.effect === "authentication-verified")).toBe(false);
  });

  it("allows a rejected protected challenge to be retried and then verified", () => {
    const tracker = new AuthenticationEvidenceTracker();
    const challenge = pageSnapshot(identity(1, 1, 1), "Verification code", [
      { ref: "@e1", role: "textbox", name: "Verification code" },
      { ref: "@e2", role: "button", name: "Verify" },
    ]);
    tracker.observe([snapshotExecution("before-challenge", challenge)]);
    const rejected = tracker.observe([
      protectedExecution("browser.type", "rejected-code", {
        before: challenge.identity,
        after: identity(1, 2, 2),
        snapshot: { ...challenge, identity: identity(1, 2, 2), text: "Incorrect verification code" },
        challengeState: "still-present",
      }),
    ]);
    expect(rejected.effects.map((effect) => effect.effect)).toEqual([
      "challenge-submitted",
      "challenge-required",
    ]);

    const retry = tracker.observe([
      protectedExecution("browser.type", "accepted-code", {
        before: identity(1, 2, 2),
        after: identity(2, 3, 3),
        snapshot: authenticatedSnapshot(identity(2, 3, 3)),
      }),
    ]);
    expect(retry.effects.map((effect) => effect.effect)).toEqual([
      "challenge-submitted",
      "authentication-candidate",
      "authentication-verified",
    ]);
  });

  it("treats an MTN 2FA success notice without challenge controls as completed", () => {
    const tracker = new AuthenticationEvidenceTracker();
    const challenge = pageSnapshot(identity(1, 1, 1), "MTN Developer Portal", [
      { ref: "@code", role: "textbox", name: "Enter authenticator code" },
      { ref: "@submit", role: "button", name: "Authenticate" }
    ]);
    tracker.observe([snapshotExecution("challenge", challenge)]);
    const authenticated = {
      ...authenticatedSnapshot(identity(2, 2, 2)),
      title: "My apps",
      text: "My apps Dashboard Success! 2FA has been verified."
    };

    const observation = tracker.observe([
      protectedExecution("browser.type", "accepted-code", {
        before: challenge.identity,
        after: authenticated.identity,
        snapshot: authenticated
      })
    ]);

    expect(observation.effects.map((effect) => effect.effect)).toEqual([
      "challenge-submitted",
      "authentication-candidate",
      "authentication-verified"
    ]);
    expect(observation.assessments).toEqual([
      expect.objectContaining({ outcome: "verified", reason: "authenticated-evidence-observed" })
    ]);
  });

  it("accepts a supervised user's causal completion of an active challenge", () => {
    const tracker = pendingApprovalChallengeTracker();
    const observation = tracker.observe([
      snapshotExecution("observe-user-completion", authenticatedSnapshot(identity(3, 3, 3))),
    ]);

    expect(observation.effects).toEqual([
      { effect: "authentication-verified", stage: "verification", toolCallId: "observe-user-completion" },
    ]);
    expect(observation.assessments).toEqual([
      expect.objectContaining({
        outcome: "verified",
        challengeDeparted: true,
        stateTransitionObserved: true,
      }),
    ]);
  });

  it("verifies an MFA departure into an authenticated destination when signals were visible behind the challenge", () => {
    const tracker = new AuthenticationEvidenceTracker();
    const before = {
      ...pageSnapshot(identity(4, 8, 12), "MFA verification", [
        { ref: "@e1", role: "textbox", name: "Verification code" },
        { ref: "@e2", role: "button", name: "Verify" },
        { ref: "@e3", role: "link", name: "Sign out" },
      ]),
      url: "https://developers.mtn.com/notifications/count",
    };
    tracker.observe([snapshotExecution("before-mfa", before)]);
    const after = {
      ...authenticatedSnapshot(identity(5, 9, 13)),
      url: "https://developers.mtn.com/apps",
    };

    const verified = tracker.observe([
      protectedExecution("browser.type", "submit-mfa", {
        before: before.identity,
        after: after.identity,
        snapshot: after,
      }),
    ]);

    expect(verified.effects).toContainEqual({
      effect: "authentication-verified",
      stage: "verification",
      toolCallId: "submit-mfa",
    });
    expect(verified.assessments).toEqual([
      expect.objectContaining({
        outcome: "verified",
        reason: "authenticated-evidence-observed",
        challengeDeparted: true,
        stateTransitionObserved: true,
        postSubmitEvidence: true,
        preexistingEvidence: true,
      }),
    ]);

    const noOpCancel = {
      ...after,
      identity: identity(5, 9, 14),
      actionDelta: {
        outcome: "no-change" as const,
        afterIdentity: identity(5, 9, 14),
        waitCondition: "dom-stable" as const,
        conditionMet: false,
        url: { changed: false, before: after.url, after: after.url },
      },
    };
    expect(tracker.observe([
      browserActionExecution("cancel-dialog", "browser.click", noOpCancel),
    ])).toEqual({ effects: [], assessments: [] });
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

  it("does not invalidate pending authentication after a failed or no-change browser action", () => {
    const tracker = new AuthenticationEvidenceTracker();
    const before = loginSnapshot(identity(1, 1, 1));
    const after = pageSnapshot(identity(2, 2, 2), "Completing sign in", []);
    tracker.observe([snapshotExecution("before", before)]);
    tracker.observe([
      protectedExecution("browser.fill_protected_form", "submit", {
        before: before.identity,
        after: after.identity,
        snapshot: after,
      }),
    ]);

    const failedAction: ToolExecutionRecord = {
      ...browserActionExecution("failed-click", "browser.click", after),
      result: { ok: false, content: "The click did not execute.", metadata: { snapshot: after } },
    };
    expect(tracker.observe([failedAction])).toEqual({ effects: [], assessments: [] });

    const noChange = {
      ...after,
      identity: identity(2, 2, 3),
      actionDelta: {
        outcome: "no-change" as const,
        afterIdentity: identity(2, 2, 3),
        waitCondition: "dom-stable" as const,
        conditionMet: false,
        url: { changed: false, before: after.url, after: after.url },
      },
    };
    expect(tracker.observe([
      browserActionExecution("cancel-no-op", "browser.click", noChange),
    ])).toEqual({ effects: [], assessments: [] });

    const verified = tracker.observe([
      snapshotExecution("verify", authenticatedSnapshot(identity(2, 3, 4))),
    ]);
    expect(verified.effects).toEqual([expect.objectContaining({ effect: "authentication-verified" })]);
  });

  it("keeps verified authentication monotonic until explicit error or signed-out evidence appears", () => {
    const errorTracker = verifiedChallengeTracker();
    const error = errorTracker.observe([
      snapshotExecution(
        "auth-error",
        pageSnapshot(identity(3, 3, 4), "Authentication failed", [])
      ),
    ]);
    expect(error.effects).toEqual([expect.objectContaining({
      effect: "authentication-blocked",
      failureProof: "authentication-error",
    })]);
    expect(error.assessments).toEqual([
      expect.objectContaining({ outcome: "blocked", reason: "authentication-error" }),
    ]);

    const signedOutTracker = verifiedChallengeTracker();
    const signedOut = signedOutTracker.observe([
      snapshotExecution("signed-out", loginSnapshot(identity(3, 3, 4))),
    ]);
    expect(signedOut.effects).toEqual([expect.objectContaining({
      effect: "authentication-blocked",
      failureProof: "signed-out",
    })]);
    expect(signedOut.assessments).toEqual([
      expect.objectContaining({ outcome: "blocked", reason: "signed-out" }),
    ]);
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
      effect: "credentials-required",
      toolCallId: "challenge-submit",
      blocker: expect.objectContaining({ kind: "user_input_required" }),
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

function verifiedChallengeTracker(): AuthenticationEvidenceTracker {
  const tracker = new AuthenticationEvidenceTracker();
  const before = loginSnapshot(identity(1, 1, 1));
  tracker.observe([snapshotExecution("before", before)]);
  tracker.observe([
    protectedExecution("browser.type", "challenge", {
      before: before.identity,
      after: identity(2, 2, 2),
      snapshot: authenticatedSnapshot(identity(2, 2, 2)),
    }),
  ]);
  return tracker;
}

function pendingApprovalChallengeTracker(): AuthenticationEvidenceTracker {
  const tracker = new AuthenticationEvidenceTracker();
  const before = loginSnapshot(identity(1, 1, 1));
  tracker.observe([snapshotExecution("before", before)]);
  tracker.observe([
    protectedExecution("browser.fill_protected_form", "submit", {
      before: before.identity,
      after: identity(2, 2, 2),
      snapshot: pageSnapshot(identity(2, 2, 2), "Approve sign-in", [
        { ref: "@e1", role: "button", name: "Approve request" },
      ]),
    }),
  ]);
  return tracker;
}

function withChangedAction(snapshot: BrowserSnapshot, beforeIdentity: BrowserStateIdentity): BrowserSnapshot {
  return {
    ...snapshot,
    actionDelta: {
      outcome: "changed",
      beforeIdentity,
      afterIdentity: snapshot.identity,
      waitCondition: "dom-stable",
      conditionMet: true,
      url: {
        changed: snapshot.identity.documentEpoch > beforeIdentity.documentEpoch,
        before: "https://portal.example.com/state",
        after: snapshot.url,
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
