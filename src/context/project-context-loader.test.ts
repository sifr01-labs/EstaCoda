import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectContextLoader } from "./project-context-loader.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-project-context-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("ProjectContextLoader", () => {
  it("discovers and loads AGENTS.md as project context", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "AGENTS.md"), "# Agent Rules\nUse repo instructions.", "utf8");

    const snapshot = await new ProjectContextLoader({ workspaceRoot: root }).load();

    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]).toMatchObject({
      source: "AGENTS.md",
      kind: "project-file",
      title: "Shared agent context",
      content: "# Agent Rules\nUse repo instructions.",
      status: "loaded"
    });
  });
});
