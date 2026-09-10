import { it, expect } from "vitest";
import { workspaceChangeSummary } from "./workspace-change-summary.js";
import type { ApplicationResult } from "../workspaces/change-application.js";
it.each(["applied", "review", "conflict", "attention"] as const)("summarizes %s without paths or raw error content", (status) => {
  const result = { status, artifact: { id: "artifact_safe", path: "/private/secret" }, paths: ["secret.txt"], reason: "TOKEN=secret" } as ApplicationResult;
  for (const locale of ["en", "ar"]) {
    const text = workspaceChangeSummary(result, locale);
    expect(text).toContain("artifact_safe"); expect(text).not.toMatch(/secret|TOKEN/);
    if (locale === "ar") expect(text).toContain("\u2066artifact_safe\u2069");
  }
});
it("explains consumed copies without claiming later edits were applied", () => {
  const result = { status: "attention", code: "copy-consumed", artifact: { id: "artifact_safe", path: "artifact:safe", kind: "data", bytes: 0, createdAt: "2030-01-01T00:00:00.000Z" }, paths: [] } satisfies ApplicationResult;
  expect(workspaceChangeSummary(result, "en")).toContain("No new changes were applied");
  expect(workspaceChangeSummary(result, "en")).toContain("fresh copy");
  expect(workspaceChangeSummary(result, "ar")).toContain("\u2066artifact_safe\u2069");
});
