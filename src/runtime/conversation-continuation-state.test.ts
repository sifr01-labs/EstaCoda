import { describe, expect, it } from "vitest";
import {
  blockedConnectorContinuationState,
  continuesConversationCommitment,
  detectPromisedAction,
  isAcknowledgementContinuation,
  renderConversationContinuationPrompt,
  sanitizeConversationContinuationState,
  updateConversationContinuationState,
  type ConversationContinuationState
} from "./conversation-continuation-state.js";

const openCommitment: ConversationContinuationState = {
  id: "continuation-test",
  status: "open",
  userRequest: "Trace model requests.",
  promisedAction: "trace how model requests actually flow",
  lastProgress: "Located provider files.",
  updatedAt: "2026-06-17T00:00:00.000Z",
  source: "heuristic"
};

describe("conversation continuation state", () => {
  it("detects promised actions conservatively", () => {
    expect(detectPromisedAction("Let me trace how model requests actually flow.")).toBe("trace how model requests actually flow");
    expect(detectPromisedAction("I'll check the provider loop next.")).toBe("check the provider loop next");
    expect(detectPromisedAction("That is done.")).toBeUndefined();
  });

  it("detects acknowledgement continuations", () => {
    expect(isAcknowledgementContinuation("okay")).toBe(true);
    expect(isAcknowledgementContinuation("continue")).toBe(true);
    expect(isAcknowledgementContinuation("go on")).toBe(true);
    expect(isAcknowledgementContinuation("let's do this [pasted text]")).toBe(true);
    expect(isAcknowledgementContinuation("why not try again")).toBe(true);
    expect(isAcknowledgementContinuation("Okay can you pick u where we lefto ff/")).toBe(true);
    expect(isAcknowledgementContinuation("Please resume where you left off.")).toBe(true);
    expect(isAcknowledgementContinuation("okay thanks")).toBe(false);
    expect(isAcknowledgementContinuation("Can you review the README?")).toBe(false);
  });

  it("creates bounded continuation for a governed connector blocker", () => {
    expect(blockedConnectorContinuationState({
      userText: "Set up these API products in Postman.",
      connectorId: "postman",
      reasonCodes: ["connector_unavailable", "verification_missing"],
      updatedAt: "2026-08-25T00:00:00.000Z"
    })).toEqual(expect.objectContaining({
      status: "open",
      source: "explicit",
      userRequest: "Set up these API products in Postman.",
      lastProgress: "Blocked by: connector_unavailable, verification_missing.",
      capabilityContext: {
        toolsets: ["browser"],
        connectors: [{ kind: "mcp", id: "postman" }]
      }
    }));
  });

  it("continues open work through acknowledgement and deictic action language", () => {
    expect(continuesConversationCommitment("let's do this", openCommitment)).toBe(true);
    expect(continuesConversationCommitment("Please click that app shown there.", openCommitment)).toBe(true);
    expect(continuesConversationCommitment("Can you review the README?", openCommitment)).toBe(false);
    expect(continuesConversationCommitment("stop", openCommitment)).toBe(false);
  });

  it("does not treat a new explicit request as continuation", () => {
    const state = updateConversationContinuationState({
      previous: openCommitment,
      userText: "Can you review the README?",
      agentText: "The README looks fine and has enough detail to proceed with the new request."
    });

    expect(state).toMatchObject({
      status: "superseded",
      lastProgress: "Superseded by a newer explicit user request."
    });
  });

  it("cancels on explicit stop language", () => {
    const state = updateConversationContinuationState({
      previous: openCommitment,
      userText: "never mind",
      agentText: "Okay, stopping."
    });

    expect(state).toMatchObject({ status: "cancelled" });
  });

  it("marks a previous promised action satisfied after a substantive answer", () => {
    const state = updateConversationContinuationState({
      previous: openCommitment,
      userText: "continue",
      agentText: "I traced the provider flow through the runtime, provider turn loop, executor, and session metadata. The request starts in AgentLoop, then ProviderTurnLoop assembles history, then ProviderExecutor resolves the route and returns the actual model."
    });

    expect(state).toMatchObject({ status: "satisfied" });
  });

  it("does not satisfy a commitment from tool execution without final explanation", () => {
    const state = updateConversationContinuationState({
      previous: openCommitment,
      userText: "continue",
      agentText: "Done.",
      toolExecutions: [{ tool: { name: "file.search" }, result: { ok: true } }]
    });

    expect(state).toMatchObject({ status: "open" });
    expect(state?.lastProgress).toContain("file.search");
  });

  it("persists only bounded browser and registered connector provenance", () => {
    const state = updateConversationContinuationState({
      userText: "Set up the app key in Postman.",
      agentText: "I'll finish the protected Postman update next.",
      toolExecutions: [
        {
          tool: {
            name: "browser.snapshot",
            toolsets: ["browser", "research"],
          },
          result: { ok: true }
        },
        {
          tool: {
            name: "mcp.postman.getCollection",
            toolsets: ["mcp"],
            connector: { kind: "mcp", id: "postman" }
          },
          result: { ok: true }
        },
        {
          tool: {
            name: "shell.run",
            toolsets: ["shell-write", "dangerous"]
          },
          result: { ok: true }
        }
      ]
    });

    expect(state?.capabilityContext).toEqual({
      toolsets: ["browser"],
      connectors: [{ kind: "mcp", id: "postman" }]
    });
  });

  it("drops untrusted persisted capability names during hydration", () => {
    const hydrated = sanitizeConversationContinuationState({
      ...openCommitment,
      capabilityContext: {
        toolsets: ["browser", "dangerous"],
        connectors: [
          { kind: "mcp", id: "postman" },
          { kind: "mcp", id: "invalid\nconnector" },
          { kind: "other", id: "untrusted" }
        ]
      }
    });

    expect(hydrated?.capabilityContext).toEqual({
      toolsets: ["browser"],
      connectors: [{ kind: "mcp", id: "postman" }]
    });
  });

  it("does not reopen an old commitment for casual thanks without open state", () => {
    expect(updateConversationContinuationState({
      userText: "okay thanks",
      agentText: "You are welcome."
    })).toBeUndefined();
  });

  it("renders only open state as subordinate prompt context", () => {
    expect(renderConversationContinuationPrompt(openCommitment)).toContain("subordinate to the latest user message");
    expect(renderConversationContinuationPrompt({ ...openCommitment, status: "satisfied" })).toBeUndefined();
    expect(renderConversationContinuationPrompt({ ...openCommitment, status: "superseded" })).toBeUndefined();
  });
});
