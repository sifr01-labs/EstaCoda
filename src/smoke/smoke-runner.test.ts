import { describe, expect, it, vi } from "vitest";
import { runSmokeCases } from "./smoke-runner.js";
import type { SmokeCase } from "./smoke-case.js";

describe("runSmokeCases", () => {
  it("runs cases with an isolated state home and restores the caller home", async () => {
    const callerHome = process.env.HOME;
    let observedHome = "";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const cases: SmokeCase[] = [{
      id: "state-home",
      name: "state home isolation",
      tags: ["test"],
      run: async () => {
        observedHome = process.env.HOME ?? "";
      }
    }];

    try {
      const report = await runSmokeCases(cases);

      expect(report.failed).toBe(0);
      expect(observedHome).toContain("estacoda-smoke-home-");
      expect(process.env.HOME).toBe(callerHome);
    } finally {
      log.mockRestore();
    }
  });
});
