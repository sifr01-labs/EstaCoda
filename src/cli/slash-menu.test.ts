import { describe, expect, it } from "vitest";
import type { Runtime } from "../runtime/create-runtime.js";
import { buildSlashCompletionViewModel } from "./slash-menu.js";

const runtime = {} as Runtime;

describe("buildSlashCompletionViewModel", () => {
  it("hides active-turn-only commands from idle slash completions", () => {
    const labels = buildSlashCompletionViewModel(runtime, "/", { limit: 100 }).options.map((option) => option.label);

    expect(labels).not.toContain("/interrupt");
    expect(labels).not.toContain("/steer");
  });

  it("includes active-turn-only commands for active-turn completions", () => {
    const labels = buildSlashCompletionViewModel(runtime, "/", {
      includeActiveTurnCommands: true,
      limit: 100,
    }).options.map((option) => option.label);

    expect(labels).toContain("/interrupt");
    expect(labels).toContain("/steer");
  });

  it("prioritizes active-turn-only commands inside the fixed active-turn panel", () => {
    const labels = buildSlashCompletionViewModel(runtime, "/", {
      includeActiveTurnCommands: true,
      limit: 6,
    }).options.map((option) => option.label);

    expect(labels).toContain("/interrupt");
    expect(labels).toContain("/steer");
  });

  it("uses free-form note usage for active-turn steer completion", () => {
    const option = buildSlashCompletionViewModel(runtime, "/steer", {
      includeActiveTurnCommands: true,
    }).options.find((candidate) => candidate.label === "/steer");

    expect(option?.description).toBe("/steer <note>");
  });

  it("keeps limit as a backward-compatible visible row option", () => {
    const labels = buildSlashCompletionViewModel(runtime, "/", { limit: 3 }).options.map((option) => option.label);

    expect(labels).toEqual(["/help", "/status", "/model"]);
  });

  it("uses visibleRows for completion windowing", () => {
    const vm = buildSlashCompletionViewModel(runtime, "/", { visibleRows: 3 });

    expect(vm.options.map((option) => option.label)).toEqual(["/help", "/status", "/model"]);
    expect(vm.visibleStartIndex).toBe(0);
    expect(vm.absoluteSelectedIndex).toBe(0);
    expect(vm.selectedIndex).toBe(0);
    expect(vm.totalOptions).toBeGreaterThan(3);
  });

  it("clamps selected indexes into the available completion range", () => {
    const negative = buildSlashCompletionViewModel(runtime, "/", { selectedIndex: -10, visibleRows: 3 });
    const tooLarge = buildSlashCompletionViewModel(runtime, "/", { selectedIndex: 10_000, visibleRows: 3 });

    expect(negative.absoluteSelectedIndex).toBe(0);
    expect(negative.selectedIndex).toBe(0);
    expect(tooLarge.absoluteSelectedIndex).toBe((tooLarge.totalOptions ?? 1) - 1);
    expect(tooLarge.selectedIndex).toBe(tooLarge.options.length - 1);
  });

  it("windows around selected completions beyond the first visible page", () => {
    const vm = buildSlashCompletionViewModel(runtime, "/", { selectedIndex: 4, visibleRows: 3 });

    expect(vm.absoluteSelectedIndex).toBe(4);
    expect(vm.visibleStartIndex).toBe(3);
    expect(vm.selectedIndex).toBe(1);
    expect(vm.options.map((option) => option.label)).toEqual(["/tools", "/skills", "/exit"]);
  });

  it("returns safe metadata for empty completion results", () => {
    const vm = buildSlashCompletionViewModel(runtime, "/zzzz", { selectedIndex: 4, visibleRows: 3 });

    expect(vm.options).toEqual([]);
    expect(vm.selectedIndex).toBe(0);
    expect(vm.absoluteSelectedIndex).toBe(0);
    expect(vm.visibleStartIndex).toBe(0);
    expect(vm.totalOptions).toBe(0);
  });
});
