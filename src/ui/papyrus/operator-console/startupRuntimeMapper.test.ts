import { describe, expect, it } from "vitest";
import type { StartupDashboardViewModel } from "../../../contracts/view-model.js";
import { mapStartupDashboardViewModelToOperatorConsoleState } from "./startupRuntimeMapper.js";

describe("Operator Console startup runtime mapper", () => {
  it("maps startup dashboard view model data into Operator Console startup state", () => {
    const state = mapStartupDashboardViewModelToOperatorConsoleState({
      viewModel: startupViewModel(),
      contextUsage: { filled: 18_400, total: 262_000 },
    });

    expect(state).toMatchObject({
      productName: "EstaCoda",
      orgName: "⟡ SIFR01 ⟡",
      tagline: "sovereign agentic infrastructure",
      version: "v0.1.0",
      sessionId: "20ea8195",
      session: {
        model: "kimi-k2.6 ◐",
        modelRoute: "fallback",
        context: "18.4k / 262k",
        workspace: "/tmp/project",
        security: "open",
        autonomy: "autonomous",
      },
      updateStatus: "Unknown.",
    });
    expect(state.commands.map((command) => command.command)).toEqual([
      "/tools",
      "/skills",
      "/model",
      "/status",
      "/compact",
    ]);
    expect(state.tips).toContain("Paste large context as attachments.");
    expect(state.tips).toContain("Use /model to switch routes.");
  });

  it("uses custom command descriptions when the view model provides them", () => {
    const state = mapStartupDashboardViewModelToOperatorConsoleState({
      viewModel: {
        ...startupViewModel(),
        availableCommands: [
          { name: "/custom", description: "preserved description" },
        ],
      },
    });

    expect(state.commands).toEqual([{ command: "/custom", description: "preserved description" }]);
  });

  it("maps known version status into dashboard update copy", () => {
    const state = mapStartupDashboardViewModelToOperatorConsoleState({
      viewModel: {
        ...startupViewModel(),
        versionStatus: "up-to-date",
      },
    });

    expect(state.updateStatus).toBe("Up to date.");
  });

  it("preserves Arabic and technical tokens without translating them", () => {
    const state = mapStartupDashboardViewModelToOperatorConsoleState({
      viewModel: {
        ...startupViewModel(),
        taglines: ["بنية تحتية وكيلة سيادية"],
        model: { provider: "mock", id: "kimi-k2.6" },
        workspaceDirectory: "/Users/ahnwy/project",
      },
      contextUsage: { total: 32_768 },
    });

    expect(state.tagline).toBe("بنية تحتية وكيلة سيادية");
    expect(state.session.model).toContain("kimi-k2.6");
    expect(state.session.context).toBe("-- / 32.8k");
  });
});

function startupViewModel(): StartupDashboardViewModel {
  return {
    kind: "startupDashboard",
    agentName: "EstaCoda",
    taglines: ["sovereign agentic infrastructure"],
    version: "v0.1.0",
    sessionId: "20ea8195-with-suffix",
    model: { provider: "kimi", id: "kimi-k2.6" },
    workspaceTrust: "trusted",
    workspaceVerification: "verified",
    workspaceDirectory: "/tmp/project",
    securityMode: "open",
    skillAutonomy: "autonomous",
    providerReadiness: "degraded",
    versionStatus: "unknown",
    availableCommands: [],
    warnings: [],
  };
}
