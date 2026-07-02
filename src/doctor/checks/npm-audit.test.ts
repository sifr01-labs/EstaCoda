import { describe, expect, it } from "vitest";
import { diagnoseNpmAudit, parseAuditJson } from "./npm-audit.js";

describe("diagnoseNpmAudit", () => {
  it("does not spawn pnpm when the audit flag is not enabled", async () => {
    let called = false;

    const diagnostic = await diagnoseNpmAudit({
      enabled: false,
      cwd: "/workspace",
      runAudit: async () => {
        called = true;
        throw new Error("should not run");
      }
    });

    expect(called).toBe(false);
    expect(diagnostic.status).toBe("not-run");
    expect(diagnostic.notes).toEqual(["Dependency audit not run."]);
  });

  it("parses successful audit JSON with runtime vulnerabilities", async () => {
    const diagnostic = await diagnoseNpmAudit({
      enabled: true,
      cwd: "/workspace",
      runAudit: async () => ({
        exitCode: 1,
        stdout: JSON.stringify({
          vulnerabilities: {
            lodash: {
              severity: "high",
              dev: false
            }
          },
          metadata: {
            vulnerabilities: {
              info: 0,
              low: 0,
              moderate: 0,
              high: 1,
              critical: 0,
              total: 1
            }
          }
        }),
        stderr: ""
      })
    });

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.totalVulnerabilities).toBe(1);
    expect(diagnostic.severityCounts.high).toBe(1);
    expect(diagnostic.runtimeVulnerabilities).toBe(1);
    expect(diagnostic.devVulnerabilities).toBe(0);
    expect(diagnostic.warnings).toEqual(["Dependency audit found 1 high runtime advisory."]);
  });

  it("reports timeout without parsing partial output", async () => {
    const diagnostic = await diagnoseNpmAudit({
      enabled: true,
      cwd: "/workspace",
      timeoutMs: 30_000,
      runAudit: async () => ({
        exitCode: null,
        stdout: "{",
        stderr: "",
        timedOut: true
      })
    });

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.timedOut).toBe(true);
    expect(diagnostic.warnings).toEqual(["Dependency audit timed out after 30s."]);
  });

  it("reports pnpm missing", async () => {
    const diagnostic = await diagnoseNpmAudit({
      enabled: true,
      cwd: "/workspace",
      runAudit: async () => ({
        exitCode: null,
        stdout: "",
        stderr: "",
        errorCode: "ENOENT",
        errorMessage: "spawn pnpm ENOENT"
      })
    });

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.warnings).toEqual([
      "Dependency audit could not run because pnpm was not found."
    ]);
  });
});

describe("parseAuditJson", () => {
  it("falls back to advisory entries when metadata is absent", () => {
    const parsed = parseAuditJson(JSON.stringify({
      advisories: {
        "100": {
          severity: "moderate",
          dependencyType: "dev"
        }
      }
    }));

    expect(parsed).toEqual({
      totalVulnerabilities: 1,
      severityCounts: {
        info: 0,
        low: 0,
        moderate: 1,
        high: 0,
        critical: 0
      },
      runtimeVulnerabilities: 0,
      devVulnerabilities: 1,
      unknownVulnerabilities: 0
    });
  });
});
