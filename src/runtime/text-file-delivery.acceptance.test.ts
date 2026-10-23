import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { answer, createResearchWorkflowHarness, nativeCall } from "../test/fakes/research-workflow-harness.js";

const LINK_REQUEST = 'Audit only the relative links in docs/index.md against local files. Save links.json with existing:["docs/setup.md"] and missing:["docs/missing.md"] if those are the findings; verify from the filesystem rather than assuming the example is true. Do not create the missing page or browse. Read back the report.';
const TRANSLATION_REQUEST = "Translate welcome and remaining in en.json to German and save de.json. Preserve every key, placeholders {name} and {n}, and token exactly SESSION_ID. Verify the saved JSON. No browsing.";
const translation = JSON.stringify({ welcome: "Willkommen, {name}", remaining: "Noch {n} Minuten", token: "SESSION_ID" });
let h: Awaited<ReturnType<typeof createResearchWorkflowHarness>> | undefined;
afterEach(async () => { await h?.dispose(); h = undefined; vi.unstubAllGlobals(); });

async function setup(timeout: boolean, denyWrites = false) {
  h = await createResearchWorkflowHarness({ denyWrites });
  const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetcher);
  if (timeout) {
    const paths = resolveProfileStateHome({ homeDir: h.homeDir, profileId: "baseline" });
    await mkdir(paths.profileRoot, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ routing: { mode: "jev-assisted", jev: { timeoutMs: 100 } } }));
    await writeFile(paths.envPath, "TYPESAFE_API_KEY=fixture-only\n");
  }
  return { runtime: h, fetcher };
}

describe("text file delivery through the real runtime", () => {
  it("audits links without treating JSON payload filenames as destinations", async () => {
    const { runtime: h, fetcher } = await setup(false);
    await mkdir(join(h.workspaceRoot, "docs"));
    await writeFile(join(h.workspaceRoot, "docs/index.md"), "# Manual\n[Setup](setup.md)\n[Missing](missing.md)\n");
    await writeFile(join(h.workspaceRoot, "docs/setup.md"), "# Setup\nUse defaults.\n");
    const report = JSON.stringify({ existing: ["docs/setup.md"], missing: ["docs/missing.md"] });
    h.enqueue(nativeCall("file_read", { path: "docs/index.md" }), nativeCall("file_read", { path: "docs/setup.md" }),
      nativeCall("file_read", { path: "docs/missing.md" }), nativeCall("file_write", { path: "links.json", content: report }),
      nativeCall("file_read", { path: "links.json" }), answer("Saved and verified links.json. The missing page was not created."));
    const result = await h.turn(LINK_REQUEST);
    expect(result.finalOutcome?.status).toBe("completed_with_recovered_errors");
    expect(result.finalOutcome?.confirmedActions).toContainEqual(expect.objectContaining({ tool: "file.write", verification: "verified" }));
    expect(await readFile(join(h.workspaceRoot, "links.json"), "utf8")).toBe(report);
    await expect(readFile(join(h.workspaceRoot, "docs/missing.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.scriptErrors).toEqual([]); expect(h.remainingSteps()).toBe(0); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])("saves and verifies translated JSON after routing (Jev timeout=%s)", async timeout => {
    const { runtime: h, fetcher } = await setup(timeout);
    await writeFile(join(h.workspaceRoot, "en.json"), JSON.stringify({ welcome: "Welcome, {name}", remaining: "{n} minutes remaining", token: "SESSION_ID" }));
    h.enqueue(request => {
      const names = (request.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name);
      expect(names).toEqual(expect.arrayContaining(["file_write", "file_read", "capability_discover", "capability_request"]));
      return nativeCall("file_read", { path: "en.json" })(request);
    }, nativeCall("file_write", { path: "de.json", content: translation }), nativeCall("file_read", { path: "de.json" }), answer("Saved and verified de.json."));
    const result = await h.turn(TRANSLATION_REQUEST);
    expect(result.finalOutcome?.status).toBe("completed");
    expect(result.finalOutcome?.confirmedActions).toContainEqual(expect.objectContaining({ tool: "file.write", verification: "verified" }));
    expect(await readFile(join(h.workspaceRoot, "de.json"), "utf8")).toBe(translation);
    expect(h.scriptErrors).toEqual([]); expect(h.remainingSteps()).toBe(0);
    if (timeout) {
      expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(h.events).toEqual(expect.arrayContaining(["intent-skills", "capabilities"].map(stage =>
        expect.objectContaining({ kind: "routing-status", stage, actualEngine: "standard", fallbackReason: "timeout" }))));
    } else expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])("completes ordinary JSON production without prescribing readback (Jev timeout=%s)", async timeout => {
    const { runtime: h } = await setup(timeout);
    h.enqueue(request => {
      expect(JSON.stringify(request.messages)).toContain("not mandatory text readback");
      return nativeCall("file_write", { path: "de.json", content: translation })(request);
    }, answer("Saved de.json."));
    const result = await h.turn("Save de.json");
    expect(result.finalOutcome?.status).toBe("completed");
    expect(result.finalOutcome?.confirmedActions).toContainEqual(expect.objectContaining({ tool: "file.write", verification: "not_verified" }));
    expect(result.toolExecutions.some(call => call.tool.name === "file.read")).toBe(false);
    expect(await readFile(join(h.workspaceRoot, "de.json"), "utf8")).toBe(translation);
    expect(h.scriptErrors).toEqual([]); expect(h.remainingSteps()).toBe(0);
  });

  it.each(["model.pt", "server.key"])("accepts command-produced %s through the real executor without text reads", async path => {
    const { runtime: h } = await setup(false);
    h.enqueue(nativeCall("terminal_run", { command: `dd if=/dev/zero of=${path} bs=1048576 count=9`, timeoutMs: 1000 }), answer(`Created ${path}.`));
    const result = await h.turn(`Generate ${path}`);
    expect(result.finalOutcome?.status, result.text).toBe("completed");
    expect(result.toolExecutions.map(call => call.tool.name)).toEqual(["terminal.run"]);
    expect(result.finalOutcome?.confirmedActions.every(action => action.verification !== "verified")).toBe(true);
    expect((await readFile(join(h.workspaceRoot, path))).length).toBe(9 * 1024 * 1024);
    expect(h.scriptErrors).toEqual([]); expect(h.remainingSteps()).toBe(0);
  });

  it("rejects completion without explicitly requested JSON readback", async () => {
    const { runtime: h } = await setup(false);
    h.enqueue(nativeCall("file_write", { path: "de.json", content: translation }),
      answer("Saved and verified de.json."), answer("Saved and verified de.json."), answer("Saved and verified de.json."));
    const result = await h.turn("Save de.json and read back the file.");
    expect(result.finalOutcome?.status).toBe("partially_completed");
    expect(result.text).toContain("matching readback");
    expect(result.text).not.toContain("Saved and verified");
    expect(h.scriptErrors).toEqual([]); expect(h.remainingSteps()).toBe(0);
  });

  it("does not let routing fallback authorize a denied JSON write", async () => {
    const { runtime: h } = await setup(true, true);
    h.enqueue(nativeCall("file_write", { path: "de.json", content: translation }), answer("Writing de.json was denied."));
    const result = await h.turn(TRANSLATION_REQUEST);
    expect(result.toolExecutions[0]).toMatchObject({ decision: "deny" });
    expect(result.finalOutcome?.status).not.toBe("completed");
    expect(result.finalOutcome?.confirmedActions).toEqual([]);
    await expect(readFile(join(h.workspaceRoot, "de.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.scriptErrors).toEqual([]); expect(h.remainingSteps()).toBe(0);
  });
});
