import { describe, expect, it, vi } from "vitest";
import { runInteractiveStartup, runSetupStartup } from "./interactive-startup.js";
import type { LaunchOptions, LaunchResult } from "./interactive-launcher.js";
import type { CliOptions } from "./cli.js";

describe("runInteractiveStartup", () => {
  it("runs reviewed setup immediately and launches the selected workspace after a fresh readiness check", async () => {
    const initialWorkspace = "/workspace/initial";
    const selectedWorkspace = "/workspace/selected";
    const launch = vi.fn<(options: LaunchOptions) => Promise<LaunchResult>>()
      .mockResolvedValueOnce(runSetupDecision(initialWorkspace, "onboarding"))
      .mockResolvedValueOnce(launchDecision(selectedWorkspace, "ar"));
    const runSetup = vi.fn(async (_options: CliOptions) => ({
      handled: true,
      exitCode: 0,
      output: "Setup verified.",
      launchHandoff: {
        workspaceRoot: selectedWorkspace,
        locale: "ar" as const,
      },
    }));

    const result = await runInteractiveStartup({
      workspaceRoot: initialWorkspace,
      homeDir: "/home/user",
      profileId: "default",
      launch,
      runSetup,
    });

    expect(runSetup).toHaveBeenCalledWith(expect.objectContaining({
      argv: ["setup", "--interactive"],
      workspaceRoot: initialWorkspace,
      homeDir: "/home/user",
      profileId: "default",
    }));
    expect(launch.mock.calls.map(([options]) => options.workspaceRoot)).toEqual([
      initialWorkspace,
      selectedWorkspace,
    ]);
    expect(result).toEqual({
      launched: true,
      output: "Setup verified.",
      exitCode: 0,
      workspaceRoot: selectedWorkspace,
      locale: "ar",
    });
  });

  it("exits normally without rechecking launch when setup completes without a launch request", async () => {
    const launch = vi.fn<(options: LaunchOptions) => Promise<LaunchResult>>()
      .mockResolvedValue(runSetupDecision("/workspace", "onboarding"));
    const runSetup = vi.fn(async (_options: CliOptions) => ({
      handled: true,
      exitCode: 0,
      output: "Setup complete.",
    }));

    const result = await runInteractiveStartup({ workspaceRoot: "/workspace", launch, runSetup });

    expect(launch).toHaveBeenCalledOnce();
    expect(result).toEqual({
      launched: false,
      output: "Setup complete.",
      exitCode: 0,
      workspaceRoot: "/workspace",
      locale: "en",
    });
  });

  it("propagates setup cancellation without attempting launch", async () => {
    const launch = vi.fn<(options: LaunchOptions) => Promise<LaunchResult>>()
      .mockResolvedValue(runSetupDecision("/workspace", "onboarding"));
    const runSetup = vi.fn(async (_options: CliOptions) => ({
      handled: true,
      exitCode: 1,
      output: "Setup cancelled.",
    }));

    const result = await runInteractiveStartup({ workspaceRoot: "/workspace", launch, runSetup });

    expect(launch).toHaveBeenCalledOnce();
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("Setup cancelled.");
  });

  it("fails closed when readiness changes after a verified setup handoff", async () => {
    const launch = vi.fn<(options: LaunchOptions) => Promise<LaunchResult>>()
      .mockResolvedValueOnce(runSetupDecision("/workspace", "onboarding"))
      .mockResolvedValueOnce(runSetupDecision("/workspace", "repair"));
    const runSetup = vi.fn(async (_options: CliOptions) => ({
      handled: true,
      exitCode: 0,
      output: "Setup verified.",
      launchHandoff: {
        workspaceRoot: "/workspace",
        locale: "en" as const,
      },
    }));

    const result = await runInteractiveStartup({ workspaceRoot: "/workspace", launch, runSetup });

    expect(result.launched).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("launch readiness changed");
  });

  it("bypasses setup for a ready launch", async () => {
    const launch = vi.fn<(options: LaunchOptions) => Promise<LaunchResult>>()
      .mockResolvedValue(launchDecision("/workspace", "en"));
    const runSetup = vi.fn();

    const result = await runInteractiveStartup({ workspaceRoot: "/workspace", launch, runSetup });

    expect(runSetup).not.toHaveBeenCalled();
    expect(result.launched).toBe(true);
  });

  it("uses the same setup orchestration for an explicit setup command", async () => {
    const launch = vi.fn<(options: LaunchOptions) => Promise<LaunchResult>>()
      .mockResolvedValue(launchDecision("/workspace/selected", "en"));
    const runSetup = vi.fn(async (_options: CliOptions) => ({
      handled: true,
      exitCode: 0,
      output: "Setup verified.",
      launchHandoff: {
        workspaceRoot: "/workspace/selected",
        locale: "en" as const,
      },
    }));

    const result = await runSetupStartup({
      workspaceRoot: "/workspace/initial",
      setupArgv: ["setup", "--interactive", "--advanced"],
      launch,
      runSetup,
    });

    expect(runSetup).toHaveBeenCalledWith(expect.objectContaining({
      argv: ["setup", "--interactive", "--advanced"],
      workspaceRoot: "/workspace/initial",
    }));
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: "/workspace/selected",
    }));
    expect(result.launched).toBe(true);
  });
});

function runSetupDecision(
  workspaceRoot: string,
  setupMode: "onboarding" | "repair"
): LaunchResult {
  return {
    kind: "run-setup",
    launched: false,
    setupMode,
    output: "",
    exitCode: 0,
    workspaceRoot,
    locale: "en",
  };
}

function launchDecision(workspaceRoot: string, locale: "en" | "ar"): LaunchResult {
  return {
    kind: "launch",
    launched: true,
    output: "",
    exitCode: 0,
    workspaceRoot,
    locale,
  };
}
