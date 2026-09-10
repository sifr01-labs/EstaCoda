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
