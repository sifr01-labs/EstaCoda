import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answer, createResearchWorkflowHarness, nativeCall, REPORT } from "../test/fakes/research-workflow-harness.js";

function names(request: { tools?: unknown }): string[] {
  return (request.tools as Array<{ function: { name: string } }> ?? []).map((tool) => tool.function.name);
}

describe("capability recovery through the real runtime", () => {
  it("discovers a workflow by query and consumes returned metadata through provider iterations", async () => {
    const h = await createResearchWorkflowHarness();
    let discovered = "";
    try {
      h.enqueue(nativeCall("capability_discover", { query: "write a paper and design experiments", kind: "skill" }),
        (request) => {
          const feedback = request.messages.map((message) => typeof message.content === "string" ? message.content : "").reverse().find((text) => text.includes('"matches"')) ?? "";
          discovered = /"id"\s*:\s*"(skill:[^"\s]+)"/u.exec(feedback)?.[1] ?? "";
          expect(discovered).not.toBe("");
          return nativeCall("capability_request", { ids: [discovered], reason: "The discovered workflow fits the requested work" })(request);
        },
        (request) => nativeCall("skill_read", { name: discovered.slice(6) })(request), answer("Instructions loaded."));
      await h.turn("Help investigate this topic.");
      expect(discovered).toBe("skill:researcher"); // Oracle used only after execution.
      expect(h.scriptErrors).toEqual([]);
      expect(h.events).toContainEqual(expect.objectContaining({ kind: "capability-skills-loaded", loadedSkills: [expect.objectContaining({ name: "researcher", readiness: "available" })] }));
    } finally { await h.dispose(); }
  });
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
        nativeCall("web_search", { query: "current recycling" }), answer(REPORT)
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
      ] }), nativeCall("file_write", { path: "later.md", content: "next iteration" }), nativeCall("web_search", { query: "current recycling" }), answer(REPORT));
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


it.each([false, true])("loads a recovered skill through skill.read and records delivery separately from routing (fallback=%s)", async (fallback) => {
  const h = await createResearchWorkflowHarness({ fallbackOnRequest: fallback ? 3 : undefined });
  try {
    h.enqueue(nativeCall("capability_request", { ids: ["skill:research-discovery"], reason: "Use a literature workflow" }),
      nativeCall("skill_read", { name: "research-discovery", mode: "contract" }),
      (request) => {
        expect(request.messages.some((message) => typeof message.content === "string" && message.content.includes("Recovered skill research-discovery; readiness="))).toBe(true);
        expect(names(request)).not.toContain("terminal_run");
        return { content: "The research workflow instructions are loaded." };
      });
    const result = await h.turn("Find battery studies.");
    expect(h.scriptErrors).toEqual([]);
    expect(h.events).toContainEqual({ kind: "capability-skills-loaded", loadedSkills: [expect.objectContaining({
      name: "research-discovery", origin: "capability-recovery", contentMode: "contract", appliedIteration: 2, readiness: "available", confirmationRequired: false
    })] });
    expect(h.events.some((event) => event.kind === "skill" && event.name === "research-discovery")).toBe(false);
    expect(result.toolExecutions.map((execution) => execution.tool.name)).toEqual(["capability.request", "skill.read"]);
  } finally { await h.dispose(); }
});

it("does not record a skill as loaded merely because it was requested", async () => {
  const h = await createResearchWorkflowHarness();
  try {
    h.enqueue(nativeCall("capability_request", { ids: ["skill:research-discovery"], reason: "Use the workflow" }), answer("I did not load instructions."));
    await h.turn("Find battery studies.");
    expect(h.scriptErrors).toEqual([]);
    expect(h.events.some((event) => event.kind === "capability-skills-loaded")).toBe(false);
  } finally { await h.dispose(); }
});

