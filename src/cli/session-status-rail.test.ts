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
