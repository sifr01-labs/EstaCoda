import { describe, expect, it } from "vitest";
import type { SecurityApprovalMode } from "../contracts/security.js";
import type { Runtime } from "../runtime/create-runtime.js";
import { operatorConsoleStatusRailState } from "./session-status-rail.js";
import type { SessionRenderer } from "./session-renderer.js";

describe("operatorConsoleStatusRailState", () => {
  it("adds a YOLO badge only when the runtime security mode is open", () => {
    expect(statusForSecurityMode("open").security).toEqual({ yolo: true });
    expect(statusForSecurityMode("adaptive")).not.toHaveProperty("security");
    expect(statusForSecurityMode("strict")).not.toHaveProperty("security");
  });

  it("keeps context usage unknown until a provider measurement exists", () => {
    expect(statusForSecurityMode("adaptive").context).toEqual({
      totalTokens: 262_000,
    });
  });

  it("maps provider-actual context usage into the operator rail", () => {
    expect(operatorConsoleStatusRailState({
      runtime: runtime("adaptive"),
      renderer: {} as SessionRenderer,
      contextUsage: { filled: 18_400, total: 262_000 },
    }).context).toEqual({
      usedTokens: 18_400,
      totalTokens: 262_000,
      percent: 7,
    });
  });
});

function statusForSecurityMode(mode: SecurityApprovalMode) {
  return operatorConsoleStatusRailState({
    runtime: runtime(mode),
    renderer: {} as SessionRenderer,
    timing: {
      now: () => 1_000,
      sessionStartedAtMs: 0,
      mode: "idle",
    },
  });
}

function runtime(mode: SecurityApprovalMode): Runtime {
  return {
    securityMode: () => mode,
    getModelInfo: () => ({
      kind: "kv",
      entries: [
        { key: "provider", value: "kimi" },
        { key: "model", value: "kimi-k2.7-code" },
        { key: "context window", value: "262000" },
      ],
    }),
  } as unknown as Runtime;
}