it("does not record skill delivery when cancelled after the instruction read", async () => {
  const h = await createResearchWorkflowHarness();
  const controller = new AbortController();
  try {
    h.enqueue(nativeCall("capability_request", { ids: ["skill:research-discovery"], reason: "Use the workflow" }),
      nativeCall("skill_read", { name: "research-discovery" }));
    await h.runtime.handle({ text: "Find battery studies.", channel: "cli", signal: controller.signal, onEvent: (event) => {
      h.events.push(event);
      if (event.kind === "tool-result" && event.tool === "skill.read") controller.abort();
    } });
    expect(h.scriptErrors).toEqual([]);
    expect(h.requests).toHaveLength(2);
    expect(h.events.some((event) => event.kind === "capability-skills-loaded")).toBe(false);
  } finally { await h.dispose(); }
});

it.each([false, true])("uses live Jev selection and discovery without same-batch execution or approval bypass (fallback=%s)", async fallback => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { resolveProfileStateHome } = await import("../config/profile-home.js");
  const { vi } = await import("vitest");
  const approvals: string[] = [];
  const h = await createResearchWorkflowHarness({ fallbackOnRequest: fallback ? 3 : undefined, approvalDecision: async request => {
    approvals.push(request.tool.name);
    return request.tool.name === "file.write" ? "denied" : "approved";
  } });
  const paths = resolveProfileStateHome({ homeDir: h.homeDir, profileId: "baseline" });
  await mkdir(paths.profileRoot, { recursive: true });
  await writeFile(paths.configPath, JSON.stringify({ routing: { mode: "jev-assisted" } }));
  await writeFile(paths.envPath, "TYPESAFE_API_KEY=fixture-only\n");
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    const discovery = payload.state.material.some((item: { text: string }) => item.text.includes("Agent discovery query"));
    return new Response(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 10, output_tokens: 0 }, answers: Object.fromEntries(Object.entries(payload.questions).map(([id, q]) => [id, { type: "noul", noul: id === "intent.research" || (q as { instructions: { subjectDescription: string } }).instructions.subjectDescription.startsWith(discovery ? "file.write:" : "web.search:") ? .95 : .05 }])) }));
  });
  try {
    h.enqueue(request => {
      expect(names(request)).toContain("web_search"); expect(names(request)).not.toContain("file_write");
      return nativeCall("capability_discover", { query: "retain the findings on disk", kind: "tool" })(request);
    }, request => {
      expect(request.messages.some(message => typeof message.content === "string" && message.content.includes('"id":"tool:file.write"'))).toBe(true);
      return { content: "", toolCalls: [
        { id: "request", name: "capability_request", argumentsText: JSON.stringify({ ids: ["tool:file.write"], reason: "Retain the findings" }) },
        { id: "premature", name: "file_write", argumentsText: JSON.stringify({ path: "premature.md", content: "must not execute" }) }
      ] };
    }, request => {
      expect(names(request)).toContain("file_write");
      return nativeCall("file_write", { path: "denied.md", content: "requires approval" })(request);
    }, answer("The write was denied."));
    await h.turn("Investigate battery methods.");
    expect(h.scriptErrors).toEqual([]);
    expect(h.events).toContainEqual(expect.objectContaining({ kind: "provider-tool-inventory", selection: expect.objectContaining({ routing: expect.objectContaining({ actualEngine: "jev" }) }) }));
    expect(approvals).toContain("file.write");
    expect(h.events).toContainEqual(expect.objectContaining({ kind: "tool-result", tool: "file.write", decision: "deny" }));
    await expect(readFile(join(h.workspaceRoot, "premature.md"))).rejects.toThrow();
    await expect(readFile(join(h.workspaceRoot, "denied.md"))).rejects.toThrow();
    expect((await h.sessionDb.listProviderUsageEntries("baseline")).some(entry => entry.provider === "typesafe")).toBe(true);
    if (fallback) expect(h.requests.some(request => request.model === "research-fallback")).toBe(true);
  } finally { fetch.mockRestore(); await h.dispose(); }
});
