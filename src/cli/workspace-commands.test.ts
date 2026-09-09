import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseGlobalCliOptions, runCliCommand } from "./cli.js";

it("consumes workspace selection only before a command or prompt", () => {
  expect(parseGlobalCliOptions(["--profile", "alpha", "--workspace", "Project", "hello"])).toEqual({ ok: true, profileId: "alpha", workspaceAlias: "project", argv: ["hello"] });
  expect(parseGlobalCliOptions(["bench", "run", "--workspace", "/fixture"])).toEqual({ ok: true, argv: ["bench", "run", "--workspace", "/fixture"] });
  expect(parseGlobalCliOptions(["hello", "--workspace", "project"])).toEqual({ ok: true, argv: ["hello", "--workspace", "project"] });
  expect(parseGlobalCliOptions(["--workspace=one", "--workspace=two"])).toMatchObject({ ok: false });
  expect(parseGlobalCliOptions(["--workspace"])).toMatchObject({ ok: false });
});

it("adds, selects, renames and removes registrations without trust or active-profile writes", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "workspace-cli-"));
  const run = (...argv: string[]) => runCliCommand({ homeDir, workspaceRoot: homeDir, profileId: "alpha", argv });
  try {
    expect((await run("workspace", "--help")).exitCode).toBe(0);
    await expect(stat(join(homeDir, ".estacoda"))).rejects.toThrow();
    const added = await run("workspace", "add", "project");
    expect(added.exitCode).toBe(0);
    const record = JSON.parse(added.output);
    expect((await run("workspace", "open", "project")).workspaceHandoff?.id).toBe(record.id);
    expect((await run("workspace", "rename", "project", "renamed")).exitCode).toBe(0);
    expect((await run("workspace", "list")).output).toContain("renamed");
    expect((await run("workspace", "show", record.id)).exitCode).toBe(0);
    expect((await run("--workspace", "renamed", "workspace", "show", record.id)).exitCode).toBe(0);
    expect((await run("workspace", "remove", "renamed")).exitCode).toBe(0);
    expect((await run("workspace", "open", "renamed")).exitCode).toBe(1);
    await expect(readFile(join(homeDir, ".estacoda", "active-profile.json"))).rejects.toThrow();
    await expect(readFile(join(homeDir, ".estacoda", "trust.json"))).rejects.toThrow();
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});
