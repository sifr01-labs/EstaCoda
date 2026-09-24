import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answer, createResearchWorkflowHarness, nativeCall } from "../test/fakes/research-workflow-harness.js";

function names(request: { tools?: unknown }): string[] {
  return (request.tools as Array<{ function: { name: string } }> ?? []).map((tool) => tool.function.name);
}

describe("capability recovery through the real runtime", () => {
  it.each([false, true])("expands on the next iteration, including provider fallback (%s)", async (fallback) => {
    const harness = await createResearchWorkflowHarness({ fallbackOnRequest: fallback ? 3 : undefined });
    try {
      harness.enqueue(
        (request) => {
          expect(names(request)).not.toContain("file_write");
          return nativeCall("capability_discover", { ids: ["tool:file.write"] })(request);
        },
        nativeCall("capability_request", { ids: ["tool:file.write"], reason: "Deliver the research notes" }),
        nativeCall("file_write", { path: "recovered.md", content: "# Recovered notes\n" }),
        answer("The notes were saved.")
      );
      await harness.turn("Find recent battery research.");
      expect(harness.scriptErrors).toEqual([]);
      expect(await readFile(join(harness.workspaceRoot, "recovered.md"), "utf8")).toContain("Recovered notes");
      expect(harness.events).toContainEqual(expect.objectContaining({ kind: "capability-recovery", applied: ["tool:file.write"] }));
      if (fallback) {
        expect(harness.requests.some((request) => request.model === "research-fallback")).toBe(true);
        const attempted = harness.requests.slice(2, 4).map(names);
        expect(attempted[0]).toEqual(attempted[1]);
      }
    } finally { await harness.dispose(); }
  });

  it("rejects same-batch use before the requested tool is exposed", async () => {
    const harness = await createResearchWorkflowHarness();
    try {
      harness.enqueue(() => ({ content: "", toolCalls: [
        { id: "request", name: "capability_request", argumentsText: JSON.stringify({ ids: ["tool:file.write"], reason: "Save research notes" }) },
        { id: "premature", name: "file_write", argumentsText: JSON.stringify({ path: "premature.md", content: "should not exist" }) }
      ] }), nativeCall("file_write", { path: "later.md", content: "next iteration" }), answer("Saved."));
      await harness.turn("Find recent battery research.");
      expect(harness.scriptErrors).toEqual([]);
      await expect(readFile(join(harness.workspaceRoot, "premature.md"))).rejects.toThrow();
      expect(await readFile(join(harness.workspaceRoot, "later.md"), "utf8")).toBe("next iteration");
    } finally { await harness.dispose(); }
  });

  it("preserves a write denial after recovery", async () => {
    const harness = await createResearchWorkflowHarness({ denyWrites: true });
    try {
      harness.enqueue(nativeCall("capability_request", { ids: ["tool:file.write"], reason: "Save notes" }), nativeCall("file_write", { path: "denied.md", content: "denied" }), answer("The write was denied."));
      await harness.turn("Find recent battery research.");
      expect(harness.scriptErrors).toEqual([]);
      await expect(readFile(join(harness.workspaceRoot, "denied.md"))).rejects.toThrow();
      expect(harness.events).toContainEqual(expect.objectContaining({ kind: "tool-result", tool: "file.write", decision: "deny" }));
    } finally { await harness.dispose(); }
  });
});


it("asks again for the recovered action under strict policy", async () => {
  const approvals: string[] = [];
  const h = await createResearchWorkflowHarness({ approvalDecision: async (request) => {
    approvals.push(request.tool.name);
    return request.tool.name === "file.write" ? "denied" : "approved";
  } });
  try {
    h.enqueue(nativeCall("capability_request", { ids: ["tool:file.write"], reason: "Save notes" }), nativeCall("file_write", { path: "strict.md", content: "blocked" }), answer("The write needs approval."));
    await h.turn("Find recent battery research.");
    expect(h.scriptErrors).toEqual([]);
    expect(approvals).toContain("capability.request");
    expect(approvals).toContain("file.write");
    await expect(readFile(join(h.workspaceRoot, "strict.md"))).rejects.toThrow();
  } finally { await h.dispose(); }
});
